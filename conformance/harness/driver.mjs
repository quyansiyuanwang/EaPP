import { spawn } from 'node:child_process';

/**
 * A conformance driver client.
 *
 * Speaks the JSON-lines protocol in `conformance/driver.md` and **imports nothing
 * from the implementation**. That constraint is the whole value of this harness: it
 * can only see what the protocol exposes, so an implementation cannot pass by being
 * the same code as the reference one.
 */

export class DriverError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'DriverError';
    this.code = code;
    this.detail = message;
  }
}

export function isDriverError(error) {
  return error instanceof DriverError;
}

export class Driver {
  #child;
  #buffer = '';
  #pending = new Map();
  #events = [];
  #debug;
  #seq = 0;
  #hello;
  #exited = null;
  #stderrTail = '';

  /**
   * Spawn a driver and wait for its hello line.
   *
   * The hello is what tells the harness which layers the implementation claims, so
   * nothing is sent until it arrives — and a driver that exits or hangs before
   * saying hello fails here, where the message is useful, rather than as a timeout
   * on the first check.
   */
  static async start(options) {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      shell: options.shell ?? false,
    });
    const driver = new Driver(child, options);
    await driver.#awaitHello(options.startupTimeoutMs ?? 60_000);
    return driver;
  }

  constructor(child, options = {}) {
    this.#child = child;
    this.#debug = options.debug ?? false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // stderr is the implementation's own business. Surfaced so a crashing driver is
      // diagnosable, never parsed.
      if (this.#debug) process.stderr.write(`[driver] ${chunk}`);
      else this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-4000);
    });

    child.on('exit', (code) => {
      this.#exited = code ?? 0;
      // Every awaited reply dies with the process. Without this, a driver that
      // crashes mid-request leaves the harness suspended instead of failing.
      for (const [id, pending] of this.#pending) {
        this.#pending.delete(id);
        pending.reject(new Error(`driver exited (code ${code}) before answering request ${id}`));
      }
    });
  }

  get hello() {
    return this.#hello;
  }

  get exited() {
    return this.#exited;
  }

  get stderrTail() {
    return this.#stderrTail;
  }

  /** Unsolicited lines the implementation pushed, in arrival order. */
  get events() {
    return [...this.#events];
  }

  drainEvents() {
    const out = [...this.#events];
    this.#events.length = 0;
    return out;
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim().length > 0) this.#onLine(line);
      index = this.#buffer.indexOf('\n');
    }
  }

  #onLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new Error(`driver emitted a line that is not JSON: ${line.slice(0, 200)}`);
    }

    if (frame.hello === true) {
      this.#hello = frame;
      return;
    }
    if (frame.event !== undefined) {
      this.#events.push(frame);
      return;
    }

    const pending = this.#pending.get(frame.id);
    if (!pending) {
      // A reply nobody asked for is a protocol violation; dropping it silently would
      // hide a driver answering the wrong request.
      throw new Error(`driver answered unknown request id ${String(frame.id)}`);
    }
    this.#pending.delete(frame.id);
    if (frame.ok === true) pending.resolve(frame.result ?? {});
    else pending.reject(new DriverError(frame.error?.code ?? 'EAPP_INTERNAL', frame.error?.message ?? ''));
  }

  async #awaitHello(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.#hello === undefined) {
      if (this.#exited !== null) {
        throw new Error(`driver exited (code ${this.#exited}) before saying hello\n${this.#stderrTail}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`driver did not send a hello line within ${timeoutMs}ms\n${this.#stderrTail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Send one request and await its reply.
   *
   * The timeout guards against an implementation that hangs instead of failing:
   * that is reported as a failed check, never as a pass.
   */
  async request(op, args = {}, timeoutMs = 10_000) {
    if (this.#exited !== null) throw new Error(`driver exited (code ${this.#exited})`);

    const id = ++this.#seq;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`driver did not answer '${op}' within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
    });

    this.#child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    return promise;
  }

  /** A request that is expected to be refused with `code`. Returns the error. */
  async refused(op, args, code, timeoutMs) {
    try {
      await this.request(op, args, timeoutMs);
    } catch (error) {
      if (!isDriverError(error)) throw error;
      if (error.code !== code) {
        throw new Error(`${op} was refused with ${error.code}, expected ${code}`);
      }
      return error;
    }
    throw new Error(`${op} succeeded, expected ${code}`);
  }

  async close() {
    if (this.#exited !== null) return;
    this.#child.stdin.end();
    const deadline = Date.now() + 3000;
    while (this.#exited === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.#exited === null) this.#child.kill('SIGKILL');
  }
}

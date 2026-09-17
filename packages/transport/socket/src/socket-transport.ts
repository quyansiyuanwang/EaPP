import { connect, type Socket } from 'node:net';

import { EappError, type Identity } from '@eapp/core';
import type { Cursor, CursorAnchor, Pattern, TransportMessage } from '@eapp/interaction';
import type {
  ExpectedRevision,
  Revision,
  StateCell,
  StateChange,
  StatePattern,
  StateTransport,
  StateTransportCapabilities,
  StateUpdate,
} from '@eapp/state';

import {
  FrameDecoder,
  carriesBrokerPrefix,
  encodeFrame,
  toWireUpdate,
  type BrokerHello,
  type WireRequest,
  type WireResponse,
  type WireStateChange,
} from './wire.js';

/**
 * SocketTransport — the client half of `@eapp/transport-socket`.
 *
 * It is a real v3.1 / v3.2 Transport: the three layers above it cannot tell it
 * apart from the in-process one. Everything it knows about the log — its
 * capabilities, the id its cursors carry — comes from the broker's `hello`,
 * because those are properties of the storage, not of the client. A client that
 * declared its own capabilities would be guessing.
 */

export interface SocketTransportOptions {
  /** Broker port. Required — there is no default port, and guessing one would be worse. */
  port: number;
  host?: string;
  /** Per-request timeout. `waitForChange` is exempt: it is a long poll by design. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class SocketTransport implements StateTransport {
  #id = '';
  #capabilities: StateTransportCapabilities | undefined;

  readonly #socket: Socket;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #decoder = new FrameDecoder();
  #seq = 0;
  #closed = false;

  private constructor(socket: Socket, timeoutMs: number) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;

    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.#onData(chunk.toString('utf8')));
    socket.on('error', () => this.#onGone('socket error'));
    socket.on('close', () => this.#onGone('socket closed'));
  }

  static async connect(options: SocketTransportOptions): Promise<SocketTransport> {
    const host = options.host ?? '127.0.0.1';
    const socket = await new Promise<Socket>((resolve, reject) => {
      const attempt = connect({ port: options.port, host });
      attempt.once('connect', () => resolve(attempt));
      attempt.once('error', reject);
    });

    const transport = new SocketTransport(socket, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // The handshake is a normal correlated request, so it exercises the same path
    // every later call takes. A handshake with its own private code path would be
    // the one part of the protocol never covered by using the protocol.
    const hello = (await transport.#request({ op: 'hello' }, transport.#timeoutMs)) as BrokerHello;
    transport.#id = hello.id;
    transport.#capabilities = hello.capabilities as StateTransportCapabilities;
    return transport;
  }

  /**
   * Cursors carry the broker's id, so a client MUST adopt it.
   *
   * This is what makes REV-8 checkable on the near side: a revision issued by a
   * different broker is rejected without a round trip, in both directions.
   */
  get id(): string {
    return this.#id;
  }

  get capabilities(): StateTransportCapabilities {
    if (!this.#capabilities) {
      throw new EappError('EAPP_UNSUPPORTED', 'capabilities are unavailable before the handshake');
    }
    return this.#capabilities;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  // ------------------------------------------------------------ request plumbing

  #onData(chunk: string): void {
    let frames: Array<WireRequest | WireResponse>;
    try {
      frames = this.#decoder.push(chunk);
    } catch {
      this.#onGone('malformed frame from broker');
      return;
    }

    for (const frame of frames) {
      if (!('ok' in frame)) continue; // clients do not receive requests
      const pending = this.#pending.get(frame.id);
      if (!pending) continue; // a cancelled long poll, or a reply nobody awaits
      this.#pending.delete(frame.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);

      if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        pending.reject(rehydrate(frame));
      }
    }
  }

  /**
   * Every awaited reply dies with the connection. Without this, a broker that
   * disappears mid-request leaves callers suspended forever instead of failing.
   */
  #onGone(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new EappError('EAPP_UNSUPPORTED', `transport ${this.#id} lost its broker: ${reason}`);
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #send(payload: Omit<WireRequest, 'id'>, timeoutMs: number): { id: number; promise: Promise<unknown> } {
    if (this.#closed) {
      return {
        id: 0,
        promise: Promise.reject(
          new EappError('EAPP_UNSUPPORTED', `transport ${this.#id} is closed`),
        ),
      };
    }

    const id = ++this.#seq;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(
                new EappError('EAPP_TIMEOUT', `no reply from broker ${this.#id} within ${timeoutMs}ms`),
              );
            }, timeoutMs)
          : undefined;

      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(encodeFrame({ ...payload, id } as WireRequest));
    });

    return { id, promise };
  }

  #request(payload: Omit<WireRequest, 'id'>, timeoutMs: number): Promise<unknown> {
    return this.#send(payload, timeoutMs).promise;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      this.#socket.destroy();
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new EappError('EAPP_UNSUPPORTED', `transport ${this.#id} was closed`));
    }
    this.#pending.clear();
    await new Promise<void>((resolve) => {
      this.#socket.end(() => resolve());
      // `end()` waits for the peer to close too; a broker that never does must not
      // hang the caller's shutdown.
      setTimeout(() => {
        this.#socket.destroy();
        resolve();
      }, 250).unref?.();
    });
  }

  // ------------------------------------------------------------------ Transport

  async send(channel: string, msg: unknown): Promise<Cursor> {
    return (await this.#request({ op: 'send', channel, message: msg }, this.#timeoutMs)) as Cursor;
  }

  async readAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: Pattern,
  ): Promise<TransportMessage[]> {
    this.#requireOwn(cursor, 'cursor');
    return (await this.#request(
      { op: 'readAfter', channel, cursor: cursor ?? null, pattern },
      this.#timeoutMs,
    )) as TransportMessage[];
  }

  async resolveAnchor(channel: string, anchor: CursorAnchor): Promise<Cursor> {
    if (anchor !== 'earliest' && anchor !== 'latest') this.#requireOwn(anchor, 'cursor');
    return (await this.#request(
      { op: 'resolveAnchor', channel, anchor },
      this.#timeoutMs,
    )) as Cursor;
  }

  /**
   * A long poll. The broker holds the request until the channel moves, so this
   * costs one round trip per wakeup rather than a poll interval — and, more
   * importantly, it is still only an optimisation: `Subscription` remains correct
   * if the broker never answers (TR-7 forbids `readAfter` from blocking; this is
   * a separate, optional method).
   *
   * `signal` aborts the wait, which also tells the broker to stop holding it.
   */
  waitForChange(channel: string, cursor: Cursor | undefined, signal?: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#requireOwn(cursor, 'cursor');

    const { id, promise } = this.#send({ op: 'waitForChange', channel, cursor: cursor ?? null }, 0);

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      signal?.addEventListener('abort', finish, { once: true });

      promise.then(finish, finish);
      signal?.addEventListener(
        'abort',
        () => {
          // Tell the broker to release the held request. Without this, a
          // subscription that closes mid-wait leaves a parked long poll behind.
          if (!this.#closed) {
            try {
              this.#socket.write(encodeFrame({ id: id, op: 'cancel', target: id } as WireRequest));
            } catch {
              /* the socket is already gone; nothing to release */
            }
          }
          this.#pending.delete(id);
        },
        { once: true },
      );
    });
  }

  // -------------------------------------------------------------- StateTransport

  async getState(channel: string, key: string): Promise<StateCell | null> {
    return (await this.#request({ op: 'getState', channel, key }, this.#timeoutMs)) as StateCell | null;
  }

  async listState(channel: string, pattern: StatePattern): Promise<StateCell[]> {
    return (await this.#request(
      { op: 'listState', channel, pattern },
      this.#timeoutMs,
    )) as StateCell[];
  }

  async head(channel: string): Promise<Revision> {
    return (await this.#request({ op: 'head', channel }, this.#timeoutMs)) as Revision;
  }

  async setStateWithCAS(channel: string, update: StateUpdate, actor: Identity): Promise<Revision> {
    return (await this.#request(
      { op: 'setStateWithCAS', channel, update: toWireUpdate(update), actor },
      this.#timeoutMs,
    )) as Revision;
  }

  async deleteStateWithCAS(
    channel: string,
    key: string,
    expectedRevision: ExpectedRevision,
    actor: Identity,
  ): Promise<Revision> {
    return (await this.#request(
      { op: 'deleteStateWithCAS', channel, key, expectedRevision, actor },
      this.#timeoutMs,
    )) as Revision;
  }

  async readChangesAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: StatePattern,
  ): Promise<StateChange[]> {
    this.#requireOwn(cursor, 'cursor');
    const changes = (await this.#request(
      { op: 'readChangesAfter', channel, cursor: cursor ?? null, pattern },
      this.#timeoutMs,
    )) as WireStateChange[];

    return changes.map((change) => ({
      channel: change.channel,
      revision: change.revision,
      key: change.key,
      type: change.type,
      ...(change.hasValue ? { value: change.value } : {}),
    }));
  }

  async nextRevision(channel: string): Promise<Revision> {
    return (await this.#request({ op: 'nextRevision', channel }, this.#timeoutMs)) as Revision;
  }

  /**
   * TS-8 / REV-8. Deliberately local and synchronous.
   *
   * The interface promises a number, not a Promise, so this cannot be a round
   * trip even if it wanted to be. That works because a cursor encodes its origin
   * in its prefix, which is exactly why the format is not free for an
   * implementer to choose.
   */
  compareRevision(a: Revision, b: Revision): number {
    this.#requireOwn(a, 'revision');
    this.#requireOwn(b, 'revision');
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  async writeStateWithRevision(
    channel: string,
    key: string,
    value: unknown,
    deleted: boolean,
    revision: Revision,
    actor: Identity,
  ): Promise<void> {
    this.#requireOwn(revision, 'revision');
    await this.#request(
      { op: 'writeStateWithRevision', channel, key, value, deleted, revision, actor },
      this.#timeoutMs,
    );
  }

  // ------------------------------------------------------------------ internals

  #requireOwn(value: Cursor | Revision | undefined, label: string): void {
    if (value === undefined || value === '') return;
    if (!carriesBrokerPrefix(this.#id, value)) {
      throw new EappError(
        'EAPP_CURSOR_INVALID',
        `${label} '${String(value)}' was not issued by transport ${this.#id}`,
      );
    }
  }
}

/**
 * Rebuild an `EappError` on this side of the wire.
 *
 * The broker serialises `code`, `message` and `retryable` separately, but
 * `EappError` renders its message as `"${code}: ${detail}"` (D-4, so that
 * `rejects.toThrow('EAPP_...')` works). Handing that rendered string back as the
 * detail would produce `EAPP_X: EAPP_X: detail` on the far side. Stripping the
 * prefix keeps the message byte-identical across the boundary, which is the only
 * way a conformance assertion written against one process still holds in another.
 */
function rehydrate(frame: Extract<WireResponse, { ok: false }>): EappError {
  const { code, message, retryable } = frame.error;
  const prefix = `${code}: `;
  const detail = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  return new EappError(code, detail, { retryable });
}

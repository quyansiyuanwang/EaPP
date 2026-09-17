import { createServer, type Server, type Socket } from 'node:net';

import { EappError, type Identity } from '@eapp/core';
import type { GroupView } from '@eapp/interaction';
import { MemoryTransport } from '@eapp/transport-memory';
import type { StateChange, StatePattern, StateTransportCapabilities } from '@eapp/state';

import { GroupRegistry } from './group-registry.js';
import {
  FrameDecoder,
  WIRE_VERSION,
  encodeFrame,
  fromWireUpdate,
  isResponse,
  type BrokerHello,
  type WireError,
  type WireGroupView,
  type WireRequest,
  type WireStateChange,
} from './wire.js';

/** Used only when a request arrives without an actor — the wire type has it optional. */
const ANONYMOUS: Identity = { domain: 'eapp.wire', id: 'anonymous', instance: 'anonymous-1' };

/**
 * SocketBroker — the process that owns the log.
 *
 * A Transport allocates positions. Positions have to be ordered, so exactly one
 * place may allocate them. Spread that across processes and you no longer have a
 * cursor, you have a suggestion — two processes would each hand out position 5
 * and `readAfter` would return nonsense. So the broker owns allocation and every
 * client asks it for a position.
 *
 * The storage itself is the in-process `MemoryTransport`. That is not a shortcut:
 * it keeps the interesting part of this package — what has to cross a process
 * boundary, and what must not be invented on the far side — visible.
 */

export interface SocketBrokerOptions {
  /** 0 (the default) lets the OS pick a free port. */
  port?: number;
  host?: string;
  /** The transport id; every cursor this broker issues carries it as a prefix. */
  id?: string;
  /**
   * How much history the underlying log keeps. Forwarded to `MemoryTransport`,
   * so `EAPP_CURSOR_TOO_OLD` is reachable across the wire too.
   */
  retention?: { kind: 'unbounded' } | { kind: 'window'; entries: number };
}

interface Held {
  controller: AbortController;
  socket: Socket;
  id: number;
}

export class SocketBroker {
  readonly id: string;
  #transport: MemoryTransport;
  #server: Server;
  #sockets = new Set<Socket>();
  #held = new Map<number, Held>();
  /** socket -> the group holders it registered, so a dropped connection frees them. */
  #holders = new Map<Socket, Set<string>>();
  readonly #groups: GroupRegistry;
  #port: number;
  #host: string;
  #closed = false;

  private constructor(id: string, transport: MemoryTransport, server: Server, port: number, host: string) {
    this.id = id;
    this.#transport = transport;
    this.#server = server;
    this.#port = port;
    this.#host = host;
    this.#groups = new GroupRegistry(id);
    this.#server.on('connection', (socket) => this.#attach(socket));
  }

  static async listen(options: SocketBrokerOptions = {}): Promise<SocketBroker> {
    const id = options.id ?? 'sock';
    const transport = new MemoryTransport(
      id,
      options.retention === undefined ? {} : { retention: options.retention },
    );
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new EappError('EAPP_UNSUPPORTED', 'broker failed to bind a TCP port');
    }
    return new SocketBroker(id, transport, server, address.port, options.host ?? '127.0.0.1');
  }

  get port(): number {
    return this.#port;
  }

  get host(): string {
    return this.#host;
  }

  /** The address a client connects to. */
  get url(): string {
    return `${this.#host}:${this.#port}`;
  }

  /**
   * What this transport honestly is.
   *
   * The storage is the same non-persistent in-process log the memory transport
   * uses — but it is now reachable from every process on this machine, so
   * `durabilityBoundary` is `'machine'`, not `'process'`. Declaring `'process'`
   * would understate what callers can rely on; declaring `'cluster'` would
   * overstate it, since there is one broker and it does not survive a restart.
   *
   * `stateConsistency: 'strong'` is honest for the same reason: a single broker
   * with a total order per channel means CAS really is correct across clients.
   * (TS-5 forbids claiming `'strong'` *beyond* the declared boundary; here the
   * boundary is exactly what the strong ordering covers.)
   */
  get capabilities(): StateTransportCapabilities {
    return {
      ...this.#transport.capabilities,
      durabilityBoundary: 'machine',
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    for (const held of this.#held.values()) held.controller.abort();
    this.#held.clear();

    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#holders.clear();

    await this.#groups.close();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await this.#transport.close();
  }

  // ------------------------------------------------------------------ internals

  #attach(socket: Socket): void {
    this.#sockets.add(socket);
    this.#holders.set(socket, new Set());
    socket.setNoDelay(true);
    const decoder = new FrameDecoder();

    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk.toString('utf8'));
      } catch {
        // A malformed frame means the peer is not speaking this protocol at all,
        // so there is nothing sensible to reply to. Dropping the connection is the
        // only honest answer.
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (isResponse(frame)) continue; // clients do not send responses
        // Deliberately NOT awaited: a `waitForChange` long-poll would otherwise
        // block every other request on this connection behind it.
        void this.#dispatch(socket, frame);
      }
    });

    const drop = (): void => {
      this.#sockets.delete(socket);
      for (const [id, held] of this.#held) {
        if (held.socket !== socket) continue;
        held.controller.abort();
        this.#held.delete(id);
      }
      // A client that dies mid-work is exactly CG-5's case, one process further
      // out: it will never ack, so waiting for the TTL would idle the group for
      // no reason.
      const holders = this.#holders.get(socket);
      this.#holders.delete(socket);
      for (const holder of holders ?? []) void this.#groups.releaseHolder(holder);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  #reply(socket: Socket, id: number, result: unknown): void {
    if (socket.destroyed) return;
    socket.write(encodeFrame({ id, ok: true, result }));
  }

  #fail(socket: Socket, id: number, error: unknown): void {
    if (socket.destroyed) return;
    const wire: WireError =
      error instanceof EappError
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : {
            code: 'EAPP_INTERNAL',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          };
    socket.write(encodeFrame({ id, ok: false, error: wire }));
  }

  async #dispatch(socket: Socket, request: WireRequest): Promise<void> {
    try {
      this.#reply(socket, request.id, await this.#execute(socket, request));
    } catch (error) {
      this.#fail(socket, request.id, error);
    }
  }

  async #execute(socket: Socket, request: WireRequest): Promise<unknown> {
    const channel = request.channel ?? '';
    // A wire `null` means "absent" (the wire carries no `undefined`); the
    // transport interface spells absence `undefined`.
    const cursor = request.cursor ?? undefined;

    switch (request.op) {
      case 'hello':
        return {
          version: WIRE_VERSION,
          id: this.id,
          capabilities: this.capabilities,
        } satisfies BrokerHello;

      case 'send':
        return this.#transport.send(channel, request.message);

      case 'readAfter':
        return this.#transport.readAfter(
          channel,
          cursor,
          (request.pattern ?? { all: true }) as Parameters<MemoryTransport['readAfter']>[2],
        );

      case 'resolveAnchor':
        return this.#transport.resolveAnchor(channel, request.anchor ?? 'latest');

      case 'waitForChange':
        return this.#waitForChange(socket, request.id, channel, cursor);

      case 'cancel': {
        // A cancelled long-poll is answered immediately rather than silently
        // forgotten: leaving it held would leak a waiter per abandoned read, and
        // the client would have no way to tell "still nothing" from "dropped".
        const held = this.#held.get(request.target ?? -1);
        held?.controller.abort();
        return null;
      }

      case 'getState':
        return this.#transport.getState(channel, request.key ?? '');

      case 'listState':
        return this.#transport.listState(channel, (request.pattern ?? { all: true }) as StatePattern);

      case 'head':
        return this.#transport.head(channel);

      case 'setStateWithCAS': {
        if (!request.update) throw new EappError('EAPP_STATE_VALUE_INVALID', 'update is required');
        return this.#transport.setStateWithCAS(
          channel,
          fromWireUpdate(request.update),
          request.actor ?? ANONYMOUS,
        );
      }

      case 'deleteStateWithCAS':
        return this.#transport.deleteStateWithCAS(
          channel,
          request.key ?? '',
          request.expectedRevision ?? null,
          request.actor ?? ANONYMOUS,
        );

      case 'readChangesAfter':
        return (await this.#transport.readChangesAfter(
          channel,
          cursor,
          (request.pattern ?? { all: true }) as StatePattern,
        )).map(toWireChange);

      case 'nextRevision':
        return this.#transport.nextRevision(channel);

      case 'writeStateWithRevision':
        return this.#transport.writeStateWithRevision(
          channel,
          request.key ?? '',
          request.value,
          request.deleted === true,
          request.revision ?? '',
          request.actor ?? ANONYMOUS,
        );

      // ------------------------------------------------------ ConsumerGroup §8
      //
      // The claim table lives here because the messages do. CG-3 needs one place
      // where "this position is taken" is decided, and a broker is that place.

      case 'groupJoin': {
        const { holder, view } = await this.#groups.join(channel, request.name ?? '', {
          initialCursor: request.initialCursor ?? '',
          ttlMs: request.ttlMs ?? 30_000,
          ...(request.holder === undefined ? {} : { holder: request.holder }),
        });
        // Remembered per connection so a client that dies without leaving still
        // releases its work — the wire equivalent of CG-5.
        this.#holders.get(socket)?.add(holder);
        return { holder, view: toWireView(view) };
      }

      case 'groupLeave':
        await this.#groups.leave(channel, request.name ?? '', request.holder ?? '');
        this.#holders.get(socket)?.delete(request.holder ?? '');
        return null;

      case 'groupClaim':
        return this.#groups.claim(
          channel,
          request.name ?? '',
          request.holder ?? '',
          request.cursors ?? [],
        );

      case 'groupSettle': {
        const view = await this.#groups.settle(channel, request.name ?? '', request.cursor ?? '');
        return view ? toWireView(view) : null;
      }

      case 'groupRelease': {
        const view = await this.#groups.release(channel, request.name ?? '', request.cursor ?? '');
        return view ? toWireView(view) : null;
      }

      case 'groupView': {
        const view = await this.#groups.view(channel, request.name ?? '');
        return view ? toWireView(view) : null;
      }

      default:
        throw new EappError('EAPP_UNSUPPORTED', `unknown wire operation '${request.op}'`);
    }
  }

  /**
   * A long poll, implemented by reusing the local `waitForChange`.
   *
   * Reusing it rather than inventing a notification scheme is the point: the
   * local push mechanism is already the tested one, and the wire layer must not
   * add ordering semantics of its own (TR-1).
   */
  async #waitForChange(
    socket: Socket,
    id: number,
    channel: string,
    cursor: string | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    this.#held.set(id, { controller, socket, id });
    try {
      await this.#transport.waitForChange(channel, cursor, controller.signal);
      return null;
    } finally {
      this.#held.delete(id);
    }
  }

  /** Test/diagnostic helper: how many long polls are currently parked. */
  get heldWaiters(): number {
    return this.#held.size;
  }
}

function toWireChange(change: StateChange): WireStateChange {
  const hasValue = Object.prototype.hasOwnProperty.call(change, 'value');
  return {
    channel: change.channel,
    revision: change.revision,
    key: change.key,
    type: change.type,
    hasValue,
    ...(hasValue ? { value: change.value } : {}),
  };
}

function toWireView(view: GroupView): WireGroupView {
  return {
    cursor: view.cursor,
    claimed: [...view.claimed],
    memberCount: view.memberCount,
    ...(view.earliestExpiryInMs === undefined
      ? {}
      : { earliestExpiryInMs: view.earliestExpiryInMs }),
  };
}

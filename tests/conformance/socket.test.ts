import { connect } from 'node:net';

import { afterEach, describe, expect, test } from 'vitest';

import type { Identity } from '@eapp/core';
import type { AckContext } from '@eapp/interaction';
import { configureStateChannel } from '@eapp/state';
import type { StateTransportCapabilities } from '@eapp/state';
import {
  FrameDecoder,
  SocketBroker,
  SocketTransport,
  encodeFrame,
} from '@eapp/transport-socket';

/**
 * Cross-process transport conformance.
 *
 * These run the broker and the clients over real TCP sockets in one process, which
 * is enough to exercise everything the wire changes: framing, correlation,
 * long polls, and the parts of the data model JSON cannot represent.
 *
 * The multi-process case — three operating-system processes, two of them
 * competing for one ConsumerGroup — is `examples/cross-process/`. What is checked
 * there and not here is that the participants really are separate processes.
 */

const ACTOR: Identity = { domain: 'eapp.test', id: 'writer', instance: 'writer-1' };

const open: SocketBroker[] = [];
const clients: SocketTransport[] = [];

async function broker(options: Parameters<typeof SocketBroker.listen>[0] = {}): Promise<SocketBroker> {
  const instance = await SocketBroker.listen(options);
  open.push(instance);
  return instance;
}

async function client(instance: SocketBroker): Promise<SocketTransport> {
  const transport = await SocketTransport.connect({ port: instance.port });
  clients.push(transport);
  return transport;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(open.splice(0).map((b) => b.close().catch(() => undefined)));
});

describe('socket transport: transport semantics', () => {
  test('a client adopts the broker identity, so cursors are usable locally', async () => {
    const server = await broker({ id: 'shared' });
    const transport = await client(server);

    // The broker owns allocation, so cursors carry ITS id. A client that kept its
    // own would produce cursors no peer could verify against.
    expect(transport.id).toBe('shared');
    const cursor = await transport.send('ch', { n: 1 });
    expect(cursor.startsWith('shared!')).toBe(true);

    // compareRevision is synchronous in the interface, so it cannot be a round
    // trip. It works because the origin is encoded in the prefix.
    const later = await transport.nextRevision('ch');
    expect(transport.compareRevision(cursor, later)).toBeLessThan(0);
    expect(transport.compareRevision(later, later)).toBe(0);
  });

  test('two clients share one log', async () => {
    const server = await broker();
    const a = await client(server);
    const b = await client(server);

    const first = await a.send('orders', { n: 1 });
    await b.send('orders', { n: 2 });

    // Reading from a position another process allocated is the whole point.
    const seenByA = await a.readAfter('orders', undefined, { all: true });
    const seenByB = await b.readAfter('orders', undefined, { all: true });
    expect(seenByA.map((m) => m.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(seenByB).toEqual(seenByA);
    expect(seenByA[0]?.cursor).toBe(first);

    // TR-5 is still strict-after, across the boundary.
    expect(await a.readAfter('orders', first, { all: true })).toHaveLength(1);
  });

  test('the pattern filter is applied by the broker, not the client', async () => {
    const server = await broker();
    const transport = await client(server);
    await transport.send('ch', { type: 'a', n: 1 });
    await transport.send('ch', { type: 'b', n: 2 });

    expect(await transport.readAfter('ch', undefined, { type: 'a' })).toHaveLength(1);
    expect(await transport.readAfter('ch', undefined, { all: true })).toHaveLength(2);
  });

  test('waitForChange wakes on a write from another connection', async () => {
    const server = await broker();
    const a = await client(server);
    const b = await client(server);

    const start = await a.resolveAnchor('ch', 'latest');
    let woken = false;
    const waiting = a.waitForChange('ch', start).then(() => {
      woken = true;
    });

    // Give the long poll time to reach the broker before provoking it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(woken).toBe(false);

    await b.send('ch', { n: 1 });
    await waiting;
    expect(woken).toBe(true);

    const after = await a.readAfter('ch', start, { all: true });
    expect(after.map((m) => m.payload)).toEqual([{ n: 1 }]);
  });

  test('aborting a long poll releases it on the broker', async () => {
    const server = await broker();
    const transport = await client(server);
    const start = await transport.resolveAnchor('ch', 'latest');

    const controller = new AbortController();
    const waiting = transport.waitForChange('ch', start, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.heldWaiters).toBe(1);

    controller.abort();
    await waiting;
    // The broker must not keep parking a waiter nobody is listening for.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.heldWaiters).toBe(0);
  });

  test('close() refuses further writes rather than silently succeeding', async () => {
    const server = await broker();
    const transport = await client(server);
    await transport.close();
    expect(transport.isClosed).toBe(true);
    await expect(transport.send('ch', { n: 1 })).rejects.toThrow('EAPP_UNSUPPORTED');
  });
});

describe('socket transport: protocol errors survive the wire', () => {
  test('an error crosses with its code, its message and its retryability', async () => {
    const server = await broker();
    const transport = await client(server);
    await transport.setStateWithCAS('ch', { key: 'k', value: 1, expectedRevision: null }, ACTOR);

    let raised: unknown;
    try {
      await transport.setStateWithCAS('ch', { key: 'k', value: 2, expectedRevision: null }, ACTOR);
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(Error);
    const error = raised as { code: string; retryable: boolean; message: string };
    expect(error.code).toBe('EAPP_REVISION_CONFLICT');
    // The code is the thing the spec fixes; a boundary that loses it makes every
    // error-handling branch on the far side unreachable.
    expect(error.retryable).toBe(true);
    // D-4 renders the message as "${code}: ${detail}". Re-serialising that
    // rendered string as the detail would double the prefix.
    expect(error.message.match(/EAPP_REVISION_CONFLICT/g)).toHaveLength(1);
  });

  test('a non-EappError failure on the broker side arrives as EAPP_INTERNAL', async () => {
    const server = await broker();
    const transport = await client(server);
    // `writeStateWithRevision` with a revision that does not advance head.
    await expect(
      transport.writeStateWithRevision('ch', 'k', 1, false, 'nope!0000000001', ACTOR),
    ).rejects.toThrow('EAPP_CURSOR_INVALID');
  });

  test('a cursor issued by another broker is rejected without a round trip', async () => {
    const first = await broker({ id: 'one' });
    const second = await broker({ id: 'two' });
    const onFirst = await client(first);
    const transport = await client(second);
    const foreign = await onFirst.send('ch', { n: 1 });

    // REV-8 / CR-5: a position only means something inside the transport that
    // issued it. Silently accepting one reads the wrong place, or nothing.
    await expect(transport.readAfter('ch', foreign, { all: true })).rejects.toThrow(
      'EAPP_CURSOR_INVALID',
    );
    expect(() => transport.compareRevision(foreign, foreign)).toThrow('EAPP_CURSOR_INVALID');
  });

  test('an unknown operation is refused, not ignored', async () => {
    const server = await broker();
    // A raw socket, because the typed client cannot express an operation the
    // protocol does not have — and "what a mismatched peer sees" is exactly what
    // is being checked here.
    const raw = connect({ port: server.port, host: '127.0.0.1' });
    await new Promise<void>((resolve) => raw.once('connect', () => resolve()));

    const frames = new FrameDecoder();
    const replies: Array<{ id: number; ok: boolean; error?: { code: string } }> = [];
    raw.on('data', (chunk: Buffer) => {
      for (const frame of frames.push(chunk.toString('utf8'))) {
        if ('ok' in frame) replies.push(frame as never);
      }
    });

    // Vaporising the request instead would leave the caller suspended on a reply
    // that is never coming.
    raw.write(encodeFrame({ id: 1, op: 'no-such-operation' } as never));
    raw.write(encodeFrame({ id: 2, op: 'hello' } as never));

    const deadline = Date.now() + 2000;
    while (replies.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    raw.destroy();

    expect(replies).toHaveLength(2);
    const refused = replies.find((r) => r.id === 1);
    expect(refused?.ok).toBe(false);
    expect(refused?.error?.code).toBe('EAPP_UNSUPPORTED');
    // ...and the connection is still usable afterwards: one bad frame is not a
    // reason to drop a peer that is otherwise speaking the protocol.
    expect(replies.find((r) => r.id === 2)?.ok).toBe(true);
  });
});

describe('socket transport: state mode across the wire', () => {
  test('CAS is atomic across connections: exactly one of two writers wins', async () => {
    const server = await broker();
    const a = await client(server);
    const b = await client(server);

    const token = await a.setStateWithCAS('ch', { key: 'stock', value: 0, expectedRevision: null }, ACTOR);

    const attempts = await Promise.allSettled([
      a.setStateWithCAS('ch', { key: 'stock', value: 1, expectedRevision: token }, ACTOR),
      b.setStateWithCAS('ch', { key: 'stock', value: 2, expectedRevision: token }, ACTOR),
    ]);

    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);

    // Exactly one write happened, so no update was silently lost.
    const cell = await b.getState('ch', 'stock');
    expect([1, 2]).toContain(cell?.value);
    expect(cell?.revision).not.toBe(token);
    const changes = await a.readChangesAfter('ch', undefined, { key: 'stock' });
    expect(changes).toHaveLength(2);
  });

  /**
   * The one the wire format exists for.
   *
   * `StateUpdate` decides things by the PRESENCE of a property, not by its value:
   * SU-2 for `value`, SU-9 for `deleted`. JSON cannot carry presence —
   * `JSON.stringify({ value: undefined })` is `{}` and
   * `JSON.stringify({ deleted: true })` keeps the key only by luck of the value
   * being defined. A transport that serialises the update object directly
   * therefore silently changes the message it was asked to deliver.
   *
   * `deleted` is where that becomes visible: losing it turns a delete into a
   * write of `undefined`, and the cell comes back alive.
   */
  test('presence semantics survive the wire: deleted stays deleted, and undefined stays a write', async () => {
    const server = await broker();
    const transport = await client(server);

    // A delete expressed through `set`, which is legal when `value` is absent.
    // If `hasDeleted` were lost in transit this would store `undefined` instead.
    await transport.setStateWithCAS(
      'ch',
      { key: 'tombstone', deleted: true, expectedRevision: null },
      ACTOR,
    );
    const tombstone = await transport.getState('ch', 'tombstone');
    expect(tombstone?.deleted).toBe(true);

    // A write of `undefined` is a real write. The channel validates presence
    // before the wire (SU-2), so this reaching the log at all proves the flag
    // survived the round trip.
    const channel = configureStateChannel(
      { id: 'ch', binding: 'b1', mode: 'state', delivery: 'at-least-once', state: 'ACTIVE' },
      transport,
      { conflictPolicy: 'cas', owner: ACTOR },
    );
    const revision = await channel.set({ key: 'explicit', value: undefined, expectedRevision: null });
    expect(revision).toBeTruthy();
    const cell = await channel.get('explicit');
    expect(cell?.deleted).toBe(false);
    expect(cell?.value).toBeUndefined();

    // The contrast: an update carrying NEITHER `value` nor `deleted` is a
    // different message, and it is invalid (SU-2).
    //
    // Note where the rejection comes from. `setStateWithCAS` on the transport
    // does NOT validate — the reference transports do not either; validation is
    // `StateChannel.set`'s job. Putting the assertion here rather than on the
    // transport is what makes it a statement about the protocol rather than
    // about one implementation.
    await expect(channel.set({ key: 'neither', expectedRevision: null })).rejects.toThrow(
      'EAPP_STATE_VALUE_INVALID',
    );
  });

  test('delete is a first-class primitive across the wire', async () => {
    const server = await broker();
    const transport = await client(server);
    const created = await transport.setStateWithCAS(
      'ch',
      { key: 'k', value: 1, expectedRevision: null },
      ACTOR,
    );

    // v3.2 §6.2: never existed + a revision is a CAS conflict, not a missing key.
    await expect(
      transport.deleteStateWithCAS('ch', 'ghost', created, ACTOR),
    ).rejects.toThrow('EAPP_REVISION_CONFLICT');
    // ...and never existed + null is DEL-4.
    await expect(transport.deleteStateWithCAS('ch', 'ghost', null, ACTOR)).rejects.toThrow(
      'EAPP_STATE_KEY_NOT_FOUND',
    );

    const deleted = await transport.deleteStateWithCAS('ch', 'k', created, ACTOR);
    expect(deleted).toBeTruthy();

    // API-1: a deleted cell still exists and is still returned.
    const cell = await transport.getState('ch', 'k');
    expect(cell?.deleted).toBe(true);

    // DEL-5: deleting it again is a no-op that allocates nothing.
    const again = await transport.deleteStateWithCAS('ch', 'k', deleted, ACTOR);
    expect(again).toBe(deleted);
  });

  test('the broker declares a wider durability boundary than an in-process log', async () => {
    const server = await broker();
    const transport = await client(server);
    const capabilities: StateTransportCapabilities = transport.capabilities;

    // The storage is the same non-persistent map the memory transport uses, but
    // it is reachable from every process on this machine. 'process' would
    // understate that; 'cluster' would overstate it (one broker, no failover).
    expect(capabilities.durabilityBoundary).toBe('machine');
    expect(capabilities.persistent).toBe(false);
    expect(capabilities.stateConsistency).toBe('strong');
  });

  test('retention applies across the wire, and an outdated cursor is refused', async () => {
    const server = await broker({ retention: { kind: 'window', entries: 1 } });
    const transport = await client(server);

    const first = await transport.send('ch', { n: 1 });
    await transport.send('ch', { n: 2 });
    await transport.send('ch', { n: 3 });

    // The retained window holds one entry, so the floor has passed `first`.
    await expect(transport.readAfter('ch', first, { all: true })).rejects.toThrow(
      'EAPP_CURSOR_TOO_OLD',
    );
    expect(await transport.resolveAnchor('ch', 'earliest')).toBeTruthy();
  });

  /**
   * CG-3 across two CONNECTIONS, which is the case that was previously impossible.
   *
   * `ConsumerGroup`'s competing state used to be process-local memory, so two
   * clients on one transport each kept a private claim table: both would be told
   * they held the same position, every message delivered twice, and nothing raised.
   * It now lives on the broker, and this is the assertion that it does.
   *
   * Two `InteractionLayerImpl` instances stand in for two processes; the layers do
   * not share objects, they share a socket.
   */
  test('competing consumption is exclusive across connections', async () => {
    const { InteractionLayerImpl } = await import('@eapp/interaction');

    const server = await broker();
    const t1 = await client(server);
    const t2 = await client(server);
    // An explicit id source, so the two sides provably name the same Channel for
    // the same reason rather than because both counters happened to start at 1.
    const l1 = new InteractionLayerImpl({ transport: t1, nextId: () => 'orders' });
    const l2 = new InteractionLayerImpl({ transport: t2, nextId: () => 'orders' });

    const source = (transport: typeof t1) => ({
      head: () => transport.resolveAnchor('orders', 'latest'),
      earliest: () => transport.resolveAnchor('orders', 'earliest'),
      readAfter: async (cursor: string, ack: (cursor: string) => AckContext) => {
        const messages = await transport.readAfter('orders', cursor, { all: true });
        return messages.map((message) => {
          const context = ack(message.cursor);
          return {
            cursor: message.cursor,
            item: {
              cursor: message.cursor,
              payload: message.payload as { n: number },
              ack: () => context.ack(),
              nack: () => context.nack(),
            },
          };
        });
      },
      waitForChange: (cursor: string, signal: AbortSignal) =>
        transport.waitForChange?.('orders', cursor, signal) ?? Promise.resolve(),
    });

    const channel1 = await l1.createChannel({ binding: 'b1', mode: 'stream' });
    const channel2 = await l2.createChannel({ binding: 'b1', mode: 'stream' });
    await channel1.connect();
    await channel2.connect();
    expect(channel1.id).toBe('orders');
    expect(channel2.id).toBe('orders');

    // Each side opens the group by name. The broker maps both names onto one
    // store, which is what makes them the same group rather than two.
    // `prefetch: 1` on both sides. Without it the first member awake claims the
    // whole visible batch (the default is 16), its peer is left with nothing and
    // blocks — correct, but it makes for a test that cannot observe competition.
    // Across processes this knob is the difference between a pool and one worker.
    const g1 = await l1.openConsumerGroup('orders', { name: 'workers', prefetch: 1 }, source(t1));
    const g2 = await l2.openConsumerGroup('orders', { name: 'workers', prefetch: 1 }, source(t2));
    type Delivered = { cursor: string; payload: { n: number }; ack(): Promise<void> };
    const a = await l1.joinConsumerGroup<Delivered>('orders', 'workers');
    const b = await l2.joinConsumerGroup<Delivered>('orders', 'workers');

    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await t1.send('orders', { n });
    }

    // Interleaved pulls, so both members are demonstrably awake and competing.
    const ia = a[Symbol.asyncIterator]();
    const ib = b[Symbol.asyncIterator]();
    const fromA: number[] = [];
    const fromB: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const first = await ia.next();
      if (!first.done) {
        fromA.push(first.value.payload.n);
        await first.value.ack();
      }
      const second = await ib.next();
      if (!second.done) {
        fromB.push(second.value.payload.n);
        await second.value.ack();
      }
    }

    const all = [...fromA, ...fromB];

    // Nothing was handed to both: this is CG-3, across a socket.
    expect(new Set(all).size).toBe(all.length);
    // ...and nothing was lost between them.
    expect([...all].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Both members actually worked, so this is competition and not one side
    // taking everything while the other sat idle.
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromB.length).toBeGreaterThan(0);

    // The member count comes from the broker, so each side sees both members —
    // which one process could never have reported.
    expect(g1.memberCount).toBe(2);
    expect(g2.memberCount).toBe(2);

    // CG-2 says the group has exactly ONE cursor. §8.2 freezes `cursor` as a
    // synchronous property, so a member can only report the view it last saw: the
    // guarantee is that there is one shared position, not that every read of it is
    // live. Both point into the same log and both have advanced past the start.
    // Asserting byte-equality here would be asserting something §8.2 cannot promise
    // across a socket, and the test would be lying about which part is guaranteed.
    expect(a.cursor.startsWith(`${server.id}!`)).toBe(true);
    expect(b.cursor.startsWith(`${server.id}!`)).toBe(true);

    await a.close();
    await b.close();
    await g1.close();
    await g2.close();
  });

  /**
   * And the refusal still holds where it should: a transport that reaches beyond
   * one process but supplies no shared store cannot back CG-3, so it is refused
   * rather than allowed to be silently wrong.
   */
  test('a transport that reaches wider than its store is refused', async () => {
    const { InteractionLayerImpl } = await import('@eapp/interaction');
    const { MemoryTransport } = await import('@eapp/transport-memory');

    const local = new MemoryTransport('local');
    const wide = local as unknown as { capabilities: { durabilityBoundary: string } };
    // 'machine' rather than 'cluster': the latter is incoherent with
    // `persistent: false` and would be rejected by the coherence check before the
    // question of a group store is ever reached.
    wide.capabilities.durabilityBoundary = 'machine';

    const layer = new InteractionLayerImpl({ transport: local });
    const channel = await layer.createChannel({ binding: 'b1', mode: 'stream' });
    await channel.connect();

    await expect(
      layer.openConsumerGroup(
        channel.id,
        { name: 'workers' },
        {
          head: () => local.resolveAnchor(channel.id, 'latest'),
          earliest: () => local.resolveAnchor(channel.id, 'earliest'),
          readAfter: async () => [],
          waitForChange: (cursor: string, signal: AbortSignal) =>
            local.waitForChange(channel.id, cursor, signal),
        },
      ),
    ).rejects.toThrow('EAPP_UNSUPPORTED');

    await local.close();
  });

  test('a whole runtime runs on it, and the layers above cannot tell', async () => {
    const { EappRuntime } = await import('@eapp/runtime');
    const server = await broker({ id: 'runtime-broker' });
    const transport = await client(server);

    const runtime = EappRuntime.create({ domain: 'eapp.test', transport });
    const provider = runtime.register({
      manifest: {
        identity: { domain: 'eapp.test', id: 'provider', instance: 'provider-1' },
        capabilities: [{ name: 'greet', version: '1.0.0' }],
      },
      handlers: { greet: async (payload) => `Hello, ${String(payload)}!` },
    });
    const consumer = runtime.register({
      manifest: {
        identity: { domain: 'eapp.test', id: 'consumer', instance: 'consumer-1' },
        capabilities: [],
      },
    });
    await runtime.activate(provider);
    await runtime.activate(consumer);

    const reply = await runtime.invoke({
      from: consumer,
      to: provider,
      capability: { name: 'greet', version: '1.0.0' },
      payload: 'wire',
    });
    expect(reply).toBe('Hello, wire!');

    await runtime.shutdown();
  });
});

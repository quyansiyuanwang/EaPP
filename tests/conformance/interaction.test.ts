import { describe, expect, test } from 'vitest';

import type { Identity } from '@eapp/core';
import {
  CorrelationTracker,
  InteractionLayerImpl,
  LeaseManager,
  LocalAck,
  TransportSubscription,
  assertCapability,
  assertDeclared,
  compareCursor,
  defaultDeliveryFor,
  isAnchorLiteral,
  isRequestExpired,
  matchesPattern,
  newCorrelationId,
  validatePattern,
  type BindingSource,
  type ChannelMode,
  type Cursor,
  type CursorAnchor,
  type Transport,
  type TransportCapabilities,
} from '@eapp/interaction';
import { configureStateChannel, type StateUpdateEvent, type StateWatcher } from '@eapp/state';
import { MemoryTransport } from '@eapp/transport-memory';

/**
 * EaPP v3.1.0 Interaction Layer conformance.
 *
 * Every invariant declared in `docs/spec/v3.1.0-interaction.md` §13 is named below.
 */

const OWNER: Identity = { domain: 'e2e', id: 'owner', instance: 'owner-1' };

function makeTransport(): MemoryTransport {
  return new MemoryTransport();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
}

function drain(
  watcher: StateWatcher,
  options: { autoAck?: boolean } = {},
): { items: StateUpdateEvent[]; stop: () => Promise<void> } {
  const items: StateUpdateEvent[] = [];
  const task = (async () => {
    for await (const update of watcher) {
      items.push(update);
      if (options.autoAck) await update.ack();
    }
  })().catch(() => undefined);
  return {
    items,
    stop: async () => {
      await watcher.close();
      await task;
    },
  };
}

/** A channel plus the machinery needed to observe it. */
async function makeStateChannel() {
  const transport = makeTransport();
  const interaction = new InteractionLayerImpl({ transport });
  const channel = await interaction.createChannel({ binding: 'b1', mode: 'state' });
  await channel.connect();
  const ch = configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner: OWNER });
  return { transport, interaction, channel, ch };
}

/** A minimal Composition Core stand-in implementing the v3.1 `BindingSource` contract. */
function fakeBindings() {
  const states = new Map<string, 'ACTIVE' | 'DORMANT' | 'CLOSED'>([['b1', 'ACTIVE']]);
  const listeners = new Set<(id: string, s: 'ACTIVE' | 'DORMANT' | 'CLOSED') => void>();
  const source: BindingSource = {
    binding: (id) => (states.has(id) ? { id } : undefined),
    bindingState: (id) => states.get(id) ?? 'CLOSED',
    onBindingStateChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    setState(id: string, state: 'ACTIVE' | 'DORMANT' | 'CLOSED') {
      states.set(id, state);
      for (const listener of listeners) listener(id, state);
    },
    close(id: string) {
      states.set(id, 'CLOSED');
      for (const listener of listeners) listener(id, 'CLOSED');
    },
  };
}

// =============================================================================
// CH — Channel
// =============================================================================
describe('CH: Channel', () => {
  test('CH-1 / CH-2 / CC-1 / CC-6 / CC-7: a Channel belongs to exactly one live Binding', async () => {
    const transport = makeTransport();
    const bindings = fakeBindings();
    const interaction = new InteractionLayerImpl({ transport, bindings: bindings.source });

    const channel = await interaction.createChannel({ binding: 'b1', mode: 'event' });
    expect(channel.binding).toBe('b1'); // CH-1

    await expect(interaction.createChannel({ binding: 'nope', mode: 'event' })).rejects.toThrow(
      'EAPP_BINDING_INVALID',
    );
    bindings.close('b1');
    await expect(interaction.createChannel({ binding: 'b1', mode: 'event' })).rejects.toThrow(
      'EAPP_BINDING_CLOSED',
    );
  });

  test('CC-2 / §8.2: a Channel follows its Binding through DORMANT and back', async () => {
    const transport = makeTransport();
    const bindings = fakeBindings();
    const interaction = new InteractionLayerImpl({ transport, bindings: bindings.source });
    const channel = await interaction.createChannel({ binding: 'b1', mode: 'event' });
    await channel.connect();
    expect(channel.state).toBe('ACTIVE');

    // Binding DORMANT -> Channel DRAINING: stop taking new work, finish what is in flight.
    bindings.setState('b1', 'DORMANT');
    expect(channel.state).toBe<string>('DRAINING');

    // ...and back again when the composition recovers.
    bindings.setState('b1', 'ACTIVE');
    expect(channel.state).toBe<string>('ACTIVE');

    bindings.close('b1');
    expect(channel.state).toBe<string>('CLOSED');
    expect(interaction.channelState(channel.id)).toBe<string>('CLOSED');
  });

  test('CH-3 / CH-4: CLOSED is terminal and close() is idempotent', async () => {
    const transport = makeTransport();
    const interaction = new InteractionLayerImpl({ transport });
    const channel = await interaction.createChannel({ binding: 'b', mode: 'request' });

    await channel.close();
    await channel.close();
    expect(channel.state).toBe('CLOSED');
    await channel.connect().catch(() => undefined);
    expect(channel.state).toBe('CLOSED'); // CH-3
    await expect(channel.connect()).rejects.toThrow('EAPP_CHANNEL_CLOSED');
  });

  test('CH-5 / CH-6 / CC-3: mode and delivery are fixed at creation', async () => {
    const transport = makeTransport();
    const interaction = new InteractionLayerImpl({ transport });
    const channel = await interaction.createChannel({
      binding: 'b',
      mode: 'stream',
      delivery: 'at-least-once',
    });
    const before = { mode: channel.mode, delivery: channel.delivery };
    await channel.connect();
    await channel.drain();
    await channel.close();
    expect({ mode: channel.mode, delivery: channel.delivery }).toEqual(before);
  });

  test('§2.4 lifecycle: OPEN -> ACTIVE -> DRAINING -> CLOSED, with drain from OPEN', async () => {
    const transport = makeTransport();
    const interaction = new InteractionLayerImpl({ transport });
    const channel = await interaction.createChannel({ binding: 'b', mode: 'event' });
    expect(channel.state).toBe('OPEN');
    await channel.connect();
    expect(channel.state).toBe('ACTIVE');
    await channel.drain();
    expect(channel.state).toBe('DRAINING');
    await channel.close();
    expect(channel.state).toBe('CLOSED');
  });
});

// =============================================================================
// DL — delivery
// =============================================================================
describe('DL: delivery guarantees', () => {
  test('DL-1 / DL-2: only two guarantees exist and exactly-once is not one', () => {
    const all: string[] = ['at-most-once', 'at-least-once'];
    expect(all).toHaveLength(2);
    expect(all).not.toContain('exactly-once');
    for (const mode of ['request', 'event', 'stream', 'state'] as ChannelMode[]) {
      expect(all).toContain(defaultDeliveryFor(mode));
    }
  });

  test('DL-3 / DL-4 / CC-4 / CC-5 / DL-6: mode determines the guarantee', async () => {
    const transport = makeTransport();
    const interaction = new InteractionLayerImpl({ transport });

    // CC-4: derived when omitted - stream and state demand at-least-once.
    expect(defaultDeliveryFor('stream')).toBe('at-least-once'); // DL-4
    expect(defaultDeliveryFor('state')).toBe('at-least-once');
    expect(defaultDeliveryFor('event')).toBe('at-most-once'); // DL-3

    // CC-5 / DL-6: the weaker guarantee is refused outright, not silently upgraded.
    await expect(
      interaction.createChannel({ binding: 'b', mode: 'stream', delivery: 'at-most-once' }),
    ).rejects.toThrow('EAPP_DELIVERY_UNSUPPORTED');
    await expect(
      interaction.createChannel({ binding: 'b', mode: 'state', delivery: 'at-most-once' }),
    ).rejects.toThrow('EAPP_DELIVERY_UNSUPPORTED');
  });

  test('DL-5: unacknowledged changes are redelivered, so consumers must be idempotent', async () => {
    const { ch } = await makeStateChannel();
    const watcher = await ch.watch({ all: true }, { cursor: 'earliest' });
    const seen = drain(watcher); // deliberately never acks
    await ch.set({ key: 'k', value: 1, expectedRevision: null });

    await waitFor(() => seen.items.length >= 2, 900);
    expect(seen.items.length).toBeGreaterThanOrEqual(2); // at-least-once, not exactly-once
    expect(seen.items[0]?.revision).toBe(seen.items[1]?.revision);
    await seen.stop();
  });
});

// =============================================================================
// L — Lease
// =============================================================================
describe('L: Lease', () => {
  test('L-1 / L-2: lease ids are unique and one cursor has at most one ACTIVE lease', () => {
    const leases = new LeaseManager();
    const first = leases.claim('c1', 1000);
    const second = leases.claim('c2', 1000);
    expect(first.leaseId).not.toBe(second.leaseId); // L-1
    expect(() => leases.claim('c1', 1000)).toThrow('EAPP_LEASE_CONFLICT'); // L-2
  });

  test('L-3 / L-4: ack and nack are idempotent', async () => {
    const leases = new LeaseManager();
    const acked = leases.claim('c1', 1000);
    await acked.ack();
    await expect(acked.ack()).resolves.toBeUndefined(); // L-3

    const nacked = leases.claim('c2', 1000);
    await nacked.nack();
    await expect(nacked.nack()).resolves.toBeUndefined(); // L-4

    // AK-3 / AK-4 / AK-5 applied to the lease surface.
    await expect(nacked.ack()).rejects.toThrow('EAPP_LEASE_CLOSED');
    const conflicted = leases.claim('c3', 1000);
    await conflicted.ack();
    await expect(conflicted.nack()).rejects.toThrow('EAPP_LEASE_CLOSED');
  });

  test('L-5: renew applies only to an ACTIVE lease', async () => {
    let now = 1000;
    const leases = new LeaseManager({ now: () => now });
    const lease = leases.claim('c1', 500);
    await lease.renew(5000);
    expect(lease.expiresAt).toBe(now + 5000);

    await lease.nack();
    await expect(lease.renew(1000)).rejects.toThrow('EAPP_LEASE_EXPIRED');
  });

  test('L-6 / L-7: expiry frees the cursor and never disturbs live leases', () => {
    let now = 1000;
    const leases = new LeaseManager({ now: () => now });
    const expiring = leases.claim('c1', 100);
    const live = leases.claim('c2', 100000);

    now += 200;
    leases.releaseExpired();

    expect(leases.status('c1')).toBe('EXPIRED');
    const reclaimed = leases.claim('c1', 1000); // L-6
    expect(reclaimed.leaseId).not.toBe(expiring.leaseId);
    expect(leases.status('c2')).toBe('ACTIVE'); // L-7
    expect(leases.active().map((l) => l.cursor).sort()).toEqual(['c1', 'c2']);
    expect(live.expiresAt).toBe(101000);
  });
});

// =============================================================================
// CR — Cursor
// =============================================================================
describe('CR: Cursor', () => {
  test('CR-1: cursors are globally ordered within a channel', async () => {
    const transport = makeTransport();
    const first = await transport.send('room', { type: 'a' });
    const second = await transport.send('room', { type: 'b' });
    expect(compareCursor(second, first)).toBeGreaterThan(0);
    // Fixed-width padding is what makes a plain string comparison a correct ordering.
    expect(first).toHaveLength(second.length);
  });

  test('CR-2 / CR-4 / SUB-9: a cursor is persistable and resumable', async () => {
    const { ch } = await makeStateChannel();
    const first = await ch.set({ key: 'k', value: 1, expectedRevision: null });

    const original = await ch.watch({ all: true }, { cursor: 'earliest' });
    const seen = drain(original, { autoAck: true });
    await waitFor(() => seen.items.length >= 1);
    expect(original.cursor).toBe(first); // SUB-9: resolved before the watcher was returned
    await seen.stop();

    // CR-2: the cursor is a plain value that can be stored and handed back later.
    const stored = original.cursor;
    await ch.set({ key: 'k', value: 2, expectedRevision: first });

    const resumed = await ch.watch({ all: true }, { cursor: stored });
    const replay = drain(resumed, { autoAck: true });
    await waitFor(() => replay.items.length >= 1);
    expect(replay.items[0]?.value).toBe(2); // CR-4: strictly AFTER the stored position
    await replay.stop();
  });

  test('CR-3: receiving never advances the cursor implicitly', async () => {
    const { ch } = await makeStateChannel();
    const watcher = await ch.watch({ all: true }, { cursor: 'earliest' });
    const seen = drain(watcher); // no acks
    const revision = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => seen.items.length >= 1);

    expect(watcher.cursor).not.toBe(revision); // not moved by mere delivery
    await seen.items[0]?.ack();
    expect(watcher.cursor).toBe(revision); // moved by the explicit ack
    await seen.stop();
  });

  test('CR-5: a transport without cursor support reports it explicitly', () => {
    const transport = makeTransport();
    (transport as unknown as { capabilities: TransportCapabilities }).capabilities = {
      ...transport.capabilities,
      supportsCursor: false,
      supportsLease: false,
    };
    expect(() => assertCapability(transport, 'cursor')).toThrow('EAPP_CURSOR_UNSUPPORTED');
    expect(() => assertCapability(transport, 'lease')).toThrow('EAPP_UNSUPPORTED');
  });

  test('§6.2: anchor literals are recognised before concrete cursors', () => {
    expect(isAnchorLiteral('earliest')).toBe(true);
    expect(isAnchorLiteral('latest')).toBe(true);
    expect(isAnchorLiteral('00000000000000000001')).toBe(false);
  });
});

// =============================================================================
// AK — ack / nack
// =============================================================================
describe('AK: ack and nack', () => {
  test('AK-1 / AK-2 / AK-3 / AK-4: idempotence and mutual exclusion', async () => {
    const acked = new LocalAck();
    await acked.ack();
    await expect(acked.ack()).resolves.toBeUndefined(); // AK-1
    await expect(acked.nack()).rejects.toThrow('EAPP_LEASE_CLOSED'); // AK-3

    const nacked = new LocalAck();
    await nacked.nack();
    await expect(nacked.nack()).resolves.toBeUndefined(); // AK-2
    await expect(nacked.ack()).rejects.toThrow('EAPP_LEASE_CLOSED'); // AK-4
  });

  test('AK-5: a terminated AckContext refuses further calls', async () => {
    const context = new LocalAck();
    context.terminate();
    await expect(context.ack()).rejects.toThrow('EAPP_LEASE_CLOSED');
    await expect(context.nack()).rejects.toThrow('EAPP_LEASE_CLOSED');
  });

  test('SUB-8 distinguishes subscription shutdown from termination', async () => {
    const { ch } = await makeStateChannel();
    const watcher = await ch.watch({ all: true }, { cursor: 'earliest' });
    const seen = drain(watcher);
    await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => seen.items.length >= 1);

    const update = seen.items[0]!;
    await watcher.close();
    await expect(update.ack()).resolves.toBeUndefined(); // silent, not a throw
    await expect(update.nack()).resolves.toBeUndefined();
    await seen.stop();
  });
});

// =============================================================================
// SUB — Subscription
// =============================================================================
describe('SUB: Subscription', () => {
  test('SUB-1 / SUB-2 / SUB-3: tied to a channel, independent cursors', async () => {
    const { ch } = await makeStateChannel();
    const a = await ch.watch({ all: true }, { cursor: 'earliest' });
    const b = await ch.watch({ all: true }, { cursor: 'earliest' });
    expect(a.channel).toBe(ch.id); // SUB-1
    expect(a.mode).toBe('exclusive');

    const da = drain(a, { autoAck: true });
    const db = drain(b);
    const revision = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => da.items.length >= 1 && db.items.length >= 1);

    expect(a.cursor).toBe(revision); // SUB-2: independent, and advancing
    expect(b.cursor).not.toBe(revision); // SUB-3: b is unaffected
    await da.stop();
    await db.stop();
  });

  test('SUB-4: group mode requires a group id', async () => {
    const { ch } = await makeStateChannel();
    await expect(ch.watch({ all: true }, { mode: 'group' })).rejects.toThrow(
      'EAPP_SUBSCRIPTION_INVALID',
    );
    await expect(ch.watch({ all: true }, { mode: 'group', group: 'workers' })).resolves.toBeDefined();
  });

  test('SUB-5: suspend stops delivery until resume', async () => {
    const { ch } = await makeStateChannel();
    const watcher = await ch.watch({ all: true }, { cursor: 'earliest' });
    const seen = drain(watcher);
    await watcher.suspend();

    const revision = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await sleep(80);
    expect(seen.items).toHaveLength(0);

    await watcher.resume();
    await waitFor(() => seen.items.length >= 1);
    expect(seen.items[0]?.revision).toBe(revision);
    await seen.stop();
  });

  test('SUB-6 / SUB-7: close is idempotent and ends delivery', async () => {
    const { ch } = await makeStateChannel();
    const watcher = await ch.watch({ all: true }, { cursor: 'earliest' });
    const seen = drain(watcher, { autoAck: true });
    const first = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => seen.items.length >= 1);

    await watcher.close();
    await watcher.close();
    await ch.set({ key: 'k', value: 2, expectedRevision: first });
    await sleep(80);
    expect(seen.items).toHaveLength(1);
    await seen.stop();
  });
});

// =============================================================================
// TR — Transport
// =============================================================================
describe('TR: Transport', () => {
  test('TR-1 / TR-2 / TR-3: a Transport carries no interaction semantics', () => {
    const transport = makeTransport();
    // TR-1: no mode, no delivery guarantee, no cursor policy on the transport itself.
    for (const leaked of ['mode', 'delivery', 'lease', 'cursor']) {
      expect(leaked in transport).toBe(false);
    }
    // TR-2: but it MUST declare its capabilities.
    expect(transport.capabilities).toBeDefined();
    expect(typeof transport.capabilities.persistent).toBe('boolean');
    // TR-3: a declaration that is missing is treated as "cannot", never as "assume yes".
    const undeclared = { id: 'broken' } as unknown as Transport;
    expect(() => assertDeclared(undeclared)).toThrow('EAPP_UNSUPPORTED');
  });

  test('TR-4: using an undeclared feature is refused', () => {
    const transport = makeTransport();
    (transport as unknown as { capabilities: TransportCapabilities }).capabilities = {
      ...transport.capabilities,
      supportsLease: false,
    };
    expect(() => assertCapability(transport, 'lease')).toThrow('EAPP_UNSUPPORTED');
  });

  test('TR-5 / TR-6 / TR-7 / TR-8: read and write semantics', async () => {
    const transport = makeTransport();
    const first = await transport.send('room', { type: 'a' });
    const second = await transport.send('room', { type: 'b' });
    expect(compareCursor(second, first)).toBeGreaterThan(0); // TR-8

    const after = await transport.readAfter('room', first, { all: true });
    expect(after.map((m) => m.cursor)).toEqual([second]); // TR-5: strictly greater

    const everything = await transport.readAfter('room', undefined, { all: true });
    expect(everything.map((m) => m.cursor)).toEqual([first, second]); // TR-6

    const none = await transport.readAfter('room', second, { all: true });
    expect(none).toEqual([]); // TR-7: empty, and returned promptly
  });

  test('§9.1: pattern filtering is applied by the transport', async () => {
    validatePattern({ type: 'job' });
    expect(() => validatePattern({ type: 42 } as never)).toThrow('EAPP_CHANNEL_INVALID');
    expect(() => validatePattern({ all: false } as never)).toThrow('EAPP_CHANNEL_INVALID');
    expect(() => validatePattern({ nope: 1 } as never)).toThrow('EAPP_CHANNEL_INVALID');

    const transport = makeTransport();
    await transport.send('room', { type: 'job' });
    await transport.send('room', { type: 'log' });
    const jobs = await transport.readAfter('room', undefined, { type: 'job' });
    expect(jobs).toHaveLength(1);
    expect(matchesPattern(jobs[0]?.payload, { type: 'job' })).toBe(true);
  });
});

// =============================================================================
// RQ / EV / ST — mode messages (§3)
// =============================================================================

interface DeliveredMessage {
  cursor: Cursor;
  payload: unknown;
  ack(): Promise<void>;
  nack(): Promise<void>;
}

/** A v3.1 Subscription over raw transport messages, used by the EV-* / ST-* tests. */
async function messageSubscription(
  transport: MemoryTransport,
  channelId: string,
  cursor?: CursorAnchor,
): Promise<TransportSubscription<DeliveredMessage>> {
  return TransportSubscription.create<DeliveredMessage>(
    channelId,
    cursor === undefined ? {} : { cursor },
    {
      head: () => transport.resolveAnchor(channelId, 'latest'),
      earliest: async () => '' as Cursor,
      readAfter: async (position, ack) => {
        const messages = await transport.readAfter(channelId, position, { all: true });
        return messages.map((message) => {
          const context = ack(message.cursor);
          return {
            cursor: message.cursor,
            item: {
              cursor: message.cursor,
              payload: message.payload,
              ack: () => context.ack(),
              nack: () => context.nack(),
            },
          };
        });
      },
      waitForChange: (position, signal) => transport.waitForChange(channelId, position, signal),
    },
  );
}

function collect<T>(source: AsyncIterable<T>, autoAck = false) {
  const items: T[] = [];
  const task = (async () => {
    for await (const item of source) {
      items.push(item);
      if (autoAck) await (item as unknown as { ack(): Promise<void> }).ack();
    }
  })().catch(() => undefined);
  return { items, settle: async () => task };
}

describe('RQ: request mode', () => {
  test('RQ-1: every request carries a unique correlationId', () => {
    const tracker = new CorrelationTracker();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = newCorrelationId('t');
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      tracker.begin(id);
    }
    expect(ids.size).toBe(200);
    // Re-using an id that is still in flight is refused rather than silently aliasing.
    const duplicate = newCorrelationId('dup');
    tracker.begin(duplicate);
    expect(() => tracker.begin(duplicate)).toThrow('EAPP_INTERNAL');
  });

  test('RQ-2 / RQ-3: a request maps to at most one response, quoting its own id', () => {
    const tracker = new CorrelationTracker();
    const requestId = newCorrelationId('r');
    tracker.begin(requestId);

    // RQ-3: a response for a different request settles nothing.
    expect(tracker.settle({ correlationId: 'someone-else', ok: true })).toBe(false);
    expect(tracker.has(requestId)).toBe(true);

    // RQ-2: the first matching response settles it...
    expect(tracker.settle({ correlationId: requestId, ok: true, result: 1 })).toBe(true);
    // ...and a second one is dropped instead of resolving the call twice.
    expect(tracker.settle({ correlationId: requestId, ok: true, result: 2 })).toBe(false);
    expect(tracker.size).toBe(0);
  });

  test('RQ-4: a request past its deadline is treated as timed out', () => {
    const fresh = { correlationId: 'a', operation: 'op', payload: null, deadline: 2000 };
    const stale = { correlationId: 'b', operation: 'op', payload: null, deadline: 1000 };
    expect(isRequestExpired(fresh, 1500)).toBe(false);
    expect(isRequestExpired(stale, 1500)).toBe(true); // MUST NOT be started
    // An absent deadline never expires.
    expect(isRequestExpired({ correlationId: 'c', operation: 'op', payload: null }, 1e12)).toBe(
      false,
    );
  });
});

describe('EV: event mode', () => {
  test('EV-1: an event expects no response', async () => {
    const transport = makeTransport();
    // The frozen EventMessage has a topic and no correlationId: there is nothing to reply to.
    const event = { topic: 'log', payload: { line: 'x' } };
    expect('correlationId' in event).toBe(false);

    const cursor = await transport.send('room', event);
    expect(typeof cursor).toBe('string'); // sending yields a position, never a reply
  });

  test('EV-2: an event MAY be delivered zero times', async () => {
    const transport = makeTransport();
    await transport.send('room', { topic: 'log', payload: 1 });

    // A consumer that joins at "latest" misses the past event entirely.
    const subscription = await messageSubscription(transport, 'room', 'latest');
    const seen = collect(subscription);
    await sleep(80);
    expect(seen.items).toHaveLength(0);
    await subscription.close();
    await seen.settle();
  });

  test('EV-3: an event MAY be delivered multiple times', async () => {
    const transport = makeTransport();
    await transport.send('room', { topic: 'log', payload: 1 });

    const subscription = await messageSubscription(transport, 'room', 'earliest');
    const seen = collect(subscription); // never acks
    await waitFor(() => seen.items.length >= 2, 900);
    expect(seen.items.length).toBeGreaterThanOrEqual(2);
    await subscription.close();
    await seen.settle();
  });
});

describe('ST: stream mode', () => {
  test('ST-1: message cursors increase globally within a channel', async () => {
    const transport = makeTransport();
    const first = await transport.send('stream', { n: 1 });
    const second = await transport.send('stream', { n: 2 });
    const third = await transport.send('stream', { n: 3 });
    expect(compareCursor(second, first)).toBeGreaterThan(0);
    expect(compareCursor(third, second)).toBeGreaterThan(0);
  });

  test('ST-2 / ST-3 / ST-4: resume by cursor, acked never returns, unacked may', async () => {
    const transport = makeTransport();
    await transport.send('stream', { n: 1 });
    await transport.send('stream', { n: 2 });

    // ST-3: ack both, remember the position, and the same position replays nothing.
    const first = await messageSubscription(transport, 'stream', 'earliest');
    const consumed = collect<DeliveredMessage>(first, true);
    await waitFor(() => consumed.items.length >= 2);
    const position = first.exportCursor();
    await first.close();
    await consumed.settle();

    // ST-2: a consumer resuming from that cursor starts after it, not before.
    await transport.send('stream', { n: 3 });
    const resumed = await messageSubscription(transport, 'stream', position);
    const replay = collect<DeliveredMessage>(resumed, true);
    await waitFor(() => replay.items.length >= 1);
    expect(replay.items.map((m) => (m.payload as { n: number }).n)).toEqual([3]);
    await resumed.close();
    await replay.settle();

    // ST-4: a consumer that never acked may see the same message again. The first pass
    // returns the whole log from the unmoved cursor; because nothing was acknowledged the
    // cursor stays put and the next pass replays the same sequence from the start.
    const unacked = await messageSubscription(transport, 'stream', 'earliest');
    const loose = collect(unacked);
    await waitFor(() => loose.items.length >= 4, 1200);
    const delivered = loose.items.slice(0, 4).map((m) => (m.payload as { n: number }).n);
    expect(delivered.slice(0, 3)).toEqual([1, 2, 3]);
    expect(delivered[3]).toBe(delivered[0]); // redelivery of the unacknowledged message
    await unacked.close();
    await loose.settle();
  });
});
describe('CC: Composition boundary', () => {
  test('CC-3 / CC-8 / CC-9: creation, state and multiplicity', async () => {
    const transport = makeTransport();
    const interaction = new InteractionLayerImpl({ transport });

    const request = await interaction.createChannel({ binding: 'b1', mode: 'request' });
    const stream = await interaction.createChannel({ binding: 'b1', mode: 'stream' });
    expect(request.id).not.toBe(stream.id); // CC-9: one Binding may derive several Channels
    expect(request.state).toBe('OPEN'); // CC-8
    await request.connect();
    expect(request.state).toBe('ACTIVE');
  });

  test('§2.2: ChannelRef carries only id and binding', async () => {
    const transport = makeTransport();
    const interaction = new InteractionLayerImpl({ transport });
    const channel = await interaction.createChannel({ binding: 'b1', mode: 'event' });
    expect(Object.keys(interaction.channelRef(channel.id)).sort()).toEqual(['binding', 'id']);
    expect(() => interaction.channelRef('missing')).toThrow('EAPP_CHANNEL_INVALID');
    expect(() => interaction.channelState('missing')).toThrow('EAPP_CHANNEL_INVALID');
  });

  test('§9: a Channel refuses a mode it cannot have', async () => {
    const transport = makeTransport();
    const interaction = new InteractionLayerImpl({ transport });
    await expect(
      interaction.createChannel({ binding: 'b', mode: 'nonsense' as ChannelMode }),
    ).rejects.toThrow('EAPP_MODE_INVALID');
  });
});

import { describe, expect, test } from 'vitest';

import type { Identity } from '@eapp/core';
import {
  InteractionLayerImpl,
  type ChannelState,
  type SubscriptionMode,
} from '@eapp/interaction';
import {
  configureStateChannel,
  type StateUpdateEvent,
  type StateWatcher,
} from '@eapp/state';
import { MemoryTransport } from '@eapp/transport-memory';

/**
 * EaPP v3.2.0 State Mode conformance.
 *
 * Every invariant declared in `docs/spec/v3.2.0-state.md` §14 is named by at least one
 * test below; `pnpm check:invariants` fails the build if that stops being true. Tests are
 * grouped where several invariants share one meaningful scenario, but each group names
 * all of the invariants it actually exercises.
 */

const OWNER: Identity = { domain: 'e2e', id: 'owner', instance: 'owner-1' };

async function makeChannel(delivery: 'at-most-once' | 'at-least-once' = 'at-least-once') {
  const transport = new MemoryTransport();
  const interaction = new InteractionLayerImpl({ transport });
  const channel = await interaction.createChannel({ binding: 'b1', mode: 'state', delivery });
  await channel.connect();
  const ch = configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner: OWNER });
  return { transport, interaction, channel, ch };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start draining a watcher into an array so tests can assert on delivered updates.
 *
 * `autoAck` acknowledges each item as it arrives, which makes the delivered sequence
 * exactly-once. Without it the at-least-once contract re-delivers anything the consumer
 * has not acknowledged, so the array can legitimately contain repeats - which is correct
 * behaviour, just inconvenient to assert against.
 */
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

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
}

/**
 * Patch a live transport's capability declaration.
 *
 * Deliberately NOT `Object.create(transport)`: a plain prototype clone does not own the
 * class's private fields, so any method it inherited would throw on the first `#field`
 * access. Mutating the real instance keeps the object authentic and only lies about the
 * one capability under test.
 */
function cripple(
  transport: MemoryTransport,
  patch: Partial<MemoryTransport['capabilities']>,
): MemoryTransport {
  (transport as unknown as { capabilities: unknown }).capabilities = {
    ...transport.capabilities,
    ...patch,
  };
  return transport;
}

// =============================================================================
// SC — StateCell
// =============================================================================
describe('SC: StateCell', () => {
  test('SC-1: key MUST NOT be empty', async () => {
    const { ch } = await makeChannel();
    await expect(ch.set({ key: '', value: 1, expectedRevision: null })).rejects.toThrow(
      'EAPP_STATE_KEY_INVALID',
    );
    await expect(ch.get('')).rejects.toThrow('EAPP_STATE_KEY_INVALID');
  });

  test('SC-2 / REV-1 / REV-2 / REV-3: revision is monotonic and transport-assigned', async () => {
    const { transport, ch } = await makeChannel();
    const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    const r2 = await ch.set({ key: 'k', value: 2, expectedRevision: r1 });
    const r3 = await ch.set({ key: 'k', value: 3, expectedRevision: r2 });

    expect(transport.compareRevision(r2, r1)).toBeGreaterThan(0);
    expect(transport.compareRevision(r3, r2)).toBeGreaterThan(0);
    // REV-3: the consumer never invents a revision; the transport's identity is embedded.
    expect(r1.startsWith(transport.id)).toBe(true);
  });

  test('SC-3 / DEL-6: delete preserves the counter and a later set clears the flag', async () => {
    const { transport, ch } = await makeChannel();
    const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    const r2 = await ch.delete('k', r1);
    const deleted = await ch.get('k');
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.revision).toBe(r2);
    expect(transport.compareRevision(r2, r1)).toBeGreaterThan(0);

    const r3 = await ch.set({ key: 'k', value: 3, expectedRevision: r2 });
    const revived = await ch.get('k');
    expect(revived?.deleted).toBe(false);
    expect(revived?.value).toBe(3);
    expect(transport.compareRevision(r3, r2)).toBeGreaterThan(0); // DEL-6: no reset
  });

  test('SC-4: a stored value round-trips through JSON, and a deleted cell has none', async () => {
    const { ch } = await makeChannel();
    await ch.set({ key: 'k', value: { a: [1, 2], b: 'x' }, expectedRevision: null });
    const cell = await ch.get('k');
    expect(JSON.parse(JSON.stringify(cell?.value))).toEqual({ a: [1, 2], b: 'x' });

    const r = await ch.set({ key: 'd', value: 1, expectedRevision: null });
    await ch.delete('d', r);
    expect((await ch.get('d'))?.value).toBeUndefined();
  });

  test('SC-5: updatedBy carries a real identity, taken from actor or channel owner', async () => {
    const { ch } = await makeChannel();
    await ch.set({ key: 'k', value: 1, expectedRevision: null });
    expect((await ch.get('k'))?.updatedBy).toEqual(OWNER);

    const actor: Identity = { domain: 'e2e', id: 'writer', instance: 'writer-9' };
    const r = await ch.set({ key: 'k', value: 2, expectedRevision: (await ch.get('k'))!.revision, actor });
    const cell = await ch.get('k');
    expect(cell?.updatedBy).toEqual(actor);
    expect(cell?.revision).toBe(r);
  });

  test('SC-6 / API-1 / API-2: get and list include logically-deleted cells', async () => {
    const { ch } = await makeChannel();
    const r1 = await ch.set({ key: 'a', value: 1, expectedRevision: null });
    await ch.set({ key: 'b', value: 2, expectedRevision: null });
    await ch.delete('a', r1);

    const a = await ch.get('a');
    expect(a).not.toBeNull(); // r2 could have returned null here, making DEL-5 unreachable
    expect(a?.deleted).toBe(true);
    expect(await ch.get('never')).toBeNull();

    const listed = await ch.list({ all: true });
    expect(listed.map((c) => c.key)).toEqual(['a', 'b']);
    expect(listed[0]?.deleted).toBe(true);
  });
});

// =============================================================================
// REV — revision vs cursor
// =============================================================================
describe('REV: Revision vs Cursor', () => {
  test('REV-4: revision never rolls back within a transport', async () => {
    const { transport, ch } = await makeChannel();
    // The first write of a key needs `null` ("never existed"); afterwards the CAS token
    // is the previous revision.
    let previous: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const current = await ch.set({ key: 'k', value: i, expectedRevision: previous });
      expect(transport.compareRevision(current, await transport.head(ch.id))).toBe(0);
      if (previous !== null) expect(transport.compareRevision(current, previous)).toBeGreaterThan(0);
      previous = current;
    }
  });

  test('REV-5: revision is opaque to consumers', async () => {
    const { ch } = await makeChannel();
    const revision = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    expect(typeof revision).toBe('string');
    // Nothing in the public surface promises a parsable shape.
    expect(revision.length).toBeGreaterThan(0);
  });

  test('REV-6: a v3.1-mode channel cannot be reinterpreted as state', async () => {
    const transport = new MemoryTransport();
    const interaction = new InteractionLayerImpl({ transport });
    const stream = await interaction.createChannel({ binding: 'b9', mode: 'stream' });
    expect(() =>
      configureStateChannel(stream, transport, { conflictPolicy: 'cas', owner: OWNER }),
    ).toThrow('EAPP_MODE_INVALID');
    // And a plain Channel exposes none of the state affordances (IX-3).
    expect('set' in stream).toBe(false);
    expect('get' in stream).toBe(false);
  });

  test('REV-7: revision MAY be used as a cursor in State Mode', async () => {
    const { ch } = await makeChannel();
    const watcher = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
    const seen = drain(watcher);
    const revision = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => seen.items.length >= 1);

    expect(seen.items[0]?.revision).toBe(revision);
    // Receiving does not move the position; acknowledging does (v3.1 CR-1/CR-3).
    await seen.items[0]?.ack();
    expect(watcher.cursor).toBe(revision); // the revision IS a usable cursor
    await seen.stop();

    // Resuming from that same revision sees nothing further - i.e. it really is a position.
    const resumed = await ch.watch({ key: 'k' }, { cursor: revision });
    const again = drain(resumed);
    await sleep(80);
    expect(again.items).toHaveLength(0);
    await again.stop();
  });

  test('REV-8: revisions are not comparable across transports', async () => {
    const a = new MemoryTransport();
    const b = new MemoryTransport();
    const { ch } = await makeChannel();
    const revisionA = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    const revisionB = await b.nextRevision('ch-x');

    expect(() => a.compareRevision(revisionA, revisionB)).toThrow('EAPP_REVISION_INVALID');
    expect(() => b.compareRevision(revisionA, revisionB)).toThrow('EAPP_REVISION_INVALID');
  });
});

// =============================================================================
// SU — StateUpdate / CAS
// =============================================================================
describe('SU: StateUpdate and CAS', () => {
  test('SU-1 / SU-2 / SU-3 / SU-9: field validation', async () => {
    const { ch } = await makeChannel();
    await expect(ch.set({ key: '', value: 1, expectedRevision: null })).rejects.toThrow(
      'EAPP_STATE_KEY_INVALID',
    );
    await expect(ch.set({ key: 'k', expectedRevision: null })).rejects.toThrow(
      'EAPP_STATE_VALUE_INVALID',
    );
    await expect(
      ch.set({ key: 'k', value: 1, deleted: true, expectedRevision: null }),
    ).rejects.toThrow('EAPP_STATE_VALUE_INVALID');
    await expect(
      ch.set({ key: 'k', value: 1, deleted: false, expectedRevision: null }),
    ).rejects.toThrow('EAPP_STATE_VALUE_INVALID');
  });

  test('SU-2: an explicit undefined value is a legitimate write', async () => {
    const { ch } = await makeChannel();
    const r = await ch.set({ key: 'k', value: undefined, expectedRevision: null });
    const cell = await ch.get('k');
    expect(cell?.revision).toBe(r);
    expect(cell?.value).toBeUndefined();
    expect(cell?.deleted).toBe(false);
  });

  test('SU-4 / SU-5 / CF-2: CAS failure reports a conflict and changes nothing', async () => {
    const { ch } = await makeChannel();
    const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await expect(ch.set({ key: 'k', value: 2, expectedRevision: 'not-the-revision' })).rejects.toThrow(
      'EAPP_REVISION_INVALID',
    );
    await ch.set({ key: 'k', value: 2, expectedRevision: r1 });
    const before = await ch.get('k');
    await expect(ch.set({ key: 'k', value: 3, expectedRevision: r1 })).rejects.toThrow(
      'EAPP_REVISION_CONFLICT',
    );
    const after = await ch.get('k');
    expect(after?.revision).toBe(before?.revision);
    expect(after?.value).toBe(2);
  });

  test('SU-6 / SNAP-7: the only public unconditional-write path is restore', async () => {
    const { ch } = await makeChannel();
    // Every public mutation demands an expectedRevision; there is no "just write it".
    await expect(ch.set({ key: 'k', value: 1 } as never)).rejects.toThrow('EAPP_REVISION_INVALID');
    // The transport's revision-pinned write refuses to move the log backwards (SNAP-4).
    const { transport } = await makeChannel();
    await expect(
      transport.writeStateWithRevision(ch.id, 'k', 1, false, `mem-0!0000000000000000`, OWNER),
    ).rejects.toThrow('EAPP_REVISION_INVALID');
  });

  test('SU-7 / TS-6: CAS is atomic under concurrency', async () => {
    const { ch } = await makeChannel();
    const r1 = await ch.set({ key: 'k', value: 0, expectedRevision: null });

    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) =>
        ch.set({ key: 'k', value: i, expectedRevision: r1 }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(99);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason.code).toBe('EAPP_REVISION_CONFLICT');
    }
  });

  test('SU-8 / §5.2: null means "never existed", not "not currently present"', async () => {
    const { ch } = await makeChannel();
    await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await expect(ch.set({ key: 'k', value: 2, expectedRevision: null })).rejects.toThrow(
      'EAPP_REVISION_CONFLICT',
    );

    // After a logical delete the key still exists, so `null` cannot resurrect it.
    const r = (await ch.get('k'))!.revision;
    await ch.delete('k', r);
    await expect(ch.set({ key: 'k', value: 3, expectedRevision: null })).rejects.toThrow(
      'EAPP_REVISION_CONFLICT',
    );
  });
});

// =============================================================================
// DEL — delete
// =============================================================================
describe('DEL: delete', () => {
  test('DEL-1 / DEL-2 / DEL-3 / SW-8: delete is a CAS that produces an observable deleted change', async () => {
    const { ch } = await makeChannel();
    const watcher = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
    const seen = drain(watcher, { autoAck: true });

    const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    const r2 = await ch.delete('k', r1);
    await waitFor(() => seen.items.length >= 2);

    expect(seen.items).toHaveLength(2);
    expect(seen.items[0]?.type).toBe('set');
    expect(seen.items[1]?.type).toBe('deleted');
    expect(seen.items[1]?.revision).toBe(r2);
    expect(seen.items[1]?.value).toBeUndefined();
    await seen.stop();
  });

  test('DEL-4: deleting a never-existing key with null reports KEY_NOT_FOUND', async () => {
    const { ch } = await makeChannel();
    await expect(ch.delete('nope', null)).rejects.toThrow('EAPP_STATE_KEY_NOT_FOUND');
    // Same situation with a revision supplied is a CONFLICT, not "not found": the error
    // depends on the shape of expectedRevision. The r2 draft stated both at once.
    await expect(ch.delete('nope', 'whatever')).rejects.toThrow('EAPP_REVISION_CONFLICT');
  });

  test('DEL-5: deleting an already-deleted key is a true no-op', async () => {
    const { transport, ch } = await makeChannel();
    const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    const r2 = await ch.delete('k', r1);

    const headBefore = await transport.head(ch.id);
    const returned = await ch.delete('k', r2); // must not throw
    const headAfter = await transport.head(ch.id);

    expect(returned).toBe(r2); // return value is the key's current revision
    expect(headAfter).toBe(headBefore); // no new revision was allocated
    const changes = await transport.readChangesAfter(ch.id, undefined, { all: true });
    expect(changes.filter((c) => c.type === 'deleted')).toHaveLength(1); // no second event
  });

  test('DEL: the full §6.2 edge-case table', async () => {
    const { ch } = await makeChannel();
    // never existed + Revision -> conflict (it is not "not found"; the shape of
    // expectedRevision decides which error applies)
    await expect(ch.delete('x', 'z')).rejects.toThrow('EAPP_REVISION_CONFLICT');
    // exists, live + null -> conflict
    const r = await ch.set({ key: 'x', value: 1, expectedRevision: null });
    await expect(ch.delete('x', null)).rejects.toThrow('EAPP_REVISION_CONFLICT');
    // exists, live + matching -> success
    const r2 = await ch.delete('x', r);
    expect(r2).not.toBe(r);
    // already deleted + null -> conflict
    await expect(ch.delete('x', null)).rejects.toThrow('EAPP_REVISION_CONFLICT');
    // already deleted + matching -> no-op success
    await expect(ch.delete('x', r2)).resolves.toBe(r2);
    // already deleted + mismatched -> conflict
    await expect(ch.delete('x', r)).rejects.toThrow('EAPP_REVISION_CONFLICT');
  });
});

// =============================================================================
// SW — StateWatcher
// =============================================================================
describe('SW: StateWatcher', () => {
  test('SW-1 / SW-2 / SW-3 / SUB-9 / API-5: watch returns a v3.1-compatible Subscription', async () => {
    const { ch } = await makeChannel();
    const watcher = await ch.watch({ key: 'k' });
    expect(watcher.kind).toBe('state');
    expect(watcher.cursor).toBeDefined(); // SUB-9: resolved eagerly, never undefined
    expect(typeof watcher.suspend).toBe('function');
    expect(typeof watcher.resume).toBe('function');
    expect(typeof watcher.close).toBe('function');
    expect(watcher.channel).toBe(ch.id);
    await watcher.close();
  });

  test('SW-3: the subscription mode is not overwritten with "state"', async () => {
    const { ch } = await makeChannel();
    const exclusive = await ch.watch({ key: 'k' }, { mode: 'exclusive' });
    expect(exclusive.mode).toBe<SubscriptionMode>('exclusive');
    await exclusive.close();
  });

  test('SW-4 / SW-5: watchers hold independent cursors and do not interfere', async () => {
    const { ch } = await makeChannel();
    const a = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
    const b = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
    const da = drain(a);
    const db = drain(b);

    const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => da.items.length >= 1 && db.items.length >= 1);

    // CR-1: delivery alone never moves the position; only an ack does.
    expect(a.cursor).not.toBe(r1);
    await da.items[0]?.ack();
    expect(a.cursor).toBe(r1);
    // ...and acking on one watcher leaves the other exactly where it was (SW-5).
    expect(b.cursor).not.toBe(r1);

    await ch.set({ key: 'k', value: 2, expectedRevision: r1 });
    await waitFor(() => da.items.length >= 2 && db.items.length >= 2);
    expect(db.items).toHaveLength(2); // b saw both changes despite a's ack

    await da.stop();
    await db.stop();
  });

  test('SW-6 / SW-10 / IX-2: the event implements the full v3.1 AckContext', async () => {
    const { ch } = await makeChannel();
    const watcher = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
    const seen = drain(watcher);
    await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => seen.items.length >= 1);

    const update = seen.items[0]!;
    expect(update.ack.length).toBe(0); // no parameters
    expect(update.nack.length).toBe(0); // AK-3/AK-4 are only meaningful with both
    expect(typeof update.nack).toBe('function');
    await update.ack();
    await seen.stop();
  });

  test('SW-7: ack does not modify the cell', async () => {
    const { ch } = await makeChannel();
    const watcher = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
    const seen = drain(watcher);
    await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => seen.items.length >= 1);

    const before = await ch.get('k');
    await seen.items[0]?.ack();
    const after = await ch.get('k');
    expect(after?.revision).toBe(before?.revision);
    expect(after?.value).toBe(before?.value);
    await seen.stop();
  });

  test('SW-9: the default initial position is "latest"', async () => {
    const { ch } = await makeChannel();
    await ch.set({ key: 'k', value: 1, expectedRevision: null });
    const watcher = await ch.watch({ key: 'k' }); // no cursor option
    const seen = drain(watcher);
    await sleep(80);
    expect(seen.items).toHaveLength(0); // history is not replayed

    await ch.set({ key: 'k', value: 2, expectedRevision: (await ch.get('k'))!.revision });
    await waitFor(() => seen.items.length >= 1);
    expect(seen.items[0]?.value).toBe(2);
    await seen.stop();
  });

  test('SW-11 / SW-12 / SUB-7 / SUB-8: close is idempotent and ack after close is a no-op', async () => {
    const { ch } = await makeChannel();
    const watcher = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
    const seen = drain(watcher);
    await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => seen.items.length >= 1);

    const update = seen.items[0]!;
    await watcher.close();
    await watcher.close(); // idempotent
    await expect(update.ack()).resolves.toBeUndefined(); // must not throw
    await seen.stop();

    await ch.set({ key: 'k', value: 2, expectedRevision: (await ch.get('k'))!.revision });
    await sleep(60);
    expect(seen.items).toHaveLength(1); // nothing delivered after close
  });

  test('SUB-5 / SUB-6: suspend stops delivery and resume continues from the cursor', async () => {
    const { ch } = await makeChannel();
    const watcher = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
    const seen = drain(watcher);
    await watcher.suspend();

    const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await sleep(60);
    expect(seen.items).toHaveLength(0);

    await watcher.resume();
    await waitFor(() => seen.items.length >= 1);
    expect(seen.items[0]?.revision).toBe(r1);
    await seen.stop();
  });

  test('nack does not advance the cursor, so the change is re-delivered', async () => {
    const { ch } = await makeChannel();
    const watcher = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
    const seen = drain(watcher);
    await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => seen.items.length >= 1);

    const before = watcher.cursor;
    await seen.items[0]?.nack();
    expect(watcher.cursor).toBe(before); // AK / §8: nack never moves the position
    await waitFor(() => seen.items.length >= 2, 800); // at-least-once redelivery
    expect(seen.items.length).toBeGreaterThanOrEqual(2);
    await seen.stop();
  });
});

// =============================================================================
// SNAP — snapshot / restore
// =============================================================================
describe('SNAP: snapshot and restore', () => {
  test('SNAP-1 / SNAP-2 / SNAP-3 / API-6 / API-7: head is read before the cells', async () => {
    const { transport, ch } = await makeChannel();
    await ch.set({ key: 'a', value: 1, expectedRevision: null });
    await ch.set({ key: 'b', value: 2, expectedRevision: null });

    const headBefore = await transport.head(ch.id);
    const snapshot = await ch.snapshot({ prefix: 'a' });
    expect(snapshot.maxRevision).toBe(headBefore);
    expect(snapshot.pattern).toEqual({ prefix: 'a' });
    for (const cell of snapshot.cells) {
      expect(transport.compareRevision(cell.revision, snapshot.maxRevision)).toBeLessThanOrEqual(0);
    }
    expect(snapshot.cells.map((c) => c.key)).toEqual(['a']);
  });

  test('SNAP-2: an empty match set still produces a valid maxRevision', async () => {
    const { transport, ch } = await makeChannel();
    const snapshot = await ch.snapshot({ prefix: 'nothing' });
    expect(snapshot.cells).toHaveLength(0);
    // The r2 draft reduced from `'' as Revision`, which no transport could compare.
    expect(() => transport.compareRevision(snapshot.maxRevision, snapshot.maxRevision)).not.toThrow();
  });

  test('SNAP-4 / SNAP-5 / SNAP-6 / API-8: restore allocates fresh revisions in order', async () => {
    const { transport, ch } = await makeChannel();
    await ch.set({ key: 'a', value: 1, expectedRevision: null });
    await ch.set({ key: 'b', value: 2, expectedRevision: null });
    const snapshot = await ch.snapshot({ all: true });

    await ch.set({ key: 'a', value: 99, expectedRevision: (await ch.get('a'))!.revision });
    const beforeRestore = (await ch.get('a'))!.revision;

    await ch.restore(snapshot);
    const restored = await ch.get('a');
    expect(transport.compareRevision(restored!.revision, beforeRestore)).toBeGreaterThan(0); // SNAP-4
    expect(restored?.value).toBe(1);
    expect(transport.compareRevision((await ch.get('a'))!.revision, (await ch.get('b'))!.revision)).toBeLessThan(0); // SNAP-6
  });

  test('SNAP-8 / DEL-3: restore is observable by watchers', async () => {
    const { ch } = await makeChannel();
    await ch.set({ key: 'a', value: 1, expectedRevision: null });
    const snapshot = await ch.snapshot({ all: true });
    await ch.set({ key: 'a', value: 2, expectedRevision: (await ch.get('a'))!.revision });

    const watcher = await ch.watch({ all: true });
    const seen = drain(watcher);
    await ch.restore(snapshot);
    await waitFor(() => seen.items.length >= 1);
    expect(seen.items[0]?.value).toBe(1);
    await seen.stop();
  });

  test('SNAP-9 / API-8: replace mode deletes cells outside the snapshot', async () => {
    const { ch } = await makeChannel();
    await ch.set({ key: 'keep', value: 1, expectedRevision: null });
    const snapshot = await ch.snapshot({ all: true });
    await ch.set({ key: 'extra', value: 2, expectedRevision: null });

    await ch.restore(snapshot, { mode: 'replace' });
    const extra = await ch.get('extra');
    expect(extra?.deleted).toBe(true);

    await expect(
      ch.restore({ ...snapshot, channel: 'somewhere-else' }),
    ).rejects.toThrow('EAPP_SNAPSHOT_INVALID');
  });

  test('SNAP-9: merge mode leaves out-of-scope cells alone', async () => {
    const { ch } = await makeChannel();
    await ch.set({ key: 'keep', value: 1, expectedRevision: null });
    const snapshot = await ch.snapshot({ key: 'keep' });
    await ch.set({ key: 'keep', value: 7, expectedRevision: (await ch.get('keep'))!.revision });

    await ch.restore(snapshot, { mode: 'merge' });
    expect((await ch.get('keep'))?.value).toBe(1);
  });
});

// =============================================================================
// CF / API — configuration and pattern handling
// =============================================================================
describe('CF and API: configuration and patterns', () => {
  test('CF-1 / CF-4 / CF-5 / IX-6: configuration is validated and the view is not a wrapper', async () => {
    const transport = new MemoryTransport();
    const interaction = new InteractionLayerImpl({ transport });
    const channel = await interaction.createChannel({ binding: 'b1', mode: 'state' });

    expect(() =>
      configureStateChannel(channel, transport, { conflictPolicy: 'lww' as never, owner: OWNER }),
    ).toThrow('EAPP_UNSUPPORTED'); // CF-1: Core only supports CAS
    expect(() =>
      configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner: undefined as never }),
    ).toThrow('EAPP_STATE_ACTOR_REQUIRED');

    const ch = configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner: OWNER });
    // CF-5 / IX-6: a narrowing view, not a wrapper - it reads through to the Channel.
    expect(ch.id).toBe(channel.id);
    expect(ch.binding).toBe(channel.binding);
    expect(ch.mode).toBe('state');
    expect(ch.delivery).toBe('at-least-once');
    expect(ch.state).toBe<ChannelState>('OPEN');
    await channel.connect();
    expect(ch.state).toBe<ChannelState>('ACTIVE');
  });

  test('CF-2 / CF-3: a CAS conflict is reported as retryable', async () => {
    const { ch } = await makeChannel();
    await ch.set({ key: 'k', value: 1, expectedRevision: null });
    const error = await ch
      .set({ key: 'k', value: 2, expectedRevision: null })
      .then(() => undefined)
      .catch((e: { code: string; retryable?: boolean }) => e);
    expect(error?.code).toBe('EAPP_REVISION_CONFLICT');
    expect(error?.retryable).toBe(true);
  });

  test('API-3 / API-4 / API-9: return values and pattern validation', async () => {
    const { transport, ch } = await makeChannel();
    const setRevision = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    expect(transport.compareRevision(setRevision, setRevision)).toBe(0); // API-3

    const deletedRevision = await ch.delete('k', setRevision);
    expect((await ch.get('k'))?.revision).toBe(deletedRevision); // API-4

    for (const bad of [
      { key: 'k', prefix: 'p' },
      { all: false },
      { key: '' },
      { nothing: true },
    ]) {
      await expect(ch.list(bad as never)).rejects.toThrow('EAPP_STATE_PATTERN_INVALID');
    }
    await expect(ch.list({ all: true })).resolves.toBeInstanceOf(Array);
  });
});

// =============================================================================
// TS — transport
// =============================================================================
describe('TS: transport', () => {
  test('TS-1 / TS-2 / TS-3 / TS-7 / TS-8: capabilities are declared and honoured', async () => {
    const { transport } = await makeChannel();
    expect(transport.capabilities.supportsState).toBe(true);
    expect(transport.capabilities.stateConsistency).toBe('strong');
    expect(typeof transport.setStateWithCAS).toBe('function'); // TS-7 extends v3.1 Transport
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.compareRevision).toBe('function'); // TS-8
    expect(transport.capabilities.durabilityBoundary).toBe('process');
  });

  test('TS-2 / TS-11: a transport that cannot order revisions cannot do CAS', async () => {
    const { transport } = await makeChannel();
    const crippled = cripple(transport, { supportsStateRevision: false });

    const interaction = new InteractionLayerImpl({ transport: crippled });
    const channel = await interaction.createChannel({ binding: 'b', mode: 'state' });
    const ch = configureStateChannel(channel, crippled, { conflictPolicy: 'cas', owner: OWNER });
    await expect(ch.set({ key: 'k', value: 1, expectedRevision: null })).rejects.toThrow(
      'EAPP_STATE_UNSUPPORTED',
    );
    await expect(ch.get('k')).resolves.toBeNull(); // reads still work
  });

  test('TS-3: watch is refused when the transport cannot watch', async () => {
    const { transport } = await makeChannel();
    const crippled = cripple(transport, { supportsStateWatch: false });

    const interaction = new InteractionLayerImpl({ transport: crippled });
    const channel = await interaction.createChannel({ binding: 'b', mode: 'state' });
    const ch = configureStateChannel(channel, crippled, { conflictPolicy: 'cas', owner: OWNER });
    await expect(ch.watch({ all: true })).rejects.toThrow('EAPP_WATCH_UNSUPPORTED');
  });

  test('TS-4: non-total revision ordering must be declared eventual', async () => {
    const { transport } = await makeChannel();
    // A transport claiming CAS must produce a total per-channel order; the memory
    // implementation does, and says so.
    expect(transport.capabilities.supportsStateRevision).toBe(true);
    expect(transport.capabilities.stateConsistency).toBe('strong');
  });

  test('TS-5: strong consistency is not claimed beyond the durability boundary', async () => {
    const { transport } = await makeChannel();
    const { durabilityBoundary, stateConsistency } = transport.capabilities;
    if (stateConsistency === 'strong') {
      expect(durabilityBoundary).toBe('process');
      expect(transport.capabilities.persistent).toBe(false);
    }
  });

  test('TS-9 / TS-10 / TS-12 / TS-14 / TS-15: change-stream semantics', async () => {
    const { transport, ch } = await makeChannel();
    expect(await transport.head(ch.id)).toBe(''); // TS-14: comparable initial value

    const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    const r2 = await ch.set({ key: 'k', value: 2, expectedRevision: r1 });
    const all = await transport.readChangesAfter(ch.id, undefined, { all: true });
    expect(all.map((c) => c.revision)).toEqual([r1, r2]); // TS-9: both writes survive

    const afterFirst = await transport.readChangesAfter(ch.id, r1, { all: true });
    expect(afterFirst.map((c) => c.revision)).toEqual([r2]); // TS-10: strictly greater
    await expect(transport.readChangesAfter(ch.id, r2, { all: true })).resolves.toEqual([]); // TS-12

    const reserved = await transport.nextRevision(ch.id);
    expect(transport.compareRevision(reserved, r2)).toBeGreaterThan(0); // TS-15
  });

  test('TS-13: distinct (channel, key) pairs never collide', async () => {
    const { transport } = await makeChannel();
    const interaction = new InteractionLayerImpl({ transport });
    const channelA = await interaction.createChannel({ binding: 'a', mode: 'state' });
    const channelB = await interaction.createChannel({ binding: 'b', mode: 'state' });
    const a = configureStateChannel(channelA, transport, { conflictPolicy: 'cas', owner: OWNER });
    const b = configureStateChannel(channelB, transport, { conflictPolicy: 'cas', owner: OWNER });

    // The r2 draft keyed on `${channel}:${key}`, so these two would have been one cell.
    await a.set({ key: 'b:c', value: 'from-a', expectedRevision: null });
    await b.set({ key: 'c', value: 'from-b', expectedRevision: null });

    expect((await a.get('b:c'))?.value).toBe('from-a');
    expect((await b.get('c'))?.value).toBe('from-b');
    expect(await b.get('b:c')).toBeNull();
  });
});

// =============================================================================
// TS-11 / stateRetention — bounded history
// =============================================================================
describe('TS: retention window', () => {
  test('the declared retention is reported truthfully', async () => {
    expect(new MemoryTransport().capabilities.stateRetention).toEqual({ kind: 'unbounded' });
    expect(
      new MemoryTransport('w', { retention: { kind: 'window', entries: 4 } }).capabilities
        .stateRetention,
    ).toEqual({ kind: 'window', entries: 4 });
    expect(() => new MemoryTransport('w', { retention: { kind: 'window', entries: 0 } })).toThrow(
      'EAPP_UNSUPPORTED',
    );
  });

  test('a windowed transport discards the oldest positions and says where it starts now', async () => {
    const transport = new MemoryTransport('w', { retention: { kind: 'window', entries: 3 } });
    const interaction = new InteractionLayerImpl({ transport });
    const channel = await interaction.createChannel({ binding: 'b', mode: 'state' });
    await channel.connect();

    const revisions: string[] = [];
    let expected: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      expected = await transport.setStateWithCAS(
        channel.id,
        { key: 'k', value: i, expectedRevision: expected },
        OWNER,
      );
      revisions.push(expected);
    }

    // Only the last three positions survive, and the floor is the newest discarded one:
    // positions strictly after it are still readable.
    const retained = await transport.readChangesAfter(channel.id, undefined, { all: true });
    expect(retained.map((c) => c.revision)).toEqual(revisions.slice(-3));

    // 'earliest' resolves to the floor, not to a position that no longer exists.
    const earliest = await transport.resolveAnchor(channel.id, 'earliest');
    expect(earliest).toBe(revisions[2]);
    expect(transport.compareRevision(earliest, revisions[3]!)).toBeLessThan(0);
    expect(retained[0]?.revision).toBe(revisions[3]);
  });

  test('TS-11: a cursor that has been discarded is refused, not silently truncated', async () => {
    const transport = new MemoryTransport('w', { retention: { kind: 'window', entries: 2 } });
    const first = await transport.send('room', { n: 1 });
    const second = await transport.send('room', { n: 2 });
    await transport.send('room', { n: 3 });
    await transport.send('room', { n: 4 }); // now the first entry has been pushed out

    expect(await transport.resolveAnchor('room', 'earliest')).toBe(second);

    // The consumer thinks it is resuming from where it left off. It is not — everything up
    // to and including `first` is gone. Silently serving the truncated history would lose
    // messages without the consumer ever finding out.
    await expect(transport.readAfter('room', first, { all: true })).rejects.toThrow(
      'EAPP_CURSOR_TOO_OLD',
    );
    await expect(transport.readChangesAfter('room', first, { all: true })).rejects.toThrow(
      'EAPP_CURSOR_TOO_OLD',
    );

    // Reading strictly after the floor is still answerable.
    await expect(transport.readAfter('room', second, { all: true })).resolves.toHaveLength(2);
  });

  test('an unbounded transport never reports a cursor as too old', async () => {
    const { transport, ch } = await makeChannel();
    const first = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    for (let i = 0; i < 20; i += 1) {
      await ch.set({ key: 'k', value: i, expectedRevision: (await ch.get('k'))!.revision });
    }
    // The very first position is still serviceable.
    const changes = await transport.readChangesAfter(ch.id, first, { all: true });
    expect(changes.length).toBe(20);
  });
});

// =============================================================================
// IX — interface isolation
// =============================================================================
describe('IX: layer isolation', () => {
  test('IX-1 / IX-3: no v3.0 or v3.1 type gained a state member', async () => {
    const { channel } = await makeChannel();
    // Exactly the five members v3.1 §2.1 declares - `state` is an accessor on the
    // prototype, so own enumerable keys are the four data fields.
    expect(Object.keys(channel).sort()).toEqual(['binding', 'delivery', 'id', 'mode']);
    expect(typeof channel.state).toBe('string');
    // And no state primitives leaked onto the Channel itself (IX-3).
    for (const leaked of ['get', 'set', 'list', 'watch', 'snapshot', 'restore', 'revision']) {
      expect(leaked in channel).toBe(false);
    }
  });

  test('IX-2: state observation reuses the v3.1 Cursor and AckContext', async () => {
    const { transport, ch } = await makeChannel();
    const watcher = await ch.watch({ all: true }, { cursor: 'earliest' });
    const seen = drain(watcher);
    const revision = await ch.set({ key: 'k', value: 1, expectedRevision: null });
    await waitFor(() => seen.items.length >= 1);

    const update = seen.items[0]!;
    expect(typeof update.ack).toBe('function'); // v3.1 AckContext, not a bespoke shape
    expect(typeof update.nack).toBe('function');
    await update.ack();
    expect(transport.compareRevision(watcher.cursor, revision)).toBe(0);
    await seen.stop();
  });

  test('IX-4: a StateTransport is still a v3.1 Transport', async () => {
    const { transport } = await makeChannel();
    const cursor = await transport.send('plain-channel', { type: 'ping' });
    const messages = await transport.readAfter('plain-channel', '', { type: 'ping' });
    expect(messages.map((m) => m.cursor)).toEqual([cursor]);
  });
});

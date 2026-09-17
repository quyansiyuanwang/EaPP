import { EappError, type Identity } from '@eapp/core';
import {
  matchesPattern,
  type Cursor,
  type CursorAnchor,
  type Pattern,
  type TransportMessage,
} from '@eapp/interaction';
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
import { matchesStatePattern } from '@eapp/state';

/**
 * MemoryTransport — EaPP v3.1.0 §12.6, extended for State Mode (v3.2 §11).
 *
 * Cursors are fixed-width, zero-padded decimal strings. That width is not cosmetic: it
 * is what makes plain lexicographic comparison equal numeric order, which in turn is what
 * lets `compareCursor` stay a trivial string comparison.
 *
 * Revision and Cursor are the SAME domain here (v3.2 D-01): a state write's revision is
 * the position of its entry in the channel log. That is why REV-7 — "Revision MAY be
 * used as Cursor in State Mode" — holds without any special casing.
 */

/** Sorts before every allocated cursor. Means "from the beginning of the retained log". */
const BEGINNING = '' as Cursor;
const WIDTH = 16;

let transportSeq = 0;

export interface MemoryTransportOptions {
  /**
   * How much history is kept. `window` drops the oldest entries once the count is
   * exceeded, which is what makes `EAPP_CURSOR_TOO_OLD` reachable: a consumer asking for a
   * position that has already been discarded must be told to resynchronise rather than
   * silently handed a truncated history.
   */
  retention?: { kind: 'unbounded' } | { kind: 'window'; entries: number };
}

export class MemoryTransport implements StateTransport {
  readonly id: string;
  readonly capabilities: StateTransportCapabilities;

  #seq = 0;
  /** channel -> appended message log */
  readonly #messages = new Map<string, Array<{ cursor: Cursor; payload: unknown }>>();
  /** channel -> key -> cell. Nested on purpose: TS-13 forbids flat concatenated keys. */
  readonly #cells = new Map<string, Map<string, StateCell>>();
  /** channel -> ordered change log */
  readonly #changes = new Map<string, StateChange[]>();
  /**
   * channel -> the newest position that has been discarded.
   *
   * A read from anything at or below this is unanswerable: those entries are gone.
   */
  readonly #floors = new Map<string, Cursor>();
  /** channel -> current head revision */
  readonly #heads = new Map<string, Revision>();
  /**
   * channel -> last cursor issued for it, from EITHER messages or state writes.
   *
   * Kept separate from `#heads` on purpose. `head()` answers "how far has the state log
   * advanced", which `snapshot()` depends on and which MUST NOT be polluted by plain
   * messages. An anchor, by contrast, answers "where is the newest thing on this
   * channel", and a stream subscriber using `'latest'` needs the latter.
   */
  readonly #anchors = new Map<string, Cursor>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #retention: { kind: 'unbounded' } | { kind: 'window'; entries: number };
  #closed = false;

  constructor(id?: string, options: MemoryTransportOptions = {}) {
    this.id = id ?? `mem-${++transportSeq}`;
    this.#retention = options.retention ?? { kind: 'unbounded' };
    if (this.#retention.kind === 'window' && !(this.#retention.entries > 0)) {
      throw new EappError('EAPP_UNSUPPORTED', 'retention window entries MUST be > 0');
    }
    this.capabilities = {
      persistent: false,
      ordering: 'global',
      delivery: { atMostOnce: true, atLeastOnce: true, replay: false },
      supportsCursor: true,
      supportsLease: true,
      durabilityBoundary: 'process',
      supportsState: true,
      supportsStateRevision: true,
      supportsStateWatch: true,
      supportsStateSnapshot: true,
      stateConsistency: 'strong',
      stateRetention: this.#retention,
    };
  }

  // ---------------------------------------------------------------- internals

  #assertOpen(): void {
    if (this.#closed) {
      throw new EappError('EAPP_UNSUPPORTED', `transport ${this.id} is closed`);
    }
  }

  /**
   * Drop anything older than the retention window and record the new floor.
   *
   * Both logs are trimmed together so that a single position domain stays consistent:
   * a cursor discarded from the message log must not still appear to be readable from the
   * change log.
   */
  #trim(channel: string): void {
    if (this.#retention.kind !== 'window') return;
    const limit = this.#retention.entries;

    const messages = this.#messages.get(channel);
    if (messages && messages.length > limit) {
      const dropped = messages.splice(0, messages.length - limit);
      const last = dropped[dropped.length - 1];
      if (last) this.#floors.set(channel, last.cursor);
    }

    const changes = this.#changes.get(channel);
    if (changes && changes.length > limit) {
      const dropped = changes.splice(0, changes.length - limit);
      const last = dropped[dropped.length - 1];
      if (last) {
        const floor = this.#floors.get(channel);
        if (floor === undefined || last.revision > floor) this.#floors.set(channel, last.revision);
      }
    }
  }

  /**
   * Resolve a read position. `undefined` and the empty sentinel both mean "from the
   * earliest position still retained" (TR-6). An explicit cursor that has already been
   * discarded is unanswerable, and MUST be reported as such rather than silently served
   * from the floor — a consumer that thinks it resumed from where it left off, but is
   * actually reading a truncated history, has lost messages without knowing.
   */
  #fromCursor(channel: string, cursor: Cursor | undefined): Cursor {
    this.#requireOwnCursor(cursor, 'cursor');
    const floor = this.#floors.get(channel) ?? BEGINNING;
    const requested = cursor ?? BEGINNING;
    if (requested === BEGINNING) return floor;
    if (requested < floor) {
      throw new EappError(
        'EAPP_CURSOR_TOO_OLD',
        `cursor '${requested}' precedes the retained floor '${floor}' on channel '${channel}'`,
      );
    }
    return requested;
  }

  /** Allocate the next position. Shared by messages and state writes so the log is total. */
  #allocate(): Revision {
    this.#seq += 1;
    return `${this.id}!${String(this.#seq).padStart(WIDTH, '0')}`;
  }

  #cellMap(channel: string): Map<string, StateCell> {
    let map = this.#cells.get(channel);
    if (!map) {
      map = new Map();
      this.#cells.set(channel, map);
    }
    return map;
  }

  #changeLog(channel: string): StateChange[] {
    let log = this.#changes.get(channel);
    if (!log) {
      log = [];
      this.#changes.set(channel, log);
    }
    return log;
  }

  #append(channel: string, change: StateChange): void {
    this.#changeLog(channel).push(change);
    this.#heads.set(channel, change.revision);
    this.#anchors.set(channel, change.revision);
    this.#trim(channel);
    this.#notify(channel);
  }

  #notify(channel: string): void {
    const waiters = this.#waiters.get(channel);
    if (!waiters) return;
    const pending = [...waiters];
    waiters.clear();
    for (const resolve of pending) resolve();
  }

  #requireOwnRevision(value: Revision, label: string): void {
    if (value === BEGINNING) return;
    if (typeof value !== 'string' || !value.startsWith(`${this.id}!`)) {
      // REV-8: a revision is meaningful only inside the transport that issued it.
      throw new EappError(
        'EAPP_REVISION_INVALID',
        `${label} '${String(value)}' was not issued by transport ${this.id}`,
      );
    }
  }

  /**
   * A cursor is only meaningful inside the transport that issued it. Accepting a foreign
   * one would silently read the wrong position — or nothing at all — so it is rejected
   * with the code v3.1 §13 reserves for exactly this case.
   */
  #requireOwnCursor(value: Cursor | undefined, label: string): void {
    if (value === undefined || value === BEGINNING) return;
    if (typeof value !== 'string' || !value.startsWith(`${this.id}!`)) {
      throw new EappError(
        'EAPP_CURSOR_INVALID',
        `${label} '${String(value)}' was not issued by transport ${this.id}`,
      );
    }
  }

  // ---------------------------------------------------------------- Transport

  async send(channel: string, msg: unknown): Promise<Cursor> {
    this.#assertOpen();
    const cursor = this.#allocate();
    const log = this.#messages.get(channel) ?? [];
    log.push({ cursor, payload: msg });
    this.#messages.set(channel, log);
    this.#anchors.set(channel, cursor);
    this.#trim(channel);
    this.#notify(channel);
    return cursor;
  }

  async readAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: Pattern,
  ): Promise<TransportMessage[]> {
    this.#requireOwnCursor(cursor, 'cursor');
    const from = this.#fromCursor(channel, cursor);
    const log = this.#messages.get(channel) ?? [];
    return log
      .filter((entry) => entry.cursor > from)
      .filter((entry) => matchesPattern(entry.payload, pattern))
      .map((entry) => ({ cursor: entry.cursor, payload: entry.payload }));
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const channel of this.#waiters.keys()) this.#notify(channel);
  }

  async resolveAnchor(channel: string, anchor: CursorAnchor): Promise<Cursor> {
    if (anchor === 'earliest') {
      // With a retention window, "earliest" is the floor, not the beginning: the earlier
      // positions are gone and pretending otherwise would hand back an unreadable cursor.
      return this.#floors.get(channel) ?? BEGINNING;
    }
    if (anchor === 'latest') {
      return this.#anchors.get(channel) ?? BEGINNING;
    }
    // A concrete cursor: it must be one this transport issued.
    this.#requireOwnCursor(anchor, 'cursor');
    return anchor;
  }

  waitForChange(channel: string, _cursor: Cursor | undefined, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const waiters = this.#waiters.get(channel) ?? new Set<() => void>();
      this.#waiters.set(channel, waiters);

      const finish = (): void => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };

      waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  // ---------------------------------------------------------------- StateTransport

  /**
   * TS-14: an empty channel still needs a comparable initial revision, so `head` returns
   * the sentinel that sorts before every allocated cursor rather than throwing or `''`
   * leaking into a comparison in the caller.
   */
  async head(channel: string): Promise<Revision> {
    return this.#heads.get(channel) ?? BEGINNING;
  }

  async getState(channel: string, key: string): Promise<StateCell | null> {
    return this.#cells.get(channel)?.get(key) ?? null;
  }

  async listState(channel: string, pattern: StatePattern): Promise<StateCell[]> {
    const map = this.#cells.get(channel);
    if (!map) return [];
    return [...map.values()]
      .filter((cell) => matchesStatePattern(cell.key, pattern))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * SU-7 / TS-6: the whole compare-and-set runs inside one synchronous block with no
   * `await`, so no interleaving can occur between the check and the write.
   */
  async setStateWithCAS(channel: string, update: StateUpdate, actor: Identity): Promise<Revision> {
    this.#assertOpen();
    const cells = this.#cellMap(channel);
    const current = cells.get(update.key);
    const expected = update.expectedRevision;

    if (expected === null) {
      // "MUST NOT have ever existed" — a logically deleted cell still counts as existing,
      // so `null` cannot be used to resurrect a key (v3.2 §5.2, closing r2's F-01).
      if (current) {
        throw new EappError('EAPP_REVISION_CONFLICT', `key '${update.key}' already exists`);
      }
    } else {
      if (!current) {
        throw new EappError('EAPP_REVISION_CONFLICT', `key '${update.key}' does not exist`);
      }
      if (this.compareRevision(current.revision, expected) !== 0) {
        throw new EappError('EAPP_REVISION_CONFLICT', `key '${update.key}' has moved on`);
      }
    }

    const deleted = update.deleted === true;
    const revision = this.#allocate();
    const cell: StateCell = {
      key: update.key,
      revision,
      value: deleted ? undefined : update.value,
      deleted,
      updatedAt: Date.now(),
      updatedBy: actor,
    };
    cells.set(update.key, cell);
    this.#append(channel, {
      channel,
      revision,
      key: update.key,
      type: deleted ? 'deleted' : 'set',
      ...(deleted ? {} : { value: update.value }),
    });
    return revision;
  }

  /**
   * §6.2 edge-case table. This cannot be expressed through `set` because the transport
   * has to distinguish "delete" from "create", and implementing delete as
   * `set({deleted:true})` loses that distinction.
   */
  async deleteStateWithCAS(
    channel: string,
    key: string,
    expectedRevision: ExpectedRevision,
    actor: Identity,
  ): Promise<Revision> {
    this.#assertOpen();
    const cells = this.#cellMap(channel);
    const current = cells.get(key);

    if (!current) {
      if (expectedRevision === null) {
        throw new EappError('EAPP_STATE_KEY_NOT_FOUND', `key '${key}' has never existed`); // DEL-4
      }
      throw new EappError('EAPP_REVISION_CONFLICT', `key '${key}' does not exist`);
    }
    if (expectedRevision === null) {
      throw new EappError('EAPP_REVISION_CONFLICT', `key '${key}' already exists`);
    }
    if (this.compareRevision(current.revision, expectedRevision) !== 0) {
      throw new EappError('EAPP_REVISION_CONFLICT', `key '${key}' has moved on`);
    }

    if (current.deleted) {
      // DEL-5 / §6.3: a no-op allocates nothing and emits nothing, and reports the key's
      // current revision so the return value stays uniform (§6.4).
      return current.revision;
    }

    const revision = this.#allocate();
    cells.set(key, {
      key,
      revision,
      value: undefined,
      deleted: true,
      updatedAt: Date.now(),
      updatedBy: actor,
    });
    this.#append(channel, { channel, revision, key, type: 'deleted' });
    return revision;
  }

  /**
   * TS-9..TS-12: strictly ascending, strictly greater than the cursor, never blocking.
   * Returning a change STREAM (rather than a post-image array) is what makes repeated
   * writes to one key observable at all.
   */
  async readChangesAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: StatePattern,
  ): Promise<StateChange[]> {
    this.#requireOwnCursor(cursor, 'cursor');
    const from = this.#fromCursor(channel, cursor);
    const log = this.#changes.get(channel) ?? [];
    return log
      .filter((change) => this.compareRevision(change.revision, from) > 0)
      .filter((change) => matchesStatePattern(change.key, pattern));
  }

  async nextRevision(_channel: string): Promise<Revision> {
    this.#assertOpen();
    return this.#allocate();
  }

  /**
   * REV-8 / TS-8: comparison is provided by the transport, and a value issued by a
   * different transport instance is rejected rather than silently mis-ordered.
   */
  compareRevision(a: Revision, b: Revision): number {
    this.#requireOwnRevision(a, 'revision');
    this.#requireOwnRevision(b, 'revision');
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  /**
   * §5.5 / SNAP-7: the revision-pinned internal write. Reachable only through
   * `StateChannel.restore`, and it refuses to move the log backwards.
   */
  async writeStateWithRevision(
    channel: string,
    key: string,
    value: unknown,
    deleted: boolean,
    revision: Revision,
    actor: Identity,
  ): Promise<void> {
    this.#assertOpen();
    this.#requireOwnRevision(revision, 'revision');
    const head = this.#heads.get(channel) ?? BEGINNING;
    if (this.compareRevision(revision, head) <= 0) {
      throw new EappError(
        'EAPP_REVISION_INVALID',
        `revision '${revision}' does not advance head '${head}'`,
      );
    }

    this.#cellMap(channel).set(key, {
      key,
      revision,
      value: deleted ? undefined : value,
      deleted,
      updatedAt: Date.now(),
      updatedBy: actor,
    });
    this.#heads.set(channel, revision);
    this.#append(channel, {
      channel,
      revision,
      key,
      type: deleted ? 'deleted' : 'set',
      ...(deleted ? {} : { value }),
    });
  }

  // ---------------------------------------------------------------- test helpers

  /** Not part of any spec surface; used by the conformance suite to inspect internals. */
  snapshotCounts(): { channels: number; cells: number; changes: number } {
    let cells = 0;
    for (const map of this.#cells.values()) cells += map.size;
    let changes = 0;
    for (const log of this.#changes.values()) changes += log.length;
    return {
      channels: new Set([...this.#cells.keys(), ...this.#changes.keys()]).size,
      cells,
      changes,
    };
  }
}

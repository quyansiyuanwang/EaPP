import { EappError } from '@eapp/core';
import { maxCursor, type Cursor } from './cursor.js';

/**
 * Where a ConsumerGroup's competing state lives.
 *
 * §8.3 reduces ConsumerGroup to two pieces of shared state:
 *
 *   the group cursor   one position, the highest acked (§6.4 / CG-2)
 *   the claim table    which positions are currently held, and by whom (CG-3)
 *
 * Everything else about a group is local: who is participating, and the ack
 * plumbing that turns a delivered item into a settled position. This interface is
 * exactly the shared half, which is why it is the seam that decides whether
 * competing consumption can survive a process boundary.
 *
 * It was previously implicit. A group's claims lived in the same object that
 * tracked its members, so there was no way to say "this state is shared" and no
 * way to notice that it was not — two processes would each keep a private claim
 * table, hand out the same position twice, and report nothing wrong. Naming the
 * seam is most of the fix.
 *
 * ## Why every method is async
 *
 * A local store could answer synchronously, and a shared one cannot. Making the
 * interface async is what stops the local implementation becoming the definition:
 * `ConsumerGroup.cursor` is a synchronous property in the frozen §8.2 shape, so a
 * group backed by shared state can only ever *report* a cached view of it. That
 * cache is updated here, on every interaction, and the getters read it.
 */

/** One member's view of the shared group state. */
export interface GroupView {
  /** §6.4: the highest position any member has acked. */
  readonly cursor: Cursor;
  /** Positions currently held by anyone in the group. */
  readonly claimed: ReadonlySet<Cursor>;
  readonly memberCount: number;
  /**
   * How long until the earliest live claim stops being exclusive, in milliseconds.
   *
   * A member whose only remaining work is held by a peer that has gone silent has
   * nothing to wait for: no new message is coming and no peer will release
   * anything. This is what lets it wake on its own instead of polling forever
   * (CG-6).
   *
   * Deliberately a duration rather than a timestamp. A store that lives in another
   * process — plausibly on another machine — cannot safely hand back an absolute
   * time for this side to subtract from its own clock.
   */
  readonly earliestExpiryInMs: number | undefined;
}

export interface GroupStore {
  /**
   * Whether this store is visible beyond one process.
   *
   * The group's guarantees are only as wide as this. A transport that claims its
   * messages outlive the process while providing a process-local store would be
   * promising CG-3 it cannot keep, which is why the interaction layer asks.
   */
  readonly shared: boolean;

  /**
   * Register a member.
   *
   * `holder` is honoured when supplied so a process can rejoin as itself; when it
   * is not, the store allocates one that is unique **across** the store's scope.
   * A member id generated per process — `group-member-1` — would collide between
   * two processes sharing a group, and two members with the same id is
   * indistinguishable from one member holding everything.
   */
  join(holder: string | undefined): Promise<{ holder: string; view: GroupView }>;

  /** CG-5: everything this holder had is released immediately, not at TTL. */
  leave(holder: string): Promise<void>;

  /**
   * Claim positions for `holder`, returning the subset actually granted.
   *
   * MUST be atomic with respect to other holders. This is the one operation that
   * cannot be built out of reads and writes around it: "check whether it is free,
   * then take it" is TOCTOU, and across a process boundary the window is large
   * enough to drive through.
   */
  claim(holder: string, cursors: readonly Cursor[]): Promise<Cursor[]>;

  /**
   * Ack: advance the group cursor to `max(cursor, current)` and drop the claim.
   *
   * No holder argument: settling is identified by the position, and the only thing
   * that needs to know who held it is `leave`, which the store already tracks.
   */
  settle(cursor: Cursor): Promise<GroupView>;

  /** Nack: return the position to the group without moving the cursor (CG-6). */
  release(cursor: Cursor): Promise<GroupView>;

  /** The current shared state, with expired claims already swept. */
  view(): Promise<GroupView>;

  close(): Promise<void>;
}

export interface LocalGroupStoreOptions {
  claimTtlMs: number;
  /** Injected so claim expiry is deterministic in tests rather than wall-clock bound. */
  now?: () => number;
  initialCursor?: Cursor;
}

/**
 * The default: one process, one plain map.
 *
 * This is the reference semantics for every CG invariant. A shared store has to
 * agree with what this does, which is why it is kept as the default rather than
 * replaced by something clever.
 */
export class LocalGroupStore implements GroupStore {
  readonly shared = false;

  readonly #claims = new Map<Cursor, { holder: string; expiresAt: number }>();
  readonly #ttl: number;
  readonly #now: () => number;
  #cursor: Cursor;
  #memberCount = 0;
  #holderSeq = 0;

  constructor(options: LocalGroupStoreOptions) {
    if (!(options.claimTtlMs > 0)) {
      throw new EappError('EAPP_SUBSCRIPTION_INVALID', 'claimTtlMs MUST be > 0');
    }
    this.#ttl = options.claimTtlMs;
    this.#now = options.now ?? (() => Date.now());
    this.#cursor = options.initialCursor ?? '';
  }

  async join(holder: string | undefined): Promise<{ holder: string; view: GroupView }> {
    this.#memberCount += 1;
    // A zero-argument callback is assignable to this signature, so
    // `InteractionLayerOptions.nextId`-style injection still works unchanged.
    const id = holder ?? `member-${++this.#holderSeq}`;
    this.#sweep();
    return { holder: id, view: this.#view() };
  }

  async leave(holder: string): Promise<void> {
    this.#memberCount = Math.max(0, this.#memberCount - 1);
    for (const [cursor, claim] of [...this.#claims]) {
      if (claim.holder === holder) this.#claims.delete(cursor);
    }
    this.#sweep();
  }

  async claim(holder: string, cursors: readonly Cursor[]): Promise<Cursor[]> {
    this.#sweep();
    const now = this.#now();
    const granted: Cursor[] = [];
    for (const cursor of cursors) {
      // No `await` between the check and the write, so nothing can interleave.
      if (this.#claims.has(cursor)) continue;
      this.#claims.set(cursor, { holder, expiresAt: now + this.#ttl });
      granted.push(cursor);
    }
    return granted;
  }

  async settle(cursor: Cursor): Promise<GroupView> {
    // §6.4: acking a later position declares everything before it settled. An
    // explicit skip, which is what CR-3 permits and what "acked up to here" means.
    this.#cursor = maxCursor(this.#cursor, cursor);
    this.#claims.delete(cursor);
    this.#sweep();
    return this.#view();
  }

  async release(cursor: Cursor): Promise<GroupView> {
    // The cursor deliberately does not move: the position stays available after it
    // and will be redelivered (at-least-once).
    this.#claims.delete(cursor);
    this.#sweep();
    return this.#view();
  }

  async view(): Promise<GroupView> {
    this.#sweep();
    return this.#view();
  }

  async close(): Promise<void> {
    this.#claims.clear();
  }

  // ------------------------------------------------------------------ internals

  /** CG-6: an expired claim returns to the group rather than stalling it. */
  #sweep(): void {
    const now = this.#now();
    for (const [cursor, claim] of [...this.#claims]) {
      if (claim.expiresAt <= now) this.#claims.delete(cursor);
    }
  }

  #view(): GroupView {
    const now = this.#now();
    let earliestExpiryInMs: number | undefined;
    for (const claim of this.#claims.values()) {
      const remaining = claim.expiresAt - now;
      if (earliestExpiryInMs === undefined || remaining < earliestExpiryInMs) {
        earliestExpiryInMs = remaining;
      }
    }
    return {
      cursor: this.#cursor,
      claimed: new Set(this.#claims.keys()),
      memberCount: this.#memberCount,
      earliestExpiryInMs,
    };
  }
}

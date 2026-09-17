import { EappError } from '@eapp/core';
import { LocalAck, type AckContext } from './ack.js';
import { maxCursor, type Cursor } from './cursor.js';
import { delay, type AckFactory, type Subscription, type SubscriptionSource } from './subscription.js';

/**
 * ConsumerGroup — EaPP v3.1.0 §8.
 *
 * Subscription answers "who is participating". ConsumerGroup answers "who is competing
 * with whom":
 *
 *   between groups  every group sees every message, each with its own cursor
 *   within a group  each message goes to exactly one member
 *
 * Exclusivity is not reinvented here. A claim IS a lease in the §5 sense, so L-2
 * ("the same cursor MUST NOT be held by two ACTIVE leases") is what makes CG-3 true.
 */

export interface ConsumerGroupOptions {
  /** MUST be unique within the Channel (CG-1). */
  name: string;
  /** How long a member may hold a claim before it returns to the group. Default 30_000. */
  claimTtlMs?: number;
}

export interface ConsumerGroup<T> {
  readonly id: string;
  readonly name: string;
  readonly channel: string;
  /** CG-2: the ONE position shared by every member. */
  readonly cursor: Cursor;
  readonly memberCount: number;
  join(): Promise<Subscription<T>>;
  close(): Promise<void>;
}

export interface ConsumerGroupDeps {
  /** Injected so claim expiry is deterministic in tests instead of wall-clock dependent. */
  now?: () => number;
}

const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_MAX_BATCH = 16;
let groupSeq = 0;

interface Claim<T> {
  ack: LocalAck;
  expiresAt: number;
  /** Which member is holding it, so a departure can release its work immediately. */
  holder?: ConsumerGroupMember<T> | undefined;
}

export class ConsumerGroupImpl<T> implements ConsumerGroup<T> {
  readonly id: string;
  readonly name: string;
  readonly channel: string;

  readonly #source: SubscriptionSource<T>;
  readonly #now: () => number;
  readonly #claimTtlMs: number;
  /** cursor -> the single AckContext for that position. Bounded by distinct positions. */
  readonly #contexts = new Map<Cursor, LocalAck>();
  /** cursor -> expiry. Only positions actually handed to a member appear here. */
  readonly #claims = new Map<Cursor, Claim<T>>();
  readonly #members = new Set<ConsumerGroupMember<T>>();
  readonly #waiters = new Set<() => void>();

  #cursor: Cursor;
  #closed = false;

  private constructor(
    channel: string,
    options: ConsumerGroupOptions,
    source: SubscriptionSource<T>,
    initialCursor: Cursor,
    deps: ConsumerGroupDeps,
  ) {
    if (typeof options.name !== 'string' || options.name.length === 0) {
      throw new EappError('EAPP_SUBSCRIPTION_INVALID', 'ConsumerGroup.name MUST NOT be empty');
    }
    const ttl = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    if (!(ttl > 0)) {
      throw new EappError('EAPP_SUBSCRIPTION_INVALID', 'claimTtlMs MUST be > 0');
    }

    this.id = `group-${++groupSeq}`;
    this.name = options.name;
    this.channel = channel;
    this.#source = source;
    this.#now = deps.now ?? (() => Date.now());
    this.#claimTtlMs = ttl;
    this.#cursor = initialCursor;
  }

  /**
   * CG-7: a group never outlives its Channel, so it is created against a resolved
   * position rather than inventing one.
   */
  static async open<T>(
    channel: string,
    options: ConsumerGroupOptions,
    source: SubscriptionSource<T>,
    deps: ConsumerGroupDeps = {},
  ): Promise<ConsumerGroupImpl<T>> {
    if (typeof channel !== 'string' || channel.length === 0) {
      throw new EappError('EAPP_CHANNEL_INVALID', 'ConsumerGroup MUST belong to a Channel');
    }
    const cursor = await source.head();
    return new ConsumerGroupImpl<T>(channel, options, source, cursor, deps);
  }

  get cursor(): Cursor {
    return this.#cursor;
  }

  get memberCount(): number {
    return this.#members.size;
  }

  async join(): Promise<Subscription<T>> {
    if (this.#closed) {
      throw new EappError('EAPP_CHANNEL_CLOSED', `ConsumerGroup '${this.name}' is closed`);
    }
    const member = new ConsumerGroupMember<T>(this);
    this.#members.add(member);
    return member;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const member of [...this.#members]) await member.close();
    this.#members.clear();
    for (const context of this.#contexts.values()) context.close();
    this.#contexts.clear();
    this.#claims.clear();
    this.#wake();
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  // ------------------------------------------------------------------ internals

  /** CG-6: an expired claim returns to the group rather than stalling it. */
  #sweep(): void {
    const now = this.#now();
    let released = false;
    for (const [cursor, claim] of this.#claims) {
      if (claim.expiresAt > now) continue;
      claim.ack.close(); // the departed member's context stops working
      this.#claims.delete(cursor);
      released = true;
    }
    if (released) this.#wake();
  }

  #wake(): void {
    const pending = [...this.#waiters];
    this.#waiters.clear();
    for (const resolve of pending) resolve();
  }

  /** Earliest moment at which some member's claim stops being exclusive, if any. */
  #earliestExpiry(): number | undefined {
    let earliest: number | undefined;
    for (const claim of this.#claims.values()) {
      if (earliest === undefined || claim.expiresAt < earliest) earliest = claim.expiresAt;
    }
    return earliest;
  }

  armWait(): { promise: Promise<void>; cancel: () => void } {
    const controller = new AbortController();
    const { signal } = controller;

    // Three independent reasons to wake, raced together:
    //   1. a new message on the channel
    //   2. another member releasing a claim (nack / departure)
    //   3. a claim expiring
    //
    // (3) is the one that is easy to miss. A member whose only remaining messages are
    // held by a peer that has gone silent would otherwise sleep forever: no new message
    // is coming, and no peer is going to release anything. Waiting until the earliest
    // expiry is what makes CG-6 true without a polling loop.
    let release!: () => void;
    const internal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notify = (): void => {
      this.#waiters.delete(notify);
      release();
    };
    this.#waiters.add(notify);
    signal.addEventListener(
      'abort',
      () => {
        this.#waiters.delete(notify);
        release();
      },
      { once: true },
    );

    const { waitForChange, pollIntervalMs } = this.#source;
    const signals: Array<Promise<unknown>> = [
      waitForChange
        ? waitForChange(this.#cursor, signal)
        : delay(pollIntervalMs ?? 50, signal),
    ];

    const expiry = this.#earliestExpiry();
    if (expiry !== undefined) {
      signals.push(delay(Math.max(1, expiry - this.#now()), signal));
    }

    const external = Promise.race(signals).catch(() => undefined);

    return {
      promise: Promise.race([internal, external]).then(() => {
        this.#waiters.delete(notify);
      }),
      cancel: () => controller.abort(),
    };
  }

  /**
   * Hand out up to `max` unclaimed positions, claiming exactly what is returned.
   *
   * The AckContext for a position is created on demand and cached, so a position that is
   * examined but NOT handed out does not leak a context on every pass.
   */
  async pull(
    max: number = DEFAULT_MAX_BATCH,
    holder?: ConsumerGroupMember<T>,
  ): Promise<Array<{ cursor: Cursor; item: T }>> {
    if (this.#closed) return [];
    this.#sweep();

    const batch = await this.#source.readAfter(this.#cursor, this.#contextFor);
    const out: Array<{ cursor: Cursor; item: T }> = [];
    const now = this.#now();

    for (const entry of batch) {
      if (out.length >= max) break;
      if (this.#claims.has(entry.cursor)) continue; // CG-3: already held by another member
      const context = this.#contexts.get(entry.cursor);
      if (!context) continue;
      this.#claims.set(entry.cursor, {
        ack: context,
        expiresAt: now + this.#claimTtlMs,
        holder,
      });
      out.push(entry);
    }

    return out;
  }

  #contextFor: AckFactory = (cursor: Cursor): AckContext => {
    const existing = this.#contexts.get(cursor);
    if (existing) return existing;

    const ack = new LocalAck({
      onAck: () => {
        // One cursor for the whole group, advanced exactly as §6.4 describes: acking a
        // later position declares everything before it settled.
        this.#cursor = maxCursor(this.#cursor, cursor);
        this.#contexts.delete(cursor);
        this.#claims.delete(cursor);
        this.#wake();
      },
      onNack: () => {
        this.#contexts.delete(cursor);
        this.#claims.delete(cursor); // CG-6: available to the group again
        this.#wake();
      },
    });
    this.#contexts.set(cursor, ack);
    return ack;
  };

  /**
   * CG-5: a departing member MUST NOT stall the group.
   *
   * Its work is released immediately rather than waiting for the claim to expire — a
   * member that has gone away is never going to acknowledge, so holding its claims until
   * the TTL elapses would leave the group idle for no reason.
   */
  memberLeft(member: ConsumerGroupMember<T>): void {
    this.#members.delete(member);
    for (const [cursor, claim] of [...this.#claims]) {
      if (claim.holder !== member) continue;
      this.#claims.delete(cursor);
      this.#contexts.get(cursor)?.close();
      this.#contexts.delete(cursor);
    }
    this.#wake();
  }
}

/**
 * A member of a group. It is a Subscription like any other, but its `cursor` is the
 * GROUP's — a member owns no position of its own (CG-2).
 */
class ConsumerGroupMember<T> implements Subscription<T> {
  readonly id: string;
  readonly channel: string;
  readonly mode = 'group' as const;
  readonly group: string;

  readonly #group: ConsumerGroupImpl<T>;
  readonly #abort = new AbortController();

  #state: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' = 'ACTIVE';
  #resumeGate: Promise<void> | undefined;
  #resolveResume: (() => void) | undefined;

  constructor(group: ConsumerGroupImpl<T>) {
    this.#group = group;
    this.id = `group-member-${++groupSeq}`;
    this.channel = group.channel;
    this.group = group.name;
  }

  get cursor(): Cursor {
    return this.#group.cursor;
  }

  get state(): 'ACTIVE' | 'SUSPENDED' | 'CLOSED' {
    return this.#state;
  }

  async suspend(): Promise<void> {
    if (this.#state !== 'ACTIVE') return;
    this.#state = 'SUSPENDED';
    this.#resumeGate = new Promise<void>((resolve) => {
      this.#resolveResume = resolve;
    });
  }

  async resume(): Promise<void> {
    if (this.#state !== 'SUSPENDED') return;
    this.#state = 'ACTIVE';
    this.#resolveResume?.();
    this.#resolveResume = undefined;
    this.#resumeGate = undefined;
  }

  async close(): Promise<void> {
    if (this.#state === 'CLOSED') return;
    this.#state = 'CLOSED';
    this.#resolveResume?.();
    this.#resolveResume = undefined;
    this.#resumeGate = undefined;
    this.#abort.abort();
    this.#group.memberLeft(this); // CG-5
  }

  #isClosed(): boolean {
    return this.#state === 'CLOSED';
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.#isClosed()) {
      if (this.#state === 'SUSPENDED') {
        await this.#resumeGate;
        continue;
      }

      // Armed before pulling, for the same reason the subscription arms before reading:
      // a message that lands in between would otherwise be missed until the next wakeup.
      const armed = this.#group.armWait();
      const batch = await this.#group.pull(undefined, this);

      if (batch.length === 0) {
        // Nothing is available to THIS member. Either there is nothing new, or everything
        // is currently claimed by another member — either way waiting is correct, and it
        // is why a competing group never busy-loops.
        await armed.promise;
        continue;
      }

      armed.cancel();
      for (const entry of batch) {
        if (this.#isClosed()) return;
        yield entry.item;
      }
    }
  }
}

export async function openConsumerGroup<T>(
  channel: string,
  options: ConsumerGroupOptions,
  source: SubscriptionSource<T>,
  deps: ConsumerGroupDeps = {},
): Promise<ConsumerGroupImpl<T>> {
  return ConsumerGroupImpl.open<T>(channel, options, source, deps);
}

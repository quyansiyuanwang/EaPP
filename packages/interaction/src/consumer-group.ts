import { EappError } from '@eapp/core';
import { LocalAck, type AckContext } from './ack.js';
import type { Cursor } from './cursor.js';
import { LocalGroupStore, type GroupStore, type GroupView } from './group-store.js';
import { delay, type AckFactory, type Subscription, type SubscriptionSource } from './subscription.js';

/**
 * ConsumerGroup — EaPP v3.1.0 §8.
 *
 * Subscription answers "who is participating". ConsumerGroup answers "who is
 * competing with whom":
 *
 *   between groups  every group sees every message, each with its own cursor
 *   within a group  each message goes to exactly one member
 *
 * Exclusivity is not reinvented here. A claim IS a lease in the §5 sense, so L-2
 * ("the same cursor MUST NOT be held by two ACTIVE leases") is what makes CG-3 true.
 *
 * The competing state — the group cursor and the claim table — lives in a
 * `GroupStore`, not in this object. That seam is what decides whether a group can
 * span processes, and keeping the two together (as an earlier revision did) made
 * the question unaskable.
 */

export interface ConsumerGroupOptions {
  /** MUST be unique within the Channel (CG-1). */
  name: string;
  /** How long a member may hold a claim before it returns to the group. Default 30_000. */
  claimTtlMs?: number;
  /**
   * How many positions a member may claim in one pull. Default 16.
   *
   * CG-3 guarantees exclusivity, not fairness, so this is the only lever against a
   * single member monopolising the backlog: the first member awake claims
   * everything currently visible, and its peers get nothing until it has worked
   * through the batch. Within one process that is a throughput/latency trade-off.
   * Across processes it is much more visible — a pool of workers where one member
   * takes the first sixteen messages is not much of a pool — so a distributed
   * deployment usually wants a small value.
   */
  prefetch?: number;
}

export interface ConsumerGroup<T> {
  readonly id: string;
  readonly name: string;
  readonly channel: string;
  /**
   * CG-2: the ONE position shared by every member.
   *
   * §8.2 freezes this as a synchronous property, so a group backed by shared state
   * can only report the last view it saw. It is refreshed on every interaction —
   * a member that has just acked reads a cursor that includes its own ack.
   */
  readonly cursor: Cursor;
  readonly memberCount: number;
  join(): Promise<Subscription<T>>;
  close(): Promise<void>;
}

export interface ConsumerGroupDeps {
  /** Injected so claim expiry is deterministic in tests instead of wall-clock dependent. */
  now?: () => number;
  /**
   * Where the group's competing state lives. Defaults to process memory.
   *
   * A transport that shares state across processes supplies one that does; a group
   * is only as wide as its store, which is why the interaction layer refuses to
   * open one at all when a transport claims wider reach than its store can back.
   *
   * `initialCursor` is passed because a shared store has to decide what a *new*
   * group starts from, and only the caller knows where the channel currently ends.
   */
  store?: (context: {
    channel: string;
    name: string;
    claimTtlMs: number;
    initialCursor: Cursor;
  }) => GroupStore;
}

const DEFAULT_CLAIM_TTL_MS = 30_000;
const DEFAULT_MAX_BATCH = 16;
let groupSeq = 0;

export class ConsumerGroupImpl<T> implements ConsumerGroup<T> {
  readonly id: string;
  readonly name: string;
  readonly channel: string;

  readonly #source: SubscriptionSource<T>;
  readonly #store: GroupStore;
  readonly #prefetch: number;
  /** cursor -> the single AckContext for that position. Bounded by distinct positions. */
  readonly #contexts = new Map<Cursor, LocalAck>();
  readonly #members = new Set<ConsumerGroupMember<T>>();
  readonly #waiters = new Set<() => void>();
  #view: GroupView;
  #closed = false;

  private constructor(
    channel: string,
    options: ConsumerGroupOptions,
    source: SubscriptionSource<T>,
    store: GroupStore,
    initialCursor: Cursor,
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
    this.#store = store;
    this.#prefetch = options.prefetch ?? DEFAULT_MAX_BATCH;
    this.#view = {
      cursor: initialCursor,
      claimed: new Set(),
      memberCount: 0,
      earliestExpiryInMs: undefined,
    };
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
    const ttl = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    const store =
      deps.store?.({ channel, name: options.name, claimTtlMs: ttl, initialCursor: cursor }) ??
      new LocalGroupStore(
        deps.now === undefined
          ? { claimTtlMs: ttl, initialCursor: cursor }
          : { claimTtlMs: ttl, initialCursor: cursor, now: deps.now },
      );
    return new ConsumerGroupImpl<T>(channel, options, source, store, cursor);
  }

  /** Whether this group's guarantees reach beyond one process. */
  get shared(): boolean {
    return this.#store.shared;
  }

  get cursor(): Cursor {
    return this.#view.cursor;
  }

  get memberCount(): number {
    return this.#view.memberCount;
  }

  /** How many positions one member may claim at a time. */
  get prefetch(): number {
    return this.#prefetch;
  }

  async join(): Promise<Subscription<T>> {
    if (this.#closed) {
      throw new EappError('EAPP_CHANNEL_CLOSED', `ConsumerGroup '${this.name}' is closed`);
    }
    const { holder, view } = await this.#store.join(undefined);
    this.#view = view;
    const member = new ConsumerGroupMember<T>(this, holder);
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
    await this.#store.close();
    this.#wake();
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  // ------------------------------------------------------------------ internals

  #wake(): void {
    const pending = [...this.#waiters];
    this.#waiters.clear();
    for (const resolve of pending) resolve();
  }

  /** Earliest moment at which some member's claim stops being exclusive, if any. */
  #earliestExpiryInMs(): number | undefined {
    return this.#view.earliestExpiryInMs;
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
        ? waitForChange(this.#view.cursor, signal)
        : delay(pollIntervalMs ?? 50, signal),
    ];

    const expiry = this.#earliestExpiryInMs();
    if (expiry !== undefined) {
      signals.push(delay(Math.max(1, expiry), signal));
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
   * Hand out up to `max` free positions, claiming exactly what is returned.
   *
   * Read, filter, then claim — three steps rather than one. The claim is the only
   * step that has to be atomic, and it is: `GroupStore.claim` returns the subset it
   * actually granted, so a position another member took in between is simply not
   * in the result. Widening the window (by putting it behind a process boundary)
   * therefore loses throughput, not correctness.
   *
   * The AckContext for a position is created on demand and cached, so a position that
   * is examined but NOT handed out does not leak a context on every pass.
   */
  async pull(
    max: number = DEFAULT_MAX_BATCH,
    holder?: string,
  ): Promise<Array<{ cursor: Cursor; item: T }>> {
    if (this.#closed) return [];

    this.#view = await this.#store.view();
    const batch = await this.#source.readAfter(this.#view.cursor, this.#contextFor);

    const candidates: Array<{ cursor: Cursor; item: T }> = [];
    for (const entry of batch) {
      if (candidates.length >= max) break;
      if (this.#view.claimed.has(entry.cursor)) continue; // CG-3: held by another member
      if (!this.#contexts.has(entry.cursor)) continue;
      candidates.push(entry);
    }
    if (candidates.length === 0) return [];

    const granted = new Set(
      await this.#store.claim(holder ?? '', candidates.map((entry) => entry.cursor)),
    );
    return candidates.filter((entry) => granted.has(entry.cursor));
  }

  #contextFor: AckFactory = (cursor: Cursor): AckContext => {
    const existing = this.#contexts.get(cursor);
    if (existing) return existing;

    const ack = new LocalAck({
      onAck: async () => {
        // One cursor for the whole group, advanced exactly as §6.4 describes: acking a
        // later position declares everything before it settled.
        this.#view = await this.#store.settle(cursor);
        this.#contexts.delete(cursor);
        this.#wake();
      },
      onNack: async () => {
        // CG-6: available to the group again, cursor unchanged.
        this.#view = await this.#store.release(cursor);
        this.#contexts.delete(cursor);
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
  async memberLeft(member: ConsumerGroupMember<T>): Promise<void> {
    this.#members.delete(member);
    await this.#store.leave(member.holder);
    this.#view = await this.#store.view();
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
  /** Unique across the store's scope, so two processes cannot present the same one. */
  readonly holder: string;

  readonly #group: ConsumerGroupImpl<T>;
  readonly #abort = new AbortController();

  #state: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' = 'ACTIVE';
  #resumeGate: Promise<void> | undefined;
  #resolveResume: (() => void) | undefined;

  constructor(group: ConsumerGroupImpl<T>, holder: string) {
    this.#group = group;
    this.holder = holder;
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
    await this.#group.memberLeft(this); // CG-5
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
      const batch = await this.#group.pull(this.#group.prefetch, this.holder);

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

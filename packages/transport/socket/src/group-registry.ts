import { LocalGroupStore, type GroupView } from '@eapp/interaction';

/**
 * The broker's side of competing consumption.
 *
 * Deliberately built on `LocalGroupStore` rather than reimplementing it. The rules
 * a group obeys — one cursor, exclusive claims, expiry returning work to the group,
 * a departing member releasing immediately — are exactly the ones CG-1 … CG-8
 * test, and writing them a second time for the shared case is how the two would
 * quietly diverge. This class adds only what a broker has to add: somewhere to keep
 * one store per group, and holder ids that are unique across every process
 * attached to it.
 *
 * That last part is not cosmetic. A member id generated per process —
 * `group-member-1` — would be handed out by every client, and two members claiming
 * under the same id are indistinguishable from one member holding everything.
 */
export class GroupRegistry {
  readonly #stores = new Map<string, LocalGroupStore>();
  readonly #prefix: string;
  #holderSeq = 0;

  constructor(prefix: string) {
    this.#prefix = prefix;
  }

  get groupCount(): number {
    return this.#stores.size;
  }

  #key(channel: string, name: string): string {
    // NUL separator: a channel named `a` with group `b:c` must not collide with
    // channel `a:b` and group `c` (the same reasoning as TS-13 for state keys).
    return `${channel}\u0000${name}`;
  }

  #store(key: string, initialCursor: string, ttlMs: number): LocalGroupStore {
    let store = this.#stores.get(key);
    if (!store) {
      store = new LocalGroupStore({ claimTtlMs: ttlMs, initialCursor });
      this.#stores.set(key, store);
    }
    return store;
  }

  /** Register a member, allocating an id nobody else in this broker can hold. */
  async join(
    channel: string,
    name: string,
    options: { initialCursor: string; ttlMs: number; holder?: string },
  ): Promise<{ holder: string; view: GroupView }> {
    const store = this.#store(this.#key(channel, name), options.initialCursor, options.ttlMs);
    const holder = options.holder ?? `${this.#prefix}-m${++this.#holderSeq}`;
    return store.join(holder);
  }

  /** CG-5: a departing member's work is released now, not at TTL. */
  async leave(channel: string, name: string, holder: string): Promise<void> {
    await this.#stores.get(this.#key(channel, name))?.leave(holder);
  }

  /** CG-3: the atomic step. Exactly one caller can be granted a free position. */
  async claim(
    channel: string,
    name: string,
    holder: string,
    cursors: readonly string[],
  ): Promise<string[]> {
    const store = this.#stores.get(this.#key(channel, name));
    if (!store) return [];
    return store.claim(holder, cursors);
  }

  async settle(channel: string, name: string, cursor: string): Promise<GroupView | undefined> {
    return this.#stores.get(this.#key(channel, name))?.settle(cursor);
  }

  async release(channel: string, name: string, cursor: string): Promise<GroupView | undefined> {
    return this.#stores.get(this.#key(channel, name))?.release(cursor);
  }

  async view(channel: string, name: string): Promise<GroupView | undefined> {
    return this.#stores.get(this.#key(channel, name))?.view();
  }

  /** Called when a client connection drops: everything it held goes back. */
  async releaseHolder(holder: string): Promise<void> {
    for (const store of this.#stores.values()) await store.leave(holder);
  }

  async close(): Promise<void> {
    for (const store of this.#stores.values()) await store.close();
    this.#stores.clear();
  }
}

import type { Cursor, GroupStore, GroupView } from '@eapp/interaction';

import type { WireGroupView } from './wire.js';

/**
 * The client half of shared competing consumption.
 *
 * Every operation is one round trip to the broker, which is the whole point: the
 * position of "who holds what" has to be decided in exactly one place, and a
 * client is not that place. `claim` in particular cannot be built out of a read
 * followed by a write — that is TOCTOU, and widening the window by putting a
 * socket in the middle makes it worse, not better.
 *
 * The broker still owns the messages. This store only owns the bookkeeping: which
 * positions are taken, by whom, and how far the group has settled.
 */

/** How the store reaches the broker. Injected so it can be tested without a socket. */
export type GroupRequest = (op: string, args: Record<string, unknown>) => Promise<unknown>;

export interface RemoteGroupStoreOptions {
  channel: string;
  name: string;
  claimTtlMs: number;
  initialCursor: Cursor;
  request: GroupRequest;
}

export class RemoteGroupStore implements GroupStore {
  /**
   * §8.3's guarantee is only as wide as the state it rests on, and this state is
   * on the broker — which is what lets the interaction layer accept a group on a
   * transport whose messages travel between processes.
   */
  readonly shared = true;

  readonly #channel: string;
  readonly #name: string;
  readonly #ttlMs: number;
  readonly #initialCursor: Cursor;
  readonly #request: GroupRequest;
  /**
   * The last view the broker gave us.
   *
   * §8.2 freezes `ConsumerGroup.cursor` as a synchronous property, so a shared
   * group can only ever report what it last saw. Every operation refreshes this, so
   * a member that has just acked reads a cursor that already includes its own ack —
   * the lag is one interaction, not indefinite.
   */
  #cache: GroupView;

  constructor(options: RemoteGroupStoreOptions) {
    this.#channel = options.channel;
    this.#name = options.name;
    this.#ttlMs = options.claimTtlMs;
    this.#initialCursor = options.initialCursor;
    this.#request = options.request;
    this.#cache = {
      cursor: options.initialCursor,
      claimed: new Set(),
      memberCount: 0,
      earliestExpiryInMs: undefined,
    };
  }

  /** The last view seen, for readers that cannot await. */
  get cached(): GroupView {
    return this.#cache;
  }

  async join(holder: string | undefined): Promise<{ holder: string; view: GroupView }> {
    const result = (await this.#request('groupJoin', {
      channel: this.#channel,
      name: this.#name,
      initialCursor: this.#initialCursor,
      ttlMs: this.#ttlMs,
      ...(holder === undefined ? {} : { holder }),
    })) as { holder: string; view: WireGroupView };

    this.#cache = fromWireView(result.view);
    return { holder: result.holder, view: this.#cache };
  }

  async leave(holder: string): Promise<void> {
    await this.#request('groupLeave', { channel: this.#channel, name: this.#name, holder });
  }

  async claim(holder: string, cursors: readonly Cursor[]): Promise<Cursor[]> {
    return (await this.#request('groupClaim', {
      channel: this.#channel,
      name: this.#name,
      holder,
      cursors: [...cursors],
    })) as Cursor[];
  }

  async settle(cursor: Cursor): Promise<GroupView> {
    this.#cache = await this.#viewFrom('groupSettle', cursor);
    return this.#cache;
  }

  async release(cursor: Cursor): Promise<GroupView> {
    this.#cache = await this.#viewFrom('groupRelease', cursor);
    return this.#cache;
  }

  async view(): Promise<GroupView> {
    const result = (await this.#request('groupView', {
      channel: this.#channel,
      name: this.#name,
    })) as WireGroupView | null;
    // A group with no members yet has no broker-side entry — the first join
    // creates it. Reporting the initial view is more useful than throwing, because
    // this is called on every pull.
    if (result) this.#cache = fromWireView(result);
    return this.#cache;
  }

  async close(): Promise<void> {
    this.#cache = { ...this.#cache, claimed: new Set() };
  }

  async #viewFrom(op: string, cursor: Cursor): Promise<GroupView> {
    const result = (await this.#request(op, {
      channel: this.#channel,
      name: this.#name,
      cursor,
    })) as WireGroupView | null;
    return result ? fromWireView(result) : this.#cache;
  }
}

export function fromWireView(view: WireGroupView): GroupView {
  return {
    cursor: view.cursor,
    claimed: new Set(view.claimed),
    memberCount: view.memberCount,
    // `earliestExpiryInMs` is `number | undefined`, not optional, so a missing
    // value on the wire maps to an explicit `undefined` rather than an absent key.
    earliestExpiryInMs: view.earliestExpiryInMs,
  };
}

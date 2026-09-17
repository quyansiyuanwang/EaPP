import { EappError } from '@eapp/core';
import { LocalAck, type AckContext } from './ack.js';
import { EARLIEST, LATEST, isAnchorLiteral, maxCursor, type Cursor, type CursorAnchor } from './cursor.js';

/**
 * Subscription — EaPP v3.1.0 §7 (added by errata E1-6; the draft required
 * `StateWatcher extends Subscription` without ever defining `Subscription`).
 *
 * This class is shared by the `stream` and `state` modes. It owns the cursor, the
 * suspend/resume gate and the delivery loop; the mode-specific part is supplied as a
 * `SubscriptionSource`.
 */

export type SubscriptionMode = 'exclusive' | 'group';

export type SubscriptionState = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export interface SubscriptionOptions {
  mode?: SubscriptionMode;
  group?: string;
  cursor?: CursorAnchor;
}

export interface Subscription<T> extends AsyncIterable<T> {
  readonly id: string;
  readonly channel: string;
  readonly mode: SubscriptionMode;
  /** SUB-9: resolved before construction returns, therefore never `undefined`. */
  readonly cursor: Cursor;
  readonly state: SubscriptionState;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** Builds the per-item ack context. Supplied by the subscription, used by the mode. */
export type AckFactory = (cursor: Cursor) => AckContext;

export interface SubscriptionSource<T> {
  /** Current end of the channel. Used to resolve 'latest'. */
  head(): Promise<Cursor>;
  /** Earliest still-serviceable position. MUST throw EAPP_CURSOR_TOO_OLD if none. */
  earliest(): Promise<Cursor>;
  /** Items strictly after `cursor`, ascending. */
  readAfter(cursor: Cursor, ack: AckFactory): Promise<Array<{ cursor: Cursor; item: T }>>;
  /** Optional push notification; the poll interval is the fallback. */
  waitForChange?(cursor: Cursor, signal: AbortSignal): Promise<void>;
  /** Fallback poll interval in ms. Defaults to 50 and MUST be > 0. */
  pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 50;
let subscriptionSeq = 0;

/**
 * Sleep that wakes early when the signal aborts. Exported because ConsumerGroup paces
 * its members the same way; duplicating it would mean fixing the same edge twice.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export class TransportSubscription<T> implements Subscription<T> {
  readonly id: string;
  readonly channel: string;
  readonly mode: SubscriptionMode;
  readonly group: string | undefined;
  readonly #source: SubscriptionSource<T>;
  readonly #pollMs: number;
  readonly #abort = new AbortController();
  /** Keyed by revision so a redelivered item replaces its earlier pending context. */
  readonly #liveAcks = new Map<Cursor, LocalAck>();

  #cursor: Cursor;
  #state: SubscriptionState = 'ACTIVE';
  #resolveResume: (() => void) | undefined;
  #resumeGate: Promise<void> | undefined;

  private constructor(
    channel: string,
    mode: SubscriptionMode,
    group: string | undefined,
    cursor: Cursor,
    source: SubscriptionSource<T>,
  ) {
    this.id = `sub-${++subscriptionSeq}`;
    this.channel = channel;
    this.mode = mode;
    this.group = group;
    this.#cursor = cursor;
    this.#source = source;
    const poll = source.pollIntervalMs ?? DEFAULT_POLL_MS;
    if (!(poll > 0)) {
      throw new EappError('EAPP_SUBSCRIPTION_INVALID', 'pollIntervalMs MUST be > 0');
    }
    this.#pollMs = poll;
  }

  /**
   * SUB-9 / spec §6.2 rule 5: the anchor is resolved EAGERLY, inside this factory, so
   * that `subscription.cursor` is already concrete before the caller can observe it.
   * The draft instead left it `undefined` and deferred to the first iteration, which
   * made its own SW-1 assertion (`cursor` toBeDefined) impossible to satisfy.
   */
  static async create<T>(
    channel: string,
    options: SubscriptionOptions,
    source: SubscriptionSource<T>,
  ): Promise<TransportSubscription<T>> {
    const mode = options.mode ?? 'exclusive';
    if (mode === 'group' && !options.group) {
      throw new EappError('EAPP_SUBSCRIPTION_INVALID', "mode 'group' requires a group id");
    }
    if (mode === 'exclusive' && options.group !== undefined) {
      throw new EappError('EAPP_SUBSCRIPTION_INVALID', "'group' is only meaningful for mode 'group'");
    }

    const anchor = options.cursor ?? LATEST;
    let cursor: Cursor;
    if (typeof anchor === 'string' && isAnchorLiteral(anchor)) {
      cursor = anchor === EARLIEST ? await source.earliest() : await source.head();
    } else {
      cursor = anchor;
    }

    return new TransportSubscription<T>(channel, mode, options.group, cursor, source);
  }

  get cursor(): Cursor {
    return this.#cursor;
  }

  get state(): SubscriptionState {
    return this.#state;
  }

  /**
   * §9 / E1-4: an explicit ack of a later position abandons the intermediate unacked
   * ones — that is what "acknowledged up to here" means. What CR-3 forbids is the
   * *implicit* advance that receiving a message would cause, which never happens here.
   */
  #ackFactory: AckFactory = (cursor: Cursor) => {
    // One context per unacknowledged revision, reused across redeliveries.
    //
    // Superseding the old context instead would be wrong: the consumer may still be
    // holding the earlier event object, and closing its context turns its `ack()` into a
    // silent no-op, so the position would never advance.
    const existing = this.#liveAcks.get(cursor);
    if (existing) return existing;

    const ack = new LocalAck({
      onAck: () => {
        this.#cursor = maxCursor(this.#cursor, cursor);
        this.#liveAcks.delete(cursor);
      },
      onNack: () => {
        // cursor deliberately unchanged: the item stays available after the cursor
        // and will be re-delivered (at-least-once).
        this.#liveAcks.delete(cursor);
      },
    });
    this.#liveAcks.set(cursor, ack);
    return ack;
  };

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

  /** SUB-6 / SUB-7 / SUB-8: idempotent, stops delivery, releases in-flight acks. */
  async close(): Promise<void> {
    if (this.#state === 'CLOSED') return;
    this.#state = 'CLOSED';
    this.#resolveResume?.();
    this.#resolveResume = undefined;
    this.#resumeGate = undefined;
    this.#abort.abort();
    for (const ack of this.#liveAcks.values()) ack.close();
    this.#liveAcks.clear();
  }

  /**
   * Arm interest in the channel BEFORE reading it.
   *
   * Order matters. Reading first and waiting second loses the wakeup whenever a write
   * lands in between: the notify fires with no listener registered, the read reports
   * "nothing", and the subsequent wait then blocks forever on a change that already
   * happened. Arming first closes that window — a spurious wakeup is harmless because
   * the loop simply re-reads.
   */
  #armWait(): { promise: Promise<void>; cancel: () => void } {
    const controller = new AbortController();
    const signal = AbortSignal.any([this.#abort.signal, controller.signal]);
    const { waitForChange } = this.#source;
    const promise = (
      waitForChange ? waitForChange(this.#cursor, signal) : delay(this.#pollMs, signal)
    ).catch(() => undefined);
    return { promise, cancel: () => controller.abort() };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let lastFirst: Cursor | undefined;
    while (!this.#isClosed()) {
      if (this.#state === 'SUSPENDED') {
        await this.#resumeGate; // SUB-5: no delivery while suspended
        continue;
      }

      const armed = this.#armWait();
      const batch = await this.#source.readAfter(this.#cursor, this.#ackFactory);

      if (batch.length === 0) {
        await armed.promise; // push notification, or one poll tick
        continue;
      }

      const first = batch[0]?.cursor;
      if (first !== undefined && first === lastFirst) {
        // Nothing was acknowledged since the previous pass, so this whole batch was
        // already handed over and is being re-delivered. Pacing it keeps the
        // at-least-once contract from becoming a busy loop with unbounded growth.
        armed.cancel();
        await delay(this.#pollMs, this.#abort.signal);
      } else {
        armed.cancel();
      }
      lastFirst = first;

      for (const entry of batch) {
        if (this.#isClosed()) return;
        yield entry.item;
      }
    }
  }

  /**
   * Read through a method so TypeScript does not assume the state observed at the top of
   * the loop still holds after an `await`: `close()` can run while we are suspended.
   */
  #isClosed(): boolean {
    return this.#state === 'CLOSED';
  }

  /** v3.1 §6.3 CR-2: the cursor is persistable, so a caller can resume elsewhere. */
  exportCursor(): Cursor {
    return this.#cursor;
  }
}

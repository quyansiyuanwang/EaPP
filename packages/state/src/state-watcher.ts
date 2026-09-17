import type {
  AckContext,
  AckFactory,
  Cursor,
  Subscription,
  SubscriptionMode,
  SubscriptionSource,
  SubscriptionState,
} from '@eapp/interaction';
import { TransportSubscription } from '@eapp/interaction';
import { assertStateCapability, type StateTransport } from './state-transport.js';
import type { Revision, StateChange, StatePattern, WatchOptions } from './types.js';
import { validatePattern } from './validate.js';

/**
 * StateWatcher — EaPP v3.2.0 §7.
 *
 * A StateWatcher IS a v3.1 Subscription (SW-1), so it must expose the full AckContext:
 * both `ack()` and `nack()`. The r2 draft's event type carried only `ack()`, which meant
 * it was not a valid v3.1 AckContext at all and AK-3/AK-4 were unsatisfiable.
 */

export interface StateUpdateEvent extends AckContext {
  readonly type: 'set' | 'deleted';
  readonly key: string;
  readonly revision: Revision;
  readonly value?: unknown;
}

export interface StateWatcher extends Subscription<StateUpdateEvent> {
  /** SW-2: identifies State Mode without touching `Subscription.mode` (SW-3). */
  readonly kind: 'state';
  readonly pattern: StatePattern;
  /** The subscription mode actually in force — never the string `'state'`. */
  readonly mode: SubscriptionMode;
}

function toEvent(change: StateChange, ack: AckFactory): StateUpdateEvent {
  const context = ack(change.revision);
  return {
    type: change.type,
    key: change.key,
    revision: change.revision,
    ...(change.type === 'set' ? { value: change.value } : {}),
    ack: () => context.ack(),
    nack: () => context.nack(),
  };
}

/**
 * The anchor `''` sorts before every allocated cursor (the memory transport pads to a
 * fixed width), so it means "from the very beginning of the retained log".
 */
const BEGINNING = '' as Cursor;

class StateWatcherImpl implements StateWatcher {
  readonly kind = 'state' as const;
  readonly pattern: StatePattern;
  readonly #inner: TransportSubscription<StateUpdateEvent>;

  constructor(pattern: StatePattern, inner: TransportSubscription<StateUpdateEvent>) {
    this.pattern = pattern;
    this.#inner = inner;
  }

  get id(): string {
    return this.#inner.id;
  }
  get channel(): string {
    return this.#inner.channel;
  }
  get mode(): SubscriptionMode {
    return this.#inner.mode;
  }
  get cursor(): Cursor {
    return this.#inner.cursor;
  }
  get state(): SubscriptionState {
    return this.#inner.state;
  }
  suspend(): Promise<void> {
    return this.#inner.suspend();
  }
  resume(): Promise<void> {
    return this.#inner.resume();
  }
  close(): Promise<void> {
    return this.#inner.close();
  }
  [Symbol.asyncIterator](): AsyncIterator<StateUpdateEvent> {
    return this.#inner[Symbol.asyncIterator]();
  }
}

export async function createStateWatcher(
  channel: string,
  pattern: StatePattern,
  transport: StateTransport,
  options: WatchOptions = {},
): Promise<StateWatcher> {
  validatePattern(pattern);
  assertStateCapability(transport, 'watch'); // TS-2: raised before the watcher exists

  const { waitForChange, resolveAnchor } = transport;
  const source: SubscriptionSource<StateUpdateEvent> = {
    head: () => transport.head(channel),
    earliest: async () =>
      resolveAnchor ? await resolveAnchor.call(transport, channel, 'earliest') : BEGINNING,

    readAfter: async (cursor, ack) => {
      const changes = await transport.readChangesAfter(channel, cursor, pattern);
      return changes.map((change) => ({ cursor: change.revision, item: toEvent(change, ack) }));
    },

    ...(waitForChange
      ? {
          waitForChange: (cursor: Cursor, signal: AbortSignal) =>
            waitForChange.call(transport, channel, cursor, signal),
        }
      : {}),

    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
  };

  const inner = await TransportSubscription.create<StateUpdateEvent>(
    channel,
    {
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.group !== undefined ? { group: options.group } : {}),
    },
    source,
  );

  return new StateWatcherImpl(pattern, inner);
}

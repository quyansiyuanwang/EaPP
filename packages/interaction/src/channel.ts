import { EappError } from '@eapp/core';

/**
 * Channel — EaPP v3.1.0 §2.
 *
 * A ChannelRef is the only part the Composition Core may see (§2.2). Everything else
 * (mode / delivery / state) belongs to this layer and MUST NOT leak downwards.
 *
 * Note that v3.1 §2.1 already lists `'state'` as a ChannelMode. No later layer extends
 * this union.
 */

export type ChannelMode = 'request' | 'event' | 'stream' | 'state';

export type DeliveryGuarantee = 'at-most-once' | 'at-least-once';

export type ChannelState = 'OPEN' | 'ACTIVE' | 'DRAINING' | 'CLOSED';

export interface ChannelRef {
  id: string;
  binding: string;
}

export interface Channel extends ChannelRef {
  mode: ChannelMode;
  delivery: DeliveryGuarantee;
  state: ChannelState;
}

/**
 * A Channel together with the lifecycle operations of §2.4. The bare `Channel` interface
 * stays a pure data view (that is all the Composition Core may see), while anything that
 * actually owns a channel gets these.
 */
export interface ManagedChannel extends Channel {
  connect(): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
  /** Throws unless the channel is ACTIVE. See the implementation for the three codes. */
  requireActive(operation: string): void;
}

/**
 * §4.4: `stream` and `state` allow only `at-least-once`; the other modes allow either.
 * Deliberately NOT tolerant of unknown modes: a typo must fail loudly rather than
 * silently default to a weaker guarantee.
 */
export function defaultDeliveryFor(mode: ChannelMode): DeliveryGuarantee {
  return mode === 'stream' || mode === 'state' ? 'at-least-once' : 'at-most-once';
}

export function assertDeliveryAllowed(mode: ChannelMode, delivery: DeliveryGuarantee): void {
  if ((mode === 'stream' || mode === 'state') && delivery !== 'at-least-once') {
    throw new EappError(
      'EAPP_DELIVERY_UNSUPPORTED',
      `mode '${mode}' requires 'at-least-once', got '${delivery}'`,
    );
  }
}

export class ChannelImpl implements ManagedChannel {
  readonly id: string;
  readonly binding: string;
  readonly mode: ChannelMode;
  readonly delivery: DeliveryGuarantee;
  #state: ChannelState = 'OPEN';

  constructor(ref: ChannelRef, mode: ChannelMode, delivery: DeliveryGuarantee) {
    assertDeliveryAllowed(mode, delivery);
    this.id = ref.id;
    this.binding = ref.binding;
    this.mode = mode;
    this.delivery = delivery;
  }

  get state(): ChannelState {
    return this.#state;
  }

  /**
   * §2.5: OPEN --connect--> ACTIVE.
   *
   * DRAINING --connect--> ACTIVE is also accepted, because v3.1 §2.4 requires the
   * re-derivation in both directions: a Binding returning to ACTIVE MUST put its
   * Channels back in service, and a DRAINING channel that could never resume would make
   * that impossible.
   */
  async connect(): Promise<void> {
    if (this.#state === 'CLOSED') {
      throw new EappError('EAPP_CHANNEL_CLOSED', `channel ${this.id} is closed`);
    }
    if (this.#state === 'OPEN' || this.#state === 'DRAINING') this.#state = 'ACTIVE';
  }

  /** §2.5: ACTIVE --drain--> DRAINING (stop accepting new work, finish in-flight). */
  async drain(): Promise<void> {
    if (this.#state === 'CLOSED' || this.#state === 'DRAINING') return;
    this.#state = 'DRAINING';
  }

  /** CH-3 / CH-4: CLOSED is terminal and close() is idempotent. */
  async close(): Promise<void> {
    this.#state = 'CLOSED';
  }

  /**
   * Guard for operations that require an ACTIVE channel.
   *
   * The three failure modes are deliberately distinct, because they call for different
   * responses: CLOSED is terminal, DRAINING means "not now, the composition is paused"
   * (§2.4 — stop accepting new work, let in-flight finish), and OPEN means the caller
   * simply forgot to connect().
   */
  requireActive(operation: string): void {
    if (this.#state === 'CLOSED') {
      throw new EappError('EAPP_CHANNEL_CLOSED', `cannot ${operation} on a closed channel`);
    }
    if (this.#state === 'DRAINING') {
      throw new EappError(
        'EAPP_CHANNEL_DRAINING',
        `cannot ${operation} while the channel is draining (its Binding is DORMANT)`,
      );
    }
    if (this.#state === 'OPEN') {
      throw new EappError(
        'EAPP_CHANNEL_INVALID',
        `cannot ${operation} on a channel that has not been connected`,
      );
    }
  }
}

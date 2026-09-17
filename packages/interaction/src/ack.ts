import { EappError } from '@eapp/core';

/**
 * AckContext — EaPP v3.1.0 §9.
 *
 * The full context carries BOTH `ack()` and `nack()`. A consumer-facing event type that
 * only exposes `ack()` is not a valid v3.1 AckContext (errata E1-3), which is why the
 * state layer's `StateUpdateEvent` extends this interface rather than redefining it.
 *
 * Two distinct terminal stories are deliberately separated:
 *
 *   AK-3 / AK-4 (spec §9)   a context resolved as ACKED may not later be NACKED and
 *                           vice versa -> EAPP_LEASE_CLOSED.
 *   SUB-8 / SW-12 (errata)  the owning subscription was closed while this item was still
 *                           unresolved -> both calls are no-ops and MUST NOT throw, so
 *                           that a `for await` loop that exits mid-flight does not blow up
 *                           in its finally block.
 */

export type AckState = 'PENDING' | 'ACKED' | 'NACKED';

export interface AckContext {
  ack(): Promise<void>;
  nack(): Promise<void>;
}

export interface LocalAckHooks {
  /**
   * Called once, when the context resolves. MAY be async.
   *
   * The hook is where the owning subscription settles the position, and a
   * ConsumerGroup backed by shared state has to confirm that with something that
   * is not in this process. The return value is awaited by `ack()` / `nack()`, so
   * a caller that awaits them knows the position is actually settled.
   */
  onAck?: (self: LocalAck) => void | Promise<void>;
  onNack?: (self: LocalAck) => void | Promise<void>;
}

export class LocalAck implements AckContext {
  #state: AckState = 'PENDING';
  #closed = false;
  #terminated = false;
  readonly #hooks: LocalAckHooks;

  constructor(hooks: LocalAckHooks = {}) {
    this.#hooks = hooks;
  }

  get state(): AckState {
    return this.#state;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get terminated(): boolean {
    return this.#terminated;
  }

  #requireLive(): void {
    // AK-5: a TERMINATED context is gone for good (its lease expired, its channel
    // closed underneath it). This is deliberately different from `close()`, which is the
    // subscription-shutdown path handled by SUB-8.
    if (this.#terminated) {
      throw new EappError('EAPP_LEASE_CLOSED', 'AckContext has been terminated');
    }
  }

  async ack(): Promise<void> {
    this.#requireLive();
    if (this.#closed) return; // SUB-8 / SW-12
    if (this.#state === 'ACKED') return; // AK-1 idempotent
    if (this.#state === 'NACKED') {
      throw new EappError('EAPP_LEASE_CLOSED', 'ack() after nack() is not allowed'); // AK-4
    }
    this.#state = 'ACKED';
    await this.#hooks.onAck?.(this);
  }

  async nack(): Promise<void> {
    this.#requireLive();
    if (this.#closed) return; // SUB-8 / SW-12
    if (this.#state === 'NACKED') return; // AK-2 idempotent
    if (this.#state === 'ACKED') {
      throw new EappError('EAPP_LEASE_CLOSED', 'nack() after ack() is not allowed'); // AK-3
    }
    this.#state = 'NACKED';
    await this.#hooks.onNack?.(this);
  }

  /** Called by the owning subscription when it closes. Not part of `AckContext`. */
  close(): void {
    this.#closed = true;
  }

  /** Terminal. Not part of `AckContext`. */
  terminate(): void {
    this.#terminated = true;
  }
}

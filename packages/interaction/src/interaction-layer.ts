import { EappError } from '@eapp/core';
import {
  ChannelImpl,
  assertDeliveryAllowed,
  defaultDeliveryFor,
  type ChannelRef,
  type ChannelMode,
  type ChannelState,
  type DeliveryGuarantee,
  type ManagedChannel,
} from './channel.js';
import type { Transport } from './transport.js';

/**
 * Channel creation — EaPP v3.1.0 §11 (added by errata E1-5).
 *
 * The draft stated "a Channel MUST be derived from a Binding" but never gave an
 * executable path, which is how a later draft ended up constructing a state channel
 * from a bare binding string with no way to reach it from `core.bind()`.
 *
 * The three-step path is:
 *
 *   1. core.bind({ from, to, capability })        -> Binding          (v3.0)
 *   2. interaction.createChannel({ binding, ... }) -> Channel         (this file)
 *   3. state.configure(channel, { owner, ... })    -> StateChannel    (v3.2)
 */

const VALID_MODES: readonly ChannelMode[] = ['request', 'event', 'stream', 'state'];

export interface CreateChannelRequest {
  /** Binding.id produced by the Composition Core. */
  binding: string;
  mode: ChannelMode;
  delivery?: DeliveryGuarantee;
}

/**
 * Structural view of the Composition Core, kept local so this layer does not depend on
 * a concrete core class. CC-6 / CC-7 are enforced only when a source is supplied —
 * without one the layer is usable standalone, which is what its unit tests rely on.
 */
export interface BindingSource {
  binding(id: string): { readonly id: string } | undefined;
  bindingState(id: string): 'ACTIVE' | 'DORMANT' | 'CLOSED';
  /**
   * CC-2: when a Binding reaches CLOSED its Channels MUST immediately close.
   * Returns an unsubscribe function.
   */
  onBindingStateChange?(
    listener: (bindingId: string, state: 'ACTIVE' | 'DORMANT' | 'CLOSED') => void,
  ): () => void;
}

export interface InteractionLayer {
  createChannel(request: CreateChannelRequest): Promise<ManagedChannel>;
  channel(id: string): ManagedChannel | undefined;
  channelRef(id: string): ChannelRef;
  channelState(id: string): ChannelState;
  listChannels(): ManagedChannel[];
  closeChannel(id: string): Promise<void>;
}

export interface InteractionLayerOptions {
  transport: Transport;
  bindings?: BindingSource;
  /** Injectable id source for deterministic tests. */
  nextId?: () => string;
}

let channelSeq = 0;

export class InteractionLayerImpl implements InteractionLayer {
  readonly #transport: Transport;
  readonly #bindings: BindingSource | undefined;
  readonly #nextId: () => string;
  readonly #channels = new Map<string, ChannelImpl>();

  constructor(options: InteractionLayerOptions) {
    this.#transport = options.transport;
    this.#bindings = options.bindings;
    this.#nextId = options.nextId ?? (() => `ch-${++channelSeq}`);

    // CH-2 / CC-2: a Channel never outlives its Binding. Binding state is DERIVED by the
    // Composition Core (v3.0 §6.4), so this layer reacts to the notification rather than
    // polling or recomputing it.
    options.bindings?.onBindingStateChange?.((bindingId, state) => {
      if (state !== 'CLOSED') return;
      for (const channel of this.#channels.values()) {
        if (channel.binding === bindingId) void channel.close();
      }
    });
  }

  get transport(): Transport {
    return this.#transport;
  }

  async createChannel(request: CreateChannelRequest): Promise<ManagedChannel> {
    if (!VALID_MODES.includes(request.mode)) {
      throw new EappError('EAPP_MODE_INVALID', `unknown channel mode '${String(request.mode)}'`);
    }

    // CC-6 / CC-7 — a Channel MUST NOT exist independently of a live Binding.
    if (this.#bindings) {
      const binding = this.#bindings.binding(request.binding);
      if (!binding) {
        throw new EappError('EAPP_BINDING_INVALID', `unknown binding '${request.binding}'`);
      }
      if (this.#bindings.bindingState(request.binding) === 'CLOSED') {
        throw new EappError('EAPP_BINDING_CLOSED', `binding '${request.binding}' is closed`);
      }
    }

    // CC-4: derive the guarantee from the mode when the caller omits it.
    const delivery = request.delivery ?? defaultDeliveryFor(request.mode);
    assertDeliveryAllowed(request.mode, delivery); // CC-5 / DL-6

    const id = this.#nextId();
    if (this.#channels.has(id)) {
      throw new EappError('EAPP_CHANNEL_INVALID', `channel id '${id}' is already in use`);
    }

    const channel = new ChannelImpl({ id, binding: request.binding }, request.mode, delivery);
    this.#channels.set(id, channel);
    return channel;
  }

  channel(id: string): ManagedChannel | undefined {
    return this.#channels.get(id);
  }

  #require(id: string): ChannelImpl {
    const channel = this.#channels.get(id);
    if (!channel) {
      throw new EappError('EAPP_CHANNEL_INVALID', `unknown channel '${id}'`);
    }
    return channel;
  }

  /** §2.2: only `id` and `binding` may cross into the Composition Core. */
  channelRef(id: string): ChannelRef {
    const channel = this.#require(id);
    return { id: channel.id, binding: channel.binding };
  }

  channelState(id: string): ChannelState {
    return this.#require(id).state;
  }

  listChannels(): ManagedChannel[] {
    return [...this.#channels.values()];
  }

  async closeChannel(id: string): Promise<void> {
    const channel = this.#require(id);
    await channel.close();
  }
}

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
import {
  assertCapabilitiesCoherent,
  assertTransportSupportsDelivery,
  type Transport,
} from './transport.js';
import {
  ConsumerGroupImpl,
  type ConsumerGroup,
  type ConsumerGroupDeps,
  type ConsumerGroupOptions,
} from './consumer-group.js';
import type { Subscription, SubscriptionSource } from './subscription.js';

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

  /** §8: competing-consumer scope. Names are unique per Channel (CG-1). */
  openConsumerGroup<T>(
    channelId: string,
    options: ConsumerGroupOptions,
    source: SubscriptionSource<T>,
    deps?: ConsumerGroupDeps,
  ): Promise<ConsumerGroup<T>>;
  consumerGroup(channelId: string, name: string): ConsumerGroup<unknown> | undefined;
  /** CG-8: joining MUST name an existing group on the same Channel. */
  joinConsumerGroup<T>(channelId: string, name: string): Promise<Subscription<T>>;
  listConsumerGroups(channelId: string): ConsumerGroup<unknown>[];
}

/** The part of a group the layer needs to manage its lifecycle. */
interface GroupHandle {
  readonly name: string;
  readonly channel: string;
  close(): Promise<void>;
}

export interface InteractionLayerOptions {
  transport: Transport;
  bindings?: BindingSource;
  /**
   * Injectable id source for deterministic tests.
   *
   * It receives the channel-creation request deliberately. A Channel's id is the
   * key its messages are stored under, so when two runtimes share one transport —
   * two processes, say — they have to agree on that key. A counter cannot: each
   * runtime would hand out `ch-1` for its own first channel and the two would
   * silently be talking about different logs. Deriving the id from the binding and
   * mode makes it the same everywhere, which is what a Channel being *derived from
   * a Binding* actually implies.
   */
  nextId?: (request: CreateChannelRequest) => string;
}

let channelSeq = 0;

export class InteractionLayerImpl implements InteractionLayer {
  readonly #transport: Transport;
  readonly #bindings: BindingSource | undefined;
  readonly #nextId: (request: CreateChannelRequest) => string;
  readonly #channels = new Map<string, ChannelImpl>();
  /** channelId -> group name -> handle. Names are unique per Channel (CG-1). */
  readonly #groups = new Map<string, Map<string, GroupHandle>>();

  constructor(options: InteractionLayerOptions) {
    this.#transport = options.transport;
    // TR-3: fail fast on a declaration that cannot be true of any real transport, rather
    // than discovering it later as a mysterious ordering or durability problem.
    assertCapabilitiesCoherent(this.#transport);
    this.#bindings = options.bindings;
    this.#nextId = options.nextId ?? (() => `ch-${++channelSeq}`);

    // CH-2 / CC-2 / §2.4 / CC-2: a Channel never outlives its Binding, and it follows the
    // Binding's derived state in both directions.
    //
    //   Binding ACTIVE   -> Channel OPEN or ACTIVE
    //   Binding DORMANT  -> Channel DRAINING   (stop taking new work, finish in-flight)
    //   Binding CLOSED   -> Channel CLOSED
    //
    // Binding state is DERIVED by the Composition Core (v3.0 §6.4), so this layer reacts
    // to the notification rather than polling or recomputing it.
    options.bindings?.onBindingStateChange?.((bindingId, state) => {
      for (const channel of this.#channels.values()) {
        if (channel.binding !== bindingId) continue;
        if (state === 'CLOSED') {
          // CG-7 again: groups go before the Channel does.
          void (async () => {
            for (const group of this.#groups.get(channel.id)?.values() ?? []) await group.close();
            this.#groups.delete(channel.id);
            await channel.close();
          })();
        } else if (state === 'DORMANT') {
          void channel.drain();
        } else {
          void channel.connect().catch(() => undefined);
        }
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

    // TR-4: "Channel MUST NOT use unsupported features." Until now the capability flags
    // were declared and never consulted, so a transport with `atLeastOnce: false` would
    // happily carry a channel that promised at-least-once — the one thing TR-3 forbids.
    assertTransportSupportsDelivery(this.#transport, delivery);

    const id = this.#nextId(request);
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
    // CG-7: a group never outlives its Channel.
    for (const group of this.#groups.get(id)?.values() ?? []) await group.close();
    this.#groups.delete(id);
    await channel.close();
  }

  // ------------------------------------------------------------------ ConsumerGroup §8

  async openConsumerGroup<T>(
    channelId: string,
    options: ConsumerGroupOptions,
    source: SubscriptionSource<T>,
    deps: ConsumerGroupDeps = {},
  ): Promise<ConsumerGroup<T>> {
    this.#require(channelId); // CG-7: the Channel must exist

    // §8.3: a claim IS a Lease, and L-2 ("the same cursor MUST NOT be held by two
    // ACTIVE leases") is what makes CG-3 true. In this implementation the claim
    // registry is process-local memory.
    //
    // That is coherent only while one process is the whole audience. Over a
    // transport whose messages outlive and outrun this process, two members in two
    // processes would each be told they hold the same position, every message would
    // be delivered to both, and CG-3 would be violated without anyone seeing an
    // error. Silent degradation is exactly what TR-4 forbids, so refuse.
    //
    // This is a statement about THIS implementation's claim registry, not about the
    // transport: a transport that also shares the registry would lift the refusal.
    const boundary = this.#transport.capabilities.durabilityBoundary;
    if (boundary !== 'process') {
      throw new EappError(
        'EAPP_UNSUPPORTED',
        `competing consumption is unavailable on transport ${this.#transport.id}: its ` +
          `durability boundary is '${boundary}', but this implementation's claim registry ` +
          `is process-local, so CG-3 could not be guaranteed`,
      );
    }

    const byName = this.#groups.get(channelId) ?? new Map<string, GroupHandle>();
    this.#groups.set(channelId, byName);
    if (byName.has(options.name)) {
      throw new EappError(
        'EAPP_SUBSCRIPTION_INVALID',
        `ConsumerGroup '${options.name}' already exists on channel '${channelId}'`, // CG-1
      );
    }

    const group = await ConsumerGroupImpl.open<T>(channelId, options, source, deps);
    byName.set(options.name, group);
    return group;
  }

  consumerGroup(channelId: string, name: string): ConsumerGroup<unknown> | undefined {
    return this.#groups.get(channelId)?.get(name) as ConsumerGroup<unknown> | undefined;
  }

  async joinConsumerGroup<T>(channelId: string, name: string): Promise<Subscription<T>> {
    this.#require(channelId);
    const group = this.#groups.get(channelId)?.get(name);
    if (!group) {
      // CG-8: a group member MUST name a group that exists on this Channel.
      throw new EappError(
        'EAPP_SUBSCRIPTION_INVALID',
        `no ConsumerGroup '${name}' on channel '${channelId}'`,
      );
    }
    return (group as ConsumerGroupImpl<T>).join();
  }

  listConsumerGroups(channelId: string): ConsumerGroup<unknown>[] {
    return [...(this.#groups.get(channelId)?.values() ?? [])] as ConsumerGroup<unknown>[];
  }
}

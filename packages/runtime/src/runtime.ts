import { randomUUID } from 'node:crypto';

import {
  EappError,
  IdentityRegistry,
  PluginRegistry,
  createCompositionCore,
  identityKey,
  type Binding,
  type CapabilityRef,
  type Criteria,
  type DiscoveryScope,
  type Identity,
  type PluginRef,
  type CompositionCoreImpl,
} from '@eapp/core';
import {
  InteractionLayerImpl,
  TransportSubscription,
  type ChannelMode,
  type DeliveryGuarantee,
  type ManagedChannel,
  type Subscription,
  type SubscriptionOptions,
  type TransportMessage,
} from '@eapp/interaction';
import { configureStateChannel, type StateChannel } from '@eapp/state';
import { MemoryTransport } from '@eapp/transport-memory';

import { assertManifest, type PluginModule, type RequestHandler } from './plugin.js';

/**
 * EaPP Runtime — the part that makes "everything is a plugin" actually usable.
 *
 * It does not add semantics of its own. Every operation below is a composition of the
 * three frozen layers:
 *
 *   discover      ->  v3.0 Discovery
 *   connect       ->  v3.0 bind()  +  v3.1 createChannel()
 *   activate      ->  v3.0 Lifecycle
 *   communicate   ->  v3.1 Channel / Subscription  +  v3.2 StateChannel
 *   invoke        ->  request mode over a real Channel, correlated by correlationId
 *
 * The runtime is deliberately NOT a fourth layer. If a rule is not already in v3.0,
 * v3.1 or v3.2, it does not belong here — it belongs in the plugin.
 */

export interface ConnectRequest {
  /** The party that provides the capability. */
  from: PluginRef;
  /** The party that consumes it. */
  to: PluginRef;
  capability: Omit<CapabilityRef, 'plugin'>;
  mode: ChannelMode;
  delivery?: DeliveryGuarantee;
}

export interface Connection {
  binding: Binding;
  channel: ManagedChannel;
}

export interface InvokeRequest {
  from: PluginRef;
  to: PluginRef;
  capability: Omit<CapabilityRef, 'plugin'>;
  payload?: unknown;
  timeoutMs?: number;
}

export interface EappRuntimeOptions {
  transport?: MemoryTransport;
  /** The runtime's own identity, used as the owner of channels it configures. */
  owner?: Identity;
  domain?: string;
  defaultTimeoutMs?: number;
}

/** A delivered message together with the v3.1 AckContext that resolves it. */
export interface RuntimeMessage extends TransportMessage {
  ack(): Promise<void>;
  nack(): Promise<void>;
}

interface RequestEnvelope {
  type: 'request';
  correlationId: string;
  capability: string;
  caller: string;
  payload: unknown;
}

interface ResponseEnvelope {
  type: 'response';
  correlationId: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

interface PendingInvocation {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'request' &&
    typeof (value as { correlationId?: unknown }).correlationId === 'string'
  );
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'response' &&
    typeof (value as { correlationId?: unknown }).correlationId === 'string'
  );
}

export class EappRuntime {
  readonly transport: MemoryTransport;
  readonly core: CompositionCoreImpl;
  readonly interaction: InteractionLayerImpl;

  readonly #identities: IdentityRegistry;
  readonly #registry: PluginRegistry;
  readonly #owner: Identity;
  readonly #defaultTimeoutMs: number;
  readonly #modules = new Map<string, PluginModule>();
  /** binding#mode -> channel, so repeated connects reuse the Channel (CC-9). */
  readonly #channels = new Map<string, ManagedChannel>();
  /** binding#mode -> in-flight creation, so concurrent connects share one Channel. */
  readonly #channelPromises = new Map<string, Promise<ManagedChannel>>();
  /** channelId -> StateChannel view (IX-6). */
  readonly #stateChannels = new Map<string, StateChannel>();
  /** bindingId -> request dispatcher. */
  readonly #dispatchers = new Map<string, AbortController>();
  readonly #pending = new Map<string, PendingInvocation>();
  #shutDown = false;

  private constructor(options: EappRuntimeOptions) {
    this.transport = options.transport ?? new MemoryTransport();
    this.#identities = new IdentityRegistry();
    this.#registry = new PluginRegistry();
    this.#owner =
      options.owner ??
      this.#identities.create({ domain: options.domain ?? 'eapp.runtime', id: 'runtime' });
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.core = createCompositionCore(this.#registry);
    // The Composition Core notifies with (binding, state); the Interaction Layer wants
    // (bindingId, state). Adapting here keeps both layers' own shapes intact — neither
    // of them should be bent to match the other's convenience.
    this.interaction = new InteractionLayerImpl({
      transport: this.transport,
      bindings: {
        binding: (id) => this.core.binding(id),
        bindingState: (id) => (this.core.binding(id) ? this.core.bindingState(id) : 'CLOSED'),
        onBindingStateChange: (listener) =>
          this.core.onBindingStateChange((binding, state) => listener(binding.id, state)),
      },
    });
  }

  static create(options: EappRuntimeOptions = {}): EappRuntime {
    return new EappRuntime(options);
  }

  get owner(): Identity {
    return this.#owner;
  }

  /** Mint an Identity for a plugin this runtime hosts. */
  issueIdentity(id: string, domain = 'eapp.plugin', instance?: string): Identity {
    return this.#identities.create(
      instance === undefined ? { domain, id } : { domain, id, instance },
    );
  }

  // --------------------------------------------------------------- 发现 discover

  /**
   * Register a plugin. Registration makes it *discoverable*, nothing more: v3.0 D-3 is
   * explicit that discovery never implies composability, and a plugin starts INACTIVE.
   */
  register(module: PluginModule): PluginRef {
    this.#assertLive();
    assertManifest(module.manifest);
    // An identity this runtime already issued is accepted as-is; anything else is minted
    // here. ID-5 ("Identity MUST NOT be self-issued") is what makes this the runtime's
    // decision rather than the plugin's.
    const identity = this.#identities.isIssued(module.manifest.identity)
      ? this.#identities.require(module.manifest.identity)
      : this.#identities.create({
          domain: module.manifest.identity.domain,
          id: module.manifest.identity.id,
          instance: module.manifest.identity.instance,
        });
    this.#registry.register({
      identity,
      capabilities: [...module.manifest.capabilities],
      lifecycle: 'INACTIVE',
    });
    this.#modules.set(identityKey(identity), module);
    return identity;
  }

  async discover(criteria: Criteria = {}, scope: DiscoveryScope = {}): Promise<PluginRef[]> {
    this.#assertLive();
    return this.core.find(criteria, scope);
  }

  /** Everything this runtime currently knows about, with its lifecycle state. */
  describe(): Array<{ identity: PluginRef; lifecycle: string; capabilities: string[] }> {
    return this.#registry.list().map((plugin) => ({
      identity: plugin.identity,
      lifecycle: plugin.lifecycle,
      capabilities: plugin.capabilities.map((c) => `${c.name}@${c.version}`),
    }));
  }

  // -------------------------------------------------------------- 连接 connect

  async connect(request: ConnectRequest): Promise<Connection> {
    this.#assertLive();
    const binding = await this.#ensureBinding(request);
    const channel = await this.#ensureChannel(binding, request.mode, request.delivery);
    return { binding, channel };
  }

  /**
   * Reuse an existing non-CLOSED Binding for the same (from, to, capability) rather than
   * failing on B-6. The uniqueness rule is the core's; the runtime's job is to honour it.
   */
  async #ensureBinding(request: ConnectRequest): Promise<Binding> {
    const capability: CapabilityRef = { plugin: request.from, ...request.capability };
    const existing = this.core
      .listBindings()
      .find(
        (b) =>
          this.core.bindingState(b.id) !== 'CLOSED' &&
          identityKey(b.from) === identityKey(request.from) &&
          identityKey(b.to) === identityKey(request.to) &&
          b.capability.name === capability.name &&
          b.capability.version === capability.version,
      );
    if (existing) return existing;

    return this.core.bind({
      from: request.from,
      to: request.to,
      capability,
    });
  }

  async #ensureChannel(
    binding: Binding,
    mode: ChannelMode,
    delivery?: DeliveryGuarantee,
  ): Promise<ManagedChannel> {
    const key = `${binding.id}#${mode}`;
    const existing = this.#channels.get(key);
    if (existing && existing.state !== 'CLOSED') return existing;

    // Deduplicate concurrent creation. Without this, three simultaneous `invoke` calls
    // each miss the cache, each derives its own Channel for the same Binding, and the
    // last write wins - so two of the three send their request into a Channel that has
    // no dispatcher attached and hang until their deadline.
    const inFlight = this.#channelPromises.get(key);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const channel = await this.interaction.createChannel({
        binding: binding.id,
        mode,
        ...(delivery !== undefined ? { delivery } : {}),
      });
      await channel.connect();
      this.#channels.set(key, channel);
      return channel;
    })();

    this.#channelPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      this.#channelPromises.delete(key);
    }
  }

  /** The Channel derived from a Binding in a given mode, if one exists. */
  channel(bindingId: string, mode: ChannelMode = 'request'): ManagedChannel | undefined {
    return this.#channels.get(`${bindingId}#${mode}`);
  }

  channelFor(binding: Binding, mode: ChannelMode = 'request'): ManagedChannel | undefined {
    return this.channel(binding.id, mode);
  }

  // ------------------------------------------------------------ 激活 activate

  async activate(plugin: PluginRef): Promise<void> {
    this.#assertLive();
    await this.core.activate(plugin);
    await this.#modules.get(identityKey(plugin))?.activate?.();
  }

  async deactivate(plugin: PluginRef): Promise<void> {
    this.#assertLive();
    await this.core.deactivate(plugin);
    await this.#modules.get(identityKey(plugin))?.deactivate?.();
  }

  /** v3.0 §7.5: suspend keeps Identity and Bindings but leaves Active Composition. */
  async suspend(plugin: PluginRef): Promise<void> {
    this.#assertLive();
    await this.core.suspend(plugin);
    await this.#modules.get(identityKey(plugin))?.suspend?.();
  }

  async resume(plugin: PluginRef): Promise<void> {
    this.#assertLive();
    await this.core.resume(plugin);
    await this.#modules.get(identityKey(plugin))?.resume?.();
  }

  // ---------------------------------------------------------- 通信 communicate

  /** event / stream: append a message to a channel. */
  async publish(request: ConnectRequest, message: unknown): Promise<string> {
    const { channel } = await this.connect(request);
    return this.transport.send(channel.id, message);
  }

  /** event / stream: observe a channel with a v3.1 Subscription. */
  async subscribe(
    channelId: string,
    pattern: { all: true } | { type: string },
    options: SubscriptionOptions = {},
  ): Promise<Subscription<RuntimeMessage>> {
    this.#assertLive();
    const transport = this.transport;
    return TransportSubscription.create<RuntimeMessage>(channelId, options, {
      head: async () => (await transport.resolveAnchor(channelId, 'latest')) ?? '',
      earliest: async () => '',
      readAfter: async (cursor, ack) => {
        const messages = await transport.readAfter(channelId, cursor, pattern);
        return messages.map((message) => {
          // Binding the ack context to the message is what makes the delivered item a
          // v3.1 AckContext rather than a bare payload (CR-1: only ack moves the cursor).
          const context = ack(message.cursor);
          return {
            cursor: message.cursor,
            item: {
              cursor: message.cursor,
              payload: message.payload,
              ack: () => context.ack(),
              nack: () => context.nack(),
            },
          };
        });
      },
      waitForChange: (cursor: string, signal: AbortSignal) =>
        transport.waitForChange(channelId, cursor, signal),
    });
  }

  /** state: derive a StateChannel over a state-mode Channel (v3.2 §10.1, step ③). */
  async stateChannel(request: Omit<ConnectRequest, 'mode'> & { owner?: Identity }): Promise<StateChannel> {
    const { binding, channel } = await this.connect({ ...request, mode: 'state' });
    void binding;
    const existing = this.#stateChannels.get(channel.id);
    if (existing) return existing;

    const stateChannel = configureStateChannel(channel, this.transport, {
      conflictPolicy: 'cas',
      owner: request.owner ?? this.#owner,
    });
    this.#stateChannels.set(channel.id, stateChannel);
    return stateChannel;
  }

  // -------------------------------------------------------------- 调用 invoke

  /**
   * request mode: send a correlated request and await the reply.
   *
   * This really does travel through a Channel — the envelope is appended to the
   * transport log and read back by a dispatcher — because a runtime that "invokes" by
   * calling a function directly would not be exercising the layers it exists to expose.
   */
  async invoke(request: InvokeRequest): Promise<unknown> {
    this.#assertLive();
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    const binding = await this.#ensureBinding({
      from: request.to,
      to: request.from,
      capability: request.capability,
      mode: 'request',
    });
    const channel = await this.#ensureChannel(binding, 'request');
    this.#startDispatcher(binding, channel);

    const correlationId = randomUUID();
    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(correlationId);
        reject(
          new EappError(
            'EAPP_TIMEOUT',
            `no response for '${request.capability.name}' within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(correlationId, { resolve, reject, timer });
    });

    await this.transport.send(channel.id, {
      type: 'request',
      correlationId,
      capability: request.capability.name,
      caller: identityKey(request.from),
      payload: request.payload,
    } satisfies RequestEnvelope);

    return reply;
  }

  /** Register a handler for a plugin after the fact; useful for dynamic wiring. */
  handle(plugin: PluginRef, capability: string, handler: RequestHandler): void {
    const module = this.#modules.get(identityKey(plugin));
    if (!module) {
      throw new EappError('EAPP_PLUGIN_NOT_FOUND', `plugin '${identityKey(plugin)}' is not registered`);
    }
    (module.handlers as Record<string, RequestHandler> | undefined) ??= {};
    (module.handlers as Record<string, RequestHandler>)[capability] = handler;
  }

  #startDispatcher(binding: Binding, channel: ManagedChannel): void {
    // Keyed by channel, not by binding: a binding may derive Channels in several modes,
    // and a dispatcher only ever drains the one it was started for.
    if (this.#dispatchers.has(channel.id)) return;
    const controller = new AbortController();
    this.#dispatchers.set(channel.id, controller);
    void this.#dispatchLoop(binding, channel, controller.signal);
  }

  /**
   * The callee side of request mode.
   *
   * Interest is armed BEFORE the read, for the same reason the subscription does it:
   * reading first and waiting second loses the wakeup whenever the request lands in
   * between, and the invocation would then hang until its timeout.
   */
  async #dispatchLoop(binding: Binding, channel: ManagedChannel, signal: AbortSignal): Promise<void> {
    let cursor = '';
    while (!signal.aborted) {
      const armed: Promise<void> = this.transport
        .waitForChange(channel.id, cursor, signal)
        .catch(() => undefined);

      let batch: TransportMessage[];
      try {
        batch = await this.transport.readAfter(channel.id, cursor, { all: true });
      } catch {
        await armed;
        continue;
      }

      if (batch.length === 0) {
        await armed;
        continue;
      }

      for (const message of batch) {
        cursor = message.cursor;
        const envelope = message.payload;
        if (isResponseEnvelope(envelope)) {
          this.#settle(envelope);
          continue;
        }
        if (isRequestEnvelope(envelope)) {
          await this.#serve(binding, channel, envelope);
        }
      }
    }
  }

  #settle(envelope: ResponseEnvelope): void {
    const pending = this.#pending.get(envelope.correlationId);
    if (!pending) return; // a late reply for a timed-out call; drop it
    this.#pending.delete(envelope.correlationId);
    clearTimeout(pending.timer);
    if (envelope.ok) {
      pending.resolve(envelope.payload);
      return;
    }
    pending.reject(
      new EappError(
        envelope.error?.code ?? 'EAPP_INTERNAL',
        envelope.error?.message ?? 'remote handler failed',
      ),
    );
  }

  async #serve(binding: Binding, channel: ManagedChannel, envelope: RequestEnvelope): Promise<void> {
    const callee = binding.from; // v3.0: `from` provides the capability
    const module = this.#modules.get(identityKey(callee));
    const handler = module?.handlers?.[envelope.capability];

    let response: ResponseEnvelope;
    if (!handler) {
      response = {
        type: 'response',
        correlationId: envelope.correlationId,
        ok: false,
        error: {
          code: 'EAPP_CAPABILITY_NOT_EXPOSED',
          message: `plugin '${identityKey(callee)}' has no handler for '${envelope.capability}'`,
        },
      };
    } else {
      try {
        const payload = await handler(envelope.payload, {
          caller: binding.to,
          callee,
          capability: envelope.capability,
          correlationId: envelope.correlationId,
        });
        response = { type: 'response', correlationId: envelope.correlationId, ok: true, payload };
      } catch (error) {
        response = {
          type: 'response',
          correlationId: envelope.correlationId,
          ok: false,
          error: {
            code: error instanceof EappError ? error.code : 'EAPP_INTERNAL',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }

    await this.transport.send(channel.id, response);
  }

  // ----------------------------------------------------------------- shutdown

  async shutdown(): Promise<void> {
    this.#shutDown = true;
    for (const controller of this.#dispatchers.values()) controller.abort();
    this.#dispatchers.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new EappError('EAPP_INTERNAL', 'runtime shut down'));
    }
    this.#pending.clear();
    for (const channel of this.#channels.values()) await channel.close();
    this.#channels.clear();
    this.#stateChannels.clear();
    await this.transport.close();
  }

  #assertLive(): void {
    if (this.#shutDown) {
      throw new EappError('EAPP_INTERNAL', 'runtime has been shut down');
    }
  }
}

export function createRuntime(options: EappRuntimeOptions = {}): EappRuntime {
  return EappRuntime.create(options);
}

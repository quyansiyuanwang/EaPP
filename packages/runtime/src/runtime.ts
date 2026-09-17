import {
  EappError,
  IdentityRegistry,
  PluginRegistry,
  assertValidIdentity,
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
  CorrelationTracker,
  InteractionLayerImpl,
  TransportSubscription,
  isRequestExpired,
  newCorrelationId,
  type ChannelMode,
  type ConsumerGroup,
  type ConsumerGroupDeps,
  type ConsumerGroupOptions,
  type DeliveryGuarantee,
  type ManagedChannel,
  type Pattern,
  type RequestMessage,
  type ResponseMessage,
  type Subscription,
  type SubscriptionOptions,
  type SubscriptionSource,
  type TransportMessage,
} from '@eapp/interaction';
import { configureStateChannel, type StateChannel, type StateTransport } from '@eapp/state';
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
  /**
   * Any StateTransport, not a concrete MemoryTransport. Typing this as the reference
   * implementation made it impossible to pass a custom transport without a cast — which
   * defeats the point of the Transport boundary.
   */
  transport?: StateTransport;
  /** The runtime's own identity, used as the owner of channels it configures. */
  owner?: Identity;
  domain?: string;
  defaultTimeoutMs?: number;
  /**
   * How Channels are named. Defaults to a per-runtime counter.
   *
   * This exists for the case where one transport is shared by several runtimes —
   * several processes, typically. A Channel's id is the key its messages live under,
   * so runtimes that do not agree on it are not sharing a log: they are each writing
   * to their own and coincidentally giving them the same name.
   *
   * `binding` is supplied because it is the only thing that is genuinely shared.
   * `bindingId` and the default counter are both per-runtime, so deriving the id from
   * the binding's `from` / `to` / `capability` is what makes every participant
   * arrive at the same key.
   */
  channelId?: (context: {
    bindingId: string;
    mode: ChannelMode;
    binding: Binding | undefined;
  }) => string;
}

/** A delivered message together with the v3.1 AckContext that resolves it. */
export interface RuntimeMessage extends TransportMessage {
  ack(): Promise<void>;
  nack(): Promise<void>;
}

/**
 * The runtime's request-mode envelopes extend the frozen v3.1 §3.1 shapes rather than
 * redefining them: `operation`, `payload`, `deadline` and `result` all keep their
 * specified names. Only two runtime-local fields are added — a discriminator, because one
 * channel carries both directions, and the caller's identity.
 */
interface RequestEnvelope extends RequestMessage {
  type: 'request';
  caller: string;
}

interface ResponseEnvelope extends ResponseMessage {
  type: 'response';
}

interface PendingInvocation {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 5000;
/** Fallback pacing when the transport cannot push notifications. */
const DISPATCH_POLL_MS = 25;

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
  readonly transport: StateTransport;
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
  /** RQ-1 / RQ-2 / RQ-3: one request, at most one response, matching correlationId. */
  readonly #correlations = new CorrelationTracker();
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
      ...(options.channelId
        ? {
            nextId: (request: { binding: string; mode: ChannelMode }) =>
              options.channelId!({
                bindingId: request.binding,
                mode: request.mode,
                binding: this.core.binding(request.binding),
              }),
          }
        : {}),
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
    // ID-6 / ID-5: the manifest identity is validated, not sanitised. An earlier revision
    // copied the fields it recognised and silently dropped the rest, so an identity
    // carrying a `version` was accepted with that field quietly removed.
    assertValidIdentity(module.manifest.identity);
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
    // O-5 makes activate() idempotent at the core. The plugin's hook must follow: firing it
    // twice because the core treated the second call as a no-op would make every plugin
    // author defend against a duplicate activation that the contract already rules out.
    if (!(await this.#changeLifecycle(plugin, () => this.core.activate(plugin)))) return;
    await this.#modules.get(identityKey(plugin))?.activate?.();
  }

  async deactivate(plugin: PluginRef): Promise<void> {
    this.#assertLive();
    if (!(await this.#changeLifecycle(plugin, () => this.core.deactivate(plugin)))) return;
    await this.#modules.get(identityKey(plugin))?.deactivate?.();
  }

  /** v3.0 §7.5: suspend keeps Identity and Bindings but leaves Active Composition. */
  async suspend(plugin: PluginRef): Promise<void> {
    this.#assertLive();
    if (!(await this.#changeLifecycle(plugin, () => this.core.suspend(plugin)))) return;
    await this.#modules.get(identityKey(plugin))?.suspend?.();
  }

  async resume(plugin: PluginRef): Promise<void> {
    this.#assertLive();
    if (!(await this.#changeLifecycle(plugin, () => this.core.resume(plugin)))) return;
    await this.#modules.get(identityKey(plugin))?.resume?.();
  }

  /** Runs a lifecycle operation and reports whether the state actually changed. */
  async #changeLifecycle(plugin: PluginRef, operation: () => Promise<void>): Promise<boolean> {
    const before = this.#registry.require(plugin).lifecycle;
    await operation();
    return before !== this.#registry.require(plugin).lifecycle;
  }

  // ---------------------------------------------------------- 通信 communicate

  /**
   * event / stream: append a message to a channel.
   *
   * Refuses on a DRAINING channel. v3.1 §2.4 defines DRAINING as "stop accepting new work,
   * let in-flight finish", and CC-2 puts a channel into that state whenever its Binding
   * derives to DORMANT — so publishing through a suspended composition has to fail rather
   * than quietly queue work nobody is going to run.
   */
  async publish(request: ConnectRequest, message: unknown): Promise<string> {
    const { channel } = await this.connect(request);
    channel.requireActive('publish');
    return this.transport.send(channel.id, message);
  }

  /**
   * The one place that knows how to read a Channel as a v3.1 SubscriptionSource.
   *
   * Both `subscribe()` and `openConsumerGroup()` need exactly this, and a plugin author
   * should never have to hand-roll it: building the source is protocol plumbing, not
   * application logic. Extracting it here is what lets the facade offer competing
   * consumers at all.
   */
  #sourceFor(channelId: string, pattern: Pattern): SubscriptionSource<RuntimeMessage> {
    const transport = this.transport;
    return {
      // `resolveAnchor` and `waitForChange` are optional on the v3.1 Transport: a transport
      // that cannot resolve anchors or push notifications simply gets the slower path.
      head: async () =>
        (transport.resolveAnchor ? await transport.resolveAnchor(channelId, 'latest') : '') ?? '',
      // Asked of the transport rather than hardcoded to the empty sentinel, so a transport
      // with a retention window reports its floor — and raises EAPP_CURSOR_TOO_OLD when
      // there is nothing retained to start from, instead of naming a discarded position.
      earliest: async () =>
        (transport.resolveAnchor ? await transport.resolveAnchor(channelId, 'earliest') : '') ?? '',
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
      ...(transport.waitForChange
        ? {
            waitForChange: (cursor: string, signal: AbortSignal) =>
              transport.waitForChange?.(channelId, cursor, signal) ?? Promise.resolve(),
          }
        : { pollIntervalMs: DISPATCH_POLL_MS }),
    };
  }

  /** event / stream: observe a channel with a v3.1 Subscription. */
  async subscribe(
    channelId: string,
    pattern: { all: true } | { type: string },
    options: SubscriptionOptions = {},
  ): Promise<Subscription<RuntimeMessage>> {
    this.#assertLive();
    // Same rule as publish: DRAINING means the composition is paused, so a new consumer
    // must not attach to it. Resolved through the interaction layer, so a channel the
    // runtime did not derive itself is still checked.
    this.interaction.channel(channelId)?.requireActive('subscribe');
    return TransportSubscription.create<RuntimeMessage>(
      channelId,
      options,
      this.#sourceFor(channelId, pattern),
    );
  }

  // ------------------------------------------------------ 竞争消费 ConsumerGroup

  /**
   * v3.1 §8 and §15 I7: open a competing-consumer scope over a Channel.
   *
   * This exists because the facade previously could not express something the layers
   * could, while `write-a-plugin.md` §8 told plugin authors that exclusivity between
   * consumers "由 ConsumerGroup + Lease 表达". Offering the rule without the operation
   * left them two choices, both wrong: assume one consumer per Channel, or reach past the
   * runtime and hand-build a `SubscriptionSource` — reimplementing protocol plumbing.
   *
   * `pattern` filters what the group competes over, exactly as `subscribe()` does.
   */
  async openConsumerGroup(
    channelId: string,
    options: ConsumerGroupOptions,
    pattern: Pattern = { all: true },
    deps: ConsumerGroupDeps = {},
  ): Promise<ConsumerGroup<RuntimeMessage>> {
    this.#assertLive();
    // A DRAINING channel accepts no new consumers, and a group is a consumer. Checked
    // through the interaction layer so a channel the runtime did not derive is covered too.
    this.interaction.channel(channelId)?.requireActive('openConsumerGroup');
    return this.interaction.openConsumerGroup<RuntimeMessage>(
      channelId,
      options,
      this.#sourceFor(channelId, pattern),
      deps,
    );
  }

  /** CG-8: joining MUST name an existing group on the same Channel. */
  async joinConsumerGroup(
    channelId: string,
    name: string,
  ): Promise<Subscription<RuntimeMessage>> {
    this.#assertLive();
    return this.interaction.joinConsumerGroup<RuntimeMessage>(channelId, name);
  }

  consumerGroup(channelId: string, name: string): ConsumerGroup<RuntimeMessage> | undefined {
    return this.interaction.consumerGroup(channelId, name) as
      | ConsumerGroup<RuntimeMessage>
      | undefined;
  }

  /** The groups currently open on a Channel. Names are unique within it (CG-1). */
  listConsumerGroups(channelId: string): ConsumerGroup<RuntimeMessage>[] {
    return this.interaction.listConsumerGroups(channelId) as ConsumerGroup<RuntimeMessage>[];
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

    const correlationId = newCorrelationId('invoke');
    this.#correlations.begin(correlationId); // RQ-1
    const deadline = Date.now() + timeoutMs;

    const reply = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(correlationId);
        this.#correlations.abandon(correlationId); // RQ-4: a timed-out request is settled
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
      operation: request.capability.name,
      caller: identityKey(request.from),
      payload: request.payload,
      deadline,
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
      // Arm before reading. A transport without `waitForChange` gets a bounded poll
      // instead — but never a busy loop.
      const armed: Promise<void> = (
        this.transport.waitForChange
          ? this.transport.waitForChange(channel.id, cursor, signal)
          : new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, DISPATCH_POLL_MS);
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            })
      ).catch(() => undefined);

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
    // RQ-2 / RQ-3: a second reply to the same request, or a reply nobody is waiting for
    // (a late one after a timeout), is dropped rather than resolving the call twice.
    if (!this.#correlations.settle(envelope)) return;
    const pending = this.#pending.get(envelope.correlationId);
    if (!pending) return;
    this.#pending.delete(envelope.correlationId);
    clearTimeout(pending.timer);
    if (envelope.ok) {
      pending.resolve(envelope.result);
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
    const handler = module?.handlers?.[envelope.operation];

    let response: ResponseEnvelope;
    if (isRequestExpired(envelope)) {
      // RQ-4: the deadline has already passed, so the work must not be started at all.
      response = {
        type: 'response',
        correlationId: envelope.correlationId,
        ok: false,
        error: { code: 'EAPP_TIMEOUT', message: 'request deadline already passed' },
      };
    } else if (!handler) {
      response = {
        type: 'response',
        correlationId: envelope.correlationId,
        ok: false,
        error: {
          code: 'EAPP_CAPABILITY_NOT_EXPOSED',
          message: `plugin '${identityKey(callee)}' has no handler for '${envelope.operation}'`,
        },
      };
    } else {
      try {
        const result = await handler(envelope.payload, {
          caller: binding.to,
          callee,
          capability: envelope.operation,
          correlationId: envelope.correlationId,
        });
        response = { type: 'response', correlationId: envelope.correlationId, ok: true, result };
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

    // A reply that cannot be delivered is dropped, not thrown.
    //
    // `shutdown()` aborts the dispatcher and closes the transport while a handler may
    // still be running: a handler that is sleeping, or waiting on a peer, does not stop
    // just because we stopped listening. Letting the transport's "closed" error escape
    // from here turns an ordinary sequence — shut down while something is in flight —
    // into an unhandled rejection that kills the process. The caller has either already
    // timed out (RQ-4) or is going away with the runtime, so there is nobody left to hand
    // the answer to. This is the only reasonable handling of a failed `send` of a response.
    try {
      await this.transport.send(channel.id, response);
    } catch {
      return;
    }
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

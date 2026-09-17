/**
 * Conformance driver for the TypeScript reference implementation.
 *
 *   npx tsx conformance/drivers/reference.ts
 *
 * This adapter exists so the harness can be checked for fairness. If only one
 * implementation were ever run against it, a check that happened to encode that
 * implementation's quirks would look like a spec requirement — and every other
 * implementation would fail it for no reason. Running two independent ones makes
 * that discoverable: a failure now means either the implementation or the check is
 * wrong, and both are worth knowing about.
 *
 * It is an adapter and nothing else: no behaviour lives here that is not in
 * `@eapp/core`, because a driver that added any would be testing itself.
 */

import {
  DiscoveryService,
  EappError,
  IdentityRegistry,
  PluginRegistry,
  createCompositionCore,
  type Binding,
  type CompositionCoreImpl,
  type Discovery,
  type Identity,
  type Plugin,
} from '../../packages/core/src/index.js';
import {
  InteractionLayerImpl,
  TransportSubscription,
  type ChannelMode,
  type ConsumerGroup,
  type DeliveryGuarantee,
  type ManagedChannel,
  type Subscription,
  type SubscriptionOptions,
  type SubscriptionSource,
} from '../../packages/interaction/src/index.js';
import { MemoryTransport } from '../../packages/transport/memory/src/index.js';

// ---------------------------------------------------------------------------
// Protocol plumbing
// ---------------------------------------------------------------------------

interface Request {
  id: number;
  op: string;
  [key: string]: unknown;
}

const write = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

/**
 * An identity from the wire, passed to the core **untouched**.
 *
 * Deliberately not validated here. Fields beyond `domain`/`id`/`instance` are part
 * of what `plugin.register` has to test (ID-6), and `IdentityRegistry.create`
 * already rejects them. Validating in the adapter instead would mean the adapter —
 * not the implementation — is what conforms, and the check would pass even if the
 * core stopped enforcing the rule.
 */
const asIdentity = (value: unknown): Identity => (value ?? {}) as Identity;

/** A creation seed. Same reasoning: the core's own checks must be the ones that fire. */
const asSeed = (value: unknown): { domain: string; id: string; instance?: string } =>
  (value ?? {}) as { domain: string; id: string; instance?: string };

const toCapabilities = (value: unknown): Plugin['capabilities'] => {
  if (!Array.isArray(value)) {
    throw new EappError('EAPP_CAPABILITY_NOT_FOUND', 'capabilities must be an array');
  }
  return value as Plugin['capabilities'];
};

// ---------------------------------------------------------------------------
// Interaction: what the wire has to stand in for
// ---------------------------------------------------------------------------

/** A delivered item, as v3.1 §7.1 defines it: a payload with its own AckContext. */
interface Delivered {
  cursor: string;
  payload: unknown;
  ack(): Promise<void>;
  nack(): Promise<void>;
}

/**
 * A subscription plus the in-flight `next()`.
 *
 * The spec models consumption as an async iterator; the wire models it as `pull`. Those
 * are not the same shape, and bridging them by calling `next()` per pull would queue a
 * second read behind the first whenever a pull times out — so the outstanding read is
 * held here and reused. A pull that times out leaves the read running; the next pull
 * picks it up. That preserves "one reader per subscription" without inventing a
 * cancellation the protocol does not have.
 */
interface SubHandle {
  sub: Subscription<Delivered>;
  iterator: AsyncIterator<Delivered>;
  inFlight: Promise<IteratorResult<Delivered>> | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

class Driver {
  #identities = new IdentityRegistry();
  #registry = new PluginRegistry();
  #core!: CompositionCoreImpl;
  #discovery: Discovery | undefined;
  #watches = new Map<number, { abort: AbortController }>();
  #watchSeq = 0;

  #transport!: MemoryTransport;
  #interaction!: InteractionLayerImpl;
  #subs = new Map<string, SubHandle>();
  #subSeq = 0;
  #deliveries = new Map<string, Delivered>();
  #deliverySeq = 0;
  #groups = new Map<string, ConsumerGroup<Delivered>>();
  #groupSeq = 0;

  constructor() {
    this.#reset();
  }

  #reset(): void {
    for (const watch of this.#watches.values()) watch.abort.abort();
    this.#watches.clear();
    this.#identities = new IdentityRegistry();
    this.#registry = new PluginRegistry();
    this.#core = createCompositionCore(this.#registry);
    this.#discovery = undefined;
    this.#watchSeq = 0;

    this.#transport = new MemoryTransport();
    this.#subs.clear();
    this.#deliveries.clear();
    this.#groups.clear();
    this.#subSeq = 0;
    this.#deliverySeq = 0;
    this.#groupSeq = 0;

    // The same wiring `EappRuntime` uses, and for the same reason: the core notifies
    // with (binding, state) while the layer wants (bindingId, state). Adapting here
    // keeps both layers' own shapes intact.
    this.#interaction = new InteractionLayerImpl({
      transport: this.#transport,
      bindings: {
        binding: (id) => this.#core.binding(id),
        bindingState: (id) => (this.#core.binding(id) ? this.#core.bindingState(id) : 'CLOSED'),
        onBindingStateChange: (listener) =>
          this.#core.onBindingStateChange((binding, state) => listener(binding.id, state)),
      },
      nextId: (request) => `${request.binding}:${request.mode}`,
    });
  }

  /**
   * The channel's own subscription source, built exactly as the facade builds it.
   *
   * A plugin author never hand-rolls this; the driver should not either, or the driver
   * would be part of what conforms.
   */
  #sourceFor(channelId: string): SubscriptionSource<Delivered> {
    const transport = this.#transport;
    return {
      head: async () =>
        (transport.resolveAnchor ? await transport.resolveAnchor(channelId, 'latest') : '') ?? '',
      earliest: async () =>
        (transport.resolveAnchor ? await transport.resolveAnchor(channelId, 'earliest') : '') ?? '',
      readAfter: async (cursor, ack) => {
        const messages = await transport.readAfter(channelId, cursor, { all: true });
        return messages.map((message) => {
          // Binding the ack context to the message is what makes the delivered item a
          // v3.1 AckContext rather than a bare payload: only ack moves the cursor.
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
        : { pollIntervalMs: 10 }),
    };
  }

  #sub(token: string): SubHandle {
    const handle = this.#subs.get(token);
    if (!handle) throw new EappError('EAPP_SUBSCRIPTION_INVALID', `unknown subscription '${token}'`);
    return handle;
  }

  /** One pull: reuse the outstanding read if there is one, otherwise start one. */
  async #pull(handle: SubHandle, timeoutMs: number): Promise<{ item: Delivered | null; done: boolean }> {
    handle.inFlight ??= handle.iterator.next();
    const read = handle.inFlight;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    try {
      const outcome = await Promise.race([read, timeout]);
      if (outcome === 'timeout') return { item: null, done: false };

      handle.inFlight = null;
      if (outcome.done === true) return { item: null, done: true };
      const item = outcome.value;
      this.#deliverySeq += 1;
      const token = `d-${this.#deliverySeq}`;
      this.#deliveries.set(token, item);
      return { item: { ...item, delivery: token } as Delivered & { delivery: string }, done: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async handle(request: Request): Promise<unknown> {
    const { op } = request;

    switch (op) {
      case 'reset':
        this.#reset();
        return {};

      // ------------------------------------------------------------------ identity
      case 'identity.create':
        // `identity` is an object, not three flat fields: a flat `id` would collide
        // with the envelope's correlation field, and one request would carry two
        // different meanings for the same key.
        return this.#identities.create(asSeed(request.identity));

      case 'identity.has': {
        const identity = asIdentity(request.identity);
        return { has: this.#identities.has(identity) };
      }

      // -------------------------------------------------------------------- plugin
      case 'plugin.register': {
        // The manifest identity goes to the core untouched, extras included. ID-6 is
        // the core's rule to enforce, so the check has to watch the core enforce it —
        // pre-validating in the adapter would make the adapter the thing that conforms.
        const requested = asSeed(request.identity);
        const identity = this.#identities.isIssued(asIdentity(request.identity))
          ? this.#identities.require(asIdentity(request.identity))
          : this.#identities.create(requested);
        this.#registry.register({
          identity,
          capabilities: [...toCapabilities(request.capabilities)],
          lifecycle: 'INACTIVE',
        });
        return identity;
      }

      case 'plugin.get': {
        const plugin = this.#registry.require(asIdentity(request.identity));
        return plugin;
      }

      case 'plugin.list':
        return this.#registry.list();

      // ----------------------------------------------------------------- lifecycle
      case 'lifecycle.activate':
      case 'lifecycle.deactivate':
      case 'lifecycle.suspend':
      case 'lifecycle.resume': {
        const ref = asIdentity(request.identity);
        const operation = op.slice('lifecycle.'.length) as
          | 'activate'
          | 'deactivate'
          | 'suspend'
          | 'resume';
        await this.#core[operation](ref);
        return { lifecycle: this.#registry.require(ref).lifecycle };
      }

      // ----------------------------------------------------------------- discovery
      case 'discovery.find': {
        const criteria = (request.criteria ?? {}) as Record<string, unknown>;
        const scope = (request.scope ?? {}) as Record<string, unknown>;
        return this.#discoverySource().find(criteria as never, scope as never);
      }

      case 'discovery.watch': {
        const criteria = (request.criteria ?? {}) as Record<string, unknown>;
        const scope = (request.scope ?? {}) as Record<string, unknown>;
        const id = ++this.#watchSeq;
        const abort = new AbortController();
        this.#watches.set(id, { abort });

        void (async () => {
          try {
            for await (const event of this.#discoverySource().watch(criteria as never, scope as never)) {
              if (abort.signal.aborted) return;
              // No `id`: this is an event, not a reply.
              write({ event: 'discovery', watch: id, type: event.type, plugin: event.plugin });
            }
          } catch {
            // A watch on a scope with no policy fails where it is created, not here;
            // if it does fail mid-stream there is nobody to tell but the harness,
            // and inventing a frame for it would be worse than stopping.
          }
        })();

        return { watch: id };
      }

      case 'discovery.unwatch': {
        const id = Number(request.watch);
        this.#watches.get(id)?.abort.abort();
        this.#watches.delete(id);
        return {};
      }

      // --------------------------------------------------------------- composition
      case 'composition.bind':
        return this.#core.bind({
          from: asIdentity(request.from),
          to: asIdentity(request.to),
          capability: {
            ...(request.capability as { name: string; version: string }),
            plugin: asIdentity(request.from),
          },
        } as never);

      case 'composition.unbind':
        await this.#core.unbind(String(request.binding));
        return {};

      case 'composition.binding': {
        const binding = this.#core.binding(String(request.binding));
        if (!binding) {
          throw new EappError('EAPP_BINDING_INVALID', `unknown binding '${String(request.binding)}'`);
        }
        return toStringBinding(binding);
      }

      case 'composition.bindingState':
        return { state: this.#core.bindingState(String(request.binding)) };

      case 'composition.bindings':
        return this.#core.listBindings().map(toStringBinding);

      // ----------------------------------------------------------------- bootstrap
      case 'bootstrap.createIdentity':
        // BR-2: minting an identity touches no plugin.
        return this.#identities.create({ domain: 'eapp.bootstrap', id: String(request.seed ?? 'root') });

      case 'bootstrap.loadFirstPlugin': {
        const ref = asIdentity(request.identity);
        const known = this.#registry.get(ref);
        if (!known) {
          throw new EappError('EAPP_PLUGIN_NOT_FOUND', `bootstrap cannot resolve '${ref.id}'`);
        }
        return known;
      }

      case 'bootstrap.initialDiscovery':
        this.#discovery = new DiscoveryService(this.#registry);
        return { ok: true };

      // ------------------------------------------------------ interaction: channel
      case 'channel.create': {
        const channel = await this.#interaction.createChannel({
          binding: String(request.binding),
          mode: request.mode as ChannelMode,
          ...(request.delivery === undefined
            ? {}
            : { delivery: request.delivery as DeliveryGuarantee }),
        });
        return toChannel(channel);
      }

      case 'channel.connect': {
        const channel = this.#channel(request.channel);
        await channel.connect();
        return toChannel(channel);
      }

      case 'channel.get':
        return toChannel(this.#channel(request.channel));

      case 'channel.channels':
        return this.#interaction.listChannels().map(toChannel);

      case 'channel.send': {
        const channel = this.#channel(request.channel);
        channel.requireActive('send');
        // Sending goes through the transport, because that is who assigns cursors
        // (TR-8). The Channel decides whether sending is allowed; the Transport decides
        // where the message lands.
        return { cursor: await this.#transport.send(channel.id, request.payload) };
      }

      case 'channel.close':
        await this.#interaction.closeChannel(String(request.channel));
        return {};

      // ------------------------------------------------- interaction: subscription
      case 'subscription.open': {
        const channelId = String(request.channel);
        const options = (request.options ?? {}) as SubscriptionOptions;
        this.#channel(channelId).requireActive('subscribe');

        const sub =
          options.mode === 'group'
            ? await this.#interaction.joinConsumerGroup<Delivered>(channelId, String(options.group))
            : await TransportSubscription.create<Delivered>(
                channelId,
                options,
                this.#sourceFor(channelId),
              );

        const token = `s-${(this.#subSeq += 1)}`;
        this.#subs.set(token, { sub, iterator: sub[Symbol.asyncIterator](), inFlight: null });
        return {
          subscription: token,
          cursor: sub.cursor,
          mode: sub.mode,
          state: sub.state,
        };
      }

      case 'subscription.pull': {
        const handle = this.#sub(String(request.subscription));
        const timeoutMs = Number(request.timeoutMs ?? 1_000);
        return this.#pull(handle, Number.isFinite(timeoutMs) ? timeoutMs : 1_000);
      }

      case 'subscription.ack':
      case 'subscription.nack': {
        this.#sub(String(request.subscription)); // the token must belong to a live subscription
        const delivered = this.#deliveries.get(String(request.delivery));
        if (!delivered) {
          throw new EappError('EAPP_LEASE_CLOSED', `unknown delivery '${String(request.delivery)}'`);
        }
        await (op === 'subscription.ack' ? delivered.ack() : delivered.nack());
        return {};
      }

      case 'subscription.state': {
        const handle = this.#sub(String(request.subscription));
        return { state: handle.sub.state, cursor: handle.sub.cursor };
      }

      case 'subscription.suspend':
        await this.#sub(String(request.subscription)).sub.suspend();
        return {};

      case 'subscription.resume':
        await this.#sub(String(request.subscription)).sub.resume();
        return {};

      case 'subscription.close':
        await this.#sub(String(request.subscription)).sub.close();
        return {};

      // ------------------------------------------------- interaction: group
      case 'group.open': {
        const channelId = String(request.channel);
        this.#channel(channelId).requireActive('openConsumerGroup');
        const group = await this.#interaction.openConsumerGroup<Delivered>(
          channelId,
          {
            name: String(request.name),
            ...(request.claimTtlMs === undefined
              ? {}
              : { claimTtlMs: Number(request.claimTtlMs) }),
          },
          this.#sourceFor(channelId),
        );
        const token = `g-${(this.#groupSeq += 1)}`;
        this.#groups.set(token, group);
        return toGroup(token, group);
      }

      case 'group.view': {
        const token = String(request.group);
        const group = this.#groups.get(token);
        if (!group) throw new EappError('EAPP_SUBSCRIPTION_INVALID', `unknown group '${token}'`);
        return toGroup(token, group);
      }

      case 'group.close': {
        const token = String(request.group);
        const group = this.#groups.get(token);
        if (!group) throw new EappError('EAPP_SUBSCRIPTION_INVALID', `unknown group '${token}'`);
        await group.close();
        return {};
      }

      // ------------------------------------------------- interaction: transport
      case 'transport.capabilities':
        return this.#transport.capabilities;

      case 'transport.send':
        return { cursor: await this.#transport.send(String(request.channel), request.payload) };

      case 'transport.readAfter': {
        const cursor = request.cursor === undefined || request.cursor === null
          ? undefined
          : String(request.cursor);
        const pattern = (request.pattern ?? { all: true }) as { all: true } | { type: string };
        const messages = await this.#transport.readAfter(String(request.channel), cursor, pattern);
        return messages.map((message) => ({ cursor: message.cursor, payload: message.payload }));
      }

      default:
        throw new EappError('EAPP_UNSUPPORTED', `unknown driver operation '${op}'`);
    }
  }

  #channel(id: unknown): ManagedChannel {
    const channel = this.#interaction.channel(String(id));
    if (!channel) throw new EappError('EAPP_CHANNEL_INVALID', `unknown channel '${String(id)}'`);
    return channel;
  }

  #discoverySource(): Discovery {
    this.#discovery ??= new DiscoveryService(this.#registry);
    return this.#discovery;
  }
}

/** `Binding.capability` carries the `plugin` field; the wire shape keeps it flat. */
function toStringBinding(binding: Binding): Record<string, unknown> {
  return {
    id: binding.id,
    from: binding.from,
    to: binding.to,
    capability: {
      name: binding.capability.name,
      version: binding.capability.version,
      plugin: binding.capability.plugin,
    },
  };
}

/** v3.1 §2.1, as the wire sees it. */
const toChannel = (channel: ManagedChannel): Record<string, unknown> => ({
  id: channel.id,
  binding: channel.binding,
  mode: channel.mode,
  delivery: channel.delivery,
  state: channel.state,
});

/**
 * v3.1 §8.2, as the wire sees it.
 *
 * `cursor` and `memberCount` are frozen as *synchronous* properties, so this can only
 * report what the group last observed. The harness is told the same thing in
 * `conformance/driver.md`: it MUST NOT assert byte-equality with a global value across
 * processes, because §8.2 does not promise that.
 */
const toGroup = (token: string, group: ConsumerGroup<Delivered>): Record<string, unknown> => ({
  id: token,
  name: group.name,
  channel: group.channel,
  cursor: group.cursor,
  memberCount: group.memberCount,
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const driver = new Driver();

// One hello line, then a response per request. Written directly rather than
// buffered: the harness is waiting on each reply before it sends the next one.
write({
  hello: true,
  driver: 'eapp-ts',
  layers: ['core', 'interaction'],
  eappVersion: '3.3.0',
});

let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffered += chunk;
  let index = buffered.indexOf('\n');
  while (index !== -1) {
    const line = buffered.slice(0, index);
    buffered = buffered.slice(index + 1);
    if (line.trim().length > 0) void dispatch(line);
    index = buffered.indexOf('\n');
  }
});

async function dispatch(line: string): Promise<void> {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    // Malformed input is not attributable to a request id, so there is nothing to
    // reply to. Stopping is more honest than inventing one.
    process.exit(1);
    return;
  }

  try {
    write({ id: request.id, ok: true, result: await driver.handle(request) });
  } catch (error) {
    write({
      id: request.id,
      ok: false,
      error:
        error instanceof EappError
          ? { code: error.code, message: error.message }
          : {
              code: 'EAPP_INTERNAL',
              message: error instanceof Error ? error.message : String(error),
            },
    });
  }
}

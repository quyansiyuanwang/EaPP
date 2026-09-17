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
// State
// ---------------------------------------------------------------------------

class Driver {
  #identities = new IdentityRegistry();
  #registry = new PluginRegistry();
  #core!: CompositionCoreImpl;
  #discovery: Discovery | undefined;
  #watches = new Map<number, { abort: AbortController }>();
  #watchSeq = 0;

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

      default:
        throw new EappError('EAPP_UNSUPPORTED', `unknown driver operation '${op}'`);
    }
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

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const driver = new Driver();

// One hello line, then a response per request. Written directly rather than
// buffered: the harness is waiting on each reply before it sends the next one.
write({
  hello: true,
  driver: 'eapp-ts',
  layers: ['core'],
  eappVersion: '3.0.0',
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

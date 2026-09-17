import {
  DiscoveryService,
  EappError,
  IdentityRegistry,
  PluginRegistry,
  identityKey,
  type Discovery,
  type Identity,
  type Plugin,
  type PluginRef,
} from '@eapp/core';

/**
 * Bootstrap Runtime — EaPP v3.0.0 §12.
 *
 * The smallest thing that can start. It exists because of a bootstrapping problem: to
 * load a plugin you need a PluginRef, and to get a PluginRef you need something already
 * running. §12 answers it with a root that is deliberately replaceable — "根可以是可替换
 * 的，但它必须先存在" — and three obligations:
 *
 *   BR-1  MUST NOT be replaced by something nonexistent
 *   BR-2  MUST NOT depend on any Plugin
 *   BR-3  MUST provide at least one initial Discovery
 */

export interface BootstrapCatalog {
  /** Resolve a PluginRef to a plugin module, or undefined if the runtime has never seen it. */
  lookup(ref: PluginRef): Plugin | undefined;
}

export interface BootstrapRuntime {
  createIdentity(seed: unknown): Promise<Identity>;
  loadFirstPlugin(ref: PluginRef): Promise<Plugin>;
  provideInitialDiscovery(): Discovery;
}

export interface BootstrapOptions {
  domain?: string;
  catalog?: BootstrapCatalog;
}

export class BootstrapRuntimeImpl implements BootstrapRuntime {
  readonly #identities = new IdentityRegistry();
  readonly #registry: PluginRegistry;
  readonly #domain: string;
  readonly #catalog: BootstrapCatalog | undefined;
  #discovery: Discovery;

  constructor(options: BootstrapOptions = {}) {
    this.#domain = options.domain ?? 'eapp.bootstrap';
    this.#registry = new PluginRegistry();
    this.#catalog = options.catalog;
    // BR-3: an initial Discovery exists before anything is loaded.
    this.#discovery = new DiscoveryService(this.#registry);
  }

  get registry(): PluginRegistry {
    return this.#registry;
  }

  /**
   * BR-2: minting an identity touches no plugin and no discovery, so the root can always
   * produce the very first reference it needs.
   */
  async createIdentity(seed: unknown): Promise<Identity> {
    if (seed === null || seed === undefined) {
      throw new EappError('EAPP_IDENTITY_INVALID', 'bootstrap identity seed is required');
    }
    const id = typeof seed === 'string' ? seed : identityKey(seed as PluginRef);
    return this.#identities.create({ domain: this.#domain, id });
  }

  /**
   * BR-1: an unknown reference fails loudly. The bootstrap NEVER invents a placeholder
   * root to keep going, because a silent stand-in is indistinguishable from a real plugin
   * to everything downstream.
   */
  async loadFirstPlugin(ref: PluginRef): Promise<Plugin> {
    const known = this.#registry.get(ref) ?? this.#catalog?.lookup(ref);
    if (!known) {
      throw new EappError(
        'EAPP_PLUGIN_NOT_FOUND',
        `bootstrap cannot resolve '${identityKey(ref)}'`,
      );
    }
    const existing = this.#registry.get(ref);
    if (existing) return existing;

    this.#registry.register(known);
    return this.#registry.require(ref);
  }

  /** BR-3. */
  provideInitialDiscovery(): Discovery {
    return this.#discovery;
  }

  /**
   * §12.3: once a first plugin is loaded it SHOULD be able to supply a new Discovery and
   * gradually replace the initial one. The old root is never destroyed on a failed
   * handover — replacement requires a real object.
   */
  replaceDiscovery(replacement: Discovery | undefined): void {
    if (!replacement || typeof replacement.find !== 'function') {
      throw new EappError('EAPP_UNSUPPORTED', 'a replacement Discovery must be a real Discovery');
    }
    this.#discovery = replacement;
  }

  /** BR-3 hold-out: at least one initial Discovery is always available. */
  static initialDiscovery(registry: PluginRegistry): Discovery {
    return new DiscoveryService(registry);
  }
}

export function createBootstrapRuntime(options: BootstrapOptions = {}): BootstrapRuntimeImpl {
  return new BootstrapRuntimeImpl(options);
}

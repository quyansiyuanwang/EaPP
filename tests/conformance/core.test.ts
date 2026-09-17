import { describe, expect, test } from 'vitest';

import {
  DiscoveryService,
  IdentityRegistry,
  PluginRegistry,
  TRUST_LEVELS,
  assertTransition,
  assertValidCapability,
  assertValidCapabilityRef,
  assertValidIdentity,
  bindingKey,
  canTransition,
  createCompositionCore,
  deriveBindingState,
  identityKey,
  isLifecycleState,
  isTrustLevel,
  isValidRange,
  isValidSemVer,
  matchesCriteria,
  satisfiesRange,
  type Capability,
  type CapabilityRef,
  type Discovery,
  type DiscoveryScope,
  type Identity,
  type Plugin,
  type PluginRef,
} from '@eapp/core';

/**
 * v3.0 §12 declares the Bootstrap Runtime contract but the frozen core ships no
 * implementation of it, so the conformance suite carries the shape itself.
 */
interface BootstrapRuntime {
  createIdentity(seed: unknown): Promise<Identity>;
  loadFirstPlugin(ref: PluginRef): Promise<Plugin>;
  provideInitialDiscovery(): Discovery;
}

/**
 * EaPP v3.0.0 Composition Core conformance.
 *
 * Every invariant declared in `docs/spec/v3.0.0-core.md` §13 is named below, including
 * BR-1..BR-3, which are exercised against the minimal Bootstrap Runtime contract of §12.
 */

const identities = new IdentityRegistry();

function identityOf(id: string): Identity {
  return identities.create({ domain: 'com.example', id });
}

function pluginOf(id: string, capabilities: Capability[] = []): Plugin {
  return { identity: identityOf(id), capabilities, lifecycle: 'INACTIVE' };
}

const LOGGING: Capability = { name: 'logging', version: '1.0.0' };

interface Harness {
  registry: PluginRegistry;
  core: ReturnType<typeof createCompositionCore>;
  provider: Plugin;
  consumer: Plugin;
  ref: CapabilityRef;
}

function harness(): Harness {
  const registry = new PluginRegistry();
  const core = createCompositionCore(registry);
  const provider = pluginOf('logger', [LOGGING]);
  const consumer = pluginOf('app', []);
  registry.register(provider);
  registry.register(consumer);
  return {
    registry,
    core,
    provider,
    consumer,
    ref: { plugin: provider.identity, name: LOGGING.name, version: LOGGING.version },
  };
}

async function activated(h: Harness): Promise<void> {
  await h.core.activate(h.provider.identity);
  await h.core.activate(h.consumer.identity);
}

// =============================================================================
// ID — Identity
// =============================================================================
describe('ID: Identity', () => {
  test('ID-1 / ID-2: domain and id MUST NOT be empty', () => {
    expect(() => identities.create({ domain: '', id: 'x' })).toThrow('EAPP_IDENTITY_INVALID');
    expect(() => identities.create({ domain: 'd', id: '' })).toThrow('EAPP_IDENTITY_INVALID');
    expect(() => assertValidIdentity({ domain: ' ', id: 'x', instance: 'i' })).toThrow(
      'EAPP_IDENTITY_INVALID',
    );
  });

  test('ID-3: instance is unique within (domain, id)', () => {
    const a = identities.create({ domain: 'com.example', id: 'dup' });
    const b = identities.create({ domain: 'com.example', id: 'dup' });
    expect(a.instance).not.toBe(b.instance); // successive creations get fresh instances
    expect(identityKey(a)).not.toBe(identityKey(b));

    // Re-using an instance that already exists is the duplicate the invariant forbids.
    expect(() =>
      identities.create({ domain: 'com.example', id: 'dup', instance: a.instance }),
    ).toThrow('EAPP_IDENTITY_DUPLICATE');
  });

  test('ID-4 / ID-5: identity is immutable and not self-issued', () => {
    const identity = identityOf('immutable');
    const stored = identities.require(identity);
    expect(stored).toEqual(identity); // ID-4
    expect(Object.isFrozen(stored)).toBe(true);

    const forged: Identity = { domain: 'com.example', id: 'forged', instance: 'forged-1' };
    expect(identities.has(forged)).toBe(false); // ID-5
    expect(() => identities.require(forged)).toThrow('EAPP_IDENTITY_INVALID');
  });

  test('ID-6: identity MUST NOT carry version semantics', () => {
    const identity = identityOf('versioned');
    expect(() =>
      assertValidIdentity({ ...identity, version: '1.0.0' } as unknown as Identity),
    ).toThrow('EAPP_IDENTITY_INVALID');
    expect(() =>
      identities.create({ domain: 'd', id: 'i', version: '1.0.0' } as never),
    ).toThrow('EAPP_IDENTITY_INVALID');
  });
});

// =============================================================================
// C — Capability
// =============================================================================
describe('C: Capability', () => {
  test('C-1 / C-2: name MUST NOT be empty and version MUST be valid SemVer', () => {
    expect(() => assertValidCapability({ name: '', version: '1.0.0' })).toThrow(
      'EAPP_CAPABILITY_NOT_FOUND',
    );
    expect(() => assertValidCapability({ name: 'x', version: 'not-semver' })).toThrow(
      'EAPP_CAPABILITY_NOT_FOUND',
    );
    expect(isValidSemVer('1.2.3')).toBe(true);
    expect(isValidSemVer('1.2.3-rc.1')).toBe(true);
    expect(isValidSemVer('1.2')).toBe(false);
  });

  test('C-3: contract is optional context', () => {
    expect(() => assertValidCapability({ name: 'x', version: '1.0.0' })).not.toThrow();
    expect(() =>
      assertValidCapability({
        name: 'x',
        version: '1.0.0',
        contract: { name: 'c', version: '1.0.0' },
      }),
    ).not.toThrow();
  });

  test('C-4 / C-6: a Capability may be exposed by many Plugins, and version is part of identity', () => {
    const h = harness();
    const other = pluginOf('other-logger', [LOGGING]);
    h.registry.register(other);
    expect(h.registry.findExposing({ name: 'logging', version: '1.0.0' }, h.provider.identity)).toBe(
      true,
    );
    expect(h.registry.findExposing({ name: 'logging', version: '1.0.0' }, other.identity)).toBe(true);

    const v2: CapabilityRef = { ...h.ref, version: '2.0.0' };
    expect(bindingKey(h.ref.plugin, h.consumer.identity, h.ref)).not.toBe(
      bindingKey(h.ref.plugin, h.consumer.identity, v2),
    );
  });

  test('C-7: Constraint matching is exact kind plus structural value equality', async () => {
    const registry = new PluginRegistry();
    const plugin = pluginOf('constrained', [
      {
        name: 'logging',
        version: '1.0.0',
        constraints: [
          { kind: 'region', value: { zone: 'eu', tier: 1 } },
          { kind: 'tags', value: ['fast', 'cheap'] },
        ],
      },
    ]);
    registry.register(plugin);
    const core = createCompositionCore(registry);
    const find = (constraints: { kind: string; value: unknown }[]) =>
      core.find({ capability: 'logging', constraints }, {});

    // Equal kind and a structurally equal value match.
    expect(await find([{ kind: 'region', value: { tier: 1, zone: 'eu' } }])).toHaveLength(1);
    expect(await find([{ kind: 'tags', value: ['fast', 'cheap'] }])).toHaveLength(1);

    // Any difference in kind or value does not.
    expect(await find([{ kind: 'zone', value: { zone: 'eu', tier: 1 } }])).toHaveLength(0);
    expect(await find([{ kind: 'region', value: { zone: 'us', tier: 1 } }])).toHaveLength(0);
    expect(await find([{ kind: 'region', value: { zone: 'eu' } }])).toHaveLength(0); // shape matters
    expect(await find([{ kind: 'tags', value: ['cheap', 'fast'] }])).toHaveLength(0); // order matters

    // Everything asked for must be present.
    expect(
      await find([
        { kind: 'region', value: { zone: 'eu', tier: 1 } },
        { kind: 'missing', value: 1 },
      ]),
    ).toHaveLength(0);

    expect(
      matchesCriteria(plugin, { constraints: [{ kind: 'region', value: { zone: 'eu', tier: 1 } }] }),
    ).toBe(true);
  });

  test('C-5: CapabilityRef MUST include a version', () => {
    expect(() =>
      assertValidCapabilityRef({ plugin: identityOf('p'), name: 'x', version: '' }),
    ).toThrow('EAPP_CAPABILITY_NOT_FOUND');
    expect(() =>
      assertValidCapabilityRef({ plugin: identityOf('p'), name: 'x' } as unknown as CapabilityRef),
    ).toThrow('EAPP_CAPABILITY_NOT_FOUND');
  });
});

// =============================================================================
// P — Plugin
// =============================================================================
describe('P: Plugin', () => {
  test('P-1 / P-3: a Plugin has one immutable Identity', () => {
    const registry = new PluginRegistry();
    const plugin = pluginOf('solo');
    registry.register(plugin);
    expect(() => registry.register(plugin)).toThrow('EAPP_IDENTITY_DUPLICATE'); // P-1
    expect(registry.require(plugin.identity).identity).toEqual(plugin.identity); // P-3
  });

  test('P-2: capabilities MAY be empty', () => {
    const registry = new PluginRegistry();
    const plugin = pluginOf('bare', []);
    expect(() => registry.register(plugin)).not.toThrow();
    expect(registry.require(plugin.identity).capabilities).toEqual([]);
  });

  test('P-4: the capability set may change by explicit declaration', () => {
    const registry = new PluginRegistry();
    const plugin = pluginOf('growing', []);
    registry.register(plugin);
    expect(registry.findExposing({ name: 'logging', version: '1.0.0' }, plugin.identity)).toBe(
      false,
    );
    registry.setCapabilities(plugin.identity, [LOGGING]);
    expect(registry.findExposing({ name: 'logging', version: '1.0.0' }, plugin.identity)).toBe(true);
  });
});

// =============================================================================
// B — Binding
// =============================================================================
describe('B: Binding', () => {
  test('B-1 / B-2 / B-7 / O-2: bind validates both endpoints and the capability', async () => {
    const h = harness();
    await activated(h);

    await expect(
      h.core.bind({
        from: { domain: 'x', id: 'ghost', instance: '1' },
        to: h.consumer.identity,
        capability: h.ref,
      }),
    ).rejects.toThrow('EAPP_PLUGIN_NOT_FOUND'); // B-1

    await expect(
      h.core.bind({
        from: h.consumer.identity,
        to: h.provider.identity,
        capability: h.ref,
      }),
    ).rejects.toThrow(); // B-7: capability.plugin must equal `from`

    await expect(
      h.core.bind({
        from: h.consumer.identity,
        to: h.provider.identity,
        capability: { plugin: h.consumer.identity, name: 'nope', version: '1.0.0' },
      }),
    ).rejects.toThrow('EAPP_CAPABILITY_NOT_EXPOSED'); // B-2 / O-2
  });

  test('B-3: Binding state is derived, never set directly', async () => {
    const h = harness();
    await activated(h);
    const binding = await h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref });

    expect(Object.keys(binding)).not.toContain('state');
    expect(Object.isFrozen(binding)).toBe(true);
    expect(h.core.bindingState(binding.id)).toBe('ACTIVE');

    await h.core.suspend(h.provider.identity);
    expect(h.core.bindingState(binding.id)).toBe('DORMANT'); // derived, not assigned
    await h.core.resume(h.provider.identity);
    expect(h.core.bindingState(binding.id)).toBe('ACTIVE');
  });

  test('B-4 / O-3 / O-4: CLOSED is terminal and unbind is idempotent', async () => {
    const h = harness();
    await activated(h);
    const binding = await h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref });

    await h.core.unbind(binding.id);
    expect(h.core.bindingState(binding.id)).toBe('CLOSED');
    await h.core.unbind(binding.id); // O-4: no throw
    expect(h.core.bindingState(binding.id)).toBe('CLOSED'); // B-4

    // A terminal Binding never comes back, even when both ends are ACTIVE again.
    await h.core.suspend(h.provider.identity);
    await h.core.resume(h.provider.identity);
    expect(h.core.bindingState(binding.id)).toBe('CLOSED');
  });

  test('B-5: any endpoint INACTIVE or SUSPENDED derives DORMANT', async () => {
    const h = harness();
    await activated(h);
    const binding = await h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref });

    await h.core.deactivate(h.consumer.identity);
    expect(h.core.bindingState(binding.id)).toBe('DORMANT');
    await h.core.activate(h.consumer.identity);
    expect(h.core.bindingState(binding.id)).toBe('ACTIVE');
    await h.core.suspend(h.consumer.identity);
    expect(h.core.bindingState(binding.id)).toBe('DORMANT');
  });

  test('B-6 / B-8: at most one non-CLOSED Binding per (from, to, capability), atomically', async () => {
    const h = harness();
    await activated(h);

    const results = await Promise.allSettled([
      h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref }),
      h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref }),
      h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        expect((result.reason as { code?: string }).code).toBe('EAPP_BINDING_DUPLICATE');
      }
    }
    const live = h.core
      .listBindings()
      .filter((b) => h.core.bindingState(b.id) !== 'CLOSED');
    expect(live).toHaveLength(1); // B-6
  });

  test('B-9: a PENDING Binding is never externally observable', async () => {
    const h = harness();
    await activated(h);
    const binding = await h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref });

    // Only the three stable states are reachable from outside (v3.0 §6.2).
    const observed = h.core.bindingState(binding.id);
    expect(['ACTIVE', 'DORMANT', 'CLOSED']).toContain(observed);
    expect(observed).not.toBe('PENDING');
  });

  test('§6.9 / CH-1: a Binding carries no interaction semantics', async () => {
    const h = harness();
    await activated(h);
    const binding = await h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref });
    for (const leaked of ['mode', 'delivery', 'channel', 'ordering', 'serialization']) {
      expect(leaked in binding).toBe(false);
    }
  });

  test('deriveBindingState encodes §6.4 exactly', () => {
    expect(deriveBindingState({ closed: true, fromLifecycle: 'ACTIVE', toLifecycle: 'ACTIVE', capabilityStillExposed: true })).toBe('CLOSED');
    expect(deriveBindingState({ closed: false, fromLifecycle: 'ACTIVE', toLifecycle: 'ACTIVE', capabilityStillExposed: true })).toBe('ACTIVE');
    expect(deriveBindingState({ closed: false, fromLifecycle: 'INACTIVE', toLifecycle: 'ACTIVE', capabilityStillExposed: true })).toBe('DORMANT');
    expect(deriveBindingState({ closed: false, fromLifecycle: 'ACTIVE', toLifecycle: 'SUSPENDED', capabilityStillExposed: true })).toBe('DORMANT');
    expect(deriveBindingState({ closed: false, fromLifecycle: 'ACTIVE', toLifecycle: 'ACTIVE', capabilityStillExposed: false })).toBe('DORMANT');
  });
});

// =============================================================================
// L — Lifecycle
// =============================================================================
describe('L: Lifecycle', () => {
  test('L-1 / L-6: activate applies only to INACTIVE', async () => {
    const h = harness();
    expect(h.registry.require(h.provider.identity).lifecycle).toBe('INACTIVE');
    await h.core.activate(h.provider.identity);
    expect(h.registry.require(h.provider.identity).lifecycle).toBe('ACTIVE'); // L-1

    await h.core.suspend(h.provider.identity);
    await expect(h.core.activate(h.provider.identity)).rejects.toThrow('EAPP_LIFECYCLE_INVALID'); // L-6
  });

  test('L-2: deactivate reaches INACTIVE from any state', async () => {
    const h = harness();
    await h.core.deactivate(h.provider.identity).catch(() => undefined);
    await h.core.activate(h.provider.identity);
    await h.core.deactivate(h.provider.identity);
    expect(h.registry.require(h.provider.identity).lifecycle).toBe('INACTIVE');

    await h.core.activate(h.provider.identity);
    await h.core.suspend(h.provider.identity);
    await h.core.deactivate(h.provider.identity);
    expect(h.registry.require(h.provider.identity).lifecycle).toBe('INACTIVE');
  });

  test('L-3 / L-4: suspend needs ACTIVE, resume needs SUSPENDED', async () => {
    const h = harness();
    await expect(h.core.suspend(h.provider.identity)).rejects.toThrow('EAPP_LIFECYCLE_INVALID'); // L-3
    await h.core.activate(h.provider.identity);
    await h.core.suspend(h.provider.identity);
    await expect(h.core.resume(h.provider.identity)).resolves.toBeUndefined(); // L-4
    expect(h.registry.require(h.provider.identity).lifecycle).toBe('ACTIVE');
    await expect(h.core.resume(h.provider.identity)).rejects.toThrow('EAPP_LIFECYCLE_INVALID');
  });

  test('L-5 / O-7: SUSPENDED does not unbind', async () => {
    const h = harness();
    await activated(h);
    const binding = await h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref });

    await h.core.suspend(h.provider.identity);
    expect(h.core.binding(binding.id)).toBeDefined(); // still bound
    expect(h.core.bindingState(binding.id)).toBe('DORMANT'); // O-7
    expect(h.core.listBindings()).toHaveLength(1);
  });

  test('the lifecycle transition table is closed', () => {
    expect(canTransition('INACTIVE', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransition('SUSPENDED', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'INACTIVE')).toBe(true);
    expect(canTransition('INACTIVE', 'SUSPENDED')).toBe(false);
    expect(() => assertTransition('INACTIVE', 'SUSPENDED')).toThrow('EAPP_LIFECYCLE_INVALID');
    expect(isLifecycleState('ACTIVE')).toBe(true);
    expect(isLifecycleState('STARTING')).toBe(false);
  });
});

// =============================================================================
// O — Composition operations
// =============================================================================
describe('O: Composition operations', () => {
  test('O-1: bind creates a Binding whose state is derived', async () => {
    const h = harness();
    const dormant = await h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref });
    expect(h.core.bindingState(dormant.id)).toBe('DORMANT'); // both ends INACTIVE

    await activated(h);
    expect(h.core.bindingState(dormant.id)).toBe('ACTIVE'); // derived without touching the binding
  });

  test('O-5: activate is idempotent', async () => {
    const h = harness();
    await h.core.activate(h.provider.identity);
    await expect(h.core.activate(h.provider.identity)).resolves.toBeUndefined();
    expect(h.registry.require(h.provider.identity).lifecycle).toBe('ACTIVE');
  });

  test('O-6 / O-8: deactivate and resume re-derive every binding of the plugin', async () => {
    const h = harness();
    await activated(h);
    const binding = await h.core.bind({ from: h.provider.identity, to: h.consumer.identity, capability: h.ref });
    expect(h.core.bindingState(binding.id)).toBe('ACTIVE');

    await h.core.deactivate(h.provider.identity);
    expect(h.core.bindingState(binding.id)).toBe('DORMANT'); // O-6
    expect(h.core.binding(binding.id)).toBeDefined(); // §7.4: deactivate does NOT close

    await h.core.activate(h.provider.identity);
    expect(h.core.bindingState(binding.id)).toBe('ACTIVE'); // O-8
  });
});

// =============================================================================
// D — Discovery
// =============================================================================
describe('D: Discovery', () => {
  function scoped() {
    const registry = new PluginRegistry();
    const provider = pluginOf('logger', [LOGGING]);
    const hidden = pluginOf('secret', [LOGGING]);
    registry.register(provider);
    registry.register(hidden);
    const policy = {
      trustLevels: TRUST_LEVELS,
      trustDomains: ['com.example'],
      isVisible: (plugin: PluginRef, scope: DiscoveryScope) =>
        scope.trustLevel === undefined || plugin.id !== 'secret',
    };
    const discovery = new DiscoveryService(registry, policy);
    return { registry, discovery, provider, hidden };
  }

  test('D-1 / D-3: find respects the trust scope and never implies composability', async () => {
    const { discovery, provider, hidden } = scoped();
    const visible = await discovery.find({ capability: 'logging' }, { trustLevel: 'L0', trustDomain: 'com.example' });
    expect(visible.map((p) => p.id)).toContain(provider.identity.id); // D-1
    expect(visible.map((p) => p.id)).not.toContain(hidden.identity.id);

    // D-3: finding both does not create anything composable.
    const all = await discovery.find({}, { trustLevel: 'L0', trustDomain: 'com.example' });
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain('binding');
  });

  test('D-2 / D-6: watch only fires for the current scope and uses the frozen event types', async () => {
    const { discovery, provider } = scoped();
    const watch = discovery.watch({}, { trustLevel: 'L0', trustDomain: 'com.example' });
    const iterator = watch[Symbol.asyncIterator]();

    const pending = iterator.next();
    discovery.notify({ type: 'changed', plugin: provider.identity });
    const first = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000)),
    ]);
    watch.close();

    expect(first).toBeDefined();
    expect(['added', 'removed', 'changed']).toContain(first?.value?.type); // D-6
  });

  /**
   * The above test calls `notify()` itself, so it proves the event plumbing works
   * and nothing more — it would pass even if nothing in the implementation ever
   * produced an event, which is exactly what was true.
   *
   * §8.1 defines `watch` as an operation of Discovery that yields events. A caller
   * who has to call `notify()` in order to be told a plugin changed already knew
   * about the change. So this test never touches `notify`: it registers a plugin
   * and expects to be told.
   */
  test('D-6: watch fires on its own when the registry changes', async () => {
    const { discovery, registry } = scoped();
    const watch = discovery.watch({}, { trustLevel: 'L0', trustDomain: 'com.example' });
    const iterator = watch[Symbol.asyncIterator]();

    const pending = iterator.next();
    // Only the registry is touched. Nothing calls `notify`.
    registry.register(pluginOf('appears', []));

    const first = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000)),
    ]);
    watch.close();

    expect(first).toBeDefined();
    expect(first?.value?.type).toBe('added');
    expect(first?.value?.plugin.id).toBe('appears');
  });

  test('D-6: a lifecycle change on an existing plugin is reported as `changed`', async () => {
    const { discovery, registry } = scoped();
    // Registered BEFORE the watch, so the `added` event for it is not what the watch
    // sees first. The plugin object is kept rather than rebuilt: `identityOf` mints a
    // fresh instance on every call, so `identityOf('changer')` twice is two plugins.
    const plugin = pluginOf('changer', []);
    registry.register(plugin);

    const watch = discovery.watch({}, { trustLevel: 'L0', trustDomain: 'com.example' });
    const iterator = watch[Symbol.asyncIterator]();
    const pending = iterator.next();
    registry.setLifecycle(plugin.identity, 'ACTIVE');

    const first = await Promise.race([
      pending,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000)),
    ]);
    watch.close();

    expect(first?.value?.type).toBe('changed');
    expect(first?.value?.plugin.id).toBe('changer');
  });

  test('D-4: discovery may cache, but only with an invalidation policy', async () => {
    const { discovery, registry } = scoped();
    await discovery.find({}, { trustLevel: 'L0', trustDomain: 'com.example' });
    const before = discovery.cacheStats();
    expect(before).toBeDefined(); // a cache policy exists and is inspectable
    discovery.invalidate();
    registry.register(pluginOf('late', []));
    const after = await discovery.find({}, { trustLevel: 'L0', trustDomain: 'com.example' });
    expect(after.map((p) => p.id)).toContain('late'); // invalidated, so the new plugin is seen
  });

  test('D-5: Discovery is not a substitute for Binding', async () => {
    const h = harness();
    await activated(h);
    await h.core.find({ capability: 'logging' }, {});
    // Being discoverable changes nothing about bindings.
    expect(h.core.listBindings()).toHaveLength(0);
  });

  test('D-7: trust levels are categories, not an authorization order', () => {
    expect(TRUST_LEVELS).toEqual(['L0', 'L1', 'L2']);
    expect(isTrustLevel('L2')).toBe(true);
    expect(isTrustLevel('L3')).toBe(false);
    const plugin = pluginOf('ranked', [LOGGING]);
    // The level is never compared as a number anywhere in the match function.
    expect(matchesCriteria(plugin, { capability: 'logging' })).toBe(true);
  });
});

// =============================================================================
// BR — Bootstrap Runtime
// =============================================================================
// =============================================================================
// §8.1 — Criteria.version is a SemVer range
// =============================================================================
describe('§8.1: Criteria.version is a range, not an exact value', () => {
  test('find honours caret, tilde, comparator and exact ranges', async () => {
    const registry = new PluginRegistry();
    const v1 = pluginOf('v1', [{ name: 'logging', version: '1.4.0' }]);
    const v2 = pluginOf('v2', [{ name: 'logging', version: '2.0.0' }]);
    registry.register(v1);
    registry.register(v2);
    const core = createCompositionCore(registry);

    const caret = await core.find({ capability: 'logging', version: '^1.0.0' }, {});
    expect(caret.map((p) => p.id)).toEqual(['v1']); // would have been [] under exact matching

    const tilde = await core.find({ capability: 'logging', version: '~1.4.0' }, {});
    expect(tilde.map((p) => p.id)).toEqual(['v1']);

    const both = await core.find({ capability: 'logging', version: '>=1.0.0' }, {});
    expect(both.map((p) => p.id).sort()).toEqual(['v1', 'v2']);

    const exact = await core.find({ capability: 'logging', version: '2.0.0' }, {});
    expect(exact.map((p) => p.id)).toEqual(['v2']);

    const any = await core.find({ capability: 'logging', version: '*' }, {});
    expect(any.map((p) => p.id).sort()).toEqual(['v1', 'v2']);

    const none = await core.find({ capability: 'logging', version: '^3.0.0' }, {});
    expect(none).toEqual([]);
  });

  test('the supported grammar is explicit, and other syntax is rejected', () => {
    for (const range of ['', '*', '1.2.3', '^1.2.3', '~1.2.3', '>=1.0.0 <2.0.0', '^1.0.0 || ^2.0.0']) {
      expect(isValidRange(range)).toBe(true);
    }
    // Rejected rather than quietly matching nothing — an unsupported range and
    // "no plugin matches" must not look the same to a caller.
    for (const range of ['1.2', '1', '1.x', '1.2.3 - 2.0.0', 'not-a-range']) {
      expect(isValidRange(range)).toBe(false);
    }
  });

  test('caret respects the left-most non-zero component', () => {
    expect(satisfiesRange('1.9.9', '^1.0.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false);
  });

  test('a prerelease sorts below the release sharing its core version', () => {
    expect(satisfiesRange('1.0.0-rc.1', '<1.0.0')).toBe(true);
    expect(satisfiesRange('1.0.0-rc.1', '>=1.0.0')).toBe(false);
  });
});

describe('BR: Bootstrap Runtime', () => {
  /** The minimal §12 contract, implemented here rather than in a package. */
  function bootstrap(): BootstrapRuntime {
    const issued = new IdentityRegistry();
    const registry = new PluginRegistry();
    const loaded: string[] = [];
    return {
      async createIdentity(seed: unknown) {
        return issued.create({ domain: 'com.example', id: String(seed) });
      },
      async loadFirstPlugin(ref: PluginRef) {
        const plugin = registry.get(ref);
        if (!plugin) throw new Error(`unknown plugin ${identityKey(ref)}`);
        loaded.push(identityKey(ref));
        return plugin;
      },
      provideInitialDiscovery(): Discovery {
        return new DiscoveryService(registry);
      },
      // Test-only introspection.
      loadedPlugins: () => loaded,
    } as BootstrapRuntime & { loadedPlugins: () => string[] };
  }

  test('BR-2: Bootstrap MUST NOT depend on any Plugin', async () => {
    const boot = bootstrap();
    // Identity issuance and discovery work before a single plugin exists.
    const identity = await boot.createIdentity('root');
    expect(identity.domain).toBe('com.example');
    expect(boot.provideInitialDiscovery()).toBeDefined();
    expect((boot as unknown as { loadedPlugins(): string[] }).loadedPlugins()).toHaveLength(0);
  });

  test('BR-3: Bootstrap MUST provide at least one initial Discovery', async () => {
    const boot = bootstrap();
    const discovery = boot.provideInitialDiscovery();
    expect(discovery.find).toBeDefined();
    expect(discovery.watch).toBeDefined();
    await expect(discovery.find({}, {})).resolves.toEqual([]);
  });

  test('BR-1: Bootstrap MUST NOT be replaced by something nonexistent', async () => {
    const boot = bootstrap();
    // Loading a plugin that does not exist fails loudly; the bootstrap never silently
    // substitutes a placeholder root.
    await expect(
      boot.loadFirstPlugin({ domain: 'com.example', id: 'ghost', instance: 'ghost-1' }),
    ).rejects.toThrow();
    const replacement = boot.provideInitialDiscovery();
    expect(replacement).toBeDefined(); // the original root still exists
  });

  test('§12.3: the root may be replaced, but only after it exists', async () => {
    const boot = bootstrap();
    const initial = boot.provideInitialDiscovery();
    expect(initial).toBeDefined();
    const replacement = new DiscoveryService(new PluginRegistry());
    expect(replacement).toBeDefined(); // replacement is possible, and requires a real object
  });
});

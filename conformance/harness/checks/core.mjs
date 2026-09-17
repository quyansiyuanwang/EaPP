/**
 * Black-box checks for EaPP v3.0.0 Composition Core.
 *
 * Every check cites the invariant it verifies and states what it observes. A check
 * here may only use what `conformance/driver.md` exposes: that is what makes it
 * usable against an implementation in any language, and what stops it from
 * accidentally testing the reference implementation's internals.
 *
 * The invariant IDs are the ones in the spec's `§13 不变量（冻结全集）`. Anything
 * listed there that these checks cannot see is named in `conformance/README.md`
 * rather than quietly omitted.
 */

import { isDriverError } from '../driver.mjs';

const CAP = { name: 'casing.apply', version: '1.0.0' };
const who = (domain, id, instance) => ({ domain, id, instance });

/** A small set of plugins the checks can build on. */
async function twoPlugins(t, { capability = CAP } = {}) {
  const provider = await t.driver.request('plugin.register', {
    identity: who('acme', 'provider', 'provider-1'),
    capabilities: [capability],
  });
  const consumer = await t.driver.request('plugin.register', {
    identity: who('acme', 'consumer', 'consumer-1'),
    capabilities: [],
  });
  return { provider, consumer };
}

/** Register both ends and activate them, so a Binding can reach ACTIVE. */
async function active(t, options) {
  const pair = await twoPlugins(t, options);
  await t.driver.request('lifecycle.activate', { identity: pair.provider });
  await t.driver.request('lifecycle.activate', { identity: pair.consumer });
  return pair;
}

async function bindThem(t, pair, capability = CAP) {
  return t.driver.request('composition.bind', {
    from: pair.provider,
    to: pair.consumer,
    capability,
  });
}

const stateOf = async (t, binding) =>
  (await t.driver.request('composition.bindingState', { binding: binding.id })).state;

export const CORE_CHECKS = [
  // ---------------------------------------------------------------- Identity
  {
    id: 'ID-1',
    rule: 'domain MUST NOT be empty',
    async run(t) {
      await t.driver.refused(
        'identity.create',
        { identity: { domain: '', id: 'a' } },
        'EAPP_IDENTITY_INVALID',
      );
    },
  },
  {
    id: 'ID-2',
    rule: 'id MUST NOT be empty',
    async run(t) {
      await t.driver.refused(
        'identity.create',
        { identity: { domain: 'acme', id: '' } },
        'EAPP_IDENTITY_INVALID',
      );
    },
  },
  {
    id: 'ID-3',
    rule: 'instance MUST be unique within (domain, id)',
    async run(t) {
      await t.driver.request('plugin.register', { identity: who('acme', 'a', 'a-1'), capabilities: [] });
      await t.driver.refused(
        'plugin.register',
        { identity: who('acme', 'a', 'a-1'), capabilities: [] },
        'EAPP_IDENTITY_DUPLICATE',
      );
    },
  },
  {
    id: 'ID-3',
    rule: 'the same (domain, id) with a different instance is a different plugin',
    async run(t) {
      await t.driver.request('plugin.register', { identity: who('acme', 'a', 'a-1'), capabilities: [] });
      // Only `instance` distinguishes them, so a duplicate check keyed on (domain, id)
      // alone would reject this — and it is legal.
      await t.driver.request('plugin.register', { identity: who('acme', 'a', 'a-2'), capabilities: [] });
    },
  },
  {
    id: 'ID-6',
    rule: 'Identity MUST NOT carry version semantics',
    async run(t) {
      // Rejecting is the point: silently stripping the field would let a plugin
      // believe an identity took effect that did not (ID-6 in the spec's §3.3).
      await t.driver.refused(
        'plugin.register',
        {
          identity: { ...who('acme', 'a', 'a-1'), version: '1.0.0' },
          capabilities: [],
        },
        'EAPP_IDENTITY_INVALID',
      );
    },
  },
  {
    id: 'ID-6',
    rule: 'the same rule applies to identity.create',
    async run(t) {
      await t.driver.refused(
        'identity.create',
        { identity: { ...who('acme', 'a', 'a-1'), version: '1.0.0' } },
        'EAPP_IDENTITY_INVALID',
      );
    },
  },
  {
    id: 'ID-5',
    rule: 'Identity MUST NOT be self-issued — the runtime mints it',
    async run(t) {
      // Asking without an instance lets the runtime choose one, which it can only do
      // if it is the issuer rather than a recorder.
      const issued = await t.driver.request('identity.create', {
        identity: { domain: 'acme', id: 'a' },
      });
      t.assert(
        typeof issued.instance === 'string' && issued.instance.length > 0,
        'identity.create returned no instance, so the runtime did not mint one',
      );
    },
  },

  // -------------------------------------------------------------- Capability
  {
    id: 'C-1',
    rule: 'Capability.name MUST NOT be empty',
    async run(t) {
      await t.driver.refused(
        'plugin.register',
        { identity: who('acme', 'a', 'a-1'), capabilities: [{ name: '', version: '1.0.0' }] },
        'EAPP_CAPABILITY_NOT_FOUND',
      );
    },
  },
  {
    id: 'C-2',
    rule: 'Capability.version MUST be valid SemVer',
    async run(t) {
      const invalid = ['1.0', 'v1.0.0', '1.0.0.0', '', 'latest'];
      for (const [index, version] of invalid.entries()) {
        await t.driver.refused(
          'plugin.register',
          {
            // Distinct identities per attempt: reusing one would make this check fail
            // with EAPP_IDENTITY_DUPLICATE and report the wrong thing.
            identity: who('acme', `bad-${index}`, `bad-${index}-1`),
            capabilities: [{ name: 'x', version }],
          },
          'EAPP_CAPABILITY_NOT_FOUND',
        );
      }
    },
  },
  {
    id: 'C-3',
    rule: 'contract is optional context',
    async run(t) {
      await twoPlugins(t, { capability: { ...CAP, contract: { name: 'Payload', version: '1.0.0' } } });
    },
  },
  {
    id: 'C-4',
    rule: 'Capability MAY be exposed by multiple Plugins',
    async run(t) {
      await t.driver.request('plugin.register', { identity: who('acme', 'a', 'a-1'), capabilities: [CAP] });
      await t.driver.request('plugin.register', { identity: who('acme', 'b', 'b-1'), capabilities: [CAP] });
      const found = await t.driver.request('discovery.find', { criteria: { capability: CAP.name } });
      t.assert(found.length >= 2, `expected both plugins to be discoverable, got ${found.length}`);
    },
  },
  {
    id: 'C-6',
    rule: 'Capability version participates in Binding identity',
    async run(t) {
      const pair = await twoPlugins(t);
      await t.driver.request('lifecycle.activate', { identity: pair.provider });
      await t.driver.request('lifecycle.activate', { identity: pair.consumer });
      await bindThem(t, pair);

      // A different version is a different capability, so it is not exposed and the
      // binding must not be created.
      await t.driver.refused(
        'composition.bind',
        {
          from: pair.provider,
          to: pair.consumer,
          capability: { name: CAP.name, version: '2.0.0' },
        },
        'EAPP_CAPABILITY_NOT_EXPOSED',
      );
    },
  },

  {
    id: 'C-7',
    rule: 'Constraint matching MUST be exact: equal kind AND structurally equal value',
    async run(t) {
      // The rule exists because the spec originally never said what "matching"
      // meant, so two implementations could read it as subset / range / predicate
      // and both call themselves conformant. It is now the narrowest reading.
      const constrained = {
        name: 'region.lookup',
        version: '1.0.0',
        constraints: [{ kind: 'region', value: 'eu' }],
      };
      await t.driver.request('plugin.register', {
        identity: who('acme', 'eu-only', 'eu-only-1'),
        capabilities: [constrained],
      });

      const hit = await t.driver.request('discovery.find', {
        criteria: { capability: 'region.lookup', constraints: [{ kind: 'region', value: 'eu' }] },
      });
      t.assert(hit.length === 1, `an exact constraint match found ${hit.length} plugins`);

      for (const wrong of [
        { kind: 'region', value: 'us' }, // same kind, different value
        { kind: 'zone', value: 'eu' }, // different kind, same value
        { kind: 'region', value: { nested: 'eu' } }, // same shape, different structure
      ]) {
        const miss = await t.driver.request('discovery.find', {
          criteria: { capability: 'region.lookup', constraints: [wrong] },
        });
        t.assert(
          miss.length === 0,
          `constraint ${JSON.stringify(wrong)} matched, but matching must be exact`,
        );
      }
    },
  },

  // ------------------------------------------------------------------ Plugin
  {
    id: 'P-2',
    rule: 'Plugin.capabilities MAY be empty',
    async run(t) {
      await t.driver.request('plugin.register', { identity: who('acme', 'a', 'a-1'), capabilities: [] });
    },
  },
  {
    id: 'P-3',
    rule: 'Plugin Identity MUST NOT change during lifecycle',
    async run(t) {
      const pair = await twoPlugins(t);
      const before = await t.driver.request('plugin.get', { identity: pair.provider });
      await t.driver.request('lifecycle.activate', { identity: pair.provider });
      await t.driver.request('lifecycle.suspend', { identity: pair.provider });
      await t.driver.request('lifecycle.resume', { identity: pair.provider });
      const after = await t.driver.request('plugin.get', { identity: pair.provider });
      t.deepEqual(after.identity, before.identity, 'identity changed across the lifecycle');
    },
  },
  {
    id: 'P-1',
    rule: 'Every Plugin MUST have a unique Identity',
    async run(t) {
      await t.driver.request('plugin.register', { identity: who('acme', 'a', 'a-1'), capabilities: [] });
      const listed = await t.driver.request('plugin.list');
      const keys = listed.map((p) => `${p.identity.domain}/${p.identity.id}/${p.identity.instance}`);
      t.assert(new Set(keys).size === keys.length, 'plugin.list contains duplicate identities');
    },
  },

  // ----------------------------------------------------------------- Binding
  {
    id: 'B-1',
    rule: 'Binding.from and Binding.to MUST be existing Plugins',
    async run(t) {
      const pair = await twoPlugins(t);
      await t.driver.refused(
        'composition.bind',
        { from: pair.provider, to: who('acme', 'ghost', 'ghost-1'), capability: CAP },
        'EAPP_PLUGIN_NOT_FOUND',
      );
    },
  },
  {
    id: 'B-2',
    rule: 'Binding.capability MUST be exposed by Binding.from',
    async run(t) {
      const pair = await twoPlugins(t);
      // `to` is the one that does not expose it.
      await t.driver.refused(
        'composition.bind',
        { from: pair.consumer, to: pair.provider, capability: CAP },
        'EAPP_CAPABILITY_NOT_EXPOSED',
      );
    },
  },
  {
    id: 'B-3',
    rule: 'Binding state MUST be derived, never assigned',
    async run(t) {
      const pair = await active(t);
      const binding = await bindThem(t, pair);
      t.equal(await stateOf(t, binding), 'ACTIVE', 'both ends ACTIVE should derive ACTIVE');

      // Nobody sets DORMANT. It follows from an endpoint leaving Active Composition.
      await t.driver.request('lifecycle.deactivate', { identity: pair.consumer });
      t.equal(await stateOf(t, binding), 'DORMANT', 'one end INACTIVE should derive DORMANT');

      await t.driver.request('lifecycle.activate', { identity: pair.consumer });
      t.equal(await stateOf(t, binding), 'ACTIVE', 'it should come back on its own');
    },
  },
  {
    id: 'B-4',
    rule: 'CLOSED is terminal',
    async run(t) {
      const pair = await active(t);
      const binding = await bindThem(t, pair);
      await t.driver.request('composition.unbind', { binding: binding.id });
      t.equal(await stateOf(t, binding), 'CLOSED', 'unbind should close the Binding');

      // Re-activating both ends must not resurrect it. This is the check that
      // separates "derived" from "recomputed whenever anything changes".
      await t.driver.request('lifecycle.deactivate', { identity: pair.provider });
      await t.driver.request('lifecycle.activate', { identity: pair.provider });
      t.equal(await stateOf(t, binding), 'CLOSED', 'a CLOSED Binding must stay CLOSED');
    },
  },
  {
    id: 'B-5',
    rule: 'Any endpoint INACTIVE/SUSPENDED => Binding DORMANT',
    async run(t) {
      const pair = await active(t);
      const binding = await bindThem(t, pair);

      await t.driver.request('lifecycle.suspend', { identity: pair.provider });
      t.equal(await stateOf(t, binding), 'DORMANT', 'SUSPENDED endpoint should derive DORMANT');

      await t.driver.request('lifecycle.resume', { identity: pair.provider });
      await t.driver.request('lifecycle.deactivate', { identity: pair.provider });
      t.equal(await stateOf(t, binding), 'DORMANT', 'INACTIVE endpoint should derive DORMANT');
    },
  },
  {
    id: 'B-6',
    rule: 'Only one non-CLOSED Binding per (from, to, capability)',
    async run(t) {
      const pair = await active(t);
      const first = await bindThem(t, pair);

      // §6.8 permits **either** outcome for a repeated bind: return the existing
      // Binding, or fail with EAPP_BINDING_DUPLICATE. A check that pinned one would
      // fail a conformant implementation — and this one did, against the reference
      // implementation, until it was corrected. What is asserted is the invariant
      // both outcomes satisfy: exactly one Binding exists for the triple.
      let second;
      try {
        second = await bindThem(t, pair);
      } catch (error) {
        if (!isDriverError(error)) throw error;
        t.equal(error.code, 'EAPP_BINDING_DUPLICATE', '§6.8 allows only this refusal');
      }
      if (second !== undefined) {
        t.equal(second.id, first.id, '§6.8: returning an existing Binding means the same one');
      }

      const all = await t.driver.request('composition.bindings');
      const matching = all.filter(
        (binding) =>
          binding.from.id === pair.provider.id &&
          binding.to.id === pair.consumer.id &&
          binding.capability.name === CAP.name &&
          binding.capability.version === CAP.version,
      );
      t.equal(matching.length, 1, 'the spec allows at most one non-CLOSED Binding per triple');
    },
  },

  // --------------------------------------------------------------- Lifecycle
  {
    id: 'L-1 / L-2 / L-3 / L-4',
    rule: 'the four transitions move the plugin where the spec says',
    async run(t) {
      const pair = await twoPlugins(t);
      const lifecycle = async () =>
        (await t.driver.request('plugin.get', { identity: pair.provider })).lifecycle;

      t.equal(await lifecycle(), 'INACTIVE', 'a registered plugin starts INACTIVE');
      await t.driver.request('lifecycle.activate', { identity: pair.provider });
      t.equal(await lifecycle(), 'ACTIVE', 'L-1 activate: INACTIVE -> ACTIVE');
      await t.driver.request('lifecycle.suspend', { identity: pair.provider });
      t.equal(await lifecycle(), 'SUSPENDED', 'L-3 suspend: ACTIVE -> SUSPENDED');
      await t.driver.request('lifecycle.resume', { identity: pair.provider });
      t.equal(await lifecycle(), 'ACTIVE', 'L-4 resume: SUSPENDED -> ACTIVE');
      await t.driver.request('lifecycle.deactivate', { identity: pair.provider });
      t.equal(await lifecycle(), 'INACTIVE', 'L-2 deactivate: any -> INACTIVE');
    },
  },
  {
    id: 'L-6',
    rule: 'activate applies only to INACTIVE — on SUSPENDED it MUST fail',
    async run(t) {
      const pair = await twoPlugins(t);
      await t.driver.request('lifecycle.activate', { identity: pair.provider });
      // On an ACTIVE plugin, activate is the O-5 idempotent no-op rather than an
      // error — the two rules have to hold at once.
      t.equal(
        (await t.driver.request('plugin.get', { identity: pair.provider })).lifecycle,
        'ACTIVE',
        'activate on ACTIVE must be a no-op (O-5)',
      );
      await t.driver.request('lifecycle.suspend', { identity: pair.provider });
      // SUSPENDED is the case L-6 is about: there is a resume for that, and using
      // activate would leave the plugin in a state nobody asked for.
      await t.driver.refused(
        'lifecycle.activate',
        { identity: pair.provider },
        'EAPP_LIFECYCLE_INVALID',
      );
    },
  },
  {
    id: 'L-5',
    rule: 'SUSPENDED MUST NOT unbind',
    async run(t) {
      const pair = await active(t);
      const binding = await bindThem(t, pair);
      await t.driver.request('lifecycle.suspend', { identity: pair.provider });

      const listed = await t.driver.request('composition.bindings');
      t.assert(
        listed.some((b) => b.id === binding.id),
        'the Binding disappeared when its endpoint was suspended',
      );
      t.equal(await stateOf(t, binding), 'DORMANT', 'it should be DORMANT, not gone');
    },
  },

  // --------------------------------------------------------------- Discovery
  {
    id: 'D-3 / D-5',
    rule: 'Discovery MUST NOT imply composability, and MUST NOT replace Binding',
    async run(t) {
      const pair = await active(t);
      const before = (await t.driver.request('composition.bindings')).length;

      const found = await t.driver.request('discovery.find', { criteria: { capability: CAP.name } });
      t.assert(found.length >= 1, 'discovery found nothing, so the check proves nothing');

      const after = (await t.driver.request('composition.bindings')).length;
      t.equal(after, before, 'discovery created or changed a Binding');
    },
  },
  {
    id: 'D-6',
    rule: 'DiscoveryEvent.type MUST be added|removed|changed',
    async run(t) {
      const allowed = new Set(['added', 'removed', 'changed']);
      t.driver.drainEvents();
      await t.driver.request('discovery.watch', { criteria: {} });
      await t.driver.request('plugin.register', {
        identity: who('acme', 'watched', 'watched-1'),
        capabilities: [],
      });

      // Events are pushed on the same stream as responses, so the register reply
      // can arrive before or after its event. A short wait is the only way to see
      // them without inventing an ordering the protocol does not promise.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const events = t.driver.events.filter((event) => event.event === 'discovery');
      t.assert(events.length >= 1, 'watch produced no event for a plugin registered while watching');
      for (const event of events) {
        t.assert(allowed.has(event.type), `event type '${String(event.type)}' is not allowed`);
        t.assert(event.plugin !== undefined, 'a discovery event carried no plugin');
      }
    },
  },

  // -------------------------------------------------------------- Operations
  {
    id: 'O-1 / O-3',
    rule: 'bind MUST create a Binding; unbind MUST set it CLOSED',
    async run(t) {
      const pair = await active(t);
      const binding = await bindThem(t, pair);
      t.assert(typeof binding.id === 'string' && binding.id.length > 0, 'bind returned no id');

      const fetched = await t.driver.request('composition.binding', { binding: binding.id });
      t.deepEqual(fetched.from, pair.provider, 'the Binding does not name the provider as `from`');

      await t.driver.request('composition.unbind', { binding: binding.id });
      t.equal(await stateOf(t, binding), 'CLOSED', 'unbind did not close the Binding');
    },
  },
  {
    id: 'O-4',
    rule: 'unbind MUST be idempotent',
    async run(t) {
      const pair = await active(t);
      const binding = await bindThem(t, pair);
      await t.driver.request('composition.unbind', { binding: binding.id });
      // Twice must not fail: a caller that retries a close cannot be punished for it.
      await t.driver.request('composition.unbind', { binding: binding.id });
      t.equal(await stateOf(t, binding), 'CLOSED', 'still not CLOSED');
    },
  },
  {
    id: 'O-5',
    rule: 'activate MUST be idempotent',
    async run(t) {
      const pair = await twoPlugins(t);
      await t.driver.request('lifecycle.activate', { identity: pair.provider });
      await t.driver.request('lifecycle.activate', { identity: pair.provider });
      t.equal(
        (await t.driver.request('plugin.get', { identity: pair.provider })).lifecycle,
        'ACTIVE',
        'a second activate changed the state',
      );
    },
  },
  {
    id: 'O-6 / O-7',
    rule: 'deactivate and suspend MUST set all Bindings DORMANT',
    async run(t) {
      for (const op of ['deactivate', 'suspend']) {
        await t.driver.request('reset');
        const pair = await active(t);
        const binding = await bindThem(t, pair);
        await t.driver.request(`lifecycle.${op}`, { identity: pair.consumer });
        const state = await stateOf(t, binding);
        t.equal(state, 'DORMANT', `lifecycle.${op} left the Binding ${state}`);
      }
    },
  },
  {
    id: 'O-8',
    rule: 'resume MUST re-evaluate all Bindings',
    async run(t) {
      const pair = await active(t);
      const binding = await bindThem(t, pair);
      await t.driver.request('lifecycle.suspend', { identity: pair.consumer });
      t.equal(await stateOf(t, binding), 'DORMANT', 'precondition: DORMANT while suspended');
      await t.driver.request('lifecycle.resume', { identity: pair.consumer });
      t.equal(await stateOf(t, binding), 'ACTIVE', 'resume did not re-evaluate the Binding');
    },
  },

  // ---------------------------------------------------------------- Protocol
  {
    id: 'driver',
    rule: 'an unknown operation MUST be refused, not crash and not be ignored',
    async run(t) {
      await t.driver.refused('definitely.not.an.operation', {}, 'EAPP_UNSUPPORTED');
      // ...and the driver is still usable, i.e. one bad frame is not fatal.
      await t.driver.request('plugin.list');
    },
  },
];

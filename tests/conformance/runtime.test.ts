import { describe, expect, test } from 'vitest';

import type { EappError } from '@eapp/core';
import { EappRuntime, createBootstrapRuntime, type PluginModule } from '@eapp/runtime';

/**
 * End-to-end runtime conformance: independent plugins discovered, connected, activated,
 * communicating and invoked — the whole point of the project.
 *
 * These tests are integration-level on purpose. The per-layer invariants are covered by
 * `core.test.ts`, `interaction.test.ts` and `state.test.ts`; what is checked here is that
 * the layers actually compose into a usable runtime.
 */

const LOGGING = { name: 'logging', version: '1.0.0' };
const METRICS = { name: 'metrics', version: '1.0.0' };
const SHARED = { name: 'shared-state', version: '1.0.0' };

function loggerPlugin(): PluginModule {
  const logs: string[] = [];
  let activations = 0;
  return {
    manifest: {
      identity: { domain: 'eapp.demo', id: 'logger', instance: 'logger-1' },
      capabilities: [LOGGING, SHARED],
    },
    async activate() {
      activations += 1;
    },
    handlers: {
      logging: async (payload) => {
        const message = String(payload);
        logs.push(message);
        return { written: message, count: logs.length, activations };
      },
    },
  };
}

function appPlugin(): PluginModule {
  return {
    manifest: {
      identity: { domain: 'eapp.demo', id: 'app', instance: 'app-1' },
      capabilities: [],
    },
  };
}

async function twoPlugins() {
  const runtime = EappRuntime.create({ domain: 'eapp.demo' });
  const logger = runtime.register(loggerPlugin());
  const app = runtime.register(appPlugin());
  return { runtime, logger, app };
}

describe('runtime: discover', () => {
  test('a registered plugin becomes discoverable but is not yet composed', async () => {
    const { runtime, logger } = await twoPlugins();

    const found = await runtime.discover({ capability: 'logging' });
    expect(found.map((p) => p.id)).toEqual(['logger']);
    expect(found[0]).toEqual(logger);

    // D-3: discovery is a necessary condition, never a sufficient one.
    expect(runtime.core.listBindings()).toHaveLength(0);
    expect(runtime.describe().find((p) => p.identity.id === 'logger')?.lifecycle).toBe('INACTIVE');
    await runtime.shutdown();
  });

  test('an unknown capability discovers nothing', async () => {
    const { runtime } = await twoPlugins();
    expect(await runtime.discover({ capability: 'teleport' })).toEqual([]);
    await runtime.shutdown();
  });
});

describe('runtime: connect', () => {
  test('connect binds the pair and derives a Channel of the requested mode', async () => {
    const { runtime, logger, app } = await twoPlugins();

    const { binding, channel } = await runtime.connect({
      from: logger,
      to: app,
      capability: LOGGING,
      mode: 'request',
    });

    expect(binding.from).toEqual(logger);
    expect(binding.to).toEqual(app);
    expect(channel.mode).toBe('request');
    expect(channel.delivery).toBe('at-most-once'); // derived from the mode (CC-4)
    expect(channel.state).toBe('ACTIVE');
    await runtime.shutdown();
  });

  test('connecting twice reuses the same Binding instead of duplicating it', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const first = await runtime.connect({ from: logger, to: app, capability: LOGGING, mode: 'request' });
    const second = await runtime.connect({ from: logger, to: app, capability: LOGGING, mode: 'request' });

    expect(second.binding.id).toBe(first.binding.id); // B-6 honoured, not violated
    expect(second.channel.id).toBe(first.channel.id);
    await runtime.shutdown();
  });

  test('connecting an unexposed capability is refused', async () => {
    const { runtime, logger, app } = await twoPlugins();
    await expect(
      runtime.connect({ from: app, to: logger, capability: METRICS, mode: 'request' }),
    ).rejects.toThrow('EAPP_CAPABILITY_NOT_EXPOSED');
    await runtime.shutdown();
  });
});

describe('runtime: activate', () => {
  test('activation runs the plugin hook and moves the binding to ACTIVE', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const { binding } = await runtime.connect({ from: logger, to: app, capability: LOGGING, mode: 'request' });
    expect(runtime.core.bindingState(binding.id)).toBe('DORMANT');

    await runtime.activate(logger);
    expect(runtime.core.bindingState(binding.id)).toBe('DORMANT'); // app is still INACTIVE
    await runtime.activate(app);
    expect(runtime.core.bindingState(binding.id)).toBe('ACTIVE');
    await runtime.shutdown();
  });

  test('suspend leaves the composition intact but dormant, and resume restores it', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const { binding } = await runtime.connect({ from: logger, to: app, capability: LOGGING, mode: 'request' });
    await runtime.activate(logger);
    await runtime.activate(app);

    await runtime.suspend(logger);
    expect(runtime.core.bindingState(binding.id)).toBe('DORMANT'); // O-7
    expect(runtime.core.binding(binding.id)).toBeDefined(); // L-5: still bound

    await runtime.resume(logger);
    expect(runtime.core.bindingState(binding.id)).toBe('ACTIVE'); // O-8
    await runtime.shutdown();
  });
});

describe('runtime: invoke', () => {
  test('a request reaches the provider and its reply comes back', async () => {
    const { runtime, logger, app } = await twoPlugins();
    await runtime.activate(logger);
    await runtime.activate(app);

    const reply = await runtime.invoke({
      from: app,
      to: logger,
      capability: LOGGING,
      payload: 'hello from the app',
    });

    expect(reply).toEqual({ written: 'hello from the app', count: 1, activations: 1 });
    await runtime.shutdown();
  });

  test('successive invocations are correlated independently', async () => {
    const { runtime, logger, app } = await twoPlugins();
    await runtime.activate(logger);
    await runtime.activate(app);

    const replies = await Promise.all([
      runtime.invoke({ from: app, to: logger, capability: LOGGING, payload: 'a' }),
      runtime.invoke({ from: app, to: logger, capability: LOGGING, payload: 'b' }),
      runtime.invoke({ from: app, to: logger, capability: LOGGING, payload: 'c' }),
    ]);
    const written = replies.map((r) => (r as { written: string }).written).sort();
    expect(written).toEqual(['a', 'b', 'c']);
    await runtime.shutdown();
  });

  test('a handler failure propagates as a code, not as a hang', async () => {
    const { runtime, logger, app } = await twoPlugins();
    runtime.handle(logger, 'logging', async () => {
      throw new Error('disk full');
    });
    await runtime.activate(logger);
    await runtime.activate(app);

    const failure = await runtime
      .invoke({ from: app, to: logger, capability: LOGGING, payload: 'x' })
      .then(() => undefined)
      .catch((error: EappError) => error);
    expect(failure?.code).toBe('EAPP_INTERNAL');
    expect(failure?.message).toContain('disk full');
    await runtime.shutdown();
  });

  test('an unanswered request times out with EAPP_TIMEOUT', async () => {
    const { runtime, logger, app } = await twoPlugins();
    await runtime.activate(logger);
    await runtime.activate(app);
    // Remove the callee's handler after the dispatcher exists: nobody will reply.
    runtime.handle(logger, 'logging', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return 'too late';
    });

    await expect(
      runtime.invoke({ from: app, to: logger, capability: LOGGING, payload: 'x', timeoutMs: 60 }),
    ).rejects.toThrow('EAPP_TIMEOUT');
    await runtime.shutdown();
  });
});

describe('runtime: communicate', () => {
  test('event mode delivers published messages to a subscriber', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const { channel } = await runtime.connect({
      from: logger,
      to: app,
      capability: LOGGING,
      mode: 'event',
    });

    const subscription = await runtime.subscribe(channel.id, { type: 'log' }, {});
    const seen: unknown[] = [];
    const task = (async () => {
      for await (const message of subscription) {
        seen.push(message.payload);
        await message.ack();
        if (seen.length === 2) break;
      }
    })();

    await runtime.publish({ from: logger, to: app, capability: LOGGING, mode: 'event' }, { type: 'log', n: 1 });
    await runtime.publish({ from: logger, to: app, capability: LOGGING, mode: 'event' }, { type: 'log', n: 2 });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await subscription.close();
    await task;

    expect(seen).toEqual([{ type: 'log', n: 1 }, { type: 'log', n: 2 }]);
    await runtime.shutdown();
  });

  test('the pattern filter is honoured by the transport', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const { channel } = await runtime.connect({
      from: logger,
      to: app,
      capability: LOGGING,
      mode: 'event',
    });

    await runtime.publish({ from: logger, to: app, capability: LOGGING, mode: 'event' }, { type: 'log' });
    await runtime.publish({ from: logger, to: app, capability: LOGGING, mode: 'event' }, { type: 'metric' });

    const jobs = await runtime.transport.readAfter(channel.id, undefined, { type: 'metric' });
    expect(jobs).toHaveLength(1);
    await runtime.shutdown();
  });
});

describe('runtime: shared state', () => {
  test('two plugins share one versioned state through a state channel', async () => {
    const { runtime, logger, app } = await twoPlugins();

    const state = await runtime.stateChannel({ from: logger, to: app, capability: SHARED });

    const first = await state.set({ key: 'counter', value: 0, expectedRevision: null });
    const watcher = await state.watch({ key: 'counter' }, { cursor: first });
    const seen: number[] = [];
    const task = (async () => {
      for await (const update of watcher) {
        seen.push(update.value as number);
        await update.ack();
        if (seen.length === 1) break;
      }
    })();

    // A concurrent writer using the CAS token it read.
    await state.set({ key: 'counter', value: 1, expectedRevision: first });

    // ...and a second writer holding a stale token is rejected rather than clobbering.
    await expect(
      state.set({ key: 'counter', value: 99, expectedRevision: first }),
    ).rejects.toThrow('EAPP_REVISION_CONFLICT');

    await new Promise((resolve) => setTimeout(resolve, 100));
    await watcher.close();
    await task;

    expect(seen).toEqual([1]);
    expect((await state.get('counter'))?.value).toBe(1);
    await runtime.shutdown();
  });

  test('a state channel requires at-least-once and a CAS policy', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const state = await runtime.stateChannel({ from: logger, to: app, capability: SHARED });
    expect(state.mode).toBe('state');
    expect(state.delivery).toBe('at-least-once'); // v3.1 §4.4
    await runtime.shutdown();
  });
});

describe('runtime: bootstrap', () => {
  test('BR-1 / BR-2 / BR-3: the root exists before anything is loaded', async () => {
    const boot = createBootstrapRuntime({ domain: 'eapp.bootstrap' });

    // BR-3
    const discovery = boot.provideInitialDiscovery();
    expect(discovery.find).toBeDefined();
    await expect(discovery.find({}, {})).resolves.toEqual([]);

    // BR-2: identity issuance needs no plugin at all.
    const identity = await boot.createIdentity('root');
    expect(identity.id).toBe('root');

    // BR-1: an unknown reference fails loudly rather than being invented.
    await expect(
      boot.loadFirstPlugin({ domain: 'eapp.bootstrap', id: 'ghost', instance: 'ghost-1' }),
    ).rejects.toThrow('EAPP_PLUGIN_NOT_FOUND');

    // §12.3: replacement must be a real Discovery.
    expect(() => boot.replaceDiscovery(undefined)).toThrow('EAPP_UNSUPPORTED');
  });
});

describe('runtime: shutdown', () => {
  test('operations after shutdown fail cleanly', async () => {
    const { runtime } = await twoPlugins();
    await runtime.shutdown();
    await expect(runtime.discover({})).rejects.toThrow('EAPP_INTERNAL');
    expect(() => runtime.register(loggerPlugin())).toThrow('EAPP_INTERNAL');
  });
});

import { describe, expect, test } from 'vitest';

import type { Identity } from '@eapp/core';
import type { Cursor, CursorAnchor, Pattern } from '@eapp/interaction';
import type {
  ExpectedRevision,
  Revision,
  StatePattern,
  StateTransport,
  StateUpdate,
} from '@eapp/state';
import {
  EappError,
  EappRuntime,
  createBootstrapRuntime,
  isEappError,
  type PluginModule,
} from '@eapp/runtime';
import { MemoryTransport } from '@eapp/transport-memory';

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) await sleep(5);
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

describe('runtime: API contract', () => {
  test('the runtime accepts any StateTransport, not just the reference implementation', async () => {
    // Delegating wrapper: it implements the interface without being a MemoryTransport, so
    // TypeScript only accepts it if the runtime is typed against the interface.
    class OffsetTransport implements StateTransport {
      readonly #inner = new MemoryTransport('wrapped-1');
      get id() {
        return this.#inner.id;
      }
      get capabilities() {
        return this.#inner.capabilities;
      }
      send(channel: string, msg: unknown) {
        return this.#inner.send(channel, msg);
      }
      readAfter(channel: string, cursor: Cursor | undefined, pattern: Pattern) {
        return this.#inner.readAfter(channel, cursor, pattern);
      }
      close() {
        return this.#inner.close();
      }
      resolveAnchor(channel: string, anchor: CursorAnchor) {
        return this.#inner.resolveAnchor(channel, anchor);
      }
      waitForChange(channel: string, cursor: Cursor | undefined, signal?: AbortSignal) {
        return this.#inner.waitForChange(channel, cursor, signal);
      }
      head(channel: string) {
        return this.#inner.head(channel);
      }
      getState(channel: string, key: string) {
        return this.#inner.getState(channel, key);
      }
      listState(channel: string, pattern: StatePattern) {
        return this.#inner.listState(channel, pattern);
      }
      setStateWithCAS(channel: string, update: StateUpdate, actor: Identity) {
        return this.#inner.setStateWithCAS(channel, update, actor);
      }
      deleteStateWithCAS(channel: string, key: string, expected: ExpectedRevision, actor: Identity) {
        return this.#inner.deleteStateWithCAS(channel, key, expected, actor);
      }
      readChangesAfter(channel: string, cursor: Cursor | undefined, pattern: StatePattern) {
        return this.#inner.readChangesAfter(channel, cursor, pattern);
      }
      nextRevision(channel: string) {
        return this.#inner.nextRevision(channel);
      }
      compareRevision(a: Revision, b: Revision) {
        return this.#inner.compareRevision(a, b);
      }
      writeStateWithRevision(
        channel: string,
        key: string,
        value: unknown,
        deleted: boolean,
        revision: Revision,
        actor: Identity,
      ) {
        return this.#inner.writeStateWithRevision(channel, key, value, deleted, revision, actor);
      }
    }

    const runtime = EappRuntime.create({ transport: new OffsetTransport(), domain: 'eapp.demo' });
    const logger = runtime.register(loggerPlugin());
    const app = runtime.register(appPlugin());
    await runtime.activate(logger);
    await runtime.activate(app);

    const reply = await runtime.invoke({
      from: app,
      to: logger,
      capability: LOGGING,
      payload: 'through a custom transport',
    });
    expect((reply as { written: string }).written).toBe('through a custom transport');
    await runtime.shutdown();
  });

  test('a lifecycle hook fires only when the state actually changes', async () => {
    const runtime = EappRuntime.create({ domain: 'eapp.demo' });
    let activations = 0;
    const plugin: PluginModule = {
      manifest: {
        identity: { domain: 'eapp.demo', id: 'counted', instance: 'counted-1' },
        capabilities: [],
      },
      activate() {
        activations += 1;
      },
    };
    const identity = runtime.register(plugin);

    await runtime.activate(identity);
    expect(activations).toBe(1);
    // O-5 makes activate() idempotent at the core; the hook must follow, or every plugin
    // author has to defend against a duplicate activation the contract rules out.
    await runtime.activate(identity);
    await runtime.activate(identity);
    expect(activations).toBe(1);

    await runtime.deactivate(identity);
    await runtime.deactivate(identity);
    await runtime.activate(identity);
    expect(activations).toBe(2); // reactivation is a real transition
    await runtime.shutdown();
  });

  test('register rejects an identity carrying fields beyond domain/id/instance', async () => {
    const runtime = EappRuntime.create({ domain: 'eapp.demo' });
    expect(() =>
      runtime.register({
        manifest: {
          identity: {
            domain: 'eapp.demo',
            id: 'sneaky',
            instance: 'sneaky-1',
            version: '1.0.0', // ID-6: identity MUST NOT carry version semantics
          },
          capabilities: [],
        },
      } as never),
    ).toThrow('EAPP_IDENTITY_INVALID');
    await runtime.shutdown();
  });

  test('the runtime re-exports the protocol error so a plugin needs one import', () => {
    const error = new EappError('EAPP_TIMEOUT', 'from the runtime package');
    expect(error.code).toBe('EAPP_TIMEOUT');
    expect(error.message).toContain('EAPP_TIMEOUT');
    expect(isEappError(error)).toBe(true);
    expect(isEappError(new Error('plain'))).toBe(false);
  });

  test('the plugin contract has no onEvent hook', () => {
    // Declared-but-never-called is worse than absent: it looks supported and silently
    // discards the handler. Consumption goes through runtime.subscribe().
    const runtime = EappRuntime.create({ domain: 'eapp.demo' });
    const plugin: PluginModule = {
      manifest: { identity: { domain: 'eapp.demo', id: 'p', instance: 'p-1' }, capabilities: [] },
    };
    expect('onEvent' in plugin).toBe(false);
    void runtime;
  });
});

describe('runtime: composition lifecycle', () => {
  test('a suspended composition refuses new work end to end', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const { channel } = await runtime.connect({
      from: logger,
      to: app,
      capability: LOGGING,
      mode: 'event',
    });
    await runtime.activate(logger);
    await runtime.activate(app);
    expect(channel.state).toBe('ACTIVE');

    await runtime.publish({ from: logger, to: app, capability: LOGGING, mode: 'event' }, { n: 1 });

    // suspend() derives the Binding to DORMANT, which per CC-2 drains the Channel.
    await runtime.suspend(logger);
    expect(channel.state).toBe('DRAINING');

    // DRAINING means "stop accepting new work, let in-flight finish" — so this has to fail
    // rather than queue work into a composition nobody is going to run.
    await expect(
      runtime.publish({ from: logger, to: app, capability: LOGGING, mode: 'event' }, { n: 2 }),
    ).rejects.toThrow('EAPP_CHANNEL_DRAINING');

    // ...and it comes back once the composition does.
    await runtime.resume(logger);
    await expect(
      runtime.publish({ from: logger, to: app, capability: LOGGING, mode: 'event' }, { n: 3 }),
    ).resolves.toBeDefined();
    await runtime.shutdown();
  });
});

describe('runtime: consumer groups', () => {
  /**
   * The facade had no way to open a ConsumerGroup at all, while `write-a-plugin.md` §8
   * told plugin authors that exclusivity between consumers "由 ConsumerGroup + Lease 表达".
   * A documented expression path the public API cannot express is a facade defect, not an
   * invitation to reach past it and hand-build a SubscriptionSource. These pin the path.
   */
  test('two plugins compete for one Channel through the runtime', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const { channel } = await runtime.connect({
      from: logger,
      to: app,
      capability: LOGGING,
      mode: 'stream',
    });
    await runtime.activate(logger);
    await runtime.activate(app);

    const group = await runtime.openConsumerGroup(channel.id, { name: 'workers' });
    const a = await runtime.joinConsumerGroup(channel.id, 'workers');
    const b = await runtime.joinConsumerGroup(channel.id, 'workers');
    expect(group.memberCount).toBe(2);

    const iteratorA = a[Symbol.asyncIterator]();
    await runtime.publish({ from: logger, to: app, capability: LOGGING, mode: 'stream' }, { n: 1 });
    const held = (await iteratorA.next()).value;
    expect(held?.payload).toEqual({ n: 1 });

    // CG-3: the position A holds is not handed to B as well.
    const seen: unknown[] = [];
    void (async () => {
      for await (const message of b) {
        seen.push(message.payload);
        await message.ack();
      }
    })();
    await sleep(60);
    expect(seen).toHaveLength(0);

    // CG-6: a nack returns it to the group, and only then does B get it.
    await held?.nack();
    await waitFor(() => seen.length >= 1);
    expect(seen).toEqual([{ n: 1 }]);

    // CG-2: one position for the whole group; no member owns its own.
    expect(a.cursor).toBe(b.cursor);
    expect(b.cursor).toBe(group.cursor);

    await a.close();
    await b.close();
    await runtime.shutdown();
  });

  test('CG-8: joining must name an existing group on the same Channel', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const { channel } = await runtime.connect({
      from: logger,
      to: app,
      capability: LOGGING,
      mode: 'stream',
    });
    await expect(runtime.joinConsumerGroup(channel.id, 'nobody')).rejects.toThrow(
      'EAPP_SUBSCRIPTION_INVALID',
    );
    await runtime.shutdown();
  });

  test('a group cannot be opened on a DRAINING Channel', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const { channel } = await runtime.connect({
      from: logger,
      to: app,
      capability: LOGGING,
      mode: 'stream',
    });
    await runtime.activate(logger);
    await runtime.activate(app);
    await runtime.suspend(logger);
    expect(channel.state).toBe('DRAINING');

    // A group is a consumer, so DRAINING — "no new work" — has to refuse it.
    await expect(runtime.openConsumerGroup(channel.id, { name: 'workers' })).rejects.toThrow(
      'EAPP_CHANNEL_DRAINING',
    );
    await runtime.shutdown();
  });

  test('CG-1: a group name is unique within its Channel', async () => {
    const { runtime, logger, app } = await twoPlugins();
    const { channel } = await runtime.connect({
      from: logger,
      to: app,
      capability: LOGGING,
      mode: 'stream',
    });
    await runtime.openConsumerGroup(channel.id, { name: 'workers' });
    await expect(runtime.openConsumerGroup(channel.id, { name: 'workers' })).rejects.toThrow(
      'EAPP_SUBSCRIPTION_INVALID',
    );
    expect(runtime.consumerGroup(channel.id, 'workers')?.name).toBe('workers');
    expect(runtime.listConsumerGroups(channel.id)).toHaveLength(1);
    await runtime.shutdown();
  });
});

describe('runtime: subscription anchors', () => {
  /**
   * `'earliest'` used to be hardcoded to the empty sentinel rather than asked of the
   * transport. On a retained log that named a position which no longer exists, so the
   * cursor a subscriber was handed did not identify anything readable.
   */
  test("'earliest' resolves to the transport's retention floor", async () => {
    const transport = new MemoryTransport('retained', { retention: { kind: 'window', entries: 2 } });
    const runtime = EappRuntime.create({ domain: 'eapp.demo', transport });
    const logger = runtime.register(loggerPlugin());
    const app = runtime.register(appPlugin());
    const { channel } = await runtime.connect({
      from: logger,
      to: app,
      capability: LOGGING,
      mode: 'stream',
    });
    await runtime.activate(logger);
    await runtime.activate(app);

    for (const n of [1, 2, 3, 4]) {
      await runtime.publish({ from: logger, to: app, capability: LOGGING, mode: 'stream' }, { n });
    }

    const subscription = await runtime.subscribe(channel.id, { all: true }, { cursor: 'earliest' });
    // Two entries are retained, so four writes leave the floor at position 2.
    expect(subscription.cursor).toBe('retained!0000000000000002');

    const received: unknown[] = [];
    void (async () => {
      for await (const message of subscription) {
        received.push(message.payload);
        await message.ack();
      }
    })();
    await waitFor(() => received.length >= 2);
    expect(received).toEqual([{ n: 3 }, { n: 4 }]);

    await subscription.close();
    await runtime.shutdown();
  });
});

describe('runtime: shutdown', () => {
  test('operations after shutdown fail cleanly', async () => {
    const { runtime } = await twoPlugins();
    await runtime.shutdown();
    await expect(runtime.discover({})).rejects.toThrow('EAPP_INTERNAL');
    expect(() => runtime.register(loggerPlugin())).toThrow('EAPP_INTERNAL');
  });

  /**
   * The assertion here is that this test finishes at all.
   *
   * `shutdown()` aborts the dispatcher and closes the transport, but a handler that is
   * sleeping does not stop just because we stopped listening. When it woke up, its reply
   * was sent into a closed transport and the resulting error escaped from a detached
   * background loop as an unhandled rejection — killing the process. Shutting down with
   * work in flight is ordinary, so it must not be fatal.
   */
  test('shutting down while a handler is still running is not fatal', async () => {
    const runtime = EappRuntime.create({ domain: 'eapp.demo' });
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });

    const slow = runtime.register({
      manifest: {
        identity: { domain: 'eapp.demo', id: 'slow', instance: 'slow-1' },
        capabilities: [LOGGING],
      },
      handlers: {
        logging: async () => {
          started();
          await sleep(40);
          return 'too late to matter';
        },
      },
    });
    const app = runtime.register(appPlugin());
    await runtime.activate(slow);
    await runtime.activate(app);

    const call = runtime.invoke({ from: app, to: slow, capability: LOGGING, timeoutMs: 5 });
    await began;
    await expect(call).rejects.toThrow('EAPP_TIMEOUT');

    // The handler is still running right now. Tear everything down underneath it.
    await runtime.shutdown();
    await sleep(80); // long enough for it to finish and try to reply
  });
});

/**
 * EaPP — everything is a plugin.
 *
 * A runnable end-to-end demonstration: three wholly independent plugins are discovered,
 * connected, activated, made to talk, and made to share versioned state — without any of
 * them knowing about each other.
 *
 *   pnpm demo
 *
 * Every step below maps onto a frozen layer, and the comment says which. The runtime adds
 * no semantics of its own.
 */

import { EappRuntime, type PluginModule } from '../../packages/runtime/src/index.js';

const LOGGING = { name: 'logging', version: '1.0.0' };
const METRICS = { name: 'metrics', version: '2.1.0' };
const SESSIONS = { name: 'sessions', version: '1.0.0' };

function banner(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log('─'.repeat(title.length));
}

// ---------------------------------------------------------------------------
// Three plugins. None of them imports another; none of them knows the runtime
// exists beyond the module contract.
// ---------------------------------------------------------------------------

function loggerPlugin(): PluginModule {
  const written: string[] = [];
  return {
    manifest: {
      identity: { domain: 'acme.logging', id: 'logger', instance: 'logger-1' },
      capabilities: [LOGGING, SESSIONS],
    },
    activate() {
      console.log('  [logger] activated — now part of the active composition');
    },
    async deactivate() {
      console.log('  [logger] deactivated — bindings will derive to DORMANT');
    },
    handlers: {
      logging: async (payload) => {
        const entry = payload as { level: string; message: string };
        const line = `${entry.level.toUpperCase()} ${entry.message}`;
        written.push(line);
        return { line, total: written.length };
      },
    },
  };
}

function metricsPlugin(): PluginModule {
  return {
    manifest: {
      identity: { domain: 'acme.observability', id: 'metrics', instance: 'metrics-1' },
      capabilities: [METRICS],
    },
    activate() {
      console.log('  [metrics] activated — ready to publish samples');
    },
    handlers: {
      // Nothing here consumes its own events. Consumption in this runtime is always
      // explicit: a subscriber calls runtime.subscribe() and gets a real v3.1
      // Subscription with a cursor it acknowledges. Section 5 shows the consumer side.
      metrics: async () => ({ publisher: 'metrics@2.1.0' }),
    },
  };
}

function appPlugin(): PluginModule {
  return {
    manifest: {
      identity: { domain: 'acme.app', id: 'checkout', instance: 'checkout-1' },
      capabilities: [],
    },
    activate() {
      console.log('  [app] activated — it declares no capabilities of its own');
    },
  };
}

async function main(): Promise<void> {
  const runtime = EappRuntime.create({ domain: 'eapp.demo' });

  // -------------------------------------------------------------------------
  // 1. Discovery — v3.0 §8
  // -------------------------------------------------------------------------
  banner('1. Discovery — 发现');
  const logger = runtime.register(loggerPlugin());
  const metrics = runtime.register(metricsPlugin());
  const app = runtime.register(appPlugin());

  for (const descriptor of runtime.describe()) {
    const caps = descriptor.capabilities.length > 0 ? descriptor.capabilities.join(', ') : '(none)';
    console.log(`  ${descriptor.identity.id.padEnd(10)} ${descriptor.lifecycle.padEnd(9)} ${caps}`);
  }

  const found = await runtime.discover({ capability: 'logging' });
  console.log(`\n  find({ capability: 'logging' }) -> ${found.map((p) => p.id).join(', ')}`);
  console.log('  Discovery found the logger, but nothing is composed yet:');
  console.log(`  bindings = ${runtime.core.listBindings().length}  (D-3: discovery ≠ composability)`);

  // -------------------------------------------------------------------------
  // 2. Activation — v3.0 §7
  // -------------------------------------------------------------------------
  banner('2. Activation — 激活');
  await runtime.activate(logger);
  await runtime.activate(metrics);
  await runtime.activate(app);

  // -------------------------------------------------------------------------
  // 3. Connect — v3.0 §9 bind() + v3.1 §11 createChannel()
  // -------------------------------------------------------------------------
  banner('3. Connect — 连接');
  const request = await runtime.connect({
    from: logger,
    to: app,
    capability: LOGGING,
    mode: 'request',
  });
  console.log(`  binding   ${request.binding.id}`);
  console.log(`  channel   ${request.channel.id}  mode=${request.channel.mode}  delivery=${request.channel.delivery}`);
  console.log(`  binding state = ${runtime.core.bindingState(request.binding.id)}  (derived, never assigned)`);

  // -------------------------------------------------------------------------
  // 4. Invoke — request mode over a real Channel
  // -------------------------------------------------------------------------
  banner('4. Invoke — 调用');
  const reply = await runtime.invoke({
    from: app,
    to: logger,
    capability: LOGGING,
    payload: { level: 'info', message: 'checkout completed' },
  });
  console.log(`  reply: ${JSON.stringify(reply)}`);

  const concurrent = await Promise.all(
    ['one', 'two', 'three'].map((word) =>
      runtime.invoke({ from: app, to: logger, capability: LOGGING, payload: { level: 'debug', message: word } }),
    ),
  );
  console.log(`  3 concurrent calls, correlated independently: ${concurrent.map((r) => (r as { line: string }).line).join(' | ')}`);

  // -------------------------------------------------------------------------
  // 5. Communicate — event mode, v3.1 Subscription with a real cursor
  // -------------------------------------------------------------------------
  banner('5. Communicate — 通信');
  const metricsChannel = await runtime.connect({
    from: metrics,
    to: app,
    capability: METRICS,
    mode: 'event',
  });
  const subscription = await runtime.subscribe(metricsChannel.channel.id, { type: 'metric' }, {});
  console.log(`  subscribed at cursor ${JSON.stringify(subscription.cursor)}  (resolved eagerly)`);

  const received: unknown[] = [];
  const pump = (async () => {
    for await (const message of subscription) {
      received.push(message.payload);
      await message.ack(); // CR-1: only an ack moves the cursor
      if (received.length === 3) break;
    }
  })();

  for (const value of [12, 47, 91]) {
    await runtime.publish(
      { from: metrics, to: app, capability: METRICS, mode: 'event' },
      { type: 'metric', value },
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  await subscription.close();
  await pump;

  console.log(`  received: ${JSON.stringify(received)}`);
  console.log(`  cursor after acks: ${JSON.stringify(subscription.cursor)}`);

  // -------------------------------------------------------------------------
  // 6. Share state — v3.2 State Mode, CAS only
  // -------------------------------------------------------------------------
  banner('6. Shared state — 共享状态');
  const sessions = await runtime.stateChannel({ from: logger, to: app, capability: SESSIONS });

  const v1 = await state_set(sessions, 'active', 0, null);
  console.log(`  set active=0   -> revision ${v1}`);
  const v2 = await state_set(sessions, 'active', 1, v1);
  console.log(`  set active=1   -> revision ${v2}`);

  // Two writers holding the same stale token: exactly one may win.
  const attempts = await Promise.allSettled([
    state_set(sessions, 'active', 42, v2),
    state_set(sessions, 'active', 43, v2),
    state_set(sessions, 'active', 44, v2),
  ]);
  const won = attempts.filter((a) => a.status === 'fulfilled').length;
  const lost = attempts.filter((a) => a.status === 'rejected');
  console.log(`  3 writers with the same token -> ${won} won, ${lost.length} rejected`);
  console.log(`  rejection code: ${(lost[0] as PromiseRejectedResult).reason.code} (retryable=true)`);
  console.log(`  final: ${JSON.stringify((await sessions.get('active'))?.value)}  — no lost update`);

  // A watcher observes the log, and its cursor IS the revision.
  const watcher = await sessions.watch({ key: 'active' });
  const observed: number[] = [];
  const watch = (async () => {
    for await (const update of watcher) {
      observed.push(update.value as number);
      await update.ack();
      if (observed.length === 1) break;
    }
  })();
  await state_set(sessions, 'active', 45, (await sessions.get('active'))!.revision);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await watcher.close();
  await watch;
  console.log(`  watcher saw ${JSON.stringify(observed)} at revision ${JSON.stringify(watcher.cursor)}`);

  // -------------------------------------------------------------------------
  // 7. Lifecycle propagation — v3.0 §7.4 / v3.1 CC-2
  // -------------------------------------------------------------------------
  banner('7. Lifecycle — 生命周期');
  await runtime.suspend(logger);
  console.log(`  suspend(logger) -> binding ${request.binding.id} = ${runtime.core.bindingState(request.binding.id)}`);
  console.log(`  channel ${request.channel.id} = ${request.channel.state}`);
  await runtime.resume(logger);
  console.log(`  resume(logger)  -> binding = ${runtime.core.bindingState(request.binding.id)}`);

  await runtime.shutdown();
  banner('done');
  console.log('Three independent plugins: discovered, connected, activated, invoked,');
  console.log('and sharing versioned state — each one unaware of the others.\n');
}

/** Small helper so the CAS calls read clearly above. */
async function state_set(
  channel: Awaited<ReturnType<EappRuntime['stateChannel']>>,
  key: string,
  value: number,
  expectedRevision: string | null,
): Promise<string> {
  return channel.set({ key, value, expectedRevision });
}

main().catch((error: unknown) => {
  console.error('\n\x1b[31mdemo failed\x1b[0m');
  console.error(error);
  process.exitCode = 1;
});

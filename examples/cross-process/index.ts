/**
 * EaPP — 万物皆插件，跨进程。
 *
 *   npx tsx examples/cross-process/index.ts
 *   pnpm run example:cross-process
 *
 * 另外四个示例都在一个进程里。这一个把三层架在真正跨越进程边界的 Transport 上：
 *
 *   broker 进程        数据的唯一所有者，独占位置分配，也是竞争状态的唯一所有者
 *   worker 进程 × 2    各自跑一个完整的运行时，加入**同一个** ConsumerGroup
 *   本进程             发布订单，并核对结论
 *
 * 跨过去之后有几件事会**变**，而它们正是这个示例存在的理由：
 *
 *   位置必须由一方独占分配 —— 两个进程各自发号，得到的不是 cursor，是巧合
 *   Channel 的 id 必须靠推导而非计数 —— 否则两个进程用同一个名字读两本日志
 *   竞争状态必须和消息待在同一处 —— 认领表在进程内内存里，CG-3 就保证不了
 *   请求分发仍然只在进程内 —— 见最后一段
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EappRuntime } from '../../packages/runtime/src/index.js';
import { SocketTransport } from '../../packages/transport/socket/src/index.js';

import {
  CHECKOUT,
  COUNTER,
  COUNTER_BINDING,
  FULFILMENT,
  LEDGER,
  ORDERS,
  PRICING,
  PRICING_PROVIDER,
  SHOP,
  channelId,
  type Order,
} from './shared.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const ORDERS_TO_SEND = 6;

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

const broken: string[] = [];
let checked = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  checked += 1;
  if (ok) return;
  broken.push(`${label}${detail === undefined ? '' : `（实际 ${JSON.stringify(detail)}）`}`);
}

function banner(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log('─'.repeat(title.length));
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------

interface Child {
  name: string;
  process: ChildProcessWithoutNullStreams;
  lines: Array<Record<string, unknown>>;
}

function launch(script: string, name: string, args: string[]): Child {
  const child = spawn(process.execPath, [tsx, join(HERE, script), ...args]);
  const record: Child = { name, process: child, lines: [] };

  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const parts = buffered.split('\n');
    buffered = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim().length === 0) continue;
      try {
        record.lines.push(JSON.parse(part) as Record<string, unknown>);
      } catch {
        // Not protocol traffic — a stray log line. Surfaced rather than dropped,
        // because a child that prints something unexpected is worth seeing.
        record.lines.push({ type: 'stray', text: part });
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    record.lines.push({ type: 'stderr', text: chunk.toString('utf8').trim() });
  });

  return record;
}

const linesOfType = (child: Child, type: string): Array<Record<string, unknown>> =>
  child.lines.filter((line) => line.type === type);

async function waitForLine(
  child: Child,
  type: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = child.lines.find((line) => line.type === type);
    if (found) return found;
    const stderr = child.lines.find((line) => line.type === 'stderr');
    if (stderr) throw new Error(`${child.name} failed:\n${String(stderr.text)}`);
    if (child.process.exitCode !== null) {
      throw new Error(`${child.name} exited early (code ${child.process.exitCode})`);
    }
    await sleep(20);
  }
  throw new Error(`${child.name} never reported '${type}'`);
}

/** Ask a worker to finish: it closes its group membership and reports what it did. */
function signalStop(child: Child): void {
  child.process.stdin.write('stop\n');
}

/** Terminate a child and actually wait for it: leaving orphans behind hangs the parent. */
async function stop(child: Child): Promise<void> {
  if (child.process.exitCode !== null) return;
  child.process.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (child.process.exitCode === null && Date.now() < deadline) await sleep(20);
  if (child.process.exitCode === null) child.process.kill('SIGKILL');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n万物皆插件 — 跨进程\n');

  const brokerChild = launch('broker.ts', 'broker', []);
  const workers: Child[] = [];

  try {
    // -----------------------------------------------------------------------
    banner('1. broker：唯一拥有日志的进程');
    // -----------------------------------------------------------------------

    const ready = await waitForLine(brokerChild, 'ready');
    const port = Number(ready?.port);
    console.log(`  broker 进程已就绪  pid=${String(brokerChild.process.pid)}  port=${port}`);
    console.log(`  transport id = ${String(ready?.id)}（每个 cursor 都带这个前缀）`);

    const transport = await SocketTransport.connect({ port });
    console.log(`  本进程连接后 adopt 到的 id = ${transport.id}  boundary=${transport.capabilities.durabilityBoundary}`);

    check('客户端采用 broker 的 id', transport.id === String(ready?.id), transport.id);
    check(
      '跨进程后 durabilityBoundary 比 process 更宽',
      transport.capabilities.durabilityBoundary === 'machine',
      transport.capabilities.durabilityBoundary,
    );

    // -----------------------------------------------------------------------
    banner('2. 一个运行时跑在 socket 上');
    // -----------------------------------------------------------------------

    const runtime = EappRuntime.create({ domain: 'eapp.xproc', transport, channelId });
    const shop = runtime.register({
      manifest: { identity: SHOP, capabilities: [ORDERS] },
      handlers: {},
    });
    const fulfilment = runtime.register({
      manifest: { identity: FULFILMENT, capabilities: [] },
    });
    await runtime.activate(shop);
    await runtime.activate(fulfilment);

    const { channel } = await runtime.connect({
      from: shop,
      to: fulfilment,
      capability: ORDERS,
      mode: 'stream',
    });
    console.log(`  channel = ${channel.id}`);
    console.log('  —— 这个名字是**推导**出来的，不是计数的：每个进程都算得出同一个');

    // 计数器 Channel：两个 worker 会在这上面用 CAS 抢同一个 key。
    runtime.register({
      manifest: { identity: LEDGER, capabilities: [COUNTER] },
      handlers: {},
    });
    const counter = await runtime.stateChannel(COUNTER_BINDING);

    // 本进程自己订阅一份，用来对照：这是 fan-out，不是竞争。
    const mine: number[] = [];
    const ownSubscription = await runtime.subscribe(channel.id, { all: true });
    const ownDrain = (async () => {
      for await (const message of ownSubscription) {
        mine.push((message.payload as Order).id);
        await message.ack();
        if (mine.length >= ORDERS_TO_SEND) return;
      }
    })().catch(() => undefined);

    // -----------------------------------------------------------------------
    banner('3. 两个 worker 进程加入同一个组');
    // -----------------------------------------------------------------------

    const alpha = launch('worker.ts', 'alpha', [
      '--port', String(port), '--name', 'alpha',
      '--orders', channel.id, '--counter', counter.id,
    ]);
    const beta = launch('worker.ts', 'beta', [
      '--port', String(port), '--name', 'beta',
      '--orders', channel.id, '--counter', counter.id,
    ]);
    workers.push(alpha, beta);

    const alphaReady = await waitForLine(alpha, 'ready');
    const betaReady = await waitForLine(beta, 'ready');
    console.log(`  alpha pid=${String(alphaReady?.pid)}   beta pid=${String(betaReady?.pid)}`);

    check('两个消费者真的在不同的进程里', alphaReady?.pid !== betaReady?.pid, [
      alphaReady?.pid, betaReady?.pid,
    ]);
    check(
      '两个进程各自算出了同一个 Channel 名',
      alphaReady?.counterChannel === counter.id && betaReady?.counterChannel === counter.id,
      [alphaReady?.counterChannel, counter.id],
    );

    const orders: Order[] = Array.from({ length: ORDERS_TO_SEND }, (_, index) => ({
      id: index + 1,
      total: (index + 1) * 37,
    }));
    for (const order of orders) {
      await runtime.publish({ from: shop, to: fulfilment, capability: ORDERS, mode: 'stream' }, order);
    }
    console.log(`\n  published ${orders.length} 条订单`);

    // 等两个 worker 一起把订单认领完。这里刻意不等某一个 worker ——
    // 谁拿到哪一条由组决定，不由我们决定。
    const handledTotal = (): number => linesOfType(alpha, 'order').length + linesOfType(beta, 'order').length;
    const deadline = Date.now() + 10_000;
    while (handledTotal() < orders.length && Date.now() < deadline) await sleep(20);

    signalStop(alpha);
    signalStop(beta);
    const alphaDone = await waitForLine(alpha, 'done');
    const betaDone = await waitForLine(beta, 'done');

    // -----------------------------------------------------------------------
    banner('4. 结论：竞争消费跨过去了');
    // -----------------------------------------------------------------------

    const fromAlpha = (alphaDone?.seen as number[] | undefined) ?? [];
    const fromBeta = (betaDone?.seen as number[] | undefined) ?? [];
    const all = [...fromAlpha, ...fromBeta];
    const expected = orders.map((order) => order.id);

    console.log(`  alpha 处理了 ${JSON.stringify(fromAlpha)}`);
    console.log(`  beta  处理了 ${JSON.stringify(fromBeta)}`);

    check('没有一条订单被两个进程都处理（CG-3）', new Set(all).size === all.length, all);
    check('一条订单都没有丢', [...all].sort((a, b) => a - b).join(',') === expected.join(','), all);
    check('两个进程都真的干了活', fromAlpha.length > 0 && fromBeta.length > 0, {
      alpha: fromAlpha.length, beta: fromBeta.length,
    });
    console.log('  —— 每条订单恰好被**一个**成员持有，而这两个成员在不同的进程里。');
    console.log('  CG-3 现在跨得过进程边界了：因为认领表和消息一起待在 broker 里。');

    // 计数器：每条订单恰好加一次。竞争消费下应当是 6，不是 12。
    const cell = await counter.get('processed');
    console.log(`\n  跨进程共享计数器：期望 ${orders.length}，实际 ${String(cell?.value)}`);
    check('每条订单恰好结算一次', cell?.value === orders.length, cell?.value);
    console.log(`  CAS 重试次数：alpha ${String(alphaDone?.retries)} / beta ${String(betaDone?.retries)}`);
    console.log('  两个进程同时 read-modify-write 同一个 key，只有 CAS 能保证不丢。');

    // -----------------------------------------------------------------------
    banner('5. 同一时刻，fan-out 仍然成立');
    // -----------------------------------------------------------------------

    await ownDrain;
    await ownSubscription.close();
    console.log(`  本进程以**独立订阅**读了 ${JSON.stringify([...mine].sort((a, b) => a - b))}`);
    check('独立订阅者看到全部订单', mine.length === orders.length, mine);
    console.log('  —— 它不在那个组里，所以它看到全部；组里的成员才互相竞争。');
    console.log('  组之间：每个组收到全部消息；组之内：每条只交给一个成员（§8.1）。');

    // -----------------------------------------------------------------------
    banner('6. 请求/响应也跨过去了');
    // -----------------------------------------------------------------------

    const pricingChild = launch('provider.ts', 'pricing', ['--port', String(port)]);
    workers.push(pricingChild);
    const pricingReady = await waitForLine(pricingChild, 'ready');
    console.log(`  provider 进程 pid=${String(pricingReady?.pid)}  channel=${String(pricingReady?.channel)}`);

    // 本进程注册它，但**不承载**它。
    //
    // 这一条区别是整个改动的一半。以前"注册了"等于"我执行它"，于是调用方的
    // dispatcher 找不到 handler，会立刻回一个 EAPP_CAPABILITY_NOT_EXPOSED ——
    // 从它自己的角度看完全正确，却会和真正的提供方抢答，谁先到谁赢。
    const pricing = runtime.registerRemote({ identity: PRICING_PROVIDER, capabilities: [PRICING] });
    const checkout = runtime.register({
      manifest: { identity: CHECKOUT, capabilities: [] },
    });
    await runtime.activate(pricing);
    await runtime.activate(checkout);

    check('本进程可寻址它，但不承载它', !runtime.hosts(pricing), runtime.hosts(pricing));

    // invoke 的 from 是**调用方**，to 是**提供方** —— 与 connect 相反。
    const quote = await runtime.invoke({
      from: checkout,
      to: pricing,
      capability: PRICING,
      payload: { quantity: 3, unit: 25 },
    });

    const pricingCalls = linesOfType(pricingChild, 'call');
    console.log(`  invoke pricing.quote → ${JSON.stringify(quote)}`);
    console.log(`  提供方进程收到 ${pricingCalls.length} 次调用，pid=${String(pricingCalls[0]?.pid)}`);

    check('回复来自另一个进程的 handler', (quote as { servedBy?: number })?.servedBy === pricingReady?.pid, quote);
    check('handler 恰好执行一次', pricingCalls.length === 1, pricingCalls.length);
    check(
      'handler 跑在提供方进程里',
      pricingCalls[0]?.pid === pricingReady?.pid,
      [pricingCalls[0]?.pid, pricingReady?.pid],
    );
    console.log('  —— handler 在**另一个进程**里执行，回复经 Channel 回来。');
    console.log('  请求路由不需要协议新概念：一条 Binding、一条 Channel、一次 invoke。');

    // -----------------------------------------------------------------------
    banner('7. 这一路都需要什么');
    // -----------------------------------------------------------------------

    console.log('  三样东西跨过去了，用的都是同一条原则 ——');
    console.log('  **"谁拥有什么"只能在数据所在的那一侧决定**：');
    console.log('');
    console.log('    位置分配   broker 独占发号，客户端 adopt 它的 id');
    console.log('    Channel 名  由 Binding 推导，每个进程都算得出同一个');
    console.log('    竞争认领   和消息一起待在 broker 里');
    console.log('    服务者身份 同样由 broker 仲裁，连接断开即释放');
    console.log('');
    console.log('  漏掉任何一条，错误都是**安静的** —— 这正是它们值得被逐条命名的原因。');
    console.log('  位置撞车 = readAfter 返回无意义的结果；Channel 名撞车 = 各自读自己那本日志；');
    console.log('  认领不共享 = 每条消息处理两次；服务者重复 = handler 跑两次而调用方看不出。');

    signalStop(pricingChild);
    await waitForLine(pricingChild, 'done');

    await runtime.shutdown();
  } finally {
    // 无论成功与否都要收干净：留下一个活着的子进程，父进程就永远不退出。
    for (const worker of workers) await stop(worker);
    await stop(brokerChild);
  }

  console.log('');
  if (broken.length > 0) {
    console.error(`\x1b[31m自检失败 ${broken.length}/${checked}\x1b[0m`);
    for (const item of broken) console.error(`  ✗ ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log(`自检: ${checked} 条断言全部通过`);
  console.log('');
  console.log('位置、顺序、CAS、投递保证、竞争所有权、请求路由 —— 都跨过去了。');
  console.log('每一处都遵循同一条原则：谁拥有什么，只能在数据所在的那一侧决定。');
}

main().catch((error: unknown) => {
  console.error('\n\x1b[31mcross-process 失败\x1b[0m');
  console.error(error);
  process.exitCode = 1;
});

/**
 * EaPP — 万物皆插件，跨进程。
 *
 *   npx tsx examples/cross-process/index.ts
 *   pnpm run example:cross-process
 *
 * 另外三个示例都在一个进程里。这一个把三层架在真正跨越进程边界的 Transport 上：
 *
 *   broker 进程        数据的唯一所有者，独占位置分配
 *   worker 进程 × 2    各自跑一个完整的运行时，通过 socket 读写同一本日志
 *   本进程             发布消息，并在最后核对结论
 *
 * 跨过去之后，有几件事会**变**，而它们正是这个示例存在的理由：
 *
 *   位置必须由一方独占分配 —— 两个进程各自发号，得到的不是 cursor，是巧合
 *   Channel 的 id 必须靠推导而非计数 —— 否则两个进程用同一个名字读两本日志
 *   状态要在 broker 那里 CAS —— 原子性不可能靠"两边都读一次再比一下"实现
 *   ConsumerGroup **跨不过去** —— 它的认领表在本进程内存里，见第 4 段
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EappError } from '../../packages/core/src/index.js';
import { EappRuntime } from '../../packages/runtime/src/index.js';
import { SocketTransport } from '../../packages/transport/socket/src/index.js';

import {
  COUNTER,
  COUNTER_BINDING,
  FULFILMENT,
  LEDGER,
  ORDERS,
  SHOP,
  channelId,
  type Order,
} from './shared.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const tsx = createRequire(import.meta.url).resolve('tsx/cli');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  /** Every JSON line the child printed, unparsed. */
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

    // 本进程也用同一个 broker，但**只**把下层接起来，不跑插件。
    const transport = await SocketTransport.connect({ port });
    console.log(`  本进程连接后 adopt 到的 id = ${transport.id}  boundary=${transport.capabilities.durabilityBoundary}`);

    check('客户端采用 broker 的 id', transport.id === String(ready?.id), transport.id);
    check(
      '跨进程后 durabilityBoundary 比 process 更宽',
      transport.capabilities.durabilityBoundary === 'machine',
      transport.capabilities.durabilityBoundary,
    );

    // -----------------------------------------------------------------------
    banner('2. 一个运行时跑在 socket 上：发布与订阅');
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
    console.log(`  —— 这个名字是**推导**出来的，不是计数的：每个进程都算得出同一个`);

    // 计数器 Channel：两个 worker 会在这上面用 CAS 抢同一把锁。
    runtime.register({
      manifest: { identity: LEDGER, capabilities: [COUNTER] },
      handlers: {},
    });
    const counter = await runtime.stateChannel(COUNTER_BINDING);

    const orders: Order[] = [
      { id: 1, total: 120 },
      { id: 2, total: 80 },
      { id: 3, total: 340 },
      { id: 4, total: 15 },
    ];

    // 先让两个 worker 上线，再发布 —— 它们从 'latest' 开始订阅。
    const alpha = launch('worker.ts', 'alpha', [
      '--port', String(port), '--name', 'alpha',
      '--orders', channel.id, '--counter', counter.id,
      '--rounds', String(orders.length),
    ]);
    const beta = launch('worker.ts', 'beta', [
      '--port', String(port), '--name', 'beta',
      '--orders', channel.id, '--counter', counter.id,
      '--rounds', String(orders.length),
    ]);
    workers.push(alpha, beta);

    const alphaReady = await waitForLine(alpha, 'ready');
    const betaReady = await waitForLine(beta, 'ready');
    console.log(`\n  alpha pid=${String(alphaReady?.pid)}   beta pid=${String(betaReady?.pid)}`);

    check('两个消费者真的在不同的进程里', alphaReady?.pid !== betaReady?.pid, [
      alphaReady?.pid, betaReady?.pid,
    ]);
    check(
      '两个进程各自算出了同一个 Channel 名',
      alphaReady?.counterChannel === counter.id && betaReady?.counterChannel === counter.id,
      [alphaReady?.counterChannel, counter.id],
    );

    for (const order of orders) {
      await runtime.publish({ from: shop, to: fulfilment, capability: ORDERS, mode: 'stream' }, order);
    }
    console.log(`\n  published ${orders.length} 条订单`);

    const alphaDone = await waitForLine(alpha, 'done');
    const betaDone = await waitForLine(beta, 'done');

    // -----------------------------------------------------------------------
    banner('3. 结论');
    // -----------------------------------------------------------------------

    const expected = orders.map((o) => o.id);
    check('alpha 看到全部订单', JSON.stringify(alphaDone?.seen) === JSON.stringify(expected), alphaDone?.seen);
    check('beta 看到全部订单', JSON.stringify(betaDone?.seen) === JSON.stringify(expected), betaDone?.seen);
    console.log(`  alpha 收到 ${JSON.stringify(alphaDone?.seen)}`);
    console.log(`  beta  收到 ${JSON.stringify(betaDone?.seen)}`);
    console.log('  两个独立进程各自订阅同一条 Channel —— 这是 fan-out，不是竞争：');
    console.log('  它们各有各的 cursor，都读到了全部消息。');

    // 每个 worker 每条消息 CAS 加一。丢更新的话，这个数会小于 8。
    const total = orders.length * 2;
    const cell = await counter.get('processed');
    console.log(`\n  跨进程共享计数器：期望 ${total}，实际 ${String(cell?.value)}`);
    check('没有丢更新', cell?.value === total, cell?.value);
    console.log(`  CAS 重试次数：alpha ${String(alphaDone?.retries)} / beta ${String(betaDone?.retries)}`);
    console.log('  两个进程同时在同一个 key 上做 read-modify-write，只有 CAS 能保证不丢；');
    console.log('  拿到 EAPP_REVISION_CONFLICT 的那一方重读再写 —— 这就是 retryable 的含义。');

    // 位置来自同一本日志，因此在哪个进程里都有效。
    const firstCursor = await transport.resolveAnchor(channel.id, 'earliest');
    const reread = await transport.readAfter(channel.id, firstCursor, { all: true });
    check('本进程能读到 worker 写下的位置之后的内容', reread.length >= orders.length, reread.length);
    console.log(`\n  本进程从 ${firstCursor || '(日志起点)'} 重读 → ${reread.length} 条`);
    console.log('  cursor 是共享日志里的位置，所以在哪个进程里读都成立。');

    // -----------------------------------------------------------------------
    banner('4. 跨不过去的那一半');
    // -----------------------------------------------------------------------

    // ConsumerGroup 的认领表在本进程内存里。跨进程时两个成员会各自以为自己
    // 持有同一个位置，于是同一条消息被两个进程都处理一遍 —— CG-3 被静默违反。
    // 与其给一个错答案，不如明确拒绝。
    let refusal: EappError | undefined;
    try {
      await runtime.openConsumerGroup(channel.id, { name: 'workers' });
    } catch (error) {
      refusal = error instanceof EappError ? error : undefined;
    }
    check('跨进程开 ConsumerGroup 被明确拒绝', refusal?.code === 'EAPP_UNSUPPORTED', refusal?.code);
    console.log(`  openConsumerGroup → ${String(refusal?.code)}`);
    console.log('  原因：认领表（claim registry）是进程内内存。');
    console.log('  两个进程会各自以为持有同一个位置 → 每条消息被处理两次，而没有任何报错。');
    console.log('  规范 §8.3 说"一次 claim 就是一次 Lease"，L-2 因此是 CG-3 的保证 ——');
    console.log('  但这套实现的 Lease 没有出过进程，所以它保证不了跨进程的 CG-3。');
    console.log('  这一条现在会**失败**而不是静默降级（TR-4）。');

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
  console.log('Transport 跨过去了：位置、顺序、CAS、投递保证都还在。');
  console.log('运行时还剩两处只在单进程内成立 —— 认领表，和请求分发。');
  console.log('它们现在是明确的失败，不再是安静的错误。');
}

main().catch(async (error: unknown) => {
  console.error('\n\x1b[31mcross-process 失败\x1b[0m');
  console.error(error);
  process.exitCode = 1;
});

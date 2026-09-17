/**
 * EaPP — 万物皆插件：用几个互不相识的插件组一个任务队列。
 *
 *   npx tsx examples/job-queue/index.ts
 *   pnpm run example:queue
 *
 * `examples/hello-plugins/` 走三层全貌，`examples/my-first-plugin/` 走 request 模式。
 * 这一个专门走 Interaction Layer 难的那一半：
 *
 *   竞争消费   一条消息只交给组里的一个成员          （CG-3）
 *   重投       成员 nack 之后位置归还给组            （CG-6 / at-least-once 的真实含义）
 *   成员离开   它持有的工作立刻释放，不等 claim TTL   （CG-5）
 *   独立组     同一 Channel 上的另一个组看到全部消息  （CG-4）
 *   共享游标   成员自己不持有位置，组只有一个         （CG-2）
 *   派生联动   suspend 一端 → Binding DORMANT → Channel DRAINING
 *
 * 和另外两个例子一样，它自己核对结论，任何一条不成立就以非 0 退出。
 */

import { EappError } from '../../packages/core/src/index.js';
import {
  EappRuntime,
  type PluginModule,
  type RuntimeMessage,
  type Subscription,
} from '../../packages/runtime/src/index.js';

const JOBS = { name: 'jobs.queue', version: '1.0.0' };
const STATS = { name: 'jobs.stats', version: '1.0.0' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
  }
  return predicate();
}

/** A latch the script can open. Used to hold a worker "inside" a job on purpose. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

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
// 插件
//
// 没有一个 import 指向另一个，没有一个知道对方存在。它们之间的每一条边
// 都是运行时在 connect() / invoke() 时按 capability 建立的。
// ---------------------------------------------------------------------------

interface Job {
  id: number;
  /** 模拟耗时。 */
  work?: number;
  /** 第一次投递故意失败，用来观察 nack 之后的重新投递。 */
  failFirst?: boolean;
  /** 卡住不返回，用来观察成员"死在岗位上"时组怎么处理。 */
  block?: boolean;
}

/** 提供 jobs.queue 的一方。提交任务就是往队列上 publish。 */
function producerPlugin(): PluginModule {
  return {
    manifest: {
      identity: { domain: 'acme.jobs', id: 'producer', instance: 'producer-1' },
      capabilities: [JOBS],
    },
    activate() {
      console.log('  [producer] activated — 它是 jobs.queue 的提供方');
    },
  };
}

/**
 * 队列的**消费侧**。
 *
 * 一条 Binding 只指名一个 `to`，所以"一个 Channel 上有多个消费者"不是从 Binding 来的，
 * 而是从 **Channel** 来的：工作池的成员拿 channelId 加入 ConsumerGroup 即可。
 * 这正是组存在的理由 —— Binding 说"这两方有关于这个能力的关系"，
 * Channel 是这段关系的介质，而组规定谁在这条通道上和谁竞争。
 */
function intakePlugin(submitted: () => number): PluginModule {
  return {
    manifest: {
      identity: { domain: 'acme.jobs', id: 'intake', instance: 'intake-1' },
      capabilities: [STATS],
    },
    activate() {
      console.log('  [intake]   activated — 队列的消费侧');
    },
    handlers: {
      // 提供方（intake）服务，调用方（producer）发起。
      'jobs.stats': async () => ({ submitted: submitted() }),
    },
  };
}

interface Worker {
  readonly module: PluginModule;
  /** 拿到手的 job id，含重复投递。 */
  readonly attempted: number[];
  /** 成功 ack 的 job id，按完成顺序。 */
  readonly handled: number[];
  readonly member: () => Subscription<RuntimeMessage> | undefined;
  /** 立刻退出组：不再消费，并释放持有的工作（CG-5）。 */
  readonly stop: () => Promise<void>;
}

/**
 * 工作池里的一个成员。
 *
 * 它是**自主消费**的：activate() 之后就自己循环拉取。谁先 pull 到谁领走。
 * 组只保证同一条消息不会同时落到两个人手里（CG-3），不保证平均 —— 见第 2 段末尾。
 */
function workerPlugin(options: {
  runtime: EappRuntime;
  channelId: string;
  group: string;
  instance: string;
  attempts: Map<number, number>;
  process: (job: Job, worker: string, attempt: number) => Promise<void>;
}): Worker {
  const handled: number[] = [];
  const attempted: number[] = [];
  let member: Subscription<RuntimeMessage> | undefined;
  let pump: Promise<void> | undefined;

  async function run(subscription: Subscription<RuntimeMessage>): Promise<void> {
    const iterator = subscription[Symbol.asyncIterator]();
    while (subscription.state !== 'CLOSED') {
      const next = await iterator.next();
      if (next.done === true) return;

      const message = next.value;
      const job = message.payload as Job;
      attempted.push(job.id);
      const attempt = (options.attempts.get(job.id) ?? 0) + 1;
      options.attempts.set(job.id, attempt);

      try {
        await options.process(job, options.instance, attempt);
        handled.push(job.id);
        // CR-1：只有 ack 会推进组的游标。ack 一个更靠后的位置，
        // 等于声明"它之前的都已了结"（§6.4）—— 这是显式跳过，不是隐式前进。
        await message.ack();
      } catch {
        // nack 把位置归还给组（CG-6），游标原地不动。这就是 at-least-once 的全部机制。
        await message.nack();
      }
    }
  }

  return {
    attempted,
    handled,
    member: () => member,
    module: {
      manifest: {
        identity: { domain: 'acme.worker', id: 'worker', instance: options.instance },
        capabilities: [],
      },
      async activate() {
        // 加入而不是新建：CG-1 要求组名在同一 Channel 内唯一，CG-8 要求组必须已存在。
        member = await options.runtime.joinConsumerGroup(options.channelId, options.group);
        pump = run(member).catch(() => undefined);
      },
      async deactivate() {
        await member?.close();
        await pump;
      },
    },
    // 故意不等 pump：一个"崩溃"的成员正卡在处理中，而崩溃的定义就是它不会返回。
    // 它的 ack 之后会落在一个已经作废的上下文上，成为空操作。
    stop: async () => {
      await member?.close();
      member = undefined;
    },
  };
}

/** 第二个组：审计。它和工作者组看同一条 Channel，各自的游标互不影响（CG-4）。 */
function auditorPlugin(
  runtime: EappRuntime,
  channelId: string,
): { module: PluginModule; seen: number[] } {
  const seen: number[] = [];
  let member: Subscription<RuntimeMessage> | undefined;
  let pump: Promise<void> | undefined;

  return {
    seen,
    module: {
      manifest: {
        identity: { domain: 'acme.audit', id: 'auditor', instance: 'auditor-1' },
        capabilities: [],
      },
      async activate() {
        member = await runtime.joinConsumerGroup(channelId, 'audit');
        const subscription = member;
        console.log("  [auditor]  activated — 已加入组 'audit'");
        pump = (async () => {
          const iterator = subscription[Symbol.asyncIterator]();
          while (subscription.state !== 'CLOSED') {
            const next = await iterator.next();
            if (next.done === true) return;
            seen.push((next.value.payload as Job).id);
            await next.value.ack();
          }
        })().catch(() => undefined);
      },
      async deactivate() {
        await member?.close();
        await pump;
      },
    },
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runtime = EappRuntime.create({ domain: 'eapp.queue' });

  const producer = runtime.register(producerPlugin());
  let submitted = 0;
  const intake = runtime.register(intakePlugin(() => submitted));

  // -------------------------------------------------------------------------
  banner('1. 拓扑 — 一条 Binding，一条 Channel');
  // -------------------------------------------------------------------------

  await runtime.activate(producer);
  await runtime.activate(intake);

  // connect 的 from 是**提供方**，to 是消费方（v3.0 bind 的方向）。
  // 注意这与 invoke 相反 —— invoke 的 from 是发起调用的一方。
  const queue = await runtime.connect({
    from: producer,
    to: intake,
    capability: JOBS,
    mode: 'stream',
  });
  console.log(`  binding ${queue.binding.id}  状态 = ${runtime.core.bindingState(queue.binding.id)}`);
  console.log(`  channel ${queue.channel.id}  mode=${queue.channel.mode}  delivery=${queue.channel.delivery}`);

  check('stream 模式推导出 at-least-once', queue.channel.delivery === 'at-least-once', queue.channel.delivery);
  check('两端 ACTIVE 后 Binding 派生为 ACTIVE', runtime.core.bindingState(queue.binding.id) === 'ACTIVE');

  // -------------------------------------------------------------------------
  banner('2. 竞争消费 — 一条消息只交给一个成员');
  // -------------------------------------------------------------------------

  const attempts = new Map<number, number>();
  const completions: Array<{ job: number; worker: string; attempt: number }> = [];

  const process = async (job: Job, worker: string, attempt: number): Promise<void> => {
    if (job.work !== undefined) await sleep(job.work);
    if (job.failFirst === true && attempt === 1) {
      throw new EappError('EAPP_JOB_TRANSIENT', `job ${job.id} failed on attempt 1`);
    }
    completions.push({ job: job.id, worker, attempt });
  };

  // CG-1：组名在同一 Channel 内唯一。CG-8：成员只能在已存在的组上加入，
  // 所以组必须先开 —— 上面那条 EAPP_SUBSCRIPTION_INVALID 不是意外，是规范要求的。
  await runtime.openConsumerGroup(queue.channel.id, { name: 'workers' });
  await runtime.openConsumerGroup(queue.channel.id, { name: 'audit' });
  const auditor = auditorPlugin(runtime, queue.channel.id);

  const alpha = workerPlugin({
    runtime, channelId: queue.channel.id, group: 'workers',
    instance: 'alpha', attempts, process,
  });
  const beta = workerPlugin({
    runtime, channelId: queue.channel.id, group: 'workers',
    instance: 'beta', attempts, process,
  });

  const alphaRef = runtime.register(alpha.module);
  const betaRef = runtime.register(beta.module);
  const auditorRef = runtime.register(auditor.module);

  await runtime.activate(auditorRef);
  await runtime.activate(alphaRef);
  await runtime.activate(betaRef);
  check('组里有两个成员', runtime.consumerGroup(queue.channel.id, 'workers')?.memberCount === 2);

  const workload: Job[] = [
    { id: 1, work: 1 }, { id: 2, work: 1 }, { id: 3, work: 1 },
    { id: 4, work: 1 }, { id: 5, work: 1 }, { id: 6, work: 1 },
    { id: 7, work: 1, failFirst: true },
    { id: 8, work: 1 }, { id: 9, work: 1 },
  ];
  for (const job of workload) {
    await runtime.publish({ from: producer, to: intake, capability: JOBS, mode: 'stream' }, job);
    submitted += 1;
  }

  const settled = await waitFor(() => completions.length >= workload.length, 3000);
  check('全部工作都被处理完', settled, completions.length);

  const done = [...alpha.handled, ...beta.handled].sort((a, b) => a - b);
  check('没有一条被两个成员都成功完成（CG-3）', new Set(done).size === done.length, done);
  check('9 条一条不少', done.length === workload.length, done);
  console.log(`  完成 ${done.length} 条：${done.join(', ')}`);
  console.log(`  分配：alpha ${alpha.handled.length} 条 / beta ${beta.handled.length} 条`);
  if (alpha.handled.length === 0 || beta.handled.length === 0) {
    console.log('  （一边全揽是正常的：CG-3 保证排他，不保证公平 —— 见文末）');
  }

  // 7 号被投递两次：第一次 nack，第二次成功。审计组只看见一次。
  check('7 号被重投过（nack 把位置归还给组）', (attempts.get(7) ?? 0) >= 2, attempts.get(7));
  console.log(`  7 号投递 ${attempts.get(7)} 次；审计组只看见它 1 次（重投是消费侧的事，不写进日志）`);

  // CG-2：成员自己不持有位置，读到的是组的。
  const alphaMember = alpha.member();
  const betaMember = beta.member();
  check(
    '两个成员读到的 cursor 是同一个（CG-2）',
    alphaMember?.cursor === betaMember?.cursor,
    [alphaMember?.cursor, betaMember?.cursor],
  );
  console.log(`  组游标 = ${alphaMember?.cursor} —— 成员没有自己的位置`);

  // 这一段已经结束：让工作者退出，免得它们把下一段的任务也顺手做了。
  await runtime.deactivate(alphaRef);
  await runtime.deactivate(betaRef);

  // -------------------------------------------------------------------------
  banner('3. 成员死在岗位上 — 它持有的工作不会陪葬');
  // -------------------------------------------------------------------------

  await runtime.openConsumerGroup(queue.channel.id, { name: 'recovery' });
  const hold = gate();

  const holder = workerPlugin({
    runtime, channelId: queue.channel.id, group: 'recovery',
    instance: 'holder', attempts,
    // 卡在这里不返回：这个成员"死"了。
    process: async (job, worker) => {
      if (job.block === true) await hold.wait;
      completions.push({ job: job.id, worker, attempt: 1 });
    },
  });
  const taker = workerPlugin({
    runtime, channelId: queue.channel.id, group: 'recovery',
    instance: 'taker', attempts, process,
  });
  const holderRef = runtime.register(holder.module);
  const takerRef = runtime.register(taker.module);

  // 先只让 holder 上线，这样"谁先领到"是确定的。
  await runtime.activate(holderRef);
  await runtime.publish(
    { from: producer, to: intake, capability: JOBS, mode: 'stream' },
    { id: 10, block: true } satisfies Job,
  );
  submitted += 1;

  const holding = await waitFor(() => holder.attempted.includes(10), 2000);
  check('holder 领到了 10 号', holding, holder.attempted);
  console.log('  holder 领走 10 号，卡在处理中（尚未 ack）');

  // 现在 taker 上线。它看得到 10 号，但那份位置被 holder 持有 —— pull 不返回它（CG-3）。
  await runtime.activate(takerRef);
  await sleep(50);
  check('被持有的位置不会同时交给组里的另一个人（CG-3）', !taker.attempted.includes(10), taker.attempted);
  console.log('  taker 上线，但拿不到 10 号 —— 它正被 holder 持有（CG-3）');

  // holder "崩溃"：成员立刻离开组。CG-5 要求它持有的位置**立刻**归还，
  // 而不是等 30s 的 claim TTL —— 已经走掉的成员永远不会 ack，等它就是白等。
  await holder.stop();
  const recovered = await waitFor(() => taker.attempted.includes(10), 1500);
  check('holder 离开后 taker 立刻接过 10 号（CG-5）', recovered, taker.attempted);
  console.log('  holder 崩溃 → taker 在 claim TTL 走完之前就接到了 10 号（CG-5）');

  await waitFor(() => taker.handled.includes(10), 1500);
  const cursorAfterTaker = runtime.consumerGroup(queue.channel.id, 'recovery')?.cursor;

  // 放开卡住的 handler。holder 醒来后会尝试 ack —— 但它的上下文已经随成员一起作废，
  // 这次 ack 是空操作，组的游标不会因此倒退或二次前进。
  hold.open();
  await sleep(80);
  const cursorAfterHolder = runtime.consumerGroup(queue.channel.id, 'recovery')?.cursor;
  check(
    '已离开成员的 ack 落在作废的上下文上，组游标不动',
    cursorAfterTaker === cursorAfterHolder,
    { before: cursorAfterTaker, after: cursorAfterHolder },
  );
  console.log('  holder 醒来并 ack → 空操作，组游标没有变化');

  // 这就是 at-least-once 的真实含义。10 号被两个成员**都**处理过了；
  // 交付保证管的是"不丢"，"不重复"是应用自己的事（幂等键、去重表）。
  const tenHandlers = completions.filter((c) => c.job === 10).map((c) => c.worker);
  check('10 号确实被执行了两次 —— 这是 at-least-once 的代价', tenHandlers.length === 2, tenHandlers);
  console.log(`  10 号被执行了 ${tenHandlers.length} 次（${tenHandlers.join(', ')}）—— 不丢，但可能重复`);

  await runtime.deactivate(takerRef);

  // -------------------------------------------------------------------------
  banner('4. 两个组，一条 Channel，各自的位置');
  // -------------------------------------------------------------------------

  await waitFor(() => auditor.seen.length >= 10, 2000);
  console.log(`  workers 组游标 = ${runtime.consumerGroup(queue.channel.id, 'workers')?.cursor}`);
  console.log(`  audit   组游标 = ${runtime.consumerGroup(queue.channel.id, 'audit')?.cursor}`);
  console.log(`  recovery 组游标 = ${runtime.consumerGroup(queue.channel.id, 'recovery')?.cursor}`);
  console.log(`  同一 Channel 上的组：${runtime.listConsumerGroups(queue.channel.id).map((g) => g.name).join(', ')}`);

  check('audit 组看到了全部 10 条', auditor.seen.length === 10, auditor.seen);
  check('三个组共存于一条 Channel（CG-1 / CG-4）', runtime.listConsumerGroups(queue.channel.id).length === 3);

  // -------------------------------------------------------------------------
  banner('5. 派生联动 — suspend 一端，队列就停止收新工作');
  // -------------------------------------------------------------------------

  await runtime.suspend(producer);
  console.log(`  suspend(producer) → binding = ${runtime.core.bindingState(queue.binding.id)}`);
  console.log(`                    → channel = ${queue.channel.state}`);

  check('Binding 派生为 DORMANT', runtime.core.bindingState(queue.binding.id) === 'DORMANT');
  check('Channel 随之 DRAINING', queue.channel.state === 'DRAINING');

  // v3.1 §2.4：DRAINING 是"停止接受新工作，让在途的做完"。
  // 所以往一条 DRAINING 的 Channel 上 publish 必须失败，而不是把工作悄悄排进队列。
  let drainCode: string | undefined;
  try {
    await runtime.publish({ from: producer, to: intake, capability: JOBS, mode: 'stream' }, { id: 11 });
  } catch (error) {
    drainCode = error instanceof EappError ? error.code : String(error);
  }
  check('DRAINING 上 publish 被拒绝', drainCode === 'EAPP_CHANNEL_DRAINING', drainCode);
  console.log(`  publish → ${drainCode}`);

  await runtime.resume(producer);
  check('resume 之后 Channel 回到 ACTIVE', queue.channel.state === 'ACTIVE', queue.channel.state);
  console.log(`  resume(producer)  → binding = ${runtime.core.bindingState(queue.binding.id)}  channel = ${queue.channel.state}`);

  // -------------------------------------------------------------------------
  banner('6. 收尾');
  // -------------------------------------------------------------------------

  // 请求模式与队列共用同一个运行时：producer 问 intake 要统计。
  // invoke 的 from 是**调用方**，to 是**提供方** —— 与 connect 相反。
  const stats = await runtime.invoke({ from: producer, to: intake, capability: STATS });
  console.log(`  invoke jobs.stats → ${JSON.stringify(stats)}`);
  check('统计能跨 Channel 拿回来', (stats as { submitted: number }).submitted === 10, stats);

  await runtime.deactivate(auditorRef);
  await runtime.shutdown();

  console.log('');
  if (broken.length > 0) {
    console.error(`\x1b[31m自检失败 ${broken.length}/${checked}\x1b[0m`);
    for (const item of broken) console.error(`  ✗ ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log(`自检: ${checked} 条断言全部通过`);
  console.log('');
  console.log('三个组，一条 Channel：工作者竞争、审计全看、恢复接手。');
  console.log('没有一个插件知道自己被谁消费，也没有一个知道谁在和自己竞争。');
  console.log('');
  console.log('关于公平：CG-3 只保证"同一条消息不会同时被同组的两个成员持有"，');
  console.log('不保证分配均匀。一次 pull 最多领走一批，所以一个成员可能把当前可见的工作');
  console.log('整批揽下 —— 上面 alpha 拿了 7 条、beta 只拿到 2 条就是这个原因。');
  console.log('要均匀，用 openConsumerGroup 的 prefetch 把每个成员的批大小压下来：');
  console.log('组是作用域，不是调度器，prefetch 是唯一对抗垄断的旋钮。');
}

main().catch((error: unknown) => {
  console.error('\n\x1b[31mjob-queue 失败\x1b[0m');
  console.error(error);
  process.exitCode = 1;
});

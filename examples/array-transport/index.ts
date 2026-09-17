/**
 * EaPP — 实现一个 Transport。
 *
 * 这是 `docs/guides/write-a-transport.md` §6 那个「可运行的 Transport」。
 * 那个示例曾经只存在于文档里，而且有两处规范违反 —— 本文件是它的修正版，
 * 并且会自己核对结论。
 *
 *   npx tsx examples/array-transport/index.ts
 *   pnpm run example:transport
 *
 * Transport 是最下面一层，职责只有两件事：**分配位置**、**按位置读回**。
 * 它不定义投递保证、不定义 Cursor、不定义 Lease（TR-1）—— 那些在上一层，
 * 由 `@eapp/interaction` 提供。
 *
 * 这个实现用「每条 Channel 一个数组」当存储，所以它只能在进程内用
 * （`durabilityBoundary: 'process'`）。它的价值在于把 Transport 的契约压到最短：
 * 去掉持久化、网络、并发之后，"一个 Transport 至少要做什么"才看得清楚。
 */

import { EappError, type Identity } from '../../packages/core/src/index.js';
import {
  EappRuntime,
  type PluginModule,
} from '../../packages/runtime/src/index.js';
import {
  TransportSubscription,
  matchesPattern,
  type Cursor,
  type CursorAnchor,
  type Pattern,
  type TransportMessage,
} from '../../packages/interaction/src/index.js';
import {
  configureStateChannel,
  matchesStatePattern,
  type ExpectedRevision,
  type Revision,
  type StateCell,
  type StateChange,
  type StatePattern,
  type StateTransport,
  type StateTransportCapabilities,
  type StateUpdate,
} from '../../packages/state/src/index.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
void sleep;

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

async function failsWith(
  label: string,
  code: string,
  run: () => Promise<unknown>,
): Promise<EappError | undefined> {
  checked += 1;
  try {
    await run();
  } catch (error) {
    if (!(error instanceof EappError)) {
      broken.push(`${label}（抛出的是 ${String(error)}，不是 EappError）`);
      return undefined;
    }
    if (error.code !== code) {
      broken.push(`${label}（code 是 ${error.code}，期望 ${code}）`);
      return undefined;
    }
    return error;
  }
  broken.push(`${label}（没有失败，期望 ${code}）`);
  return undefined;
}

// ---------------------------------------------------------------------------
// Transport 实现
// ---------------------------------------------------------------------------

/**
 * 固定宽度、零填充十进制。这不是美观问题：等宽数字串的**字典序等于数值序**，
 * 所以 `compareCursor` 可以只是一次 `<` 比较（§4.3）。
 */
const WIDTH = 20;

/** 排在所有已分配位置之前。表示"保留日志的起点"。 */
const BEGINNING = '' as Cursor;

export class ArrayTransport implements StateTransport {
  readonly id: string;
  readonly capabilities: StateTransportCapabilities;

  readonly #log = new Map<string, Array<{ cursor: Cursor; message: unknown }>>();
  readonly #cells = new Map<string, Map<string, StateCell>>();
  readonly #changes = new Map<string, StateChange[]>();
  readonly #heads = new Map<string, Revision>();
  /** channel -> 当前最新的位置，消息与状态写入共用。 */
  readonly #anchors = new Map<string, Cursor>();
  readonly #waiters = new Map<string, Set<() => void>>();
  #seq = 0;
  #closed = false;

  constructor(id = 'array-1', options: { withCas?: boolean } = {}) {
    this.id = id;
    this.capabilities = {
      persistent: false,
      ordering: 'global',
      delivery: { atMostOnce: true, atLeastOnce: true, replay: false },
      supportsCursor: true,
      supportsLease: false,
      durabilityBoundary: 'process',
      supportsState: true,
      // withCas: false 用来演示 TS-4 —— 没有全序就不能做 CAS，而且必须是显式失败。
      supportsStateRevision: options.withCas ?? true,
      supportsStateWatch: true,
      supportsStateSnapshot: true,
      stateConsistency: 'strong',
      stateRetention: { kind: 'unbounded' },
    };
  }

  // ------------------------------------------------------------------ 内部

  #assertOpen(): void {
    if (this.#closed) {
      throw new EappError('EAPP_UNSUPPORTED', `transport ${this.id} is closed`);
    }
  }

  /**
   * 唯一的分配点。消息与状态写入共用这一本日志，所以"位置"天然是全序的 ——
   * v3.2 D-01 说 Revision 就是写入在日志中的位置，因此 `Revision` 与 `Cursor`
   * 在这里是同一个东西，REV-7 不需要任何特判。
   */
  #allocate(): Revision {
    this.#seq += 1;
    return `${this.id}!${String(this.#seq).padStart(WIDTH, '0')}`;
  }

  #notify(channel: string): void {
    const waiters = this.#waiters.get(channel);
    if (!waiters) return;
    const pending = [...waiters];
    waiters.clear();
    for (const resolve of pending) resolve();
  }

  /**
   * 一个位置只在自己签发的 Transport 里有意义（REV-8 / CR-5）。
   * 接受外来的值会静默读到错的位置 —— 或者什么都读不到 —— 所以必须拒绝。
   */
  #requireOwn(value: Cursor | Revision | undefined, label: string): void {
    if (value === undefined || value === BEGINNING) return;
    if (typeof value !== 'string' || !value.startsWith(`${this.id}!`)) {
      throw new EappError(
        'EAPP_CURSOR_INVALID',
        `${label} '${String(value)}' was not issued by transport ${this.id}`,
      );
    }
  }

  #cellMap(channel: string): Map<string, StateCell> {
    let map = this.#cells.get(channel);
    if (!map) {
      map = new Map();
      this.#cells.set(channel, map);
    }
    return map;
  }

  #changeLog(channel: string): StateChange[] {
    let log = this.#changes.get(channel);
    if (!log) {
      log = [];
      this.#changes.set(channel, log);
    }
    return log;
  }

  /** 提交一次变更：推进 head 与 anchor，唤醒等待者。 */
  #commit(channel: string, change: StateChange): void {
    this.#changeLog(channel).push(change);
    this.#heads.set(channel, change.revision);
    this.#anchors.set(channel, change.revision);
    this.#notify(channel);
  }

  // ------------------------------------------------------------- Transport

  async send(channel: string, msg: unknown): Promise<Cursor> {
    this.#assertOpen();
    const cursor = this.#allocate();
    const log = this.#log.get(channel) ?? [];
    log.push({ cursor, message: msg });
    this.#log.set(channel, log);
    this.#anchors.set(channel, cursor);
    this.#notify(channel);
    return cursor;
  }

  async readAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: Pattern,
  ): Promise<TransportMessage[]> {
    this.#requireOwn(cursor, 'cursor');
    const from = cursor ?? BEGINNING;
    return (this.#log.get(channel) ?? [])
      .filter((entry) => entry.cursor > from) // TR-5：严格大于
      .filter((entry) => matchesPattern(entry.message, pattern))
      .map((entry) => ({ cursor: entry.cursor, payload: entry.message }));
    // TR-7：没有匹配就是一个空数组，立即返回，绝不阻塞。
  }

  async resolveAnchor(channel: string, anchor: CursorAnchor): Promise<Cursor> {
    if (anchor === 'earliest') return BEGINNING;
    if (anchor === 'latest') return this.#anchors.get(channel) ?? BEGINNING;
    // 规则 2：其余字符串当 cursor —— 但必须是本 Transport 签发的。
    this.#requireOwn(anchor, 'cursor');
    return anchor;
  }

  /**
   * 真的阻塞，直到该 Channel 上有新东西。这是**优化**，不是正确性依赖（§4.5）：
   * 没有它，`Subscription` 会退化成按 `pollIntervalMs` 轮询。
   */
  waitForChange(channel: string, _cursor: Cursor | undefined, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const waiters = this.#waiters.get(channel) ?? new Set<() => void>();
      this.#waiters.set(channel, waiters);

      const finish = (): void => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };

      waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  /**
   * `close()` 之后的写入 MUST 明确失败，而不是静默成功。
   * 一个空实现的 `close()` 会让"已关闭"和"还开着"从调用方看完全一样 ——
   * 这正是 TR-4 要禁掉的静默降级。
   */
  async close(): Promise<void> {
    this.#closed = true;
    // 唤醒所有等待者，让它们的循环有机会看到关闭并退出。
    for (const channel of this.#waiters.keys()) this.#notify(channel);
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  // --------------------------------------------------------- StateTransport

  async head(channel: string): Promise<Revision> {
    // TS-14：空 Channel 也要有一个**可比较**的初始位置，不能抛、也不能返回 undefined。
    return this.#heads.get(channel) ?? BEGINNING;
  }

  async getState(channel: string, key: string): Promise<StateCell | null> {
    return this.#cells.get(channel)?.get(key) ?? null;
  }

  async listState(channel: string, pattern: StatePattern): Promise<StateCell[]> {
    return [...(this.#cells.get(channel)?.values() ?? [])]
      .filter((cell) => matchesStatePattern(cell.key, pattern))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * TS-6：检查和写入之间**没有 await**，所以不可能交错。
   * 把 CAS 做成"读一次、比一下、再写"是 TOCTOU，两个并发写者会同时通过检查。
   */
  async setStateWithCAS(channel: string, update: StateUpdate, actor: Identity): Promise<Revision> {
    this.#assertOpen();
    const cells = this.#cellMap(channel);
    const current = cells.get(update.key);
    const expected = update.expectedRevision;

    if (expected === null) {
      // "MUST NOT have ever existed"。已逻辑删除的 cell 仍然算存在，
      // 所以 `null` 不能用来复活一个 key（§5.2）。
      if (current) {
        throw new EappError('EAPP_REVISION_CONFLICT', `key '${update.key}' already exists`);
      }
    } else {
      if (!current) {
        throw new EappError('EAPP_REVISION_CONFLICT', `key '${update.key}' does not exist`);
      }
      if (this.compareRevision(current.revision, expected) !== 0) {
        throw new EappError('EAPP_REVISION_CONFLICT', `key '${update.key}' has moved on`);
      }
    }

    const deleted = update.deleted === true;
    const revision = this.#allocate();
    cells.set(update.key, {
      key: update.key,
      revision,
      value: deleted ? undefined : update.value,
      deleted,
      updatedAt: Date.now(),
      updatedBy: actor,
    });
    this.#commit(channel, {
      channel,
      revision,
      key: update.key,
      type: deleted ? 'deleted' : 'set',
      ...(deleted ? {} : { value: update.value }),
    });
    return revision;
  }

  /**
   * 删除是**一等原语**，不是 `set({deleted:true})` 的语法糖（v3.2 §6.1）。
   * 两者对"key 从未存在"的反应不同，把 delete 做成 set 的糖，
   * `EAPP_STATE_KEY_NOT_FOUND` 这个码就永远产生不出来。
   */
  async deleteStateWithCAS(
    channel: string,
    key: string,
    expectedRevision: ExpectedRevision,
    actor: Identity,
  ): Promise<Revision> {
    this.#assertOpen();
    const cells = this.#cellMap(channel);
    const current = cells.get(key);

    if (!current) {
      // §6.2 边界表第 2 行：从未存在 **且** 期待一个具体 revision，是 CAS 冲突。
      // 只有"期待它不存在"（expectedRevision === null）才是 KEY_NOT_FOUND。
      // 把这两种情况合成一个码，会让调用方无法区分"写错了"和"来晚了"。
      if (expectedRevision === null) {
        throw new EappError('EAPP_STATE_KEY_NOT_FOUND', `key '${key}' has never existed`); // DEL-4
      }
      throw new EappError('EAPP_REVISION_CONFLICT', `key '${key}' does not exist`);
    }
    if (expectedRevision === null) {
      throw new EappError('EAPP_REVISION_CONFLICT', `key '${key}' already exists`);
    }
    if (this.compareRevision(current.revision, expectedRevision) !== 0) {
      throw new EappError('EAPP_REVISION_CONFLICT', `key '${key}' has moved on`);
    }

    if (current.deleted) {
      // DEL-5：no-op 不分配位置、不发出变更，但返回该 key 当前的 revision，
      // 让返回值的含义保持统一。
      return current.revision;
    }

    const revision = this.#allocate();
    cells.set(key, {
      key,
      revision,
      value: undefined,
      deleted: true,
      updatedAt: Date.now(),
      updatedBy: actor,
    });
    this.#commit(channel, { channel, revision, key, type: 'deleted' });
    return revision;
  }

  /**
   * TS-9 / TS-10：返回的是**变更流**（每次写入一条），不是 post-image 数组。
   * post-image 表达不了"同一个 key 写了两次"，中间那次就永久丢了，
   * 观察位置也就没有意义。
   */
  async readChangesAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: StatePattern,
  ): Promise<StateChange[]> {
    this.#requireOwn(cursor, 'cursor');
    const from = cursor ?? BEGINNING;
    return (this.#changes.get(channel) ?? [])
      .filter((change) => change.revision > from)
      .filter((change) => matchesStatePattern(change.key, pattern));
  }

  /** TS-15：预留一个严格大于当前 head 的位置。 */
  async nextRevision(_channel: string): Promise<Revision> {
    this.#assertOpen();
    return this.#allocate();
  }

  /** REV-8：比较由 Transport 提供，外来值必须明确失败，而不是被静默错排。 */
  compareRevision(a: Revision, b: Revision): number {
    this.#requireOwn(a, 'revision');
    this.#requireOwn(b, 'revision');
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  /** §5.5 / SNAP-7：只给 `restore` 用的钉住写入。它只允许前进。 */
  async writeStateWithRevision(
    channel: string,
    key: string,
    value: unknown,
    deleted: boolean,
    revision: Revision,
    actor: Identity,
  ): Promise<void> {
    this.#assertOpen();
    this.#requireOwn(revision, 'revision');
    if (this.compareRevision(revision, await this.head(channel)) <= 0) {
      throw new EappError(
        'EAPP_REVISION_INVALID',
        `revision '${revision}' does not advance head`,
      );
    }
    this.#cellMap(channel).set(key, {
      key,
      revision,
      value: deleted ? undefined : value,
      deleted,
      updatedAt: Date.now(),
      updatedBy: actor,
    });
    this.#commit(channel, {
      channel,
      revision,
      key,
      type: deleted ? 'deleted' : 'set',
      ...(deleted ? {} : { value }),
    });
  }
}

// ---------------------------------------------------------------------------
// 用另一种方式接上去：让运行时跑在这个 Transport 上
// ---------------------------------------------------------------------------

const GREETING = { name: 'greeting.render', version: '1.0.0' };

function greeterPlugin(): PluginModule {
  return {
    manifest: {
      identity: { domain: 'eapp.transport', id: 'greeter', instance: 'greeter-1' },
      capabilities: [GREETING],
    },
    handlers: {
      'greeting.render': async (payload) => `Hello, ${String(payload)}!`,
    },
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n实现一个 Transport — array-transport\n');

  // =========================================================================
  // 第一部分：直接接下面的组件
  //
  // 这是运行时内部使用的同一组调用。它同时是 Transport 契约最容易看清的用法：
  // 没有运行时替你藏任何东西。
  // =========================================================================
  console.log('① 直接接线：Channel 订阅 + StateChannel\n');

  const transport = new ArrayTransport('array-1');
  const owner: Identity = { domain: 'eapp.transport', id: 'owner', instance: 'owner-1' };

  const state = configureStateChannel(
    { id: 'ch-1', binding: 'binding-1', mode: 'state', delivery: 'at-least-once', state: 'ACTIVE' },
    transport,
    { conflictPolicy: 'cas', owner },
  );

  const v1 = await state.set({ key: 'stock', value: 1, expectedRevision: null });
  const v2 = await state.set({ key: 'stock', value: 2, expectedRevision: v1 });
  console.log(`  set stock=1 → ${v1}`);
  console.log(`  set stock=2 → ${v2}`);

  // 拿着同一个 token 的第二次写入必须被拒绝。CAS 的意义就在这里。
  const stale = await failsWith('同 token 的第二次写入', 'EAPP_REVISION_CONFLICT', () =>
    state.set({ key: 'stock', value: 99, expectedRevision: v1 }),
  );
  console.log(`  拿着旧 token 再写 → ${stale?.code}  retryable=${String(stale?.retryable)}`);
  check('EAPP_REVISION_CONFLICT 默认可重试', stale?.retryable === true);

  const cell = await state.get('stock');
  check('没有丢更新', cell?.value === 2, cell?.value);
  console.log(`  最终值 = ${JSON.stringify(cell?.value)} —— 没有丢更新`);

  // 观察者：位置与 revision 是同一个东西（REV-7）。
  const watcher = await state.watch({ key: 'stock' });
  const seen: unknown[] = [];
  const watching = (async () => {
    for await (const update of watcher) {
      seen.push(update.value);
      await update.ack();
      if (seen.length === 1) break;
    }
  })();
  const v3 = await state.set({
    key: 'stock',
    value: 3,
    expectedRevision: (await state.get('stock'))!.revision,
  });
  await watching;
  await watcher.close();
  check('watcher 看到了新值', seen[0] === 3, seen);
  check('watcher 的 cursor 就是写入的 revision（REV-7）', watcher.cursor === v3, {
    cursor: watcher.cursor, revision: v3,
  });
  console.log(`  watcher 看到 ${JSON.stringify(seen)}，它的 cursor = ${watcher.cursor}`);
  console.log('  —— 与 revision 同一个值：在这一层 Revision 和 Cursor 同域（REV-7）');

  // 消息与状态写入共用同一本日志，所以位置是连续的。
  /**
   * 注意 `TransportSubscription.create<T>` 里的 `T` 是**交付给消费者的那个东西**，
   * 不是 payload —— 它要同时带上 `cursor`、`ack()`、`nack()`。
   * 写成 `create<{ n: number }>` 会编译不过，那是有意的：订阅交付的从来不只是负载。
   */
  interface Delivered {
    cursor: Cursor;
    payload: { n: number };
    ack(): Promise<void>;
    nack(): Promise<void>;
  }

  const subscription = await TransportSubscription.create<Delivered>(
    'orders',
    {},
    {
      head: () => transport.resolveAnchor('orders', 'latest'),
      earliest: () => transport.resolveAnchor('orders', 'earliest'),
      readAfter: async (cursor, ack) => {
        const messages = await transport.readAfter('orders', cursor, { all: true });
        return messages.map((message) => {
          const context = ack(message.cursor); // AckContext 把 ack 绑到位置上
          return {
            cursor: message.cursor,
            item: {
              cursor: message.cursor,
              payload: message.payload as { n: number },
              ack: () => context.ack(),
              nack: () => context.nack(),
            },
          };
        });
      },
      waitForChange: (cursor, signal) => transport.waitForChange('orders', cursor, signal),
    },
  );

  await transport.send('orders', { n: 10 });
  await transport.send('orders', { n: 11 });
  const received: number[] = [];
  for await (const message of subscription) {
    received.push(message.payload.n);
    await message.ack();
    if (received.length === 2) break;
  }
  await subscription.close();
  check('订阅收到两条', received.join(',') === '10,11', received);
  check('状态写入与消息共用同一本日志', subscription.cursor.startsWith('array-1!'), subscription.cursor);
  console.log(`  订阅收到 ${JSON.stringify(received)}，cursor = ${subscription.cursor}`);
  console.log('  —— 前缀是 array-1，与上面三次状态写入同一本日志（位置连续）');

  // =========================================================================
  // 第二部分：把同一个 Transport 交给运行时
  //
  // 「换掉消息怎么走」的完整含义：三层全部照跑，只有最下面一层被替换。
  // =========================================================================
  console.log('\n② 交给运行时：三层全部照跑在同一个 Transport 上\n');

  const runtime = EappRuntime.create({
    domain: 'eapp.transport',
    transport: new ArrayTransport('runtime-1'),
  });
  const greeter = runtime.register(greeterPlugin());
  const client = runtime.register({
    manifest: {
      identity: { domain: 'eapp.transport', id: 'client', instance: 'client-1' },
      capabilities: [],
    },
  });
  await runtime.activate(greeter);
  await runtime.activate(client);

  const reply = await runtime.invoke({
    from: client, // 调用方
    to: greeter, // 能力提供方
    capability: GREETING,
    payload: 'Transport',
  });
  console.log(`  invoke  → ${JSON.stringify(reply)}`);
  check('request 模式跑在自定义 Transport 上', reply === 'Hello, Transport!', reply);

  const { channel } = await runtime.connect({
    from: greeter,
    to: client,
    capability: GREETING,
    mode: 'stream',
  });
  const sub = await runtime.subscribe(channel.id, { all: true });
  await runtime.publish({ from: greeter, to: client, capability: GREETING, mode: 'stream' }, { n: 1 });
  let published: unknown;
  for await (const message of sub) {
    published = message.payload;
    await message.ack();
    break;
  }
  await sub.close();
  console.log(`  publish → 订阅收到 ${JSON.stringify(published)}`);
  check('stream 模式跑在自定义 Transport 上', JSON.stringify(published) === '{"n":1}', published);

  const shared = await runtime.stateChannel({ from: greeter, to: client, capability: GREETING });
  const revision = await shared.set({ key: 'k', value: 'v', expectedRevision: null });
  console.log(`  state   → revision ${revision}`);
  check('state 模式跑在自定义 Transport 上', revision.startsWith('runtime-1!'), revision);

  await runtime.shutdown();

  // =========================================================================
  // 第三部分：关掉之后必须明确失败
  // =========================================================================
  console.log('\n③ 关闭之后写入必须明确失败\n');

  await transport.close();
  check('close() 之后 Transport 报告已关闭', transport.isClosed);

  const closed = await failsWith('关闭后 send', 'EAPP_UNSUPPORTED', () =>
    transport.send('orders', { n: 12 }),
  );
  console.log(`  send  → ${closed?.code}`);
  // 注意：这里期望的是 EAPP_UNSUPPORTED，不是 EAPP_CURSOR_INVALID。
  // 两个码回答不同的问题 —— "这个位置不是我的" vs "我已经关了"。

  console.log('');
  if (broken.length > 0) {
    console.error(`\x1b[31m自检失败 ${broken.length}/${checked}\x1b[0m`);
    for (const item of broken) console.error(`  ✗ ${item}`);
    process.exitCode = 1;
    return;
  }
  console.log(`自检: ${checked} 条断言全部通过`);
  console.log('');
  console.log('Transport 只做两件事：分配位置、按位置读回。');
  console.log('把这两件事做对，上面三层不需要知道它是数组、是内存，还是网络。');
}

main().catch((error: unknown) => {
  console.error('\n\x1b[31marray-transport 失败\x1b[0m');
  console.error(error);
  process.exitCode = 1;
});

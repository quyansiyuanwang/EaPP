# `StateWatcher`

> 观察某个 [`StatePattern`](./state-update.md) 范围内、从某个位置开始的**变更流**。

| | |
|---|---|
| **层** | v3.2 State Mode |
| **规范** | [v3.2.0-state §7](../spec/v3.2.0-state.md) |
| **实现** | [`packages/state/src/state-watcher.ts`](../../packages/state/src/state-watcher.ts) |
| **测试** | [`tests/conformance/state.test.ts`](../../tests/conformance/state.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface StateWatcher extends Subscription<StateUpdateEvent> {
  readonly kind: 'state';              // 标识 State Mode（SW-2）
  readonly mode: SubscriptionMode;     // v3.1 §7.1，继承，MUST NOT 被覆盖为 'state'（SW-3）
  readonly pattern: StatePattern;
}

interface StateUpdateEvent extends AckContext {
  readonly type: 'set' | 'deleted';
  readonly key: string;
  readonly revision: Revision;
  readonly value?: unknown;            // 当且仅当 type === 'set'
}

interface WatchOptions {
  cursor?: CursorAnchor;               // 默认 'latest'
  mode?: SubscriptionMode;             // 默认 'exclusive'
  group?: string;                      // mode === 'group' 时 MUST 指定
  pollIntervalMs?: number;             // 无 waitForChange 时的轮询间隔，默认 50，MUST > 0
}

// 由 StateChannel.watch 调用；state-watcher.ts 的导出入口
function createStateWatcher(
  channel: string,
  pattern: StatePattern,
  transport: StateTransport,
  options?: WatchOptions,
): Promise<StateWatcher>;
```

`StateWatcher` 从 v3.1 `Subscription` 继承的成员：`id`、`channel`、`cursor`、`state`、
`suspend()`、`resume()`、`close()`、`[Symbol.asyncIterator]()`。

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `kind` | `'state'` | 是 | State Mode 的标识；MUST NOT 借用 `mode` 表达它（SW-2 / SW-3） |
| `mode` | `SubscriptionMode` | 是 | 订阅模式，取值仍是 v3.1 的 `'exclusive' \| 'group'` |
| `pattern` | `StatePattern` | 是 | 本 watcher 的选择范围；由 Transport 在读取变更流时施加 |
| `cursor` | `Cursor` | 是 | 观察位置。创建时 eager 解析完成，MUST 非 `undefined`（SUB-9） |
| `revision`（事件） | [`Revision`](./revision.md) | 是 | 该变更在 Channel 状态日志中的位置；同时就是可用的 `Cursor`（REV-7） |
| `value`（事件） | `unknown` | 条件 | 当且仅当 `type === 'set'` |
| `ack` / `nack`（事件） | `() => Promise<void>` | 是 | v3.1 `AckContext`；**MUST NOT 携带参数**（SW-6） |

---

## 语义

### 1. StateWatcher **就是**一个 v3.1 Subscription（SW-1）

不是"类似订阅"，而是 `Subscription<StateUpdateEvent>` 的子类型：可以 `for await` 消费，有独立的
`cursor`，可以 `suspend` / `resume` / `close`。State Mode MUST 复用 v3.1 的语义而不是另建一套
（IX-2），因此 `ack` / `nack` 的形状、`cursor` 的含义、`close` 的效果全部与 v3.1 一致。

### 2. `kind` 与 `mode` 是两回事（SW-2 / SW-3）

`kind = 'state'` 说明"这是 State Mode 的观察者"；`mode` 仍是 v3.1 的订阅模式
（`'exclusive'` 默认，`'group'` 表示竞争消费）。把 `mode` 覆盖成 `'state'` 会同时破坏两层的类型契约
——v3.1 的 `SubscriptionMode` 里没有 `'state'` 这个取值。

### 3. 消费接口（§7.2）

```typescript
for await (const update of watcher) {
  try {
    apply(update);
    await update.ack();      // 无参数 —— v3.1 AckContext
  } catch {
    await update.nack();     // 无参数 —— v3.1 AckContext
  }
}
```

**MUST NOT** 写成 `watcher.ack(update)`。**MUST NOT** 只提供 `ack()`：只提供 `ack()` 的类型不是合法的
v3.1 `AckContext`，`AK-3` / `AK-4` 随之不可满足。

### 4. ack / nack 语义（§7.3）

```
ack()   MUST 将 cursor 置为 max(cursor, 本变更的 revision)
nack()  MUST NOT 推进 cursor；该变更 MUST 在下一次迭代重新投递
```

位置只在 **ack** 时前进，收到事件本身不前进（v3.1 CR-1）。**MUST NOT 引入 `pending` 结构**：
把 cursor 只推进到第一个未 ack 变更之前，与 v3.1 §6.4「ack 一个更新的 cursor 意味着放弃中间
未 ack 的消息」直接冲突。CR-3 禁止的是**隐式**跳过；显式 ack 一个更靠后的位置并放弃
中间项是允许的。

因为位置只在 ack 时前进，同一 watcher 在未 ack 时会看到重复投递——这是 at-least-once 的应有之义。
测试夹具因此用 `autoAck` 换取"恰好一次"的断言口径。

### 5. 初始位置 MUST 在 `watch()` 返回前解析完成（§7.4）

```
1. cursor 省略          → 等价于 'latest'
2. 'latest'             → 创建时刻的 head(channel)
3. 'earliest'           → 仍可服务的最早位置
4. Cursor               → 该位置之后
5. 锚点 MUST 在 watch() 返回之前解析完成（eager）
6. 因此 watch() 返回后 watcher.cursor MUST 非 undefined（v3.1 SUB-9）
```

这就是 `StateChannel.watch()` 返回 `Promise<StateWatcher>` 的原因（已登记的偏离 D-1）：解析
`'latest'` 需要异步读取 Channel head，同步返回只能交出一个未解析的 cursor。同步返回与
"初始 cursor 是具体位置"（`SUB-9`）不能同时满足；异步返回才能让 `SUB-9` 成立。

### 6. 变更发现（§7.5）

```typescript
waitForChange?(channel: string, cursor: Cursor | undefined, signal?: AbortSignal): Promise<void>;
```

Transport 未实现 `waitForChange` 时，watcher MUST 以 `WatchOptions.pollIntervalMs` 轮询
（默认 50，MUST > 0）。**MUST NOT 无等待忙轮询。**

变更的读取本身 MUST NOT 阻塞：`readChangesAfter` 无匹配时返回空数组（TS-12），"等待"只发生在
发现层。这一点是必要的——观察者需要"独立 cursor + per-update ack + 删除事件可观察"三者同时成立，
而这三者只有在**变更流**（同一 key 的多次写入各自成条）上才有定义。

### 7. 生命周期

`close()` MUST 幂等，关闭后 MUST NOT 再投递；`close()` 之后调用 `ack()` / `nack()` MUST 是无副作用的
no-op 且 MUST NOT 抛错（SW-11 / SW-12）。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `SW-1` | `StateWatcher` MUST implement v3.1 `Subscription` | `state.test.ts` › `'SW-1 / SW-2 / SW-3 / SUB-9 / API-5: watch returns a v3.1-compatible Subscription'` |
| `SW-2` | `StateWatcher` MUST have `kind = 'state'` | `state.test.ts` › `'SW-1 / SW-2 / SW-3 / SUB-9 / API-5: watch returns a v3.1-compatible Subscription'` |
| `SW-3` | `StateWatcher` MUST NOT override `Subscription.mode` | `state.test.ts` › `'SW-3: the subscription mode is not overwritten with "state"'` |
| `SW-4` | MUST have an independent cursor when `mode === 'exclusive'` | `state.test.ts` › `'SW-4 / SW-5: watchers hold independent cursors and do not interfere'` |
| `SW-5` | MUST NOT affect other `StateWatcher`s | `state.test.ts` › `'SW-4 / SW-5: watchers hold independent cursors and do not interfere'` |
| `SW-6` | `ack()` and `nack()` MUST NOT take parameters | `state.test.ts` › `'SW-6 / SW-10 / IX-2: the event implements the full v3.1 AckContext'` |
| `SW-7` | `ack()` MUST NOT modify any `StateCell` | `state.test.ts` › `'SW-7: ack does not modify the cell'` |
| `SW-8` | `StateWatcher` MUST receive `deleted` changes | `state.test.ts` › `'DEL-1 / DEL-2 / DEL-3 / SW-8: delete is a CAS that produces an observable deleted change'` |
| `SW-9` | Default initial position MUST be `'latest'` | `state.test.ts` › `'SW-9: the default initial position is "latest"'` |
| `SW-10` | MUST implement the full v3.1 `AckContext` | `state.test.ts` › `'SW-6 / SW-10 / IX-2: the event implements the full v3.1 AckContext'` |
| `SW-11` | `close()` MUST be idempotent; no delivery after `close()` | `state.test.ts` › `'SW-11 / SW-12 / SUB-7 / SUB-8: close is idempotent and ack after close is a no-op'` |
| `SW-12` | `ack()` / `nack()` after `close()` MUST be a no-op | `state.test.ts` › `'SW-11 / SW-12 / SUB-7 / SUB-8: close is idempotent and ack after close is a no-op'` |

`SW-4` / `SW-5` 由同一个双 watcher 场景承载：两者都从 `'earliest'` 起步，一个 ack 之后另一个的
`cursor` MUST 原地不动，且两边都收到全部变更。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_WATCH_UNSUPPORTED` | `transport.capabilities.supportsStateWatch === false`；`watch()` 立即被拒绝（TS-2 闸门。`watch()` 按 §10.2 是异步的，见偏离 D-1，因此表现为 Promise 拒绝而非同步抛出） | `false` |
| `EAPP_STATE_UNSUPPORTED` | `transport.capabilities.supportsState === false` | `false` |
| `EAPP_STATE_PATTERN_INVALID` | `pattern` 校验失败（§8） | `false` |
| `EAPP_SUBSCRIPTION_INVALID` | `mode === 'group'` 但未给 `group`；`mode === 'exclusive'` 却给了 `group`；`pollIntervalMs <= 0`（由 v3.1 Subscription 层抛出） | `false` |

`watch` 的两项能力检查顺序是：先校验 pattern（`EAPP_STATE_PATTERN_INVALID`），再检查
`supportsStateWatch`（`EAPP_WATCH_UNSUPPORTED`）——因此一个非法 pattern 无论 Transport 是否支持
watch 都会先被拒绝。

---

## 示例

```typescript
import { expect } from 'vitest';
import type { Identity } from '@eapp/core';
import { InteractionLayerImpl } from '@eapp/interaction';
import { configureStateChannel, type StateUpdateEvent } from '@eapp/state';
import { MemoryTransport } from '@eapp/transport-memory';

const owner: Identity = { domain: 'e2e', id: 'owner', instance: 'owner-1' };
const transport = new MemoryTransport();
const interaction = new InteractionLayerImpl({ transport });
const channel = await interaction.createChannel({
  binding: 'b1',
  mode: 'state',
  delivery: 'at-least-once',
});
await channel.connect();
const ch = configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner });

// SUB-9 / SW-1：初始位置 eager 解析，因此 watch() 是异步的且返回后 cursor 已具体
const watcher = await ch.watch({ key: 'k' }, { cursor: 'earliest' });
expect(watcher.kind).toBe('state');        // SW-2
expect(watcher.mode).toBe('exclusive');    // SW-3：mode 仍是 v3.1 的订阅模式
expect(watcher.cursor).toBeDefined();

const seen: StateUpdateEvent[] = [];
const task = (async () => {
  for await (const update of watcher) {    // §7.2：在 watcher 上迭代，不在 update 上
    seen.push(update);
    await update.ack();                    // SW-6：无参数
  }
})().catch(() => undefined);

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
const r2 = await ch.delete('k', r1);       // SW-8 / DEL-3：删除事件同样被投递
await waitFor(() => seen.length >= 2);

expect(seen.map((u) => u.type)).toEqual(['set', 'deleted']);
expect(seen[1]?.revision).toBe(r2);
expect(seen[1]?.value).toBeUndefined();    // value 仅出现在 type === 'set' 的事件上
expect(watcher.cursor).toBe(r2);           // ack 之后位置才前进，且 Revision 就是 Cursor

// SW-11 / SW-12：close 幂等，且关闭后 ack / nack 是无副作用 no-op
await watcher.close();
await watcher.close();
await expect(seen[0]!.ack()).resolves.toBeUndefined();
await expect(seen[0]!.nack()).resolves.toBeUndefined();
await task;
```

---

## 相关

- [`StateChannel`](./state-channel.md) —— `watch()` 的入口与返回值约定
- [`Revision`](./revision.md) —— 事件的 `revision` 与 `cursor` 是同一域（REV-7）
- [`StateUpdate`](./state-update.md) —— `pattern` 的选择范围与校验规则
- [`StateSnapshot`](./state-snapshot.md) —— restore 的每一次写入 MUST 对 watcher 可见（SNAP-8）
- [`StateTransport`](./state-transport.md) —— `readChangesAfter` 与 `waitForChange` 的契约

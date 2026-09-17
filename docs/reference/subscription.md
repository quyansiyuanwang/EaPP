# `Subscription`

> **谁在**参与 —— 对某个 Channel 的一次异步订阅，持有自己的游标与暂停闸门。

| | |
|---|---|
| **层** | v3.1 Interaction Layer |
| **规范** | [v3.1.0-interaction §7](../spec/v3.1.0-interaction.md) |
| **实现** | [`packages/interaction/src/subscription.ts`](../../packages/interaction/src/subscription.ts) |
| **测试** | [`tests/conformance/interaction.test.ts`](../../tests/conformance/interaction.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
type SubscriptionMode = 'exclusive' | 'group';
type SubscriptionState = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

interface SubscriptionOptions {
  mode?: SubscriptionMode;      // 默认 'exclusive'
  group?: string;               // mode === 'group' 时 MUST 指定
  cursor?: CursorAnchor;        // 默认 'latest'
}

interface Subscription<T> extends AsyncIterable<T> {
  readonly id: string;
  readonly channel: string;
  readonly mode: SubscriptionMode;
  readonly cursor: Cursor;      // MUST 非 undefined（SUB-9）
  readonly state: SubscriptionState;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}

/** 模式相关的部分由调用方提供；订阅本体只拥有游标、闸门与投递循环。 */
interface SubscriptionSource<T> {
  head(): Promise<Cursor>;
  earliest(): Promise<Cursor>;   // 无可服务位置时 MUST 抛 EAPP_CURSOR_TOO_OLD
  readAfter(cursor: Cursor, ack: AckFactory): Promise<Array<{ cursor: Cursor; item: T }>>;
  waitForChange?(cursor: Cursor, signal: AbortSignal): Promise<void>;
  pollIntervalMs?: number;       // 默认 50；MUST > 0
}

type AckFactory = (cursor: Cursor) => AckContext;

class TransportSubscription<T> implements Subscription<T> {
  static create<T>(
    channel: string,
    options: SubscriptionOptions,
    source: SubscriptionSource<T>,
  ): Promise<TransportSubscription<T>>;
  exportCursor(): Cursor;
}
```

字段逐个说明：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | `string` | 是 | 订阅标识 |
| `channel` | `string` | 是 | 所属 Channel；订阅 `MUST NOT` 独立于它存在（SUB-1） |
| `mode` | `SubscriptionMode` | 是 | `exclusive`（默认，独立游标）或 `group`（共享游标、竞争消费） |
| `cursor` | `Cursor` | 是 | 当前游标；创建返回前已解析为非 `undefined`（SUB-9） |
| `state` | `SubscriptionState` | 是 | `ACTIVE` / `SUSPENDED` / `CLOSED` |
| `suspend()` | `Promise<void>` | 是 | 停止投递；已 yield 未 ack 的项仍然有效 |
| `resume()` | `Promise<void>` | 是 | 从当前游标继续；`MUST NOT` 重投已 ack 的项 |
| `close()` | `Promise<void>` | 是 | 终止迭代（挂起的 `next()` resolve 为 `done`）；`close()` 幂等（SUB-6 / SUB-7） |
| `cursor`（`options`） | `CursorAnchor` | 否 | 起始位置；缺省 `'latest'`，按 §6.2 在创建期立即解析 |
| `pollIntervalMs` | `number` | 否 | 无推送时的轮询间隔，默认 `50` 且 `MUST > 0` |

---

## 语义

`Subscription` 回答"谁在参与"；"谁和谁在竞争"由 [ConsumerGroup](./consumer-group.md) 回答（§8.1）。

**两种模式**（§7.1）：

```
exclusive   每个订阅持有独立 cursor，收到全部匹配项          （默认）
group       同 group 的订阅共享一个 cursor，竞争消费          （MUST 指定 group）
```

**三个操作**（§7.2）：

| 操作 | 语义 |
|---|---|
| `suspend()` | 停止投递；已 yield 未 ack 的项仍然有效（SUB-5） |
| `resume()` | 从当前 cursor 继续；`MUST NOT` 重投已 ack 的项 |
| `close()` | 终止迭代（挂起的 `next()` resolve 为 `done`）；`close()` 幂等（SUB-6 / SUB-7） |

`close()` 之后对已 yield 项调用 `ack()` `MUST` 是 no-op —— 不抛错、不改变游标（SUB-8）。
这条与"上下文被终结则抛 `EAPP_LEASE_CLOSED`"是两条不同的终结故事，
分离的动机见 [`AckContext`](./ack-context.md)。

**消费单元 `T` `MUST` 携带 [`AckContext`](./ack-context.md)**（E1-3）。
对 State 模式，`T` 就是 v3.2 的 `StateUpdateEvent`，它扩展同一接口而不是另立一套。

锚点在创建期解析。§6.2 规则 5 要求锚点 eager 解析；SUB-9 把它写成可观察的承诺：
`create()` 返回时 `subscription.cursor` 已是具体位置，`MUST NOT` 延迟到首次迭代。
默认锚点是 `'latest'`。

独立游标互不干扰。`exclusive` 订阅各自推进自己的游标，
一个订阅的确认 `MUST NOT` 影响同 Channel 上的另一个订阅（SUB-2 / SUB-3）——
每个订阅因此看到全部匹配项。`group` 模式下成员不持有自己的位置，
它的 `cursor` 是**组**的游标，见 [ConsumerGroup](./consumer-group.md)。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `SUB-1` | Subscription MUST NOT 独立于 Channel 存在 | `interaction.test.ts` › `'SUB-1 / SUB-2 / SUB-3: tied to a channel, independent cursors'` |
| `SUB-2` | Subscription MUST 有独立 cursor（`mode === 'exclusive'`） | `interaction.test.ts` › `'SUB-1 / SUB-2 / SUB-3: tied to a channel, independent cursors'` |
| `SUB-3` | Subscription MUST NOT 影响同 Channel 的其他 exclusive 订阅 | `interaction.test.ts` › `'SUB-1 / SUB-2 / SUB-3: tied to a channel, independent cursors'` |
| `SUB-4` | `mode === 'group'` 时 group MUST 非空 | `interaction.test.ts` › `'SUB-4: group mode requires a group id'` |
| `SUB-5` | `suspend()` 之后 MUST NOT 继续投递，直到 `resume()` | `interaction.test.ts` › `'SUB-5: suspend stops delivery until resume'` |
| `SUB-6` | `close()` MUST 幂等 | `interaction.test.ts` › `'SUB-6 / SUB-7: close is idempotent and ends delivery'` |
| `SUB-7` | `close()` 之后 MUST NOT 再投递 | `interaction.test.ts` › `'SUB-6 / SUB-7: close is idempotent and ends delivery'` |
| `SUB-8` | `close()` 之后对已 yield 项调用 `ack()` MUST 为 no-op（不抛错、不改变 cursor） | `interaction.test.ts` › `'SUB-8 distinguishes subscription shutdown from termination'` |
| `SUB-9` | cursor MUST 在 Subscription 创建返回前被解析为非 undefined 值 | `interaction.test.ts` › `'CR-2 / CR-4 / SUB-9: a cursor is persistable and resumable'` |

**命名偏差（本页登记）**：SUB-8 的测试名是
`'SUB-8 distinguishes subscription shutdown from termination'`，
没有遵循其余测试使用的 `'ID: …'` 形式（冒号后接描述）。测试确实存在且覆盖 SUB-8，
只是名字少了一个冒号。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_SUBSCRIPTION_INVALID` | `mode === 'group'` 而 `group` 缺失或为空（SUB-4）；`mode === 'exclusive'` 却传了 `group`；`pollIntervalMs <= 0` | `false` |
| `EAPP_CURSOR_TOO_OLD` | 起始锚点为 `'earliest'`，而 `SubscriptionSource.earliest()` 已无法定位任何可服务位置（§6.2 规则 6） | `false` |
| `EAPP_CHANNEL_INVALID` | 订阅/组引用了不存在的 Channel；`SubscriptionSource` 由调用方提供，本层不校验其内容 | `false` |

`retryable` 取 `EappError` 的默认值（本层的码不在 `RETRYABLE_CODES` 中）。

---

## 示例

```typescript
import { TransportSubscription } from '@eapp/interaction';
import type { Cursor, SubscriptionSource } from '@eapp/interaction';
import { MemoryTransport } from '@eapp/transport-memory';
import { expect } from 'vitest';

interface Delivered {
  cursor: Cursor;
  payload: unknown;
  ack(): Promise<void>;
  nack(): Promise<void>;
}

const transport = new MemoryTransport();
await transport.send('room', { type: 'job', id: 1 });

const source: SubscriptionSource<Delivered> = {
  head: () => transport.resolveAnchor('room', 'latest'),
  earliest: () => transport.resolveAnchor('room', 'earliest'),
  readAfter: async (cursor, ack) => {
    const messages = await transport.readAfter('room', cursor, { all: true });
    return messages.map((message) => {
      const context = ack(message.cursor);      // 每个位置一个 AckContext
      return {
        cursor: message.cursor,
        item: {
          cursor: message.cursor,
          payload: message.payload,
          ack: () => context.ack(),
          nack: () => context.nack(),
        },
      };
    });
  },
  waitForChange: (cursor, signal) => transport.waitForChange('room', cursor, signal),
};

const subscription = await TransportSubscription.create<Delivered>(
  'room',
  { cursor: 'earliest' },
  source,
);
expect(subscription.mode).toBe('exclusive');
expect(subscription.channel).toBe('room');                  // SUB-1
expect(typeof subscription.cursor).toBe('string');          // SUB-9
expect(subscription.cursor).not.toBe('latest');             // 锚点已解析

// SUB-4：group 模式 MUST 指出组名
await expect(
  TransportSubscription.create('room', { mode: 'group' }, source),
).rejects.toThrow('EAPP_SUBSCRIPTION_INVALID');

// SUB-5：挂起期间不投递，恢复后从当前游标继续
await subscription.suspend();
expect(subscription.state).toBe('SUSPENDED');
await subscription.resume();
expect(subscription.state).toBe('ACTIVE');

for await (const item of subscription) {
  expect(item.payload).toEqual({ type: 'job', id: 1 });
  await item.ack();                                         // 唯一推进游标的动作
  break;
}

// SUB-6 / SUB-7：幂等关闭，且此后不再投递
await subscription.close();
await subscription.close();
expect(subscription.state).toBe('CLOSED');                  // SUB-8 的静默 ack 见 AckContext 页
```

---

## 相关

- [`Channel`](./channel.md) —— 订阅的归属；SUB-1 要求它存在
- [`ConsumerGroup`](./consumer-group.md) —— `mode: 'group'` 的竞争作用域
- [`Cursor`](./cursor.md) —— 订阅持有的位置与锚点解析（SUB-9）
- [`AckContext`](./ack-context.md) —— 消费单元 `T` 必须携带的两个动作
- [`Transport`](./transport.md) —— `SubscriptionSource` 通常由 Transport 适配而来
- [`Delivery`](./delivery.md) —— `at-least-once` 下未 ack 项的重新投递

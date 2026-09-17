# `ConsumerGroup`

> **谁和谁在竞争** —— 可靠竞争消费的命名作用域。

| | |
|---|---|
| **层** | v3.1 Interaction Layer |
| **规范** | [v3.1.0-interaction §8](../spec/v3.1.0-interaction.md) |
| **实现** | [`packages/interaction/src/consumer-group.ts`](../../packages/interaction/src/consumer-group.ts) |
| **测试** | [`tests/conformance/interaction.test.ts`](../../tests/conformance/interaction.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface ConsumerGroupOptions {
  name: string;          // MUST 在同一 Channel 内唯一（CG-1）
  claimTtlMs?: number;   // 一次 claim 可以持有多久；默认 30_000，MUST > 0
}

interface ConsumerGroup<T> {
  readonly id: string;
  readonly name: string;
  readonly channel: string;
  readonly cursor: Cursor;      // 组共享位置，MUST 唯一（CG-2）
  readonly memberCount: number;
  join(): Promise<Subscription<T>>;
  close(): Promise<void>;
}

interface ConsumerGroupDeps {
  now?: () => number;           // 注入时钟，使 claim 过期可确定性测试
}

class ConsumerGroupImpl<T> implements ConsumerGroup<T> {
  static open<T>(
    channel: string,
    options: ConsumerGroupOptions,
    source: SubscriptionSource<T>,
    deps?: ConsumerGroupDeps,
  ): Promise<ConsumerGroupImpl<T>>;
}

function openConsumerGroup<T>(channel, options, source, deps?): Promise<ConsumerGroupImpl<T>>;
```

由 `InteractionLayer` 暴露的操作面（按 Channel 查找、按名字加入）：

```typescript
interface InteractionLayer {
  openConsumerGroup<T>(
    channelId: string,
    options: ConsumerGroupOptions,
    source: SubscriptionSource<T>,
    deps?: ConsumerGroupDeps,
  ): Promise<ConsumerGroup<T>>;
  consumerGroup(channelId: string, name: string): ConsumerGroup<unknown> | undefined;
  joinConsumerGroup<T>(channelId: string, name: string): Promise<Subscription<T>>;
  listConsumerGroups(channelId: string): ConsumerGroup<unknown>[];
}
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `name` | `string` | 是 | 组名；在同一 Channel 内唯一（CG-1），`MUST NOT` 为空 |
| `claimTtlMs` | `number` | 否 | 一次 claim 的持有上限；超时后位置归还给组（CG-6）。默认 `30_000` |
| `id` | `string` | 是 | 组标识（实现分配） |
| `channel` | `string` | 是 | 所属 Channel；组 `MUST NOT` 独立于它存在（CG-7） |
| `cursor` | `Cursor` | 是 | 组共享位置，等于组内已 ack 位置的最大值（CG-2 / §8.3） |
| `memberCount` | `number` | 是 | 当前成员数 |
| `join()` | `Promise<Subscription<T>>` | 是 | 加入一个成员；返回的订阅是 [`Subscription`](./subscription.md)，其 `cursor` 是**组**的 |
| `close()` | `Promise<void>` | 是 | 关闭组：先关成员，再释放全部 claim；幂等 |

`join()` 是本实现给出的方法；规范 §8.2 冻结的 `ConsumerGroup` 不含它 ——
规范的加入路径是通过既有的 `SubscriptionOptions` 表达成员身份（`{ mode: 'group', group }`），
不引入新的订阅类型。

---

## 语义

**竞争作用域是两层的**（§8.1）：

```
组之间   每个组都收到全部消息，各自持有独立 Cursor          （CG-4）
组之内   每条消息只交给一个成员 —— 成员之间竞争             （CG-3）
```

```
同一个 Channel
├── ConsumerGroup "workers"    组游标 = W     看到 W 之后的全部消息
│     ├── member a  ─┐
│     └── member b  ─┘   同一位置只能被其中一个持有（claim）
└── ConsumerGroup "auditors"   组游标 = A     独立推进，不受 workers 影响
      └── member c
```

**排他性不是重新发明的，它就是 [Lease](./lease.md)。** §8.3 写死：一次 claim 就是一次
Lease，因此 §5 的 L-2 —— "同一 cursor 在任意时刻 `MUST NOT` 被多个 `ACTIVE` Lease 持有" ——
**就是 CG-3 的机制保证**。`ConsumerGroup` 只是规定这份所有权**在哪一组消费者之间**竞争。
一条消息因此不会同时交给同一组的两个成员：第二个成员看到的是"该位置已被领走"。

**组游标 = 组内已 ack 位置的最大值**（§8.3，与 §6.4 一致）：

```
成员 ack 一个更靠后的位置  ⇒  声明"它之前的位置都已了结"
                           ⇒  中间未 ack 的项被**显式**放弃
                           ⇒  这是一次显式跳过，不违反 CR-3
```

实现 `MUST NOT` 用"最小未了结位置"替代组游标 —— 那会让一个掉队的成员**永久拖住**
整个组的位置，且与 §6.4 已冻结的语义冲突。

**归还的两条路径**：`nack()` 或 claim 超时都让位置重新对该组可用（CG-6）；
一个成员离开时，它持有的工作 `MUST` 立即释放，而不是等 TTL 走完 ——
离开的成员永远不会 ack，等它就是让组白白空转（CG-5）。

**每个组起点独立。** `openConsumerGroup()` 以一个已解析的位置开始（创建时取 Channel 头），
组与组之间不共享游标（CG-4）；组里的成员不持有自己的位置，它的 `cursor` 读的就是组的（CG-2）。

**合规等级**：§15 把 ConsumerGroup 单列为 **I7 ConsumerGroup（SHOULD）** ——
命名竞争消费作用域。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `CG-1` | `ConsumerGroup.name` MUST 在同一 Channel 内唯一 | `interaction.test.ts` › `'CG-1: a group name is unique within its Channel'` |
| `CG-2` | 一个 ConsumerGroup 的所有成员 MUST 共享恰好一个 Cursor | `interaction.test.ts` › `'CG-2: every member shares exactly one cursor'` |
| `CG-3` | 一条消息在同一时刻 MUST NOT 被同一组的多个成员同时持有 | `interaction.test.ts` › `'CG-3 / CG-6: a claimed message is not handed to a peer, and release frees it'` |
| `CG-4` | 同一 Channel 上的不同 ConsumerGroup MUST NOT 互相影响各自的 Cursor | `interaction.test.ts` › `'CG-4: different groups on one Channel keep independent cursors'` |
| `CG-5` | 一个成员离开 MUST NOT 使该组停滞 | `interaction.test.ts` › `'CG-5: a member leaving does not stall the group'` |
| `CG-6` | 被 nack 或 claim 超时的位置 MUST 重新对该组可用 | `interaction.test.ts` › `'CG-6: an expired claim returns to the group on its own'`（另有 `'CG-3 / CG-6: a claimed message is not handed to a peer, and release frees it'` 覆盖 nack 路径） |
| `CG-7` | ConsumerGroup MUST NOT 独立于其 Channel 存在 | `interaction.test.ts` › `'CG-7: a ConsumerGroup never outlives its Channel'` |
| `CG-8` | `mode === 'group'` 的 Subscription MUST 指名同一 Channel 上的一个 ConsumerGroup | `interaction.test.ts` › `'CG-8: joining MUST name an existing group on the same Channel'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_SUBSCRIPTION_INVALID` | 组名为空；同一 Channel 上重复的组名（CG-1）；`claimTtlMs <= 0`；`join()` 指名的组在该 Channel 上不存在（CG-8） | `false` |
| `EAPP_CHANNEL_INVALID` | `openConsumerGroup()` 引用了不存在的 Channel（CG-7） | `false` |
| `EAPP_CHANNEL_CLOSED` | 对已关闭的组调用 `join()` | `false` |
| `EAPP_SUBSCRIPTION_INVALID` | `{ mode: 'group' }` 缺少 `group`，或 `{ mode: 'exclusive', group }` 多传了组名（SUB-4，见 [`Subscription`](./subscription.md)） | `false` |

`retryable` 取 `EappError` 的默认值（本层的码不在 `RETRYABLE_CODES` 中）。

---

## 示例

```typescript
import { InteractionLayerImpl } from '@eapp/interaction';
import type { Cursor, SubscriptionSource } from '@eapp/interaction';
import { MemoryTransport } from '@eapp/transport-memory';
import { expect } from 'vitest';

interface Job {
  cursor: Cursor;
  payload: unknown;
  ack(): Promise<void>;
  nack(): Promise<void>;
}

const transport = new MemoryTransport();
const interaction = new InteractionLayerImpl({ transport });
const channel = await interaction.createChannel({ binding: 'b1', mode: 'stream' });
await channel.connect();

const source: SubscriptionSource<Job> = {
  head: () => transport.resolveAnchor(channel.id, 'latest'),
  earliest: () => transport.resolveAnchor(channel.id, 'earliest'),
  readAfter: async (cursor, ack) => {
    const messages = await transport.readAfter(channel.id, cursor, { all: true });
    return messages.map((message) => {
      const context = ack(message.cursor);
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
  waitForChange: (cursor, signal) => transport.waitForChange(channel.id, cursor, signal),
};

// CG-1：组名在同一 Channel 内唯一；claimTtlMs 省略时取默认 30_000
const group = await interaction.openConsumerGroup<Job>(channel.id, { name: 'workers' }, source);
await expect(
  interaction.openConsumerGroup(channel.id, { name: 'workers' }, source),
).rejects.toThrow('EAPP_SUBSCRIPTION_INVALID');

// CG-8：加入必须指名该 Channel 上一个已存在的组
const a = await interaction.joinConsumerGroup<Job>(channel.id, 'workers');
const b = await interaction.joinConsumerGroup<Job>(channel.id, 'workers');
expect(group.memberCount).toBe(2);
await expect(interaction.joinConsumerGroup(channel.id, 'nobody')).rejects.toThrow(
  'EAPP_SUBSCRIPTION_INVALID',
);

await transport.send(channel.id, { type: 'job', id: 1 });

const iterator = a[Symbol.asyncIterator]();
const held = (await iterator.next()).value!;
expect(held.payload).toEqual({ type: 'job', id: 1 });

// 这一刻该位置只被 a 持有：b 拿不到它。排他性就是 §5 的 Lease（L-2），
// 因此 ack() 之前 b 拉不到同一条 —— 细节见 CG-3 / CG-6 的一致性测试。
await held.ack();

// CG-2：组内只有一个位置；成员不持有自己的游标
expect(group.cursor).toBe(held.cursor);
expect(b.cursor).toBe(a.cursor);

// CG-5：成员离开不使组停滞
await a.close();
await b.close();
expect(group.memberCount).toBe(0);
await group.close();
```

---

## 相关

- [`Subscription`](./subscription.md) —— 组的成员就是订阅；"谁在参与"与"谁和谁竞争"是两问
- [`Lease`](./lease.md) —— 一次 claim 就是一次 Lease，L-2 是 CG-3 的机制保证
- [`Cursor`](./cursor.md) —— 组游标与 §6.4 的推进规则
- [`AckContext`](./ack-context.md) —— 成员的 `ack()` / `nack()` 推进的是组游标
- [`Channel`](./channel.md) —— 组的作用域边界；组随 Channel 一起关闭（CG-7）
- [`Delivery`](./delivery.md) —— 竞争消费只在 `at-least-once` 下有完整语义

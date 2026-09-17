# `Delivery`

> 一次投递**保证**什么 —— 只有两条保证，且 `exactly-once` 不在其中。

| | |
|---|---|
| **层** | v3.1 Interaction Layer |
| **规范** | [v3.1.0-interaction §4](../spec/v3.1.0-interaction.md) |
| **实现** | [`packages/interaction/src/channel.ts`](../../packages/interaction/src/channel.ts) · [`packages/interaction/src/transport.ts`](../../packages/interaction/src/transport.ts) |
| **测试** | [`tests/conformance/interaction.test.ts`](../../tests/conformance/interaction.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

投递保证是 [Channel](./channel.md) 上的一个冻结字段，不是一个独立的对象：

```typescript
type DeliveryGuarantee = 'at-most-once' | 'at-least-once';

interface Channel extends ChannelRef {
  mode: ChannelMode;
  delivery: DeliveryGuarantee;
  state: ChannelState;
}

/** §4.4：省略 delivery 时按 mode 推导。 */
function defaultDeliveryFor(mode: ChannelMode): DeliveryGuarantee;

/** DL-6：mode 不支持该保证时抛 EAPP_DELIVERY_UNSUPPORTED。 */
function assertDeliveryAllowed(mode: ChannelMode, delivery: DeliveryGuarantee): void;

/** Transport 侧必须声明自己能提供哪几种（§10.2）。 */
interface TransportCapabilities {
  delivery: {
    atMostOnce: boolean;
    atLeastOnce: boolean;
    replay: boolean;
  };
}
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `delivery` | `DeliveryGuarantee` | 是 | Channel 冻结的保证；`MUST` 是两条之一（DL-1） |
| `defaultDeliveryFor(mode)` | `(ChannelMode) => DeliveryGuarantee` | — | `stream` / `state` 推导为 `at-least-once`，其余推导为 `at-most-once`（CC-4） |
| `assertDeliveryAllowed(mode, delivery)` | `(ChannelMode, DeliveryGuarantee) => void` | — | 显式拒绝非法组合；`MUST NOT` 静默降级（DL-6 / CC-5） |
| `capabilities.delivery.*` | `boolean` | 是 | Transport 的自述能力；缺失字段按"不支持"处理（TR-3） |

---

## 语义

**只有两条保证**（DL-1 / DL-2）。`exactly-once` `MUST NOT` 出现在 Core：
它需要跨进程的分布式提交，协议层不声称能提供。`at-least-once` 的下界由
[Subscription](./subscription.md) 的重新投递实现，上界不是本层的承诺 —— 因此
`at-least-once` 的消费者 `MUST` 幂等（DL-5）。

**保证与确认的关系**：

```
at-most-once   不确认（DL-3）：投递一次即视为完成，不要求消费者确认
               丢掉的投递不会被补上 —— "最多一次"就是这个意思
at-least-once  必须确认（DL-4）：未 ack 的位置保持可用，在下一次迭代重新投递
```

两条保证都不改变游标规则：游标只随显式 `ack()` 前移（CR-3），
"不确认"不等于"自动前移"。

**模式决定允许的保证**（§4.4，DL-3 / DL-4 / DL-6）：

| 模式 | 允许的 delivery | 省略时的推导 |
|---|---|---|
| `request` | `at-most-once`, `at-least-once` | `at-most-once` |
| `event` | `at-most-once`, `at-least-once` | `at-most-once` |
| `stream` | **`at-least-once` only** | `at-least-once` |
| `state` | **`at-least-once` only** | `at-least-once` |

对 `stream` / `state` 指定 `at-most-once` `MUST` 返回 `EAPP_DELIVERY_UNSUPPORTED`（DL-6），
`MUST NOT` 被静默升级成更强的保证 —— 非法组合在创建期失败。

**未覆盖点（本页登记）**：§10.4 的 TR-4 要求 "Channel `MUST NOT` 使用超出 Transport 能力的特性"，
但实现的能力检查 `assertCapability()` 只覆盖 `cursor` 与 `lease`，
没有把 `mode` / `delivery` 与 `capabilities.delivery.*` 对照。
因此"在不支持 `atLeastOnce` 的 Transport 上创建 `at-least-once` Channel"这一情形
既没有守卫也没有测试。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `DL-1` | `delivery` MUST 是 `at-most-once` 或 `at-least-once` | `interaction.test.ts` › `'DL-1 / DL-2: only two guarantees exist and exactly-once is not one'` |
| `DL-2` | `exactly-once` MUST NOT 出现在 Core | `interaction.test.ts` › `'DL-1 / DL-2: only two guarantees exist and exactly-once is not one'` |
| `DL-3` | `at-most-once` MUST NOT ack | `interaction.test.ts` › `'DL-3 / DL-4 / CC-4 / CC-5 / DL-6: mode determines the guarantee'` |
| `DL-4` | `at-least-once` MUST ack | `interaction.test.ts` › `'DL-3 / DL-4 / CC-4 / CC-5 / DL-6: mode determines the guarantee'` |
| `DL-5` | `at-least-once` 消费者 MUST 幂等处理 | `interaction.test.ts` › `'DL-5: unacknowledged changes are redelivered, so consumers must be idempotent'` |
| `DL-6` | 创建 `stream` / `state` Channel 时指定 `at-most-once` MUST 返回 `EAPP_DELIVERY_UNSUPPORTED` | `interaction.test.ts` › `'DL-3 / DL-4 / CC-4 / CC-5 / DL-6: mode determines the guarantee'` |

**覆盖范围说明**：DL-3 / DL-4 的测试落点是 `defaultDeliveryFor()` 的"模式 → 保证"映射
（`event` ⇒ `at-most-once`，`stream` / `state` ⇒ `at-least-once`），
而不是运行时的 ack / 不 ack 分支 —— 本层的 `TransportSubscription` 不读取 `delivery` 字段，
确认路径由所属模式与消费者共同决定。DL-5 的测试则是真实的重新投递观察。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_DELIVERY_UNSUPPORTED` | `assertDeliveryAllowed(mode, delivery)` 收到 `stream` / `state` + `at-most-once`；`createChannel()` 因此在创建期失败（DL-6 / CC-5） | `false` |

本层没有声明"Transport 不支持该保证"的运行时错误：TR-4 要求的检查在实现里不覆盖 `delivery`，
见上文"未覆盖点"。

---

## 示例

```typescript
import { InteractionLayerImpl, assertDeliveryAllowed, defaultDeliveryFor } from '@eapp/interaction';
import { MemoryTransport } from '@eapp/transport-memory';
import { expect } from 'vitest';

// CC-4 / DL-4：stream 与 state 只允许 at-least-once，省略时推导为它
expect(defaultDeliveryFor('stream')).toBe('at-least-once');
expect(defaultDeliveryFor('state')).toBe('at-least-once');
expect(defaultDeliveryFor('event')).toBe('at-most-once');   // DL-3

// DL-6：非法组合被显式拒绝，而不是被升级
expect(() => assertDeliveryAllowed('stream', 'at-most-once')).toThrow('EAPP_DELIVERY_UNSUPPORTED');
assertDeliveryAllowed('event', 'at-most-once');
assertDeliveryAllowed('event', 'at-least-once');            // 两种都允许

const interaction = new InteractionLayerImpl({ transport: new MemoryTransport() });
await expect(
  interaction.createChannel({ binding: 'b1', mode: 'state', delivery: 'at-most-once' }),
).rejects.toThrow('EAPP_DELIVERY_UNSUPPORTED');
```

`at-least-once` 的实际形状 —— 同一位置被重新投递，消费者必须能重复处理：

```typescript
import { TransportSubscription } from '@eapp/interaction';
// SubscriptionSource 的完整构造见 [Subscription](./subscription.md) 的示例。
const subscription = await TransportSubscription.create<Delivered>('room', { cursor: 'earliest' }, source);
let handled = 0;
for await (const item of subscription) {
  handled += 1;               // 不 ack，于是同一个位置会再次出现（DL-5）
  if (handled >= 2) break;
}
await subscription.close();
```

---

## 相关

- [`Channel`](./channel.md) —— 承载 `delivery` 字段的实体
- [`Subscription`](./subscription.md) —— `at-least-once` 的重新投递由它实现
- [`Cursor`](./cursor.md) —— 未 ack 的位置为什么不会被跳过
- [`Transport`](./transport.md) —— `capabilities.delivery` 的声明与 TR-4 的要求

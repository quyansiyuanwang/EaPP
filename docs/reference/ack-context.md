# `AckContext`

> 如何**确认**一件事已经完成 —— 一个消费单元拿到的两个动作：`ack()` 与 `nack()`。

| | |
|---|---|
| **层** | v3.1 Interaction Layer |
| **规范** | [v3.1.0-interaction §9](../spec/v3.1.0-interaction.md) |
| **实现** | [`packages/interaction/src/ack.ts`](../../packages/interaction/src/ack.ts) |
| **测试** | [`tests/conformance/interaction.test.ts`](../../tests/conformance/interaction.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
type AckState = 'PENDING' | 'ACKED' | 'NACKED';

interface AckContext {
  ack(): Promise<void>;
  nack(): Promise<void>;
}

interface LocalAckHooks {
  onAck?: (self: LocalAck) => void;
  onNack?: (self: LocalAck) => void;
}

class LocalAck implements AckContext {
  constructor(hooks?: LocalAckHooks);
  get state(): AckState;
  get closed(): boolean;
  get terminated(): boolean;
  ack(): Promise<void>;
  nack(): Promise<void>;
  close(): void;        // 不属于 AckContext；订阅关停时由它调用
  terminate(): void;    // 不属于 AckContext；终结，之后一律抛 EAPP_LEASE_CLOSED
}
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `ack()` | `Promise<void>` | 是 | 项被确认；游标推进到该项位置（取 `max`）。`MUST` 幂等（AK-1） |
| `nack()` | `Promise<void>` | 是 | 项被拒绝并回到可用；游标 `MUST NOT` 前移。`MUST` 幂等（AK-2） |
| `state` | `AckState` | 是 | 仅在 `LocalAck` 上；`PENDING` → `ACKED` / `NACKED`，单向 |
| `closed` | `boolean` | 是 | 归属的 [Subscription](./subscription.md) 已关闭；此后两个动作都是静默 no-op |
| `terminated` | `boolean` | 是 | 终态；此后任何调用都抛 `EAPP_LEASE_CLOSED` |
| `close()` | `() => void` | 否 | 订阅关停路径（SUB-8）：`MUST NOT` 抛错、`MUST NOT` 改变游标 |
| `terminate()` | `() => void` | 否 | 终结路径（AK-5）：租约过期、Channel 关闭 |

`LocalAck` 是本实现的落地类；`AckContext` 是消费端应当看到的最小面。
两者只有 `ack()` / `nack()` 是协议面，`close()` / `terminate()` 不是。

---

## 语义

**两条终结故事必须分开**，否则 `for await` 循环会在 `finally` 里炸掉：

| 路径 | 触发者 | `ack()` / `nack()` 的行为 | 规范落点 |
|---|---|---|---|
| 订阅关停 | 所属 Subscription 被 `close()` | 静默 no-op，`MUST NOT` 抛错，`MUST NOT` 改变游标 | SUB-8 |
| 上下文终结 | 租约过期 / Channel 关闭 | 一律抛 `EAPP_LEASE_CLOSED` | AK-5 |

```
状态冲突（同一个 AckContext 实例上）：
  ack() 之后 nack()  →  EAPP_LEASE_CLOSED   （AK-3）
  nack() 之后 ack()  →  EAPP_LEASE_CLOSED   （AK-4）
自身重复：
  ack() 之后 ack()   →  静默成功            （AK-1）
  nack() 之后 nack() →  静默成功            （AK-2）
```

**`ack()` 推进游标，`nack()` 不推进。** §9 的表格把它写死：`ack()` 把游标置为
`max(当前游标, 该项位置)`，`nack()` 只把该项放回可用、游标**不前移**。
后者是 `at-least-once` 的重新投递得以发生的原因（见 [Delivery](./delivery.md)、[Cursor](./cursor.md)）。

**E1-3：`AckContext` 必须被完整实现。** 任何消费端事件类型（含 v3.2 的
`StateUpdateEvent`）`MUST` 同时提供 `ack()` 与 `nack()`；只提供 `ack()` 的实现
`MUST` 被视为不符合本层规范。AK-3 / AK-4 的"再次调用"指的正是**同一 `AckContext` 实例上**
的状态冲突调用。

**实现约束（非规范性）**：同一位置被重新投递时 `MUST` 复用同一个 `AckContext`，
而不是替换成新的。原因是消费者可能仍持有前一个事件对象 —— 若把旧上下文关掉，
它持有的 `ack()` 会变成静默 no-op，位置将永远无法推进。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `AK-1` | `ack()` MUST 幂等 | `interaction.test.ts` › `'AK-1 / AK-2 / AK-3 / AK-4: idempotence and mutual exclusion'` |
| `AK-2` | `nack()` MUST 幂等 | `interaction.test.ts` › `'AK-1 / AK-2 / AK-3 / AK-4: idempotence and mutual exclusion'` |
| `AK-3` | `ack()` 之后 MUST NOT 允许 `nack()` | `interaction.test.ts` › `'AK-1 / AK-2 / AK-3 / AK-4: idempotence and mutual exclusion'` |
| `AK-4` | `nack()` 之后 MUST NOT 允许 `ack()` | `interaction.test.ts` › `'AK-1 / AK-2 / AK-3 / AK-4: idempotence and mutual exclusion'` |
| `AK-5` | 对已终结的 AckContext 再次调用 MUST 返回 `EAPP_LEASE_CLOSED` | `interaction.test.ts` › `'AK-5: a terminated AckContext refuses further calls'` |

`SUB-8`（订阅关停路径是 no-op 而非抛错）由 [Subscription](./subscription.md) 页拥有，
其测试为 `interaction.test.ts` ›
`'SUB-8 distinguishes subscription shutdown from termination'`。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_LEASE_CLOSED` | 在 `ACKED` 的上下文上调用 `nack()`（AK-3）；在 `NACKED` 的上下文上调用 `ack()`（AK-4）；在 `terminate()` 之后的上下文上调用任一动作（AK-5） | `false` |

`retryable` 取 `EappError` 的默认值（本层的码不在 `RETRYABLE_CODES` 中）。
订阅关停（`close()`，即 SUB-8）**不**产生任何错误。

---

## 示例

```typescript
import { LocalAck } from '@eapp/interaction';
import { expect } from 'vitest';

// AK-1：ack() 幂等
const acked = new LocalAck();
await acked.ack();
expect(acked.state).toBe('ACKED');
await expect(acked.ack()).resolves.toBeUndefined();

// AK-3：ack() 之后 MUST NOT 允许 nack()
await expect(acked.nack()).rejects.toThrow('EAPP_LEASE_CLOSED');

// AK-2 / AK-4：对侧同理
const nacked = new LocalAck();
await nacked.nack();
await expect(nacked.nack()).resolves.toBeUndefined();
await expect(nacked.ack()).rejects.toThrow('EAPP_LEASE_CLOSED');

// SUB-8：订阅关停是另一条路径 —— 静默 no-op，不抛错、不改变游标
const shutdown = new LocalAck();
shutdown.close();
await expect(shutdown.ack()).resolves.toBeUndefined();
await expect(shutdown.nack()).resolves.toBeUndefined();
expect(shutdown.state).toBe('PENDING');

// AK-5：terminate() 是终结，不是关停
const terminated = new LocalAck();
terminated.terminate();
await expect(terminated.ack()).rejects.toThrow('EAPP_LEASE_CLOSED');
await expect(terminated.nack()).rejects.toThrow('EAPP_LEASE_CLOSED');

// 钩子让订阅在 ack 时推进自己的游标；LocalAck 本身不持有位置
const seen: string[] = [];
const hooked = new LocalAck({ onAck: () => seen.push('ack'), onNack: () => seen.push('nack') });
await hooked.ack();
expect(seen).toEqual(['ack']);
```

---

## 相关

- [`Subscription`](./subscription.md) —— 构造并持有 `AckContext`，关停时调用 `close()`（SUB-8）
- [`Lease`](./lease.md) —— `ack()` / `nack()` 与租约状态共享同一套终结规则
- [`Cursor`](./cursor.md) —— 只有 `ack()` 会推进游标，`nack()` 不会
- [`Delivery`](./delivery.md) —— `at-least-once` 要求消费端确认
- [`ConsumerGroup`](./consumer-group.md) —— 组内成员的确认推进的是组游标

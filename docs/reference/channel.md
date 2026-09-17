# `Channel`

> 交互发生在**哪里** —— 由一个 Binding 派生、携带模式与投递保证的消息通道。

| | |
|---|---|
| **层** | v3.1 Interaction Layer |
| **规范** | [v3.1.0-interaction §2](../spec/v3.1.0-interaction.md) · §12（创建路径） |
| **实现** | [`packages/interaction/src/channel.ts`](../../packages/interaction/src/channel.ts) |
| **测试** | [`tests/conformance/interaction.test.ts`](../../tests/conformance/interaction.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
type ChannelMode = 'request' | 'event' | 'stream' | 'state';
type DeliveryGuarantee = 'at-most-once' | 'at-least-once';
type ChannelState = 'OPEN' | 'ACTIVE' | 'DRAINING' | 'CLOSED';

interface ChannelRef {          // §2.2：Composition Core 唯一可见的部分
  id: string;
  binding: string;
}

interface Channel extends ChannelRef {
  mode: ChannelMode;
  delivery: DeliveryGuarantee;
  state: ChannelState;
}

interface ManagedChannel extends Channel {
  connect(): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
}
```

字段逐个说明：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | `string` | 是 | Channel 标识；由 `InteractionLayer` 分配，在同一实现实例内唯一 |
| `binding` | `string` | 是 | 派生它的 `Binding.id`（v3.0 `core.bind()` 的产物）；CH-1 要求恰好一个 |
| `mode` | `ChannelMode` | 是 | 四种模式之一，创建时冻结（CH-5） |
| `delivery` | `DeliveryGuarantee` | 是 | 投递保证，创建时冻结（CH-6）；省略时按 §4.4 推导 |
| `state` | `ChannelState` | 是 | 生命周期状态；`CLOSED` 是终结态（CH-3） |
| `connect()` | `Promise<void>` | 是 | `OPEN`（或 `DRAINING`）→ `ACTIVE`；已 `CLOSED` 时抛 `EAPP_CHANNEL_CLOSED` |
| `drain()` | `Promise<void>` | 是 | `ACTIVE` → `DRAINING`：停止接受新工作，完成在途工作 |
| `close()` | `Promise<void>` | 是 | → `CLOSED`；`MUST` 幂等（CH-4） |

`ManagedChannel` 是本实现给出的操作面；规范 §2.1 只冻结 `Channel` 这一数据视图。
`ChannelRef` 是它的只读投影 —— 跨层传递时 `MUST` 只传 `id` 与 `binding`。

---

## 语义

ChannelRef 是跨层契约，不是便利类型。§2.2 规定 Composition Core 只可见 `id` 与
`binding`；`mode` / `delivery` / `state` 属于 Interaction Layer，`MUST NOT` 向下泄漏。
实现把这一点落成两个类型：`ChannelRef`（纯数据）与 `ManagedChannel`（数据 + 生命周期操作）。

四种模式已经冻结。`request` / `event` / `stream` / `state` ——
其中 `'state'` 自 v3.1 起就是 `ChannelMode` 的既有成员（E1-2），
后续版本 `MUST NOT` 声称"扩展出第四种模式"。`state` 的运行时语义由 v3.2.0 定义，
本层只声明它存在并冻结其信封（见 [模式消息](./messages.md)）。

**生命周期**（§2.2）：

```
OPEN ──connect──► ACTIVE ──drain──► DRAINING
  │                  │                  │
  └──────close───────┴──────close───────┴──► CLOSED ──any──► CLOSED（幂等）
```

实现额外接受 `DRAINING --connect--> ACTIVE`。规范的理由是 CC-2：Binding 恢复 `ACTIVE` 时，
其 Channel `MUST` 回到服务中；一个再也无法恢复的 `DRAINING` Channel 会让该要求无法满足。
§2.2 的转移表本身没有列出这条边，见本页"与实现的差异"。

**创建路径**（§12，E1-5 补齐）：

```typescript
interface CreateChannelRequest {
  binding: string;               // Binding.id（来自 v3.0 core.bind()）
  mode: ChannelMode;             // MUST 显式指定（CC-3）
  delivery?: DeliveryGuarantee;  // 省略时按 §4.4 推导（CC-4）
}
```

一个 Binding `MAY` 派生多个 Channel，各自 `mode` 不同（CC-9）。
调用方 `MUST NOT` 用一个不存在的 Binding 构造 Channel：CC-6 / CC-7 要求
`EAPP_BINDING_INVALID` / `EAPP_BINDING_CLOSED`。
本实现只在构造 `InteractionLayerImpl` 时提供了 `BindingSource` 才强制这两条，
否则该层可脱离 Composition Core 单独使用。

Channel 随 Binding 派生。Binding 由 Composition Core 派生其状态（v3.0 §6.4），
本层订阅通知并跟随：`ACTIVE` → `OPEN`/`ACTIVE`，`DORMANT` → `DRAINING`，
`CLOSED` → 先关闭该 Channel 的 ConsumerGroup，再 `close()` 该 Channel（CH-2 / CC-2）。

**与实现的差异（本页登记）**：实现允许 `DRAINING --connect--> ACTIVE`，
而 §2.2 的转移表未列出该边；该转移是为满足 CC-2 的"双向恢复"而必需的，一致性测试
`CC-2 / §8.2` 依赖它。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `CH-1` | 一个 Channel 对应恰好一个 Binding | `interaction.test.ts` › `'CH-1 / CH-2 / CC-1 / CC-6 / CC-7: a Channel belongs to exactly one live Binding'` |
| `CH-2` | Channel 生命周期 MUST NOT 超过 Binding | `interaction.test.ts` › `'CH-1 / CH-2 / CC-1 / CC-6 / CC-7: a Channel belongs to exactly one live Binding'` |
| `CH-3` | CLOSED 是终结状态 | `interaction.test.ts` › `'CH-3 / CH-4: CLOSED is terminal and close() is idempotent'` |
| `CH-4` | `close()` MUST 幂等 | `interaction.test.ts` › `'CH-3 / CH-4: CLOSED is terminal and close() is idempotent'` |
| `CH-5` | `mode` MUST NOT 在生命周期内改变 | `interaction.test.ts` › `'CH-5 / CH-6 / CC-3: mode and delivery are fixed at creation'` |
| `CH-6` | `delivery` MUST NOT 在生命周期内改变 | `interaction.test.ts` › `'CH-5 / CH-6 / CC-3: mode and delivery are fixed at creation'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_MODE_INVALID` | `createChannel({ mode })` 的 `mode` 不属于四种冻结模式 | `false` |
| `EAPP_CHANNEL_INVALID` | 分配到的 Channel `id` 已被占用；或按 `id` 查找一个不存在的 Channel | `false` |
| `EAPP_DELIVERY_UNSUPPORTED` | `stream` / `state` 模式指定 `at-most-once`（DL-6） | `false` |
| `EAPP_CHANNEL_CLOSED` | 对 `CLOSED` 的 Channel 调用 `connect()`，或调用需要 `ACTIVE` 的操作 | `false` |
| `EAPP_BINDING_INVALID` | `binding` 不存在（CC-6；仅在提供了 `BindingSource` 时强制） | `false` |
| `EAPP_BINDING_CLOSED` | `binding` 已 `CLOSED`（CC-7；同上） | `false` |
| `EAPP_CHANNEL_DRAINING` | §13 声明了该码，但当前实现从未抛出：`requireActive()` 对 `DRAINING` 抛的是 `EAPP_CHANNEL_INVALID` | `false` |

`retryable` 取 `EappError` 的默认值：只有 `EAPP_REVISION_CONFLICT` 在 `RETRYABLE_CODES` 中，
本层的码都不在其中，也没有调用点显式传入 `retryable`。

---

## 示例

```typescript
import { InteractionLayerImpl } from '@eapp/interaction';
import { MemoryTransport } from '@eapp/transport-memory';
import { expect } from 'vitest';

const transport = new MemoryTransport();
const interaction = new InteractionLayerImpl({ transport });

// CC-3：mode 必须显式指定；CC-4：delivery 省略时按 §4.4 推导
const channel = await interaction.createChannel({ binding: 'b1', mode: 'stream' });
expect(channel.state).toBe('OPEN');                 // CC-8
expect(channel.delivery).toBe('at-least-once');     // CC-4 / DL-4

await channel.connect();
expect(channel.state).toBe('ACTIVE');

await channel.drain();
expect(channel.state).toBe('DRAINING');

await channel.close();
await channel.close();                              // CH-4：幂等
expect(channel.state).toBe('CLOSED');               // CH-3：终结
await expect(channel.connect()).rejects.toThrow('EAPP_CHANNEL_CLOSED');

// §2.2：跨层只能看见 id 与 binding
expect(Object.keys(interaction.channelRef(channel.id)).sort()).toEqual(['binding', 'id']);

// DL-6 / CC-5：较弱的保证被显式拒绝，而不是被静默升级
await expect(
  interaction.createChannel({ binding: 'b1', mode: 'stream', delivery: 'at-most-once' }),
).rejects.toThrow('EAPP_DELIVERY_UNSUPPORTED');

// CC-9：一个 Binding MAY 派生多个 mode 各异的 Channel
const also = await interaction.createChannel({ binding: 'b1', mode: 'event' });
expect(also.id).not.toBe(channel.id);
```

---

## 相关

- [`Subscription`](./subscription.md) —— 谁在参与这个 Channel
- [`ConsumerGroup`](./consumer-group.md) —— 谁和谁在竞争这个 Channel 上的消息
- [`Delivery`](./delivery.md) —— `delivery` 字段允许取哪些值、由谁推导
- [`Transport`](./transport.md) —— Channel 依赖的物理承载与能力声明（CC-1 … CC-9 在此页）
- [`Lifecycle`](./lifecycle.md) —— v3.0 的 Binding 状态；Channel 的生命周期由它派生

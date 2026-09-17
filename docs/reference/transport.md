# `Transport`

> 消息**物理上怎么走** —— 只搬字节、只分配位置，不定义任何交互语义。

| | |
|---|---|
| **层** | v3.1 Interaction Layer |
| **规范** | [v3.1.0-interaction §10](../spec/v3.1.0-interaction.md) · §11 / §12（Composition 边界，CC-1 … CC-9） |
| **实现** | 接口：[`packages/interaction/src/transport.ts`](../../packages/interaction/src/transport.ts) |
| **实现** | [`@eapp/transport-memory`](../../packages/transport/memory/src/memory-transport.ts)（进程内） · [`@eapp/transport-socket`](../../packages/transport/socket/src/socket-transport.ts)（跨进程） |
| **测试** | [`tests/conformance/interaction.test.ts`](../../tests/conformance/interaction.test.ts) · [`socket.test.ts`](../../tests/conformance/socket.test.ts) |
| **稳定度** | FROZEN |

两种已交付的实现用来说明"接口稳定、实现自由"：

| 实现 | 位置域 | `durabilityBoundary` | 位置由谁分配 |
|---|---|---|---|
| `@eapp/transport-memory` | 一个进程 | `'process'` | 它自己 |
| `@eapp/transport-socket` | 一台机器的所有进程 | `'machine'` | broker 进程（独占） |

### 可选扩展：共享的竞争状态

`Transport` 接口是冻结的，不含这一项。但一个消息跨出了进程的 Transport，
如果不把 [`ConsumerGroup`](./consumer-group.md) 的竞争状态也跨出去，
CG-3 就会**静默失效** —— 两个进程各自以为持有同一个位置，每条消息被处理两次。
所以有这么一组可选的成员：

```typescript
readonly sharesGroupState: boolean;
groupStore(context: {
  channel: string; name: string; claimTtlMs: number; initialCursor: Cursor;
}): GroupStore;
```

Interaction Layer 在存在时使用它；`durabilityBoundary` 比 `'process'` 宽、
而这组成员缺失时，`openConsumerGroup()` 抛 `EAPP_UNSUPPORTED`
（TR-4：宁可明确失败，不静默降级）。规则是"谁拥有什么"只能在数据所在的一侧决定。

### 可选扩展：Channel 的服务者角色

同一个原则，另一处应用。request 模式假设**恰好一个**进程应答一个 Channel。
两个进程都跑 dispatcher 时，两个都会执行 handler，而重复的那条回复会被
correlation tracker 当作重复响应丢掉 —— 调用方看到的是一个完全正常的回答，
**副作用却发生了两次**。

```typescript
readonly sharesServerRole: boolean;
claimServerRole(channel: string): Promise<boolean>;    // 已被别人持有则 false
releaseServerRole(channel: string): Promise<void>;
```

角色由**连接**持有：服务方进程消失时角色自动归还，不需要任何人注意到 ——
和组认领在连接断开时释放是同一个机制。

> 两处扩展都是**可选的**，都不属于冻结的 v3.1 §10 接口。Transport 声明自己具备，
> 上层在存在时使用；不存在时不假装具备，而是走单进程的假设，或明确拒绝。

---

## 签名

```typescript
type Pattern = { readonly all: true } | { readonly type: string };

interface TransportMessage {
  cursor: Cursor;
  payload: unknown;
}

interface TransportCapabilities {
  persistent: boolean;
  ordering: 'none' | 'per-source' | 'global';
  delivery: { atMostOnce: boolean; atLeastOnce: boolean; replay: boolean };
  supportsCursor: boolean;
  supportsLease: boolean;
  /** E1-7：持久化存储的可见范围 */
  durabilityBoundary: 'process' | 'machine' | 'cluster' | 'global';
}

interface Transport {
  readonly id: string;
  readonly capabilities: TransportCapabilities;
  send(channel: string, msg: unknown): Promise<Cursor>;
  readAfter(channel: string, cursor: Cursor | undefined, pattern: Pattern): Promise<TransportMessage[]>;
  close(): Promise<void>;
  resolveAnchor?(channel: string, anchor: CursorAnchor): Promise<Cursor>;
  waitForChange?(channel: string, cursor: Cursor | undefined, signal?: AbortSignal): Promise<void>;
}

function validatePattern(pattern: Pattern): void;
function matchesPattern(value: unknown, pattern: Pattern): boolean;
function assertCapability(transport: Transport, feature: 'cursor' | 'lease'): void;
function assertDeclared(transport: Transport): void;
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | `string` | 是 | Transport 标识 |
| `capabilities` | `TransportCapabilities` | 是 | 能力自述；缺失字段按"不支持"处理（TR-3） |
| `send(channel, msg)` | `(string, unknown) => Promise<Cursor>` | 是 | 追加一条消息，由 Transport 分配游标（TR-8） |
| `readAfter(channel, cursor, pattern)` | 见上 | 是 | 返回严格大于 `cursor` 的消息，升序（TR-5 / TR-6 / TR-7） |
| `close()` | `Promise<void>` | 是 | 关闭；此后 `send()` 抛 `EAPP_UNSUPPORTED` |
| `resolveAnchor?(channel, anchor)` | 见上 | 否 | 解析 `'earliest'` / `'latest'`；`'earliest'` 可能抛 `EAPP_CURSOR_TOO_OLD` |
| `waitForChange?(channel, cursor, signal)` | 见上 | 否 | 可选推送；没有它时由订阅方按 `pollIntervalMs` 轮询 |
| `durabilityBoundary` | 四值联合 | 是 | 持久化边界的可见范围（E1-7）；状态一致性相对于它定义 |

Composition 边界（§11 / §12）同样是本页的签名面：

```typescript
interface CompositionToInteraction {
  onBindingCreated(binding: Binding): ChannelRef;
  onBindingActive(binding: Binding): void;
  onBindingDormant(binding: Binding): void;
  onBindingClosed(binding: Binding): void;
}

interface InteractionToComposition {
  channelRef(id: string): ChannelRef;
  channelState(id: string): ChannelState;
}

interface CreateChannelRequest {
  binding: string;               // Binding.id
  mode: ChannelMode;             // MUST 显式指定（CC-3）
  delivery?: DeliveryGuarantee;  // 省略时按 §4.4 推导（CC-4）
}

interface BindingSource {        // 本实现对本层的结构化视图，避免依赖具体 Core 类
  binding(id: string): { readonly id: string } | undefined;
  bindingState(id: string): 'ACTIVE' | 'DORMANT' | 'CLOSED';
  onBindingStateChange?(
    listener: (bindingId: string, state: 'ACTIVE' | 'DORMANT' | 'CLOSED') => void,
  ): () => void;
}
```

---

## 语义

**Transport 不定义交互语义**（TR-1）。它 `MUST NOT` 引入模式、投递保证、租约或游标策略 ——
这些分别属于 [`Channel`](./channel.md)、[`Delivery`](./delivery.md)、[`Lease`](./lease.md)、
[`Cursor`](./cursor.md)。它只做两件事：搬运消息、分配位置。
实现的一致性测试因此逐项断言 `mode` / `delivery` / `lease` / `cursor` 这些字段
`MUST NOT` 出现在 Transport 对象上。

**读写语义**（§10.1）：

```
TR-5  readAfter MUST 只返回 cursor 严格大于参数的消息
TR-6  cursor === undefined MUST 解释为"从最早已保留位置开始"
TR-7  readAfter 无匹配时 MUST 返回空数组，MUST NOT 阻塞
TR-8  send 返回的 cursor MUST 在该 Channel 内严格大于此前所有 cursor
```

**能力声明与检查**（§10.4）：

```
TR-2   Transport MUST 声明自己的能力
TR-3   Transport MUST NOT 伪装支持 —— 缺失的声明按"不支持"处理
TR-4   Channel MUST NOT 使用超出 Transport 能力的特性
TR-9  不支持时 MUST 返回 EAPP_UNSUPPORTED；不支持 cursor 时 MUST 返回 EAPP_CURSOR_UNSUPPORTED
```

**未覆盖点（本页登记）**：实现的 `assertCapability()` 只接受 `'cursor'` 与 `'lease'` 两个特性，
`assertDeclared()` 只检查 `persistent` 与 `ordering` 的类型。
因此 `capabilities.delivery` / `persistent` / `ordering` / `durabilityBoundary` 都没有 TR-4 意义上的
使用点守卫 —— 没有任何代码在创建 `at-least-once` Channel 时去看
`capabilities.delivery.atLeastOnce`。

**能力矩阵**（§10.3，规范性表格，此处照录）：

| Transport | persistent | ordering | atLeastOnce | replay | cursor | lease | durabilityBoundary |
|---|---|---|---|---|---|---|---|
| Memory | ❌ | global | ✅ | ❌ | ✅ | ✅ | `process` |
| Socket | ❌ | per-source | ✅ | ❌ | ✅ | ✅ | `machine` |
| Redis Streams | ✅ | global | ✅ | ✅ | ✅ | ✅ | `cluster` |
| NATS JetStream | ✅ | global | ✅ | ✅ | ✅ | ✅ | `cluster` |
| NATS Core | ❌ | per-source | ❌ | ❌ | ❌ | ❌ | `machine` |

**`durabilityBoundary` 的作用**（E1-7）：它回答"这条持久化的消息对谁可见"。
边界为 `'process'` 的 Transport（如 `MemoryTransport`）`MUST NOT` 被当作跨进程强一致的承载 ——
v3.2 的状态一致性就相对于这个边界定义。

**CC-1 … CC-9 —— Composition 与 Interaction 的边界。** 只有 `ChannelRef`（`id` + `binding`）
可以向上穿过这条边界：

```
① core.bind({ from, to, capability })                     → Binding      （v3.0）
② interaction.createChannel({ binding, mode, delivery? }) → Channel      （§12）
③ state.configure(channel, { conflictPolicy, owner })     → StateChannel （v3.2）
```

| ID | 规则 | 文本来源 |
|---|---|---|
| `CC-1` | Channel `MUST NOT` 独立于 Binding 存在 | 草案 §8.1（§0 判定为"未改变"），冻结版 §14 汇总 |
| `CC-2` | Binding `CLOSED` 时 Channel `MUST` 立即进入 `CLOSED` | 同上；实现按 §8.2 把它扩展为"双向派生"：`DORMANT` → `DRAINING`，恢复后回 `ACTIVE` |
| `CC-3` … `CC-9` | 见下表 | 冻结版 §12 |

`CC-1` / `CC-2` 的规则文本见 [§2.4](../spec/v3.1.0-interaction.md)；§14 把它们
与 `CC-3` … `CC-9` 一并列入冻结全集。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `TR-1` | Transport MUST NOT 定义 Interaction 语义 | `interaction.test.ts` › `'TR-1 / TR-2 / TR-3: a Transport carries no interaction semantics'` |
| `TR-2` | Transport MUST 声明自己的能力 | `interaction.test.ts` › `'TR-1 / TR-2 / TR-3: a Transport carries no interaction semantics'` |
| `TR-3` | Transport MUST NOT 伪装支持 | `interaction.test.ts` › `'TR-1 / TR-2 / TR-3: a Transport carries no interaction semantics'` |
| `TR-4` | Channel MUST NOT 使用超出 Transport 能力的特性 | `interaction.test.ts` › `'TR-4: using an undeclared feature is refused'` |
| `TR-5` | `readAfter` MUST 只返回 cursor 严格大于参数的消息 | `interaction.test.ts` › `'TR-5 / TR-6 / TR-7 / TR-8: read and write semantics'` |
| `TR-6` | `cursor === undefined` MUST 解释为"从最早已保留位置开始" | `interaction.test.ts` › `'TR-5 / TR-6 / TR-7 / TR-8: read and write semantics'` |
| `TR-7` | `readAfter` 无匹配时 MUST 返回空数组，MUST NOT 阻塞 | `interaction.test.ts` › `'TR-5 / TR-6 / TR-7 / TR-8: read and write semantics'` |
| `TR-8` | `send` 返回的 cursor MUST 在该 Channel 内严格大于此前所有 cursor | `interaction.test.ts` › `'TR-5 / TR-6 / TR-7 / TR-8: read and write semantics'` |
| `CC-1` | Channel MUST NOT 独立于 Binding 存在 | `interaction.test.ts` › `'CH-1 / CH-2 / CC-1 / CC-6 / CC-7: a Channel belongs to exactly one live Binding'` |
| `CC-2` | Binding CLOSED 时 Channel MUST 立即进入 CLOSED | `interaction.test.ts` › `'CC-2 / §8.2: a Channel follows its Binding through DORMANT and back'` |
| `CC-3` | `mode` MUST 由调用方显式指定 | `interaction.test.ts` › `'CC-3 / CC-8 / CC-9: creation, state and multiplicity'`（另有 `'CH-5 / CH-6 / CC-3: mode and delivery are fixed at creation'`） |
| `CC-4` | `delivery` 省略时：`stream` / `state` 推导为 `at-least-once`，其余为 `at-most-once` | `interaction.test.ts` › `'DL-3 / DL-4 / CC-4 / CC-5 / DL-6: mode determines the guarantee'` |
| `CC-5` | `stream` / `state` 指定 `at-most-once` MUST 返回 `EAPP_DELIVERY_UNSUPPORTED` | `interaction.test.ts` › `'DL-3 / DL-4 / CC-4 / CC-5 / DL-6: mode determines the guarantee'` |
| `CC-6` | `binding` 不存在 MUST 返回 `EAPP_BINDING_INVALID` | `interaction.test.ts` › `'CH-1 / CH-2 / CC-1 / CC-6 / CC-7: a Channel belongs to exactly one live Binding'` |
| `CC-7` | `binding` 已 CLOSED MUST 返回 `EAPP_BINDING_CLOSED` | `interaction.test.ts` › `'CH-1 / CH-2 / CC-1 / CC-6 / CC-7: a Channel belongs to exactly one live Binding'` |
| `CC-8` | Channel 创建后处于 `OPEN`；`connect()` 后进入 `ACTIVE` | `interaction.test.ts` › `'CC-3 / CC-8 / CC-9: creation, state and multiplicity'` |
| `CC-9` | 一个 Binding MAY 派生多个 Channel，各自 `mode` 不同 | `interaction.test.ts` › `'CC-3 / CC-8 / CC-9: creation, state and multiplicity'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_UNSUPPORTED` | `assertDeclared()` 面对缺失能力声明的 Transport（TR-3）；`assertCapability(t, 'lease')` 而 `supportsLease === false`（TR-4 / TR-9）；`send()` 已关闭的 Transport | `false` |
| `EAPP_CURSOR_UNSUPPORTED` | `assertCapability(t, 'cursor')` 而 `supportsCursor === false`（CR-5 / TR-9） | `false` |
| `EAPP_CHANNEL_INVALID` | `validatePattern()` 收到非法 `Pattern`（不是对象、字段数不为 1、`all` 不为 `true`、`type` 不是字符串、未知字段）；`channelRef()` / `channelState()` 按不存在的 id 查询 | `false` |
| `EAPP_MODE_INVALID` | `createChannel({ mode })` 的 `mode` 不属于四种冻结模式 | `false` |
| `EAPP_DELIVERY_UNSUPPORTED` | `createChannel()` 为 `stream` / `state` 指定 `at-most-once`（CC-5 / DL-6） | `false` |
| `EAPP_BINDING_INVALID` | `binding` 不存在（CC-6；仅在提供了 `BindingSource` 时强制） | `false` |
| `EAPP_BINDING_CLOSED` | `binding` 已 `CLOSED`（CC-7；同上） | `false` |
| `EAPP_CURSOR_TOO_OLD` | `resolveAnchor(channel, 'earliest')` 在日志已压缩时无法定位最早位置（§6.2 规则 6）。`MemoryTransport` 保留无界，永不抛 —— **未覆盖** | `false` |
| `EAPP_CURSOR_INVALID` | §13 声明了该码，实现中没有任何抛出点 —— **未覆盖** | `false` |

`retryable` 取 `EappError` 的默认值（本层的码不在 `RETRYABLE_CODES` 中）。

---

## 示例

```typescript
import {
  InteractionLayerImpl,
  assertCapability,
  assertDeclared,
  compareCursor,
  validatePattern,
} from '@eapp/interaction';
import type { BindingSource, Cursor, Transport } from '@eapp/interaction';
import { MemoryTransport } from '@eapp/transport-memory';
import { expect } from 'vitest';

const transport = new MemoryTransport();
assertDeclared(transport);                                  // TR-2 / TR-3
expect(transport.capabilities.durabilityBoundary).toBe('process');   // E1-7

const first = await transport.send('room', { type: 'job' });
const second = await transport.send('room', { type: 'log' });
expect(compareCursor(second, first)).toBeGreaterThan(0);    // TR-8

expect(await transport.readAfter('room', first, { all: true })).toHaveLength(1);      // TR-5
expect(await transport.readAfter('room', undefined, { all: true })).toHaveLength(2);  // TR-6
expect(await transport.readAfter('room', second, { all: true })).toEqual([]);         // TR-7

// TR-4 / TR-9：不支持的特性必须显式失败，而不是静默降级
const noCursor: Transport = {
  id: 'no-cursor',
  capabilities: { ...transport.capabilities, supportsCursor: false, supportsLease: false },
  send: async () => 'c0' as Cursor,
  readAfter: async () => [],
  close: async () => undefined,
};
expect(() => assertCapability(noCursor, 'cursor')).toThrow('EAPP_CURSOR_UNSUPPORTED');
expect(() => assertCapability(noCursor, 'lease')).toThrow('EAPP_UNSUPPORTED');

// Pattern 由 Transport 在读取时应用（§10.1）
validatePattern({ type: 'job' });
expect(() => validatePattern({ all: false } as never)).toThrow('EAPP_CHANNEL_INVALID');
expect(await transport.readAfter('room', undefined, { type: 'job' })).toHaveLength(1);

// CC-1 / CC-3 / CC-6 / CC-8 / CC-9：Channel 由 Binding 派生
const bindings: BindingSource = {
  binding: (id) => (id === 'b1' ? { id } : undefined),
  bindingState: (id) => (id === 'b1' ? 'ACTIVE' : 'CLOSED'),
};
const interaction = new InteractionLayerImpl({ transport, bindings });

const channel = await interaction.createChannel({ binding: 'b1', mode: 'event' });
expect(channel.state).toBe('OPEN');                         // CC-8
expect(interaction.channelRef(channel.id)).toEqual({ id: channel.id, binding: 'b1' });
expect((await interaction.createChannel({ binding: 'b1', mode: 'request' })).id).not.toBe(channel.id); // CC-9
await expect(
  interaction.createChannel({ binding: 'nope', mode: 'event' }),
).rejects.toThrow('EAPP_BINDING_INVALID');                  // CC-6
```

---

## 相关

- [`Channel`](./channel.md) —— 由 Binding 派生、受能力约束的交互载体
- [`Cursor`](./cursor.md) —— 游标由 Transport 分配；CR-5 要求显式报告不支持
- [`Subscription`](./subscription.md) —— `SubscriptionSource` 通常由 Transport 适配而来
- [`ConsumerGroup`](./consumer-group.md) —— 需要 `supportsLease` 的竞争消费
- [`Delivery`](./delivery.md) —— `capabilities.delivery` 的声明与 TR-4 之间的缺口
- [概念：三层心智模型](../guides/concepts.md) —— Transport 在"谁和谁组合 / 如何互动 / 如何共享状态"里的位置

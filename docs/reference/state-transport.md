# `StateTransport`

> v3.1 `Transport` 的扩展：除了消息怎么走，还要回答**状态存在哪里、位置由谁签发、位置之间怎么比较**。

| | |
|---|---|
| **层** | v3.2 State Mode |
| **规范** | [v3.2.0-state §11, §12](../spec/v3.2.0-state.md) |
| **实现** | [`packages/state/src/state-transport.ts`](../../packages/state/src/state-transport.ts) · [`packages/transport/memory/src/memory-transport.ts`](../../packages/transport/memory/src/memory-transport.ts) |
| **测试** | [`tests/conformance/state.test.ts`](../../tests/conformance/state.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface StateTransportCapabilities extends TransportCapabilities {
  supportsState: boolean;
  supportsStateRevision: boolean;
  supportsStateWatch: boolean;
  supportsStateSnapshot: boolean;
  stateConsistency: 'strong' | 'eventual';
  stateRetention: { kind: 'unbounded' } | { kind: 'window'; entries: number };
}

interface StateTransport extends Transport {
  readonly capabilities: StateTransportCapabilities;

  getState(channel: string, key: string): Promise<StateCell | null>;
  listState(channel: string, pattern: StatePattern): Promise<StateCell[]>;
  head(channel: string): Promise<Revision>;

  setStateWithCAS(channel: string, update: StateUpdate, actor: Identity): Promise<Revision>;
  deleteStateWithCAS(
    channel: string, key: string, expectedRevision: ExpectedRevision, actor: Identity,
  ): Promise<Revision>;

  readChangesAfter(
    channel: string, cursor: Cursor | undefined, pattern: StatePattern,
  ): Promise<StateChange[]>;

  nextRevision(channel: string): Promise<Revision>;
  compareRevision(a: Revision, b: Revision): number;
  writeStateWithRevision(
    channel: string, key: string, value: unknown,
    deleted: boolean, revision: Revision, actor: Identity,
  ): Promise<void>;

  waitForChange?(channel: string, cursor: Cursor | undefined, signal?: AbortSignal): Promise<void>;
}

// 能力闸门（TS-2）：每个标志恰好一个运行时后果
type StateCapability = 'state' | 'revision' | 'watch' | 'snapshot';
function assertStateCapability(transport: StateTransport, feature: StateCapability): void;
```

| 成员 | 含义 |
|---|---|
| `capabilities` | state 能力声明，与 v3.1 的 `TransportCapabilities` 合并为一个对象 |
| `getState` / `listState` | 后像读取；`listState` 按 `key` 字典序排序 |
| `head` | 状态日志的当前末尾；空 Channel MUST 返回**可比较**的初始值（TS-14） |
| `setStateWithCAS` | 比较 + 写入，**原子**（TS-6 / SU-7） |
| `deleteStateWithCAS` | 一等原语，**不是** `set({deleted:true})` 的语法糖（§6.1） |
| `readChangesAfter` | 变更**流**；严格升序、严格大于 cursor、不阻塞（TS-9 / TS-10 / TS-12） |
| `nextRevision` | 预留一个严格大于 `head` 的位置（TS-15） |
| `compareRevision` | 位置比较；外来 revision MUST 抛 `EAPP_REVISION_INVALID`（REV-8） |
| `writeStateWithRevision` | 内部钉定写入；收到 `<= head` MUST 抛 `EAPP_REVISION_INVALID`（§5.5a） |
| `waitForChange`（可选） | 阻塞到 cursor 之后出现变更或 `signal` 中止；未实现时由轮询替代（§7.5） |

---

## 语义

### 1. 它仍然是一个 Transport（TS-7 / IX-4）

`StateTransport extends Transport`：`send` / `readAfter` / `close` / `id` / `capabilities` 全部保留。
State Mode 不替换 v3.1 的传输模型，只是要求它额外提供存储与位置能力。参考的 `MemoryTransport`
同时实现两层接口，`send` 与状态写入**共用同一个位置分配器**——这是 `Revision` 与 `Cursor` 同域
（§2.2 C-1）在实现上的落点。

### 2. 寻址按 `(channel, key)` 二元组（TS-13）

```
TS-13  寻址 MUST 按 (channel, key) 二元组；MUST NOT 把二者拼接为单一字符串。
```

用 `` `${channel}:${key}` `` 作 map key 会让 `(channel="a", key="b:c")` 与
`(channel="a:b", key="c")` 命中同一个 cell，造成跨 channel 污染。参考实现用**嵌套 map**
（`channel -> key -> cell`）而不是扁平字符串键。

### 3. 变更流，而不是后像数组

`readChangesAfter` 取代了 r2 的 `readStateAfter`：后者返回 `StateCell[]`（当前值），**无法表达同一 key 的
两次变更**，中间的变更永久丢失，cursor 语义因此不可实现。返回变更流才能让"独立 cursor + per-update
ack + 删除事件可观察"三者同时成立。

```
TS-9   readChangesAfter MUST 按 revision 严格升序返回
TS-10  readChangesAfter MUST 只返回 revision 严格大于 cursor 的变更（不含 cursor 本身）
TS-11  cursor === undefined MUST 解释为"从最早已保留位置开始"
TS-12  readChangesAfter 无匹配时 MUST 返回空数组，MUST NOT 阻塞
TS-14  head 在 Channel 尚无任何变更时 MUST 返回一个可比较的初始 revision
TS-15  nextRevision MUST 返回一个严格大于当前 head 的位置
```

### 4. 能力闸门：每个标志恰好一个运行时后果（§12.2 / TS-2）

| 标志 | `false` 时的强制行为 |
|---|---|
| `supportsState` | `get` / `list` / `set` / `delete` / `snapshot` / `restore` / `watch` 全部抛 `EAPP_STATE_UNSUPPORTED` |
| `supportsStateRevision` | `set` / `delete` / `restore` 抛 `EAPP_STATE_UNSUPPORTED`（CAS 不可能成立）；`get` / `list` 仍可用 |
| `supportsStateWatch` | `watch()` 抛 `EAPP_WATCH_UNSUPPORTED` |
| `supportsStateSnapshot` | `snapshot()` / `restore()` 抛 `EAPP_UNSUPPORTED` |

```
TS-1  Transport MUST declare state capabilities
TS-2  Each capability flag MUST have exactly one mandated runtime consequence,
      enforced at the earliest possible call, synchronously where the API is synchronous
TS-3  MUST NOT fake support
```

`TS-3` 是这一节的立场：声明 `supportsStateWatch: true` 却不实现 `readChangesAfter`，或声明
`supportsStateRevision: true` 却给不出全序，都是**假声明**——而闸门表的存在使得假声明必然在第一次
相关调用上暴露。r2 草案声明了四个标志却一个都不检查。

### 5. 一致性能力收紧（§12.3 / TS-4 / TS-5）

```
providesStateRevision === true   ⟺  Revision 在 Channel 内构成全序且单调
supportsStateRevision === false  ⟹  MUST NOT 用于 CAS

TS-4  A Transport whose revision ordering is not total per channel MUST declare
      supportsStateRevision = false, MUST declare stateConsistency = 'eventual',
      and MUST NOT claim CAS support.
TS-5  A Transport MUST NOT declare stateConsistency = 'strong' beyond its durabilityBoundary.
```

> 上段按 §12.3 原文照录，其中 `providesStateRevision` 是遗留的写法；`StateTransportCapabilities`
> 上的字段名是 `supportsStateRevision`（§12.1 明确指出命名与 v3.1 对齐：`supports*`，非 `provides*`）。

r2 给 CRDT 加了"eventual 的 revision + CAS 共存"的豁免，那等于允许一个**会静默丢更新**的 CAS——
CAS 的正确性就建立在全序之上。本版本取消豁免，改为收紧能力标志：排序不全序 → 必须声明
`supportsStateRevision = false` 且 `stateConsistency = 'eventual'`，于是 CAS 自动不可用。

### 6. 能力矩阵（§12.4）

| Transport | state | revision | watch | snapshot | consistency | durabilityBoundary |
|---|---|---|---|---|---|---|
| Memory | ✅ | ✅ | ✅ | ✅ | strong | process |
| Socket | ❌ | ❌ | ❌ | ❌ | — | machine |
| Redis | ✅ | ✅ | ✅ | ✅ | strong | cluster |
| NATS KV | ✅ | ✅ | ✅ | ✅ | strong | cluster |
| CRDT | ✅ | ❌ | ✅ | ❌ | eventual | global |

CRDT 行的 `revision` 与 `snapshot` 是 ❌：其 revision 非全序，故 `supportsStateRevision = false`，
CAS 不可用；而 `restore` 依赖 `nextRevision`，故 snapshot 亦不可用。CRDT 的冲突合并策略属于 Extension。

### 7. 参考实现：`MemoryTransport`

| 事实 | 值 |
|---|---|
| 能力 | 四个 `supports*State*` 全为 `true`；`stateConsistency: 'strong'`；`stateRetention: { kind: 'unbounded' }`；`durabilityBoundary: 'process'` |
| 位置形状 | `mem-<n>!<16 位零填充十进制>`。固定宽度不是装饰：它让字典序等于数值序，`compareRevision` 因此可以是一次字符串比较 |
| 初始哨兵 | `''`（`BEGINNING`），排序早于任何已分配位置，表示"最早已保留位置之前"；它同时是 `TS-14` 的空 Channel 初始值 |
| `head` 与 anchor 分离 | `#heads` 只被状态写入推进（`snapshot` 依赖它），`#anchors` 被消息与状态写入共同推进（`'latest'` 订阅位置需要它）——两者混用会让 `head` 被普通消息污染 |
| CAS 原子性 | 整个判定与写入位于**一个不含 `await` 的同步块**内 | 
| 日志压缩 | 未实现（`unbounded`）。`EAPP_CURSOR_TOO_OLD` 在参考实现中**没有产生点**，已在[一致性声明](../CONFORMANCE.md)第 6 节登记 |

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `TS-1` | Transport MUST declare state capabilities | `state.test.ts` › `'TS-1 / TS-2 / TS-3 / TS-7 / TS-8: capabilities are declared and honoured'` |
| `TS-2` | Each capability flag MUST have exactly one mandated runtime consequence | `state.test.ts` › `'TS-2 / TS-11: a transport that cannot order revisions cannot do CAS'` |
| `TS-3` | MUST NOT fake support | `state.test.ts` › `'TS-3: watch is refused when the transport cannot watch'` |
| `TS-4` | Non-total revision ordering MUST declare `supportsStateRevision = false` | `state.test.ts` › `'TS-4: non-total revision ordering must be declared eventual'` |
| `TS-5` | `stateConsistency` MUST NOT exceed `durabilityBoundary` | `state.test.ts` › `'TS-5: strong consistency is not claimed beyond the durability boundary'` |
| `TS-6` | CAS MUST be implemented atomically in Transport | `state.test.ts` › `'SU-7 / TS-6: CAS is atomic under concurrency'` |
| `TS-7` | `StateTransport` MUST extend `Transport` | `state.test.ts` › `'TS-1 / TS-2 / TS-3 / TS-7 / TS-8: capabilities are declared and honoured'` |
| `TS-8` | Revision comparison MUST be provided by Transport | `state.test.ts` › `'TS-1 / TS-2 / TS-3 / TS-7 / TS-8: capabilities are declared and honoured'` |
| `TS-9` | `readChangesAfter` MUST return changes in strictly ascending revision order | `state.test.ts` › `'TS-9 / TS-10 / TS-12 / TS-14 / TS-15: change-stream semantics'` |
| `TS-10` | `readChangesAfter` MUST return only revisions strictly greater than the cursor | `state.test.ts` › `'TS-9 / TS-10 / TS-12 / TS-14 / TS-15: change-stream semantics'` |
| `TS-11` | `cursor === undefined` MUST mean "from the earliest retained position" | `state.test.ts` › `'TS-2 / TS-11: a transport that cannot order revisions cannot do CAS'` |
| `TS-12` | `readChangesAfter` MUST NOT block | `state.test.ts` › `'TS-9 / TS-10 / TS-12 / TS-14 / TS-15: change-stream semantics'` |
| `TS-13` | Addressing MUST use the `(channel, key)` pair, never string concatenation | `state.test.ts` › `'TS-13: distinct (channel, key) pairs never collide'` |
| `TS-14` | `head` MUST return a comparable initial revision for an empty channel | `state.test.ts` › `'TS-9 / TS-10 / TS-12 / TS-14 / TS-15: change-stream semantics'` |
| `TS-15` | `nextRevision` MUST return a position strictly greater than the current head | `state.test.ts` › `'TS-9 / TS-10 / TS-12 / TS-14 / TS-15: change-stream semantics'` |

关于 `TS-11` 的测试归属：该 ID 由 `'TS-2 / TS-11: a transport that cannot order revisions cannot do CAS'`
承载（不变量闸门按测试标题中的 ID 求集合差）。`cursor === undefined` 这一路径的实际行使在
`'TS-9 / TS-10 / TS-12 / TS-14 / TS-15: change-stream semantics'` 中
（`readChangesAfter(ch.id, undefined, { all: true })` 返回全部变更）。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_STATE_UNSUPPORTED` | `supportsState === false`；或 `supportsStateRevision === false` 而调用 `set` / `delete` / `restore` | `false` |
| `EAPP_WATCH_UNSUPPORTED` | `supportsStateWatch === false` 而调用 `watch()`（TS-2 的 watch 闸门） | `false` |
| `EAPP_UNSUPPORTED` | `supportsStateSnapshot === false` 而调用 `snapshot()` / `restore()`；或 Transport 已 `close()` | `false` |
| `EAPP_REVISION_INVALID` | `compareRevision` 收到外来 revision（REV-8）；`writeStateWithRevision` 收到 `<= head` 的 revision | `false` |
| `EAPP_REVISION_CONFLICT` | `setStateWithCAS` / `deleteStateWithCAS` 的 CAS 前提不成立（§5.2 / §6.2） | `true` |
| `EAPP_STATE_KEY_NOT_FOUND` | `deleteStateWithCAS` 遇到从未存在的 key 且 `expectedRevision === null`（DEL-4） | `false` |
| `EAPP_STATE_KEY_INVALID` / `EAPP_STATE_VALUE_INVALID` / `EAPP_STATE_PATTERN_INVALID` | `setStateWithCAS` 经 `StateChannel` 透传的字段校验错误（§5.3 / §8） | `false` |
| `EAPP_CURSOR_TOO_OLD` | 日志已压缩到无法定位请求位置（v3.1 既有码）。参考实现保留全部日志，因此**没有产生点** | `false` |

---

## 示例

```typescript
import { expect } from 'vitest';
import type { Identity } from '@eapp/core';
import { InteractionLayerImpl } from '@eapp/interaction';
import { configureStateChannel } from '@eapp/state';
import { MemoryTransport } from '@eapp/transport-memory';

const owner: Identity = { domain: 'e2e', id: 'owner', instance: 'owner-1' };
const transport = new MemoryTransport();
const interaction = new InteractionLayerImpl({ transport });
const channel = await interaction.createChannel({
  binding: 'b1',
  mode: 'state',
  delivery: 'at-least-once',
});
const ch = configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner });

// TS-1 / TS-5 / TS-7 / TS-8：能力声明与实际形状
expect(transport.capabilities.supportsState).toBe(true);
expect(transport.capabilities.stateConsistency).toBe('strong');
expect(transport.capabilities.durabilityBoundary).toBe('process');
expect(typeof transport.send).toBe('function');            // TS-7：仍然是 v3.1 Transport
expect(typeof transport.compareRevision).toBe('function'); // TS-8

// TS-14：空 Channel 也要有可比较的初始 revision
expect(await transport.head(ch.id)).toBe('');

// TS-9 / TS-10 / TS-11 / TS-12 / TS-15：变更流语义
const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
const r2 = await ch.set({ key: 'k', value: 2, expectedRevision: r1 });
expect((await transport.readChangesAfter(ch.id, undefined, { all: true })).map((c) => c.revision))
  .toEqual([r1, r2]);                                      // TS-9 / TS-11：两次写入都在，且保序
expect((await transport.readChangesAfter(ch.id, r1, { all: true })).map((c) => c.revision))
  .toEqual([r2]);                                          // TS-10：严格大于
await expect(transport.readChangesAfter(ch.id, r2, { all: true })).resolves.toEqual([]); // TS-12
expect(transport.compareRevision(await transport.nextRevision(ch.id), r2)).toBeGreaterThan(0); // TS-15

// TS-13：两个 channel 上的相邻字符串不会碰撞
const b = configureStateChannel(
  await interaction.createChannel({ binding: 'b', mode: 'state', delivery: 'at-least-once' }),
  transport,
  { conflictPolicy: 'cas', owner },
);
await b.set({ key: 'c', value: 'from-b', expectedRevision: null });
expect(await b.get('b:c')).toBeNull(); // r2 的 `${channel}:${key}` 会让二者变成同一个 cell

// TS-2：能力标志恰好一个运行时后果 —— 用一致性测试的 cripple 手法关闭 revision 支持
const crippled = new MemoryTransport();
(crippled as unknown as { capabilities: unknown }).capabilities = {
  ...crippled.capabilities,
  supportsStateRevision: false,
};
const crippledCh = configureStateChannel(
  await new InteractionLayerImpl({ transport: crippled }).createChannel({
    binding: 'b2',
    mode: 'state',
    delivery: 'at-least-once',
  }),
  crippled,
  { conflictPolicy: 'cas', owner },
);
await expect(crippledCh.set({ key: 'k', value: 1, expectedRevision: null })).rejects.toThrow(
  'EAPP_STATE_UNSUPPORTED', // CAS 不可能成立
);
await expect(crippledCh.get('k')).resolves.toBeNull(); // 读取仍然可用
```

---

## 相关

- [`Revision`](./revision.md) —— `head` / `nextRevision` / `compareRevision` 的语义
- [`StateCell`](./state-cell.md) —— `getState` / `listState` 返回什么
- [`StateWatcher`](./state-watcher.md) —— 谁消费 `readChangesAfter` 与 `waitForChange`
- [`StateSnapshot`](./state-snapshot.md) —— `head` / `listState` / `nextRevision` 如何组成一致性快照
- [`StateChannel`](./state-channel.md) —— 能力闸门在操作面上的落点
- [一致性声明](../CONFORMANCE.md) —— 参考实现的能力声明、已登记的偏离与尚未实现项（CRDT、日志压缩、跨进程 Transport）

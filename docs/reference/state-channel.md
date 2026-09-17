# `StateChannel`

> State Mode 的操作面：在**一个** mode 为 `'state'` 的 v3.1 `Channel` 上读写 cell、观察变更、取快照。

| | |
|---|---|
| **层** | v3.2 State Mode |
| **规范** | [v3.2.0-state §6, §10](../spec/v3.2.0-state.md) |
| **实现** | [`packages/state/src/state-channel.ts`](../../packages/state/src/state-channel.ts) |
| **测试** | [`tests/conformance/state.test.ts`](../../tests/conformance/state.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface StateChannel extends Channel {
  readonly mode: 'state';

  get(key: string): Promise<StateCell | null>;
  list(pattern: StatePattern): Promise<StateCell[]>;
  set(update: StateUpdate): Promise<Revision>;
  delete(key: string, expectedRevision: ExpectedRevision, options?: { actor?: Identity }): Promise<Revision>;
  watch(pattern: StatePattern, options?: WatchOptions): Promise<StateWatcher>;
  snapshot(pattern: StatePattern): Promise<StateSnapshot>;
  restore(snapshot: StateSnapshot, options?: { mode?: RestoreMode }): Promise<void>;
}

function configureStateChannel(
  channel: Channel,
  transport: StateTransport,
  config: StateChannelConfig,
): StateChannel;
```

`StateChannel` 是 `Channel` 的**收窄视图**（IX-6 / CF-5），不是包装类型：`id` / `binding` / `delivery` /
`state` 直接读到被包装的 Channel 对象上，因此 Channel 的生命周期（`OPEN → ACTIVE → DRAINING → CLOSED`）
在组合层依然可观察，不会被一份副本遮蔽。实现另暴露 `channel` 与 `config` 两个只读访问器。

`Channel` 的既有成员（v3.1 §2.1）：`id`、`binding`、`mode`、`delivery`、`state`。

| 操作 | 返回 |
|---|---|
| `get` | `StateCell`，或 `null`（**仅当 key 从未存在**） |
| `list` | `StateCell[]`，按 `key` 字典序稳定排序，含已删除的 cell |
| `set` | 新 [`Revision`](./revision.md) |
| `delete` | 操作完成后该 key 的**当前** revision（§6.4） |
| `watch` | `Promise<StateWatcher>`（见 §10.2 注；已登记偏离 D-1） |
| `snapshot` | read-consistent 快照 |
| `restore` | `void` |

---

## 语义

### 1. 创建：三条路径（§10.1）

```typescript
// ① v3.0 Composition Core
const binding: Binding = await core.bind({ from, to, capability });

// ② v3.1 Interaction Layer
const channel: Channel = await interaction.createChannel({
  binding: binding.id,
  mode: 'state',
  delivery: 'at-least-once',
});

// ③ v3.2 State Mode
const ch: StateChannel = configureStateChannel(channel, transport, {
  conflictPolicy: 'cas',
  owner: identity,
});
```

`configureStateChannel` MUST 校验全部前置条件，MUST NOT 留到第一次使用时才以含混的 Transport 错误暴露：

| 前置条件 | 不满足时 |
|---|---|
| `channel.mode === 'state'` | `EAPP_MODE_INVALID` |
| `channel.delivery === 'at-least-once'` | `EAPP_DELIVERY_UNSUPPORTED` |
| `transport.capabilities.supportsState` | `EAPP_STATE_UNSUPPORTED` |
| `config.conflictPolicy === 'cas'` | `EAPP_UNSUPPORTED`（CF-1） |
| `config.owner` 已提供 | `EAPP_STATE_ACTOR_REQUIRED`（SC-5） |

### 2. `delete` 是一等原语（§6.1）

```
delete MUST 由 Transport 的一等原语实现，
MUST NOT 被实现为 set({ deleted: true }) 的语法糖。
```

理由不是风格：若 `delete()` 被实现成 `set({deleted:true})`，Transport 就**无法区分"删除"与"创建"**，
`EAPP_STATE_KEY_NOT_FOUND` 于是**结构上不可产生**——而 `DEL-4` 要求它存在。参考实现因此把
`deleteStateWithCAS` 作为 `StateTransport` 的独立原语。

### 3. 删除的边界情况（§6.2 完整表）

| key 当前状态 | `expectedRevision` | 结果 |
|---|---|---|
| 从未存在 | `null` | `EAPP_STATE_KEY_NOT_FOUND` |
| 从未存在 | `Revision` | `EAPP_REVISION_CONFLICT` |
| 存在，未删除（rev = r） | `null` | `EAPP_REVISION_CONFLICT` |
| 存在，未删除（rev = r） | `r` | 成功；分配新 revision；产生 `deleted` 变更 |
| 存在，未删除 | `r' ≠ r` | `EAPP_REVISION_CONFLICT` |
| 已删除（rev = r） | `null` | `EAPP_REVISION_CONFLICT` |
| 已删除（rev = r） | `r` | **no-op 成功** |
| 已删除 | `r' ≠ r` | `EAPP_REVISION_CONFLICT` |

两处尤其容易写错：

- **`expectedRevision: null` 表示"从未存在"，不是"当前不存在"。** 逻辑删除过的 key **仍然算存在**，
  因此 `null` 不能把它复活；复活 MUST 携带旧 revision。§5.2 把"`null` = 从未存在"写成硬约束
  （F-01 的关闭点），也正是 r2 草案把两种读法混在一起时自相矛盾的地方。
- **同一个"key 不存在"会因 `expectedRevision` 的形状给出两个不同错误码。** 删除一个从未存在的 key：
  传 `null` → `EAPP_STATE_KEY_NOT_FOUND`；传任意 revision → `EAPP_REVISION_CONFLICT`。
  这不是不一致，而是两种主张的失败：前者是"我要创建一个全新的 key"（不成立：这是删除），
  后者是"我认为它当前是这个版本"（不成立：它根本没有版本）。

### 4. no-op 语义与返回值（§6.3 / §6.4）

```
删除一个"已删除"的 key 且 revision 匹配时：
  MUST NOT 分配新 revision
  MUST NOT 产生 type='deleted' 变更
  MUST NOT 通知 StateWatcher

delete 的返回值 MUST 恒等于操作完成后 key 的当前 revision：
  → 成功删除：返回新 revision
  → no-op：   返回旧 revision
```

no-op 返回**旧** revision 而不是"什么都不返回"，是为了让返回值保持统一：调用方总能把返回值当作
该 key 的当前版本继续使用。

### 5. 可见性与排序（§4.2 / §10.3）

`get` 与 `list` MUST 返回已逻辑删除的 cell，MUST NOT 因 `deleted` 而返回 `null`（SC-6 / API-1 / API-2）。
`list` MUST 按 `key` 字典序稳定排序。这条可见性规则是 `DEL-5` 的 no-op 分支与 `DEL-6` 的复活能够
实现的前提——调用方必须能拿到已删除 cell 的 `revision`。

### 6. 分层隔离（IX-1 … IX-4, IX-6）

```
IX-1  State Mode MUST NOT modify, remove or retype any existing member of any v3.0 or v3.1 type
IX-2  State Mode MUST reuse v3.1 Subscription / Cursor / AckContext semantics
IX-3  State Mode MUST NOT introduce new primitives into Channel
IX-4  StateTransport MUST extend v3.1 Transport
IX-6  StateChannel MUST be a narrowing view of Channel
```

（`IX-5` 已按 R-1 删除：`ChannelMode` 从未被扩展。）

具体地：`Channel` 上 MUST NOT 出现 `get` / `set` / `list` / `watch` / `snapshot` / `restore` / `revision`
中的任何一个；`mode` 的取值域 MUST NOT 因为 State Mode 而改变；State Mode 新增的操作只出现在
`StateChannel` 上。观察侧同理——事件用的是 v3.1 的 `Cursor` 与 `AckContext`，不是 State Mode 自造的
形状（IX-2）。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `DEL-1` | `delete` MUST perform CAS | `state.test.ts` › `'DEL-1 / DEL-2 / DEL-3 / SW-8: delete is a CAS that produces an observable deleted change'` |
| `DEL-2` | A successful delete MUST produce a `type='deleted'` change（no-op 除外） | `state.test.ts` › `'DEL-1 / DEL-2 / DEL-3 / SW-8: delete is a CAS that produces an observable deleted change'` |
| `DEL-3` | `StateWatcher` MUST receive deleted changes | `state.test.ts` › `'DEL-1 / DEL-2 / DEL-3 / SW-8: delete is a CAS that produces an observable deleted change'` |
| `DEL-4` | `delete` with `expectedRevision = null` on a never-existing key MUST return `EAPP_STATE_KEY_NOT_FOUND` | `state.test.ts` › `'DEL-4: deleting a never-existing key with null reports KEY_NOT_FOUND'` |
| `DEL-5` | `delete` of an already-deleted key with matching revision MUST be a no-op success | `state.test.ts` › `'DEL-5: deleting an already-deleted key is a true no-op'` |
| `DEL-6` | `delete` followed by `set` MUST increment revision and clear the `deleted` flag | `state.test.ts` › `'SC-3 / DEL-6: delete preserves the counter and a later set clears the flag'` |
| `API-1` | `get` MUST return the current cell (including deleted) or `null` | `state.test.ts` › `'SC-6 / API-1 / API-2: get and list include logically-deleted cells'` |
| `API-2` | `list` MUST return matching cells (including deleted), sorted by key | `state.test.ts` › `'SC-6 / API-1 / API-2: get and list include logically-deleted cells'` |
| `API-3` | `set` MUST return the new revision | `state.test.ts` › `'API-3 / API-4 / API-9: return values and pattern validation'` |
| `API-4` | `delete` MUST return the key's current revision after the operation | `state.test.ts` › `'API-3 / API-4 / API-9: return values and pattern validation'` |
| `API-5` | `watch` MUST return a v3.1-compatible `Subscription`（awaited） | `state.test.ts` › `'SW-1 / SW-2 / SW-3 / SUB-9 / API-5: watch returns a v3.1-compatible Subscription'` |
| `API-6` | `snapshot` MUST be read-consistent | `state.test.ts` › `'SNAP-1 / SNAP-2 / SNAP-3 / API-6 / API-7: head is read before the cells'` |
| `API-7` | `snapshot` MUST include `maxRevision` | `state.test.ts` › `'SNAP-1 / SNAP-2 / SNAP-3 / API-6 / API-7: head is read before the cells'` |
| `API-8` | `restore` MUST overwrite the state covered by `snapshot.pattern` | `state.test.ts` › `'SNAP-4 / SNAP-5 / SNAP-6 / API-8: restore allocates fresh revisions in order'`；`'SNAP-9 / API-8: replace mode deletes cells outside the snapshot'` |
| `API-9` | `StatePattern` MUST be a union type | `state.test.ts` › `'API-3 / API-4 / API-9: return values and pattern validation'` |
| `IX-1` | State Mode MUST NOT modify／remove／retype any existing member of any v3.0 or v3.1 type | `state.test.ts` › `'IX-1 / IX-3: no v3.0 or v3.1 type gained a state member'` |
| `IX-2` | State Mode MUST reuse v3.1 `Subscription` / `Cursor` / `AckContext` semantics | `state.test.ts` › `'IX-2: state observation reuses the v3.1 Cursor and AckContext'` |
| `IX-3` | State Mode MUST NOT introduce new primitives into `Channel` | `state.test.ts` › `'IX-1 / IX-3: no v3.0 or v3.1 type gained a state member'` |
| `IX-4` | `StateTransport` MUST extend v3.1 `Transport` | `state.test.ts` › `'IX-4: a StateTransport is still a v3.1 Transport'` |
| `IX-6` | `StateChannel` MUST be a narrowing view of `Channel` | `state.test.ts` › `'CF-1 / CF-4 / CF-5 / IX-6: configuration is validated and the view is not a wrapper'` |

§6.2 的八行边界表另有一个逐行断言的测试：
`state.test.ts` › `'DEL: the full §6.2 edge-case table'`（该测试标题不含不变量 ID）。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_STATE_KEY_NOT_FOUND` | 删除一个从未存在的 key，且 `expectedRevision === null`（DEL-4） | `false` |
| `EAPP_REVISION_CONFLICT` | CAS 前提不成立：key 已存在而用了 `null`、key 不存在却给了 revision、或 revision 不匹配（§5.2 / §6.2） | `true` |
| `EAPP_STATE_KEY_INVALID` | `get` / `delete` 的 key 不是非空字符串（SC-1） | `false` |
| `EAPP_STATE_PATTERN_INVALID` | `list` / `watch` / `snapshot` 的 pattern 校验失败（§8） | `false` |
| `EAPP_MODE_INVALID` | `configure` 时 `channel.mode !== 'state'`（v3.1 既有码） | `false` |
| `EAPP_DELIVERY_UNSUPPORTED` | `configure` 时 `channel.delivery !== 'at-least-once'`（v3.1 既有码） | `false` |
| `EAPP_STATE_UNSUPPORTED` | 能力闸门：`supportsState === false`，或 `set` / `delete` 遇到 `supportsStateRevision === false` | `false` |
| `EAPP_WATCH_UNSUPPORTED` | `watch()` 遇到 `supportsStateWatch === false` | `false` |
| `EAPP_UNSUPPORTED` | `configure` 时 `conflictPolicy !== 'cas'`（CF-1） | `false` |
| `EAPP_STATE_ACTOR_REQUIRED` | `configure` 未提供 `owner`；或写入既无 `actor` 也无 `owner`（SC-5） | `false` |
| `EAPP_SNAPSHOT_INVALID` | `restore` 收到的快照属于另一个 channel（SNAP-9） | `false` |

同一函数内的检查顺序：`set` 是 **能力闸门 → 字段校验 → actor 解析**；`delete` 是 **key 形状 → 能力闸门 →
actor 解析**。因此一个 key 为空的 `delete` 无论 Transport 支不支持 revision，都先得到
`EAPP_STATE_KEY_INVALID`。

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

// §10.1 ②③：先建 v3.1 Channel，再收窄成 StateChannel
const channel = await interaction.createChannel({
  binding: 'b1',
  mode: 'state',
  delivery: 'at-least-once',
});
const ch = configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner });

// IX-6 / CF-5：收窄视图，不是包装类型 —— 成员直通底层 Channel
expect(ch.id).toBe(channel.id);
expect(ch.binding).toBe(channel.binding);
expect(ch.state).toBe('OPEN');
await channel.connect();
expect(ch.state).toBe('ACTIVE'); // 生命周期仍从组合层可观察

// API-1 / API-2：只有"从未存在"才返回 null
expect(await ch.get('never')).toBeNull();
const r1 = await ch.set({ key: 'a', value: 1, expectedRevision: null });
const r2 = await ch.set({ key: 'b', value: 2, expectedRevision: null });

// API-3 / API-4：set 返回新 revision；delete 返回操作后的当前 revision
const r3 = await ch.delete('a', r1);
expect(transport.compareRevision(r3, r1)).toBeGreaterThan(0);
expect((await ch.get('a'))?.revision).toBe(r3);
expect((await ch.get('a'))?.deleted).toBe(true); // SC-6：墓碑仍然可读
expect((await ch.list({ all: true })).map((c) => c.key)).toEqual(['a', 'b']); // API-2

// §6.2：三种不同的失败，错误码取决于 expectedRevision 的形状
await expect(ch.delete('ghost', null)).rejects.toThrow('EAPP_STATE_KEY_NOT_FOUND'); // DEL-4
await expect(ch.delete('ghost', r2)).rejects.toThrow('EAPP_REVISION_CONFLICT');     // 从未存在 + revision
await expect(ch.set({ key: 'a', value: 9, expectedRevision: null })).rejects.toThrow(
  'EAPP_REVISION_CONFLICT', // null 不能复活已删除的 key（它"曾经存在"）
);

// §6.3 / §6.4：删除一个已删除的 key（revision 匹配）是 no-op，返回旧 revision
expect(await ch.delete('a', r3)).toBe(r3);

// DEL-6：删除后重新 set，revision 继续前进且 deleted 被清除
const r4 = await ch.set({ key: 'a', value: 3, expectedRevision: r3 });
expect(transport.compareRevision(r4, r3)).toBeGreaterThan(0);
expect((await ch.get('a'))?.deleted).toBe(false);

// IX-3：Channel 本身没有拿到任何 state 原语
expect(Object.keys(channel).sort()).toEqual(['binding', 'delivery', 'id', 'mode']);
for (const leaked of ['get', 'set', 'list', 'watch', 'snapshot', 'restore', 'revision']) {
  expect(leaked in channel).toBe(false);
}
```

---

## 相关

- [`StateCell`](./state-cell.md) —— `get` / `list` 返回什么
- [`Revision`](./revision.md) —— `set` / `delete` 的返回值与 `expectedRevision` 的位置域
- [`StateUpdate`](./state-update.md) —— 写入请求的形状、CAS 判定与能力闸门顺序
- [`StateWatcher`](./state-watcher.md) —— `watch()` 返回的观察者
- [`StateSnapshot`](./state-snapshot.md) —— `snapshot()` / `restore()` 的完整契约
- [`StateTransport`](./state-transport.md) —— `deleteStateWithCAS` 为什么必须是一等原语

# `StateCell`

> 共享状态的最小单元：某个 key 的**最后一次写入的后像**，连同那次写入在 Channel 状态日志中的位置。

| | |
|---|---|
| **层** | v3.2 State Mode |
| **规范** | [v3.2.0-state §4](../spec/v3.2.0-state.md) |
| **实现** | [`packages/state/src/types.ts`](../../packages/state/src/types.ts) |
| **测试** | [`tests/conformance/state.test.ts`](../../tests/conformance/state.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface StateCell {
  readonly key: string;
  readonly revision: Revision;    // 最后一次写入的日志位置
  readonly value: unknown;        // 可序列化；deleted === true 时 MUST 为 undefined
  readonly deleted: boolean;      // 逻辑删除标记
  readonly updatedAt: number;     // Unix ms
  readonly updatedBy: Identity;   // 最后一次写入者（v3.0 §3.1）
}
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `key` | `string` | 是 | 单元标识；MUST 非空（SC-1）。单元由 `(channel, key)` 二元组唯一确定，MUST NOT 把二者拼接成单串寻址（TS-13） |
| `revision` | [`Revision`](./revision.md) | 是 | 产生本 cell 的那次写入的日志位置（§2.2） |
| `value` | `unknown` | 是 | 最后写入的值；`deleted === true` 时 MUST 为 `undefined`。值为 `undefined` 与字段缺失不是一回事（SU-2） |
| `deleted` | `boolean` | 是 | 逻辑删除标记。`true` 表示墓碑，**不表示 cell 不存在** |
| `updatedAt` | `number` | 是 | 最后一次写入的 Unix 毫秒时间戳 |
| `updatedBy` | `Identity` | 是 | 最后一次写入者；写入未携带 `actor` 时回落到 `StateChannelConfig.owner` |

`StateCell` 由 [`StateChannel`](./state-channel.md) 的 `get` / `list` 返回，由 [`StateUpdate`](./state-update.md) 经 CAS 写入。

---

## 语义

**cell 是后像，不是变更。** `StateCell` 回答"这个 key 现在是什么"，不回答"它经历过什么"。
变更历史由 `StateChange`（§11）承载，并只经 `StateTransport.readChangesAfter` 以**变更流**的形式暴露给
[`StateWatcher`](./state-watcher.md)；两者不可互相推导——同一 key 的两次写入之间没有任何信息留在 cell 里。

**`deleted` 是墓碑，不是缺席。** 逻辑删除后 cell 依然存在、依然被返回，只是 `deleted === true` 且
`value === undefined`：

```
key 从未存在     ──►  get(key) === null
key 存在且未删除 ──►  get(key) =  { deleted: false, value: … }
key 存在且已删除 ──►  get(key) =  { deleted: true,  value: undefined }   ← 不是 null
```

这不是实现细节，而是协议要求（SC-6）。理由：`DEL-5` 的 no-op 分支要求调用方**拿得出已删除 cell 的
`revision`**；若 `get` 对已删除的 key 返回 `null`，该分支永远不可达，`DEL-6` 的"删除后重新 set"
也无从携带 revision。v3.2 r2 草案允许 `get` 返回 `null`，正是它让 own `DEL-5` 不可实现的根因。

**`updatedBy` 必须有来源。** 写入可以显式携带 `actor`，否则回落到 Channel 的 `owner`
（§4.1 SC-5 / §5.1）。二者都没有时不是"填一个默认身份"，而是硬失败
`EAPP_STATE_ACTOR_REQUIRED`——r2 草案伪造 `{domain:'x',id:'x',instance:'x'}` 的做法会让 SC-5 变成恒真式。

**`value` 的可序列化约束只约束活的 cell。** SC-4 明确限定"only for `deleted === false`"：墓碑的
`value` 恒为 `undefined`，不参与该约束。

**寻址是二元组。** `(channel, key)` 才是地址；把二者拼成 `` `${channel}:${key}` `` 会让
`(a, "b:c")` 与 `("a:b", "c")` 命中同一个 cell，造成跨 channel 污染（TS-13）。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `SC-1` | `key` MUST NOT 为空 | `state.test.ts` › `'SC-1: key MUST NOT be empty'` |
| `SC-2` | `revision` MUST 在 Channel 内单调递增 | `state.test.ts` › `'SC-2 / REV-1 / REV-2 / REV-3: revision is monotonic and transport-assigned'` |
| `SC-3` | `deleted = true` MUST 保留 `revision`（MUST NOT 重置计数器） | `state.test.ts` › `'SC-3 / DEL-6: delete preserves the counter and a later set clears the flag'` |
| `SC-4` | `value` MUST 可序列化（仅约束 `deleted === false` 的 cell） | `state.test.ts` › `'SC-4: a stored value round-trips through JSON, and a deleted cell has none'` |
| `SC-5` | `updatedBy` MUST 是已存在的 `Identity` | `state.test.ts` › `'SC-5: updatedBy carries a real identity, taken from actor or channel owner'` |
| `SC-6` | `get` / `list` MUST 返回已逻辑删除的 cell，MUST NOT 因 `deleted` 而返回 `null` | `state.test.ts` › `'SC-6 / API-1 / API-2: get and list include logically-deleted cells'` |

`SC-2` 与 [`Revision`](./revision.md) 的 `REV-1`／`REV-2`／`REV-3` 是同一条规律的两种说法（§2.2 第 4 点），
因此由同一个测试承载。`SC-3` 的"保留计数"与删除语义的 `DEL-6` 同测。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_STATE_KEY_INVALID` | `get` / `set` / `delete` 的 key 不是非空字符串（SC-1、SU-1） | `false` |
| `EAPP_STATE_ACTOR_REQUIRED` | 写入既未携带 `actor`，Channel 也无 `owner`，`updatedBy` 无来源（SC-5） | `false` |
| `EAPP_STATE_UNSUPPORTED` | `transport.capabilities.supportsState === false`（§12.2 闸门） | `false` |
| `EAPP_REVISION_CONFLICT` | 写入的 `expectedRevision` 前提不成立（§5.2） | `true` |

`retryable` 取自 `@eapp/core` 的 `RETRYABLE_CODES`；`EAPP_REVISION_CONFLICT` 是其中唯一的 State Mode 码（§13）。

---

## 示例

> 以下片段可直接放进 vitest 测试文件（ESM 顶层 `await` 可用）。

```typescript
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
await channel.connect();
const ch = configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner });

// 首次写入必须用 null：key "从未存在"
const r1 = await ch.set({ key: 'counter', value: { n: 1 }, expectedRevision: null });
const cell = await ch.get('counter');
// cell.revision === r1（SC-2 / REV-3）
// cell.deleted === false，cell.updatedBy === owner（SC-5：未给 actor，回落到 Channel owner）
// JSON.parse(JSON.stringify(cell.value)) 与原值相等（SC-4）

// 逻辑删除：cell 变成墓碑，但仍然存在
const r2 = await ch.delete('counter', r1);
const tombstone = await ch.get('counter');
// tombstone !== null   —— SC-6：已删除不等于不存在
// tombstone.deleted === true，tombstone.value === undefined
// tombstone.revision === r2，且 r2 > r1（SC-3：MUST NOT 重置计数器）

// list 含已删除的 cell，按 key 字典序稳定排序
const listed = await ch.list({ all: true });
// listed.map((c) => c.key) === ['counter']，listed[0].deleted === true

// 只有"从未存在"才返回 null
await ch.set({ key: 'other', value: 1, expectedRevision: null });
// await ch.get('other') // 非 null
// await ch.get('never') // === null
```

---

## 相关

- [`Revision`](./revision.md) —— cell 的 `revision` 是 Channel 状态日志中的位置，与 `Cursor` 同一域
- [`StateUpdate`](./state-update.md) —— 写入 cell 的请求形状与 CAS 前提
- [`StateChannel`](./state-channel.md) —— `get` / `list` 的操作面，以及删除的完整边界表
- [`StateWatcher`](./state-watcher.md) —— 观察 cell 的变更流
- [一致性声明](../CONFORMANCE.md) —— v3.2 层 84 / 84 不变量覆盖

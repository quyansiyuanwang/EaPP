# `StateUpdate`

> 一次状态变更请求：写**哪个 key**、写**什么**、以及**以哪个版本为前提**。

| | |
|---|---|
| **层** | v3.2 State Mode |
| **规范** | [v3.2.0-state §5](../spec/v3.2.0-state.md) |
| **实现** | [`packages/state/src/types.ts`](../../packages/state/src/types.ts) · [`packages/state/src/validate.ts`](../../packages/state/src/validate.ts) |
| **测试** | [`tests/conformance/state.test.ts`](../../tests/conformance/state.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface StateUpdate {
  key: string;
  value?: unknown;                // 新值；"存在性"按属性存在判定
  deleted?: boolean;              // 逻辑删除；出现时 MUST 为 true
  expectedRevision: ExpectedRevision;
  actor?: Identity;               // 省略时回落到 Channel.owner
}

type ExpectedRevision = Revision | null;
// null     → key MUST NOT have ever existed
// Revision → key MUST exist and its revision MUST match exactly

interface StateChannelConfig {
  conflictPolicy: 'cas';          // Core 只支持这一种（CF-1）
  owner: Identity;                // 写入未携带 actor 时，updatedBy 的来源（SC-5）
}
```

校验入口（`validate.ts`，被 `StateChannel.set` / `delete` / `list` / `watch` / `snapshot` 调用）：

```typescript
function validateUpdate(update: StateUpdate): { hasValue: boolean; hasDeleted: boolean };
function hasValueProperty(update: StateUpdate): boolean;   // SU-2：按属性存在判定
function validatePattern(pattern: StatePattern): void;      // §8：逐字段校验
function matchesStatePattern(key: string, pattern: StatePattern): boolean;
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `key` | `string` | 是 | 目标单元；MUST 非空（SU-1 / SC-1） |
| `value` | `unknown` | 条件 | 新值。与 `deleted = true` 二选一（SU-2 / SU-3） |
| `deleted` | `boolean` | 条件 | 出现时 MUST 为 `true`；`deleted: false` 被拒绝（SU-9） |
| `expectedRevision` | `Revision \| null` | 是 | CAS 前提。**MUST 是 `Revision \| null`，`undefined` 会被拒绝**（SU-8） |
| `actor` | `Identity` | 否 | 写入者；省略时回落到 `StateChannelConfig.owner` |

> `types.ts` 另导出了 `StateDeleteRequest { key; expectedRevision; actor? }`。参考实现中没有任何路径
> 消费它——`StateChannel.delete()` 按 §10.2 采用**位置参数** `(key, expectedRevision, options?)`。

---

## 语义

### 1. CAS：唯一的前置条件

`conflictPolicy` 在 Core 里只有 `'cas'` 一个取值（CF-1），因此每一次写入都携带 `expectedRevision`，
没有"无条件写"这种客户端操作（SU-6）。§5.2 的完整判定表：

```
expectedRevision === null
    key 从未存在           → 成功
    key 存在（含已删除）   → EAPP_REVISION_CONFLICT

expectedRevision is Revision
    key 不存在             → EAPP_REVISION_CONFLICT
    revision 不匹配        → EAPP_REVISION_CONFLICT
    revision 匹配          → 成功
```

**`null` 是唯一表示"不存在"的方式。MUST NOT 使用 `''` / `'0'` / `-1`。**
**`null` 表示"从未存在"，MUST NOT 用它复活一个已逻辑删除的 key**——复活必须携带旧 revision。

```
写入 k ──► r1 ──► delete(k, r1) ──► r2（墓碑）
                                        │
       set({ key:'k', expectedRevision: null })  ──► EAPP_REVISION_CONFLICT   ← 不能复活
       set({ key:'k', expectedRevision: r2 })    ──► 成功，分配 r3 > r2        ← 必须带 revision
```

把 `null` 读成"当前不存在"，逻辑删除就变成一条隐式的"允许覆盖"通道。

### 2. 存在性按属性判定（SU-2）

`value` 是否出现，判定依据是**属性是否存在**（`hasOwnProperty`），MUST NOT 用 `value !== undefined`。
因此 `{ key, value: undefined, expectedRevision: null }` 是**合法写入**，语义明确：写入一个值为
`undefined` 的活 cell（`deleted === false`）。用 `value !== undefined` 判定会让这个写入无法表达。

### 3. 字段校验的判定顺序

参考实现 `validateUpdate` 的检查顺序（同一函数内，先命中者决定错误码）：

```
① update 是对象                          → 否则 EAPP_STATE_VALUE_INVALID
② key 是非空字符串                        → 否则 EAPP_STATE_KEY_INVALID      （SU-1 / SC-1）
③ expectedRevision !== undefined          → 否则 EAPP_REVISION_INVALID       （SU-8）
④ deleted 未出现，或恰为 true              → 否则 EAPP_STATE_VALUE_INVALID    （SU-9）
⑤ NOT（同时有 value 与 deleted = true）    → 否则 EAPP_STATE_VALUE_INVALID    （SU-3）
⑥ 至少有一个：value 属性存在，或 deleted = true → 否则 EAPP_STATE_VALUE_INVALID （SU-2）
```

能力闸门更靠前：`StateChannel.set` 先 `assertStateCapability(transport, 'revision')`，再
`validateUpdate`。一个既不支持 revision 又收到非法 update 的调用，得到的是
`EAPP_STATE_UNSUPPORTED`，不是字段错误。

### 4. CAS 的原子性是 Transport 的责任（SU-7 / TS-6）

"比较 + 写入"MUST 在 Transport 内原子完成；`StateChannel` **MUST NOT** 自己先 `get` 再 `set`——
那会在两步之间打开竞态窗口，让两个调用方同时通过检查。参考实现的 `MemoryTransport.setStateWithCAS`
把整个判定放在一个不含 `await` 的同步块里，因此 100 个并发写入同一 `expectedRevision` 只有一个成功。

### 5. 冲突策略（CF-1 … CF-5）

```
CF-1  Core MUST only support CAS
CF-2  CAS failure MUST return EAPP_REVISION_CONFLICT
CF-3  Other policies MUST be defined in Extension
CF-4  Policy MUST be specified at Channel creation (configure())
CF-5  StateChannel MUST extend Channel, MUST NOT be a wrapper type
```

策略在 `configureStateChannel` 时给定并立即校验：`conflictPolicy !== 'cas'` → `EAPP_UNSUPPORTED`。
其他策略（LWW、CRDT 合并等）不在 Core 内定义，属于 Extension——Core 的 CAS 正确性建立在
[`Revision`](./revision.md) 的全序之上，一个"eventual 的 revision + CAS"的组合会静默丢更新，因此被
§12.3 明确排除。

### 6. `StatePattern` 校验（§8）

```typescript
type StatePattern =
  | { readonly key: string }        // 精确匹配
  | { readonly prefix: string }     // 前缀匹配
  | { readonly all: true };         // 全部
```

校验 MUST 逐字段，MUST NOT 只检查属性名：

```
合法：{ key: <非空 string> } | { prefix: <string> } | { all: true }
非法（MUST 返回 EAPP_STATE_PATTERN_INVALID）：
  属性数量 ≠ 1
  属性名不在 { key, prefix, all }
  { all: false } / { all: 1 }
  { key: '' }
  同时出现 key 与 prefix
```

只看属性名的校验会让 `{ all: false }` 与 `{ key: '' }` 通过一条自带错误码的规则——
一个不能拒绝的校验器不是校验器。参考实现用 `Object.keys(pattern).length !== 1` 加逐字段类型判定
关闭这一点。§8 只对 pattern 校验提出要求，`StatePattern` 的类型归属（`API-9`）记在
[`StateChannel`](./state-channel.md)。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `SU-1` | `StateUpdate` MUST specify `key` | `state.test.ts` › `'SU-1 / SU-2 / SU-3 / SU-9: field validation'` |
| `SU-2` | MUST have a `'value'` property or set `deleted = true`；`value` 的存在性按属性存在判定 | `state.test.ts` › `'SU-2: an explicit undefined value is a legitimate write'` |
| `SU-3` | MUST NOT carry both `'value'` and `deleted = true` | `state.test.ts` › `'SU-1 / SU-2 / SU-3 / SU-9: field validation'` |
| `SU-4` | CAS failure MUST return `EAPP_REVISION_CONFLICT` | `state.test.ts` › `'SU-4 / SU-5 / CF-2: CAS failure reports a conflict and changes nothing'` |
| `SU-5` | CAS failure MUST NOT modify state | `state.test.ts` › `'SU-4 / SU-5 / CF-2: CAS failure reports a conflict and changes nothing'` |
| `SU-6` | Core MUST NOT expose an unconditional client-facing write | `state.test.ts` › `'SU-6 / SNAP-7: the only public unconditional-write path is restore'` |
| `SU-7` | CAS check + write MUST be atomic in Transport | `state.test.ts` › `'SU-7 / TS-6: CAS is atomic under concurrency'` |
| `SU-8` | `expectedRevision` MUST be `Revision \| null` | `state.test.ts` › `'SU-8 / §5.2: null means "never existed", not "not currently present"'` |
| `SU-9` | `deleted`, when present, MUST be `true` | `state.test.ts` › `'SU-1 / SU-2 / SU-3 / SU-9: field validation'` |
| `CF-1` | Core MUST only support CAS | `state.test.ts` › `'CF-1 / CF-4 / CF-5 / IX-6: configuration is validated and the view is not a wrapper'` |
| `CF-2` | CAS failure MUST return `EAPP_REVISION_CONFLICT` | `state.test.ts` › `'CF-2 / CF-3: a CAS conflict is reported as retryable'` |
| `CF-3` | Other policies MUST be defined in Extension | `state.test.ts` › `'CF-2 / CF-3: a CAS conflict is reported as retryable'` |
| `CF-4` | Policy MUST be specified at Channel creation (`configure()`) | `state.test.ts` › `'CF-1 / CF-4 / CF-5 / IX-6: configuration is validated and the view is not a wrapper'` |
| `CF-5` | `StateChannel` MUST extend `Channel`, MUST NOT be a wrapper type | `state.test.ts` › `'CF-1 / CF-4 / CF-5 / IX-6: configuration is validated and the view is not a wrapper'` |

`CF-3` 规定 Core 不定义 CAS 之外的策略。承载它的测试同时验证了"Core 只接受
`'cas'`"这一可执行的一面（`'lww'` → `EAPP_UNSUPPORTED`）。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_STATE_KEY_INVALID` | `key` 不是非空字符串（SU-1 / SC-1） | `false` |
| `EAPP_STATE_VALUE_INVALID` | `value` 与 `deleted = true` 同时出现（SU-3）；二者都没有（SU-2）；`deleted === false`（SU-9）；update 不是对象 | `false` |
| `EAPP_REVISION_INVALID` | `expectedRevision` 缺失或为 `undefined`（SU-8）；或它在本 Transport 无法比较（§3.2 / REV-8） | `false` |
| `EAPP_REVISION_CONFLICT` | CAS 前提不成立：key 已存在而用了 `null`、key 不存在、或 revision 不匹配（§5.2） | `true` |
| `EAPP_STATE_PATTERN_INVALID` | pattern 校验失败（§8） | `false` |
| `EAPP_UNSUPPORTED` | `configure()` 时 `conflictPolicy !== 'cas'`（CF-1） | `false` |
| `EAPP_STATE_ACTOR_REQUIRED` | `configure()` 未提供 `owner`（SC-5） | `false` |
| `EAPP_STATE_UNSUPPORTED` | `transport.capabilities.supportsStateRevision === false`，`set` / `delete` / `restore` 拒绝执行（TS-2 / TS-4） | `false` |

关于 `EAPP_REVISION_INVALID` 与 `EAPP_REVISION_CONFLICT` 的分工：**前缀错误取决于 CAS 走到了哪一步**。
key 不存在时无须比较即可判负，得到 `EAPP_REVISION_CONFLICT`（§5.2 为"key 不存在"规定的结果）；
key 存在时必须真做一次比较，陌生 token 于是在这一层被拦成 `EAPP_REVISION_INVALID`。

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
await channel.connect();
const ch = configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner });

// SU-1 / SU-2 / SU-3 / SU-9：字段校验
await expect(ch.set({ key: '', value: 1, expectedRevision: null })).rejects.toThrow(
  'EAPP_STATE_KEY_INVALID',
);
await expect(ch.set({ key: 'k', expectedRevision: null })).rejects.toThrow(
  'EAPP_STATE_VALUE_INVALID', // 既没有 value 属性，也没有 deleted = true
);
await expect(
  ch.set({ key: 'k', value: 1, deleted: true, expectedRevision: null }),
).rejects.toThrow('EAPP_STATE_VALUE_INVALID'); // SU-3
await expect(
  ch.set({ key: 'k', value: 1, deleted: false, expectedRevision: null }),
).rejects.toThrow('EAPP_STATE_VALUE_INVALID'); // SU-9
await expect(ch.set({ key: 'k', value: 1 } as never)).rejects.toThrow(
  'EAPP_REVISION_INVALID', // SU-8：expectedRevision 不是可省略字段
);

// SU-2：value 的存在性按属性存在判定，所以显式 undefined 是合法写入
const rUndef = await ch.set({ key: 'u', value: undefined, expectedRevision: null });
expect((await ch.get('u'))?.value).toBeUndefined();
expect((await ch.get('u'))?.deleted).toBe(false);
expect((await ch.get('u'))?.revision).toBe(rUndef);

// §5.2：null 只表示"从未存在"，key 已经存在时不能再用它
const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });
await expect(ch.set({ key: 'k', value: 2, expectedRevision: null })).rejects.toThrow(
  'EAPP_REVISION_CONFLICT',
);

// 错误码取决于 CAS 走到了哪一步：key 存在时，陌生 token 在比较那一层被拦下
await expect(ch.set({ key: 'k', value: 2, expectedRevision: 'not-the-revision' })).rejects.toThrow(
  'EAPP_REVISION_INVALID',
);

// 正常前进一次，r1 随即过期
const r2 = await ch.set({ key: 'k', value: 2, expectedRevision: r1 });

// SU-5：CAS 失败不改变任何状态
const before = await ch.get('k');
await expect(ch.set({ key: 'k', value: 3, expectedRevision: r1 })).rejects.toThrow(
  'EAPP_REVISION_CONFLICT',
);
expect((await ch.get('k'))?.value).toBe(2);
expect((await ch.get('k'))?.revision).toBe(before?.revision);
expect(before?.revision).toBe(r2);

// CF-2：冲突被标记为可重试
const error = await ch
  .set({ key: 'k', value: 4, expectedRevision: r1 })
  .then(() => undefined)
  .catch((e: { code: string; retryable?: boolean }) => e);
expect(error?.code).toBe('EAPP_REVISION_CONFLICT');
expect(error?.retryable).toBe(true);

// §8：pattern 校验逐字段，而不是只看属性名
for (const bad of [{ key: 'k', prefix: 'p' }, { all: false }, { key: '' }, { nothing: true }]) {
  await expect(ch.list(bad as never)).rejects.toThrow('EAPP_STATE_PATTERN_INVALID');
}
```

---

## 相关

- [`Revision`](./revision.md) —— `expectedRevision` 所在的位置域，以及错误码的分工
- [`StateCell`](./state-cell.md) —— 一次成功写入产出什么
- [`StateChannel`](./state-channel.md) —— `set` / `delete` 的操作面与删除的完整边界表
- [`StateSnapshot`](./state-snapshot.md) —— SU-6 的唯一例外：`restore()` 是唯一的无条件写入路径
- [`StateTransport`](./state-transport.md) —— CAS 原子性（TS-6）与能力闸门

# `StateSnapshot`

> 某个 [`StatePattern`](./state-update.md) 范围内、对着一个**先于读取日志头**取得的一致性位置的状态冻结，
> 以及把它写回去的恢复过程。

| | |
|---|---|
| **层** | v3.2 State Mode |
| **规范** | [v3.2.0-state §9](../spec/v3.2.0-state.md) |
| **实现** | [`packages/state/src/state-channel.ts`](../../packages/state/src/state-channel.ts) |
| **测试** | [`tests/conformance/state.test.ts`](../../tests/conformance/state.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface StateSnapshot {
  readonly channel: string;
  readonly pattern: StatePattern;   // 本快照的选择范围（r3 新增；r2 无从表达它）
  readonly cells: StateCell[];
  readonly maxRevision: Revision;   // 在读取 cells 之前观测到的 Channel head（§9.2）
  readonly takenAt: number;
}

type RestoreMode = 'merge' | 'replace';

// StateChannel 上的两个操作
snapshot(pattern: StatePattern): Promise<StateSnapshot>;
restore(snapshot: StateSnapshot, options?: { mode?: RestoreMode }): Promise<void>;  // 默认 'merge'
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `channel` | `string` | 是 | 快照所属的 Channel；与目标 channel 不一致时 `restore` MUST 拒绝（SNAP-9） |
| `pattern` | `StatePattern` | 是 | 本快照覆盖的选择范围，也是 `replace` 模式的删除范围 |
| `cells` | `StateCell[]` | 是 | 范围内、且 `revision <= maxRevision` 的全部 cell |
| `maxRevision` | [`Revision`](./revision.md) | 是 | **先于** cell 读取观测到的 Channel head，MUST NOT 由 `cells` 归约得出 |
| `takenAt` | `number` | 是 | 快照生成时刻（Unix ms） |
| `options.mode` | `'merge' \| 'replace'` | 否 | 省略时为 `'merge'` |

---

## 语义

### 1. 读取顺序就是一致性定义（§9.2）

```
snapshot MUST 按此顺序执行：
  ① P := head(channel)                      ← 先取日志头
  ② cells := listState(channel, pattern)，过滤到 revision <= P
  ③ maxRevision := P

MUST NOT 用 reduce 从 cells 推导 maxRevision。
```

`maxRevision` 是**在读取 cells 之前**观测到的 Channel head，不是这些 cell 的 `revision` 的最大值。
这个顺序不是实现口味，而是 SNAP-1 能否成立的全部：

| 做法 | 后果 |
|---|---|
| `cells` 与 `maxRevision` 来自同一次读取，`maxRevision = reduce(max, cells)` | `cell.revision <= maxRevision` 成为**恒真式**。任何 Transport 都不可能违反它，因为 `maxRevision` 是从被检查的集合里算出来的——**不可违反的不变量无法被测试** |
| 先读 head，再读 cells（本版本） | 两步之间出现一个**真实的竞态窗口**：并发写入可能落在窗口内。若 Transport 不把 `cells` 过滤到 `<= P`，SNAP-1 就会被违反。不变量因此**可违反、因而可测试** |

参考实现把这条窗口闭合在 Transport 返回之后：

```typescript
const maxRevision = await this.#transport.head(this.#channel.id);
const all = await this.#transport.listState(this.#channel.id, pattern);
const cells = all.filter((cell) => this.#transport.compareRevision(cell.revision, maxRevision) <= 0);
```

于是"快照里可能缺少窗口内的写入"是**允许**的——这正是 `SNAP-3`：快照是 read-consistent，**MUST NOT
声称 linearizable**。`takenAt` 与 `maxRevision` 共同描述了它的时间点，但没有承诺"此刻世界就是如此"。

r2 草案还有第二个坑：它用 `'' as Revision` 作为归约种子，零匹配时 `maxRevision === ''` ——
一个没有任何 Transport 能比较的非法值，直接违反 SNAP-2。本版本零匹配时返回的是真实的 head，
空 Channel 上是 Transport 自己的可比较初始位置（TS-14）。

### 2. 恢复：只前进，不回退（§9.3）

| 模式 | 语义 |
|---|---|
| `merge` | 快照内每个 cell 分配**新 revision** 并写入；范围外的 cell 不动 |
| `replace` | 先 `merge`，再把 `snapshot.pattern` 范围内、不在快照中的 cell 全部逻辑删除 |

两种模式的共同点：**每一次写入都申请一个新位置**（`nextRevision` + `writeStateWithRevision`），
而不是把日志倒回快照时的位置。因此：

- `SNAP-4`：restore MUST NOT roll back revisions。恢复后每个 cell 的 revision 都**大于**恢复前的值。
- `SNAP-5`：restore MUST assign new revisions to all restored cells。
- `SNAP-6`：restore MUST preserve relative ordering。按 `snapshot.cells` 的顺序逐个写入，先写的先拿到
  位置，相对次序因此得以保留。
- `SNAP-8`：restore MUST append a change for every write；观察者 MUST 能看到它们。

`replace` 模式在补偿删除时会跳过已经是墓碑的 cell（"已经逻辑删除，没有东西需要覆盖"），它们不构成
"范围外残留"。（r2 的 `restore` 只写不删，与 `API-8`「MUST overwrite current state」的两种读法并存；
本版本用显式 `mode` 消除歧义。）

### 3. `restore` 是唯一的无条件写入路径（SNAP-7）

```
SU-6  Core MUST NOT 对外暴露无条件写入。
      Transport MAY 提供 revision 钉定的内部写入原语（writeStateWithRevision），前提是：
        (a) 收到 <= head 的 revision 时 MUST 抛 EAPP_REVISION_INVALID；
        (b) MUST NOT 从 StateChannel 的公开 API 可达，唯一例外是 restore()
```

`restore` 之所以能"无条件写入"，是因为它**自带条件**：它逐条申请新位置，而 `writeStateWithRevision`
自己拒绝 `<= head` 的 revision。因此无条件 ≠ 可回退，`SNAP-4` 由机制而非约定保证。

### 4. Transport 层不再提供 restore（§9.4）

```
MUST NOT 在 StateTransport 上提供 restoreState。
restore MUST 在 StateChannel 层唯一实现，由 nextRevision + writeStateWithRevision 组合而成。
```

r2 同时存在 `StateTransport.restoreState` 与 `StateChannel` 自建循环两个竞争入口，关系未定义，
可能双写。§9.4 把恢复收敛成单一实现点。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `SNAP-1` | `snapshot` MUST be read-consistent against a head read BEFORE the cell read | `state.test.ts` › `'SNAP-1 / SNAP-2 / SNAP-3 / API-6 / API-7: head is read before the cells'` |
| `SNAP-2` | `snapshot` MUST include `maxRevision` | `state.test.ts` › `'SNAP-2: an empty match set still produces a valid maxRevision'` |
| `SNAP-3` | `snapshot` MUST NOT claim linearizability | `state.test.ts` › `'SNAP-1 / SNAP-2 / SNAP-3 / API-6 / API-7: head is read before the cells'` |
| `SNAP-4` | `restore` MUST NOT roll back revisions | `state.test.ts` › `'SNAP-4 / SNAP-5 / SNAP-6 / API-8: restore allocates fresh revisions in order'` |
| `SNAP-5` | `restore` MUST assign new revisions | `state.test.ts` › `'SNAP-4 / SNAP-5 / SNAP-6 / API-8: restore allocates fresh revisions in order'` |
| `SNAP-6` | `restore` MUST preserve relative ordering | `state.test.ts` › `'SNAP-4 / SNAP-5 / SNAP-6 / API-8: restore allocates fresh revisions in order'` |
| `SNAP-7` | `restore` MUST be the only public path to an unconditional write | `state.test.ts` › `'SU-6 / SNAP-7: the only public unconditional-write path is restore'` |
| `SNAP-8` | `restore` MUST append a change for every write | `state.test.ts` › `'SNAP-8 / DEL-3: restore is observable by watchers'` |
| `SNAP-9` | `restore` MUST reject a snapshot from another channel | `state.test.ts` › `'SNAP-9 / API-8: replace mode deletes cells outside the snapshot'` |

两点关于测试口径的说明：

- `SNAP-3` 是一条**否定性**约束（MUST NOT claim）。可执行的一面是：`StateSnapshot` 上没有任何字段
  声称 linearizability，唯一与时间有关的声明就是 `maxRevision` 与 `takenAt`；承载其 ID 的测试验证的是
  `maxRevision` 确实等于**读取之前**的 head，以及每个 cell 的 `revision <= maxRevision`。
- `SNAP-9` 的"拒绝外来 channel"与"`replace` 模式的删除范围"由同一个测试承载；另一个
  `'SNAP-9: merge mode leaves out-of-scope cells alone'` 覆盖同一 ID 的另一面。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_SNAPSHOT_INVALID` | `restore` 的 `snapshot.channel` 与目标 channel 不一致（SNAP-9） | `false` |
| `EAPP_UNSUPPORTED` | `transport.capabilities.supportsStateSnapshot === false`；`snapshot()` / `restore()` 拒绝执行（TS-2 闸门） | `false` |
| `EAPP_STATE_UNSUPPORTED` | `transport.capabilities.supportsState === false` | `false` |
| `EAPP_STATE_PATTERN_INVALID` | `snapshot(pattern)` 的 pattern 校验失败（§8） | `false` |
| `EAPP_STATE_ACTOR_REQUIRED` | 恢复写入需要 actor，而 Channel 没有 `owner`（SC-5） | `false` |
| `EAPP_REVISION_INVALID` | `writeStateWithRevision` 收到 `<= head` 的 revision（§5.5a / SNAP-4 的机制） | `false` |

`snapshot` 的检查顺序：先校验 pattern，再检查 `snapshot` 能力。`restore` 的顺序是：能力 → channel
一致性 → actor 解析 → 逐条写入。

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

await ch.set({ key: 'a', value: 1, expectedRevision: null });
await ch.set({ key: 'b', value: 2, expectedRevision: null });

// SNAP-1 / SNAP-2 / SNAP-3：maxRevision 是读取 cells 之前观测到的 head
const headBefore = await transport.head(ch.id);
const snapshot = await ch.snapshot({ all: true });
expect(snapshot.maxRevision).toBe(headBefore);
expect(snapshot.pattern).toEqual({ all: true });
for (const cell of snapshot.cells) {
  expect(transport.compareRevision(cell.revision, snapshot.maxRevision)).toBeLessThanOrEqual(0);
}

// SNAP-2：零匹配也要给出一个可比较的 maxRevision（r2 会归约出非法的 ''）
const empty = await ch.snapshot({ prefix: 'nothing' });
expect(empty.cells).toHaveLength(0);
expect(() => transport.compareRevision(empty.maxRevision, empty.maxRevision)).not.toThrow();

// SNAP-7：restore 是唯一的无条件写入路径；钉定写入本身拒绝不前进的位置
await expect(
  transport.writeStateWithRevision(ch.id, 'a', 0, false, headBefore, owner),
).rejects.toThrow('EAPP_REVISION_INVALID');

// SNAP-4 / SNAP-5 / SNAP-6 / API-8：恢复分配新 revision，且保持相对次序
await ch.set({ key: 'a', value: 99, expectedRevision: (await ch.get('a'))!.revision });
const beforeRestore = (await ch.get('a'))!.revision;
await ch.restore(snapshot); // 默认 merge
expect((await ch.get('a'))?.value).toBe(1);
expect(transport.compareRevision((await ch.get('a'))!.revision, beforeRestore)).toBeGreaterThan(0);
expect(
  transport.compareRevision((await ch.get('a'))!.revision, (await ch.get('b'))!.revision),
).toBeLessThan(0); // SNAP-6：a 先于 b 的顺序被保留

// SNAP-9 / API-8：replace 会逻辑删除范围内、不在快照中的 cell
await ch.set({ key: 'extra', value: 3, expectedRevision: null });
await ch.restore(snapshot, { mode: 'replace' });
expect((await ch.get('extra'))?.deleted).toBe(true);

// SNAP-9：外来 channel 的快照 MUST 被拒绝
await expect(ch.restore({ ...snapshot, channel: 'somewhere-else' })).rejects.toThrow(
  'EAPP_SNAPSHOT_INVALID',
);
```

---

## 相关

- [`StateChannel`](./state-channel.md) —— `snapshot()` / `restore()` 的操作面
- [`Revision`](./revision.md) —— `maxRevision` 所在的位置域，以及"新位置"如何分配
- [`StateTransport`](./state-transport.md) —— `head` / `listState` / `nextRevision` / `writeStateWithRevision`
- [`StateWatcher`](./state-watcher.md) —— 恢复的每一次写入都必须被观察到（SNAP-8）
- [`StateUpdate`](./state-update.md) —— SU-6 与 SNAP-7 的分工：唯一的无条件写入例外

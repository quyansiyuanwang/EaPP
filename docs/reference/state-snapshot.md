# StateSnapshot

它是某个模式范围内的状态冻结，附带一个先于读取取得的位置。

| | |
|---|---|
| **层** | State Mode |
| **规范** | `§43` |
| **不变量** | `SNAP-1…SNAP-9` |
| **稳定度** | FROZEN |

## 语义

`StateSnapshot` 由来源 Channel、选择范围 `StatePattern`、范围内的 cell、`maxRevision` 与生成时间构成（`§43.1`）。`maxRevision` 是读取 cells **之前**观察到的 Channel 头位置（`§43.1`）。

一致性由执行顺序定义（`§43.2`）：先取日志头，再读取并过滤 `revision <= P` 的 cells，最后把 `maxRevision` 置为 `P`。MUST NOT 从 cells 归约推导 `maxRevision`，因为那样 `cell.revision <= maxRevision` 是恒真式，`SNAP-1` 不可被违反也就不可被测试（`§43.2`）。快照 MUST 携带 `maxRevision`（`SNAP-2`），MUST NOT 声称 linearizability（`SNAP-3`）。

恢复由 `restore(snapshot, options)` 完成，`options.mode` 取 `merge` 或 `replace`，默认 `merge`（`§43.3`）。`merge` 为快照内每个 cell 分配**新** revision 并写入，范围外的 cell 不动；`replace` 先 `merge`，再把范围内不在快照中的 cell 全部逻辑删除（`§43.3`）。

因此恢复 MUST NOT 回滚 revision（`SNAP-4`），MUST 为所有恢复的 cell 分配新 revision（`SNAP-5`），MUST 保持相对顺序（`SNAP-6`），且 MUST 为它执行的每一次写入追加一条变更，观察者 MUST 能看到它们（`SNAP-8`）。

`restore` 是唯一可达的无条件写入公开路径（`SNAP-7`、`SU-6`），也 MUST 只在 StateChannel 层实现：StateTransport 上 MUST NOT 提供 `restoreState`（`§43.4`）。

## 常见误用

- "从 cells 归约推导 `maxRevision`"：`§43.2` 规定 MUST NOT 这样做，理由是它使 `SNAP-1` 成为恒真式而不可能被测试。
- "恢复时沿用快照中的 revision"：`SNAP-4` 规定恢复 MUST NOT 回滚 revision，`SNAP-5` 要求为所有恢复的 cell 分配新 revision。
- "恢复一个来自另一个 Channel 的快照"：`SNAP-9` 规定 MUST 拒绝并返回 `EAPP_SNAPSHOT_INVALID`。
- "把 `restore` 同时实现在 StateTransport 与 StateChannel 上"：`§43.4` 规定 MUST NOT 在 StateTransport 上提供 `restoreState`，理由是同一份快照可能被写入两次。

## 相关

- [`StateChannel`](./state-channel.md) —— `snapshot` / `restore` 的唯一公开落点（`API-6`、`API-8`）
- [`StateTransport`](./state-transport.md) —— 提供 `head` 与位置原语的一方（`TS-14`）
- [`Revision`](./revision.md) —— `maxRevision` 的类型（`SNAP-2`）
- [`StateWatcher`](./state-watcher.md) —— 必须观察到恢复产生的变更（`SNAP-8`）
- [`StateCell`](./state-cell.md) —— 快照范围内的单元（`§43.1`）
- [规范 §43](../spec/eapp.md) —— Snapshot 与 Restore 的语义

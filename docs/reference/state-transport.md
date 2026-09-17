# StateTransport

它是 Transport 的状态扩展——状态存在哪里、位置由谁签发。

| | |
|---|---|
| **层** | State Mode |
| **规范** | `§45`、`§46` |
| **不变量** | `TS-1…TS-15` |
| **稳定度** | FROZEN |

## 语义

`StateTransport` 在 [`Transport`](./transport.md) 之上增加状态操作（`§45`）：读写 cell 的 `getState` / `listState`、取头位置的 `head`、CAS 写入的 `setStateWithCAS` 与 `deleteStateWithCAS`、读取变更流的 `readChangesAfter`，以及位置原语 `nextRevision` / `compareRevision` / `writeStateWithRevision`（`§45`）。

`readChangesAfter` 返回**变更流**而非 cell 后像（`§45`）：后像无法表达同一键的两次变更，中间的变更会永久丢失。它 MUST 按 revision 严格升序返回（`TS-9`），MUST 只返回严格大于 cursor 的变更（`TS-10`），`cursor === undefined` MUST 解释为"从最早已保留位置开始"（`TS-11`），无匹配时 MUST 返回空数组且 MUST NOT 阻塞（`TS-12`）。

寻址 MUST 按 `(channel, key)` 二元组，MUST NOT 把二者拼接为单一字符串（`TS-13`）。`head` 在 Channel 尚无任何变更时 MUST 返回一个可比较的初始 revision（`TS-14`），`nextRevision` MUST 返回严格大于当前头位置的值（`TS-15`）。

能力声明在 `TransportCapabilities` 之上增加 `supportsState`、`supportsStateRevision`、`supportsStateWatch`、`supportsStateSnapshot`、`stateConsistency` 与 `stateRetention`（`§46.1`）。每个标志 MUST 有唯一的运行时后果（`TS-2`、`§46.2`），Transport MUST NOT 伪装支持（`TS-3`），且 MUST NOT 声明超出 `durabilityBoundary` 的 `stateConsistency`（`TS-5`）。

revision 排序不是全序的 Transport MUST 声明 `supportsStateRevision = false`、`stateConsistency = 'eventual'`，且 MUST NOT 声称支持 CAS（`TS-4`）。

## 常见误用

- "把 `(channel, key)` 拼接为单一寻址字符串"：`TS-13` 禁止该做法，`§45` 说明 `(channel="a", key="b:c")` 与 `(channel="a:b", key="c")` 会命中同一个 cell。
- "声明超出持久化边界的一致性"：`TS-5` 规定 `stateConsistency` MUST NOT 超出 `durabilityBoundary`，`§46.3` 进一步收紧能力标志。
- "声明 `supportsStateRevision = true` 却只提供非全序位置"：`TS-4` 要求这类 Transport 声明 `supportsStateRevision = false` 且 MUST NOT 声称 CAS 支持。
- "在 `StateTransport` 上提供 `restoreState`"：`§43.4` 规定 MUST NOT 这样做，恢复只在 [`StateChannel`](./state-channel.md) 层唯一实现。

## 相关

- [`Transport`](./transport.md) —— 被扩展的 Interaction Layer 接口（`TS-7`）
- [`Revision`](./revision.md) —— 由 StateTransport 分配与比较（`REV-3`、`TS-8`）
- [`StateChannel`](./state-channel.md) —— 状态操作对外的视图（`CF-5`）
- [`StateSnapshot`](./state-snapshot.md) —— 依赖 `head` 与位置原语（`SNAP-1`）
- [`StateUpdate`](./state-update.md) —— CAS 写入的请求形状（`SU-7`）
- [规范 §45](../spec/eapp.md) 与 [规范 §46](../spec/eapp.md) —— 接口、能力声明与闸门

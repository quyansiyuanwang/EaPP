# Revision

它是状态日志的位置——与 Interaction Layer 的 Cursor 同域同类型。

| | |
|---|---|
| **层** | State Mode |
| **规范** | `§36.2`、`§37` |
| **不变量** | `REV-1…REV-8` |
| **稳定度** | FROZEN |

## 语义

`Revision` 是一个不透明标识，在 `(Transport, Channel)` 内唯一且全序；它的字面形式由 Transport 定义（`§37`）。

核心裁定是 `§36.2`：Revision 与 [`Cursor`](./cursor.md) 是**同一域上的同一类型**，都是字符串，都在 Channel 内全局有序。每次写入 MUST 在 Channel 日志尾部追加一条 `StateChange` 并获得新位置，该位置既是本次写入的 Revision，也是可用的 Cursor（`§36.2`）。因此 `REV-1`、`REV-2`、`REV-4` 与 `CR-1` 是同一条规律，`REV-7` 是 `CR-1` 的推论。

单调性有四条：MUST 在 Channel 内单调（`REV-1`）、新 revision MUST 大于当前头位置（`REV-2`）、MUST NOT 回滚（`REV-4`）、MUST 由 Transport 分配（`REV-3`）。

不透明性与可比性是可分的：Revision MUST 对消费者不透明（`REV-5`），消费者 MUST NOT 直接比较字符串，比较 MUST 由 Transport 提供（`§37.2`）；跨 Transport 比较 MUST NOT 进行（`REV-8`）。作为 Cursor 使用只限于 State Mode（`REV-6`、`REV-7`）。

## 常见误用

- "把 Revision 实现为 per-cell 的独立计数器"：`§36.2` 规定 MUST NOT 这样做，理由是它既不是全序，也无法充当 Cursor。
- "由消费者直接比较 Revision 字符串"：`§37.2` 规定比较 MUST 由 Transport 提供，非本 Transport 签发的值 MUST 返回 `EAPP_REVISION_INVALID`（`REV-8`）。
- "在 request / event / stream 模式里用 Revision 充当位置"：`REV-6` 规定 Revision MUST NOT 作为这些模式的 Cursor 使用，`§36.2` 的裁定把 Revision 与 Cursor 的同一性限定在 State Mode 内。
- "跨 Transport 比较位置"：`REV-8` 规定 Revision MUST NOT be compared across Transports。

## 相关

- [`StateCell`](./state-cell.md) —— 承载 revision 的单元（`SC-2`）
- [`StateUpdate`](./state-update.md) —— `expectedRevision` 的取值域（`SU-8`）
- [`Cursor`](./cursor.md) —— 同域同类型的 Interaction Layer 位置（`§36.2`）
- [`StateTransport`](./state-transport.md) —— 分配与比较 revision 的一方（`REV-3`、`TS-8`）
- [规范 §37](../spec/eapp.md) —— Revision 的语义、比较与分配

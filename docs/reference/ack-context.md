# AckContext

它是"如何确认一件事已经完成"—— 每个消费单元携带的确认句柄。

| | |
|---|---|
| **层** | Interaction Layer |
| **规范** | `§29` |
| **不变量** | `AK-1…AK-5` |
| **稳定度** | FROZEN |

## 语义

`AckContext` 是每个消费单元携带的确认句柄，由 `ack()` 与 `nack()` 两个操作构成（`§29`）。

两个操作的效果是相反的（`§29`）：`ack()` 确认该项并把 cursor 推进到该项位置（取 `max`）；`nack()` 拒绝该项，使其回到可用，cursor **不前移**（`§26.4`）。

两个操作都 MUST 幂等（`AK-1`、`AK-2`）。一个位置只走其中一条路：`ack()` 之后 MUST NOT 允许 `nack()`（`AK-3`），`nack()` 之后 MUST NOT 允许 `ack()`（`AK-4`）。

对已终结的 AckContext 再次调用 MUST 返回 `EAPP_LEASE_CLOSED`（`AK-5`）。同类规则出现在 [`Subscription`](./subscription.md) 上：`close()` 之后对已 yield 项调用 `ack()` MUST 为 no-op（`SUB-8`），[`StateWatcher`](./state-watcher.md) 上则是 `SW-12`。

确认动作 MUST 完整：只提供确认而不提供拒绝的类型不是合法的 AckContext（`§41.2`、`SW-10`）。

## 常见误用

- "给 `ack()` 或 `nack()` 传参数"：`SW-6` 规定二者 MUST NOT 取参数，`§41.2` 也禁止写成由 watcher 代收的形式。
- "在 `ack()` 之后又调用 `nack()`"：`AK-3` 规定 `ack()` 之后 MUST NOT 允许 `nack()`，反向受 `AK-4` 约束。
- "对已终结的句柄继续调用"：`AK-5` 规定此时 MUST 返回 `EAPP_LEASE_CLOSED`。
- "把确认理解为对消息的确认"：`SW-7` 规定 `ack()` MUST NOT 修改任何 `StateCell`；确认改变的是位置。

## 相关

- [`Cursor`](./cursor.md) —— 确认动作推进的位置（`§26.4`）
- [`Lease`](./lease.md) —— 认领层面的 `ack` / `nack` / `renew`（`§25`）
- [`Subscription`](./subscription.md) —— `T` MUST 携带 AckContext（`§27.1`）
- [`StateWatcher`](./state-watcher.md) —— State Mode 下的完整 AckContext（`SW-10`）
- [`Delivery`](./delivery.md) —— `at-least-once` 的确认义务（`DL-4`）
- [规范 §29](../spec/eapp.md) —— Ack / Nack 的效果与不变量

# Lease

它是"谁领了这份工作、领到什么时候"—— 一次认领。

| | |
|---|---|
| **层** | Interaction Layer |
| **规范** | `§25` |
| **不变量** | `L-1…L-7` |
| **稳定度** | FROZEN |

## 语义

`Lease` 是对某个位置的一次认领，由 `leaseId`、被认领的 [`Cursor`](./cursor.md) 与到期时间构成（`§25`）。

排他性由不变量钉死：同一 cursor 在任意时刻 MUST NOT 被多个 ACTIVE Lease 持有（`L-2`），`leaseId` MUST 全局唯一（`L-1`）。这条规则正是 [`ConsumerGroup`](./consumer-group.md) 竞争消费的机制保证（`§28.3`）。

三个操作都对认领本身生效：`ack()` 与 `nack()` MUST 幂等（`L-3`、`L-4`），`renew(ttl)` 只对 ACTIVE Lease 有效（`L-5`）。

到期是一条边界：`expiresAt` 到期后该 cursor MAY 被其他消费者重新领取（`L-6`），而过期的 Lease MUST NOT 影响新 Lease（`L-7`）。

认领的确认动作在消费单元上的形状由 [`AckContext`](./ack-context.md) 收窄：`ack()` 将 cursor 置为 `max(当前 cursor, 该位置)`，`nack()` MUST NOT 推进 cursor（`§29`）。

## 常见误用

- "认为过期的 Lease 仍能阻挡新认领"：`L-7` 规定过期的 Lease MUST NOT 影响新 Lease，`L-6` 允许该 cursor 被重新领取。
- "在到期后继续 renew"：`L-5` 规定 `renew()` 只对 ACTIVE Lease 有效。
- "让两个消费者同时持有同一个 cursor"：`L-2` 规定同一 cursor 在任意时刻 MUST NOT 被多个 ACTIVE Lease 持有。
- "对已终结的认领再次确认"：`AK-5` 规定对已终结的 AckContext 再次调用 MUST 返回 `EAPP_LEASE_CLOSED`。

## 相关

- [`Cursor`](./cursor.md) —— 被认领的位置（`L-2`）
- [`AckContext`](./ack-context.md) —— `ack` / `nack` 对位置的效果（`§29`）
- [`ConsumerGroup`](./consumer-group.md) —— 认领在哪一组消费者之间竞争（`§28.1`）
- [`Delivery`](./delivery.md) —— `at-least-once` 的确认义务（`DL-4`）
- [规范 §25](../spec/eapp.md) —— Lease 的字段、操作与不变量

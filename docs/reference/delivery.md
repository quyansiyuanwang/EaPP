# Delivery

它是"一次投递保证什么"—— 两条保证，不含 exactly-once。

| | |
|---|---|
| **层** | Interaction Layer |
| **规范** | `§24` |
| **不变量** | `DL-1…DL-6` |
| **稳定度** | FROZEN |

## 语义

`delivery` 的取值域是 `at-most-once` 与 `at-least-once`（`DL-1`）。`exactly-once` MUST NOT 出现在 Core（`DL-2`）。

两条保证与确认的关系是相反的：`at-most-once` MUST NOT ack（`DL-3`），`at-least-once` MUST ack（`DL-4`）。因此 `at-least-once` 的消费者 MUST 幂等处理（`DL-5`）。

模式与保证的对应关系被冻结（`§24`）：`request` 与 `event` 允许两条保证，`stream` 与 `state` 只允许 `at-least-once`。创建 `stream` / `state` Channel 时指定 `at-most-once` MUST 返回 `EAPP_DELIVERY_UNSUPPORTED`（`DL-6`、`CC-5`）。

`delivery` 在 Channel 创建时确定，MUST NOT 在生命周期内改变（`CH-6`）。省略 `delivery` 时按模式推导：`stream` / `state` 推导为 `at-least-once`，其余推导为 `at-most-once`（`CC-4`）。

## 常见误用

- "要求 exactly-once 语义"：`DL-2` 规定 `exactly-once` MUST NOT 出现在 Core。
- "给 `stream` 或 `state` Channel 指定 `at-most-once`"：`DL-6` 规定此时 MUST 返回 `EAPP_DELIVERY_UNSUPPORTED`，`CC-5` 重复了这条要求。
- "在 `at-most-once` 下调用 ack"：`DL-3` 规定 `at-most-once` MUST NOT ack。
- "在 `at-least-once` 下写出非幂等的消费者"：`DL-4` 要求 ack，`DL-5` 要求消费者 MUST 幂等处理。

## 相关

- [`Channel`](./channel.md) —— `delivery` 是它的字段之一（`§22.1`）
- [`AckContext`](./ack-context.md) —— `at-least-once` 下确认动作的载体（`AK-1`、`AK-2`）
- [`Cursor`](./cursor.md) —— 未 ack 的位置为何会被重新投递（`ST-4`）
- [`Transport`](./transport.md) —— 能力声明中的投递能力（`§30.2`）
- [规范 §24](../spec/eapp.md) —— 投递语义与模式对应表

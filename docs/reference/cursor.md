# Cursor

它是"恢复到哪里"—— 已确认过的位置，而非收到过的最远位置。

| | |
|---|---|
| **层** | Interaction Layer |
| **规范** | `§26` |
| **不变量** | `CR-1…CR-5` |
| **稳定度** | FROZEN |

## 语义

`Cursor` 是一个不透明字符串，在 Channel 内全局有序；它的字面形式由实现定义（`§26.1`、`CR-1`）。它 MUST 可持久化、可恢复（`CR-2`），恢复 MUST 从该游标继续（`CR-4`）。

推进由 `ack` 唯一决定（`§26.4`）：`ack(c)` MUST 将 cursor 置为 `max(当前 cursor, c)`；`nack()` MUST NOT 推进 cursor，该项回到可用并在下一次迭代重新投递。因此 `CR-3` 禁止的是**隐式**跳过，而显式 ack 一个更靠后的位置、因而放弃中间未 ack 的项 MUST 被允许（`§26.4`、`§28.3`）。

`'earliest'` 与 `'latest'` 是位置参数的锚点（`§26.2`）。解析规则有七条 MUST：锚点字面量先于具体游标被识别（规则 1）、其余字符串当作游标（规则 2）、`'earliest'` 解析为仍可服务的最早位置（规则 3）、`'latest'` 解析为当前头位置（规则 4）、锚点立即解析（规则 5）、无法定位 `'earliest'` 时返回 `EAPP_CURSOR_TOO_OLD`（规则 6）、已被删除的具体游标同样返回 `EAPP_CURSOR_TOO_OLD` 而不得静默替换为保留起点（规则 7）。

保留语义的边界是保留起点：位置大于或等于它可读，小于它 MUST 返回 `EAPP_CURSOR_TOO_OLD`（`§26.2`）。[`StateTransport`](./state-transport.md) 的 `stateRetention` 能力声明（`§46.1`）MUST 与实际行为一致（`§26.2`）。

在不支持游标的 Transport 上使用游标 MUST 返回 `EAPP_CURSOR_UNSUPPORTED`（`CR-5`、`TR-9`）。

## 常见误用

- "把游标随"收到消息"自动前移"：`CR-3` 规定的禁止对象正是隐式跳过；`§26.4` 与 `§41.3` 都重申只有显式 ack 才推进。
- "只推进到第一个未 ack 项之前"：`§26.4` 规定这类实现 MUST 被视为违反该节，`§28.3` 也禁止用最小未了结位置替代组游标。
- "把已被删除的具体游标静默替换为保留起点"：`§26.2` 规则 7 要求此时 MUST 返回 `EAPP_CURSOR_TOO_OLD`。
- "延迟到首次迭代再解析锚点"：`§26.2` 规则 5 规定锚点 MUST 在订阅创建时立即解析。

## 相关

- [`Subscription`](./subscription.md) —— 持有游标并在创建返回前解析它（`SUB-9`）
- [`ConsumerGroup`](./consumer-group.md) —— 组游标取组内已 ack 位置的最大值（`§28.3`）
- [`AckContext`](./ack-context.md) —— 唯一能推进游标的动作（`§29`）
- [`Revision`](./revision.md) —— State Mode 中与游标同域同类型的位置（`§36.2`）
- [`Transport`](./transport.md) —— 游标由它分配（`§30.1`）
- [规范 §26](../spec/eapp.md) —— Cursor 的定义、锚点、推进规则与不变量

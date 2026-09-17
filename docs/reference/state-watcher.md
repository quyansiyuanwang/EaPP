# StateWatcher

它是状态变更的观察者——在 Subscription 之上收窄的一种。

| | |
|---|---|
| **层** | State Mode |
| **规范** | `§41`、`§42` |
| **不变量** | `SW-1…SW-12` |
| **稳定度** | FROZEN |

## 语义

`StateWatcher` 是 [`Subscription`](./subscription.md) 在状态变更上的收窄（`§41.1`）：MUST 实现 Interaction Layer 的 Subscription（`SW-1`），`kind` MUST 为 `'state'`（`SW-2`），且 MUST NOT 覆盖 `Subscription.mode`（`SW-3`）。

每个变更同时是一个可确认的消费单元：`StateUpdateEvent` 携带 `type`（`set` 或 `deleted`）、`key`、`revision`，以及当且仅当 `type` 为 `set` 时出现的 `value`（`§41.1`）。删除变更同样 MUST 被观察（`DEL-3`、`SW-8`）。

消费接口按序列取得变更并逐个确认（`§41.2`）。确认动作与 Interaction Layer 一致：`ack()` MUST 将 cursor 置为 `max(cursor, 本变更的 revision)`，`nack()` MUST NOT 推进 cursor 且该变更 MUST 在下一次迭代重新投递（`§41.3`）。

初始位置默认 `'latest'`（`SW-9`），锚点 MUST 在 `watch()` 返回之前解析完成（`§41.4`），因此返回后 `watcher.cursor` 必然非 undefined。变更发现是可选能力：Transport 不提供 `waitForChange` 时 MUST 以 `pollIntervalMs` 轮询，MUST NOT 无等待忙轮询（`§41.5`）。

观察范围由 `StatePattern` 给出：精确匹配、前缀匹配或全部，校验 MUST 逐字段进行，属性数量、属性名与取值都必须匹配 `§42` 的合法形状（`§42`、`API-9`）。

## 常见误用

- "引入 `pending` 结构或只推进到第一个未 ack 项之前"：`§41.3` 明确禁止，理由是它与 `§26.4`"ack 一个更新的游标意味着放弃中间项"冲突。
- "只提供确认而不提供拒绝"：`§41.2` 规定只提供其一的类型不是合法的 [`AckContext`](./ack-context.md)，`SW-10` 要求实现完整的 AckContext。
- "把 `mode` 覆盖为 `state`"：`SW-3` 规定 StateWatcher MUST NOT 覆盖 `Subscription.mode`。
- "只按属性名校验 `StatePattern`"：`§42` 规定校验 MUST 逐字段，`{ all: false }`、`{ key: '' }`、同时出现 `key` 与 `prefix` 等形状 MUST 返回 `EAPP_STATE_PATTERN_INVALID`。

## 相关

- [`Subscription`](./subscription.md) —— 被收窄的 Interaction Layer 语义（`SW-1`）
- [`AckContext`](./ack-context.md) —— 完整的 `ack` / `nack`（`SW-10`、`SW-12`）
- [`StateChannel`](./state-channel.md) —— `watch()` 的落点（`API-5`）
- [`StateCell`](./state-cell.md) —— 观察对象所处的单元（`§38`）
- [`StateSnapshot`](./state-snapshot.md) —— 恢复写入的变更同样必须被观察（`SNAP-8`）
- [规范 §41](../spec/eapp.md) 与 [规范 §42](../spec/eapp.md) —— 观察者与模式校验

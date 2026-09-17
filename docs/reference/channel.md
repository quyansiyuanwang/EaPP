# Channel

它是交互发生的地方 —— 由 Binding 派生，携带模式与投递保证。

| | |
|---|---|
| **层** | Interaction Layer |
| **规范** | `§22`、`§32` |
| **不变量** | `CH-1…CH-6`、`CC-1…CC-9` |
| **稳定度** | FROZEN |

## 语义

Composition Core 唯一可观察的 Channel 形态是 `ChannelRef`，它只有 `id` 与派生它的 `binding` 两个字段（`§13.1`）。`Channel` 在 `ChannelRef` 之上增加 `mode`、`delivery` 与 `state` 三个字段（`§22.1`）。

`ChannelMode` 的取值是 `request` / `event` / `stream` / `state`，四种模式已冻结（`§23`）。一个 Channel MUST 恰好有一种模式（`§23`），`mode` MUST NOT 在生命周期内改变（`CH-5`），且 MUST 由调用方显式指定（`CC-3`）。

Channel 生命周期不独立于它的 Binding：`ACTIVE` 的 Binding 对应 `OPEN` 或 `ACTIVE` 的 Channel，`DORMANT` 对应 `DRAINING`，`CLOSED` 对应 `CLOSED`（`§22.4`）。Binding 进入 DORMANT 时 Channel MUST 进入 `DRAINING`，Binding 恢复 `ACTIVE` 时 Channel MUST 回到 `ACTIVE`（`CC-2`）。`DORMANT` 对应 `DRAINING` 而不是 `CLOSED`，是为了不丢弃在途消息。

创建路径是三段式：`bind()` 得到 Binding，`createChannel({ binding, mode, delivery })` 得到 Channel，`configure()` 得到 [`StateChannel`](./state-channel.md)（`§32`、`§44.1`）。一个 Binding MAY 派生多个 Channel，各自 mode 不同（`CC-9`）。

## 常见误用

- "把 `Channel` 当成独立于 Binding 的资源"：`CH-1` 规定一个 Channel 对应恰好一个 Binding，`CC-1` 规定 Channel MUST NOT 独立于 Binding 存在。
- "把 `DORMANT` 的 Binding 对应的 Channel 直接关闭"：`CC-2` 要求它进入 `DRAINING`，`§22.4` 说明这是为了等待在途消息完成。
- "在 Channel 生命周期内改写 `mode` 或 `delivery`"：`CH-5` 与 `CH-6` 分别禁止二者在生命周期内改变。
- "在裸 `Channel` 上调用状态操作"：`IX-3` 规定 State Mode MUST NOT 向 Channel 引入新原语，`get` / `set` / `watch` / `snapshot` 只出现在 StateChannel 视图上（`§48.1`）。

## 相关

- [`Binding`](./binding.md) —— 派生 Channel 的关系（`CC-1`、`CC-2`）
- [`messages`](./messages.md) —— 三种消息传递模式的信封（`§23.1`）
- [`Subscription`](./subscription.md) —— 从 Channel 消费的单元（`SUB-1`）
- [`StateChannel`](./state-channel.md) —— `mode` 收窄为 `'state'` 的视图（`IX-6`）
- [`Transport`](./transport.md) —— Channel 由它承载（`TR-4`）
- [规范 §22](../spec/eapp.md) 与 [规范 §32](../spec/eapp.md) —— Channel 的边界与创建路径

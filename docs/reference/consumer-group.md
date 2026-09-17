# ConsumerGroup

它是"谁和谁在竞争"—— 可靠竞争消费的命名作用域。

| | |
|---|---|
| **层** | Interaction Layer |
| **规范** | `§28` |
| **不变量** | `CG-1…CG-8` |
| **稳定度** | FROZEN |

## 语义

[`Subscription`](./subscription.md) 回答"谁在参与"，ConsumerGroup 回答"谁和谁在竞争"（`§28.1`）。

同一 Channel 上可以有多个组。组之间各自持有独立 cursor，每个组都收到全部消息；组之内每条消息只交给一个成员，成员之间竞争（`§28.1`、`CG-4`）。

组名在同一 Channel 内唯一（`CG-1`）。组的所有成员 MUST 共享恰好一个 cursor（`CG-2`）。

竞争由 [`Lease`](./lease.md) 提供机制：一次 claim 就是一次 Lease，`L-2` 保证同一 cursor 不被两个 ACTIVE Lease 持有，组不需要重新发明排他性（`§28.3`）。

组 cursor 是组内已 ack 位置的最大值，与 `§26.4` 一致（`§28.3`）；一个成员 ack 更靠后的位置即声明它之前的位置都已了结，中间未 ack 的项被显式放弃，这不违反 `CR-3`。

成员身份通过既有的 `SubscriptionOptions` 表达，不引入新的订阅类型（`§28.2`）。一次 claim 的持有上限由 `claimTtlMs` 给出，超时后该位置归还给组（`§28.2`、`CG-6`）。

## 常见误用

- "用最小未了结位置替代组 cursor"：`§28.3` 规定实现 MUST NOT 这样做，理由是它会让掉队成员永久拖住整个组，并与 `§26.4` 已冻结的语义冲突。
- "让组独立于 Channel 存在"：`CG-7` 规定 ConsumerGroup MUST NOT 独立于其 Channel 存在。
- "认为一个成员离开会使组停滞"：`CG-5` 规定一个成员离开 MUST NOT 使该组停滞。
- "为竞争消费引入新的订阅类型"：`§28.2` 规定成员身份通过既有的 `SubscriptionOptions` 表达，`CG-8` 要求 `group` 模式的 Subscription 指名同一 Channel 上的一个 ConsumerGroup。

## 相关

- [`Lease`](./lease.md) —— 一次 claim 对应的临时所有权（`§28.3`）
- [`Cursor`](./cursor.md) —— 组共享位置与推进规则（`§26.4`）
- [`Subscription`](./subscription.md) —— 成员身份的既有表达方式（`SUB-4`）
- [`Channel`](./channel.md) —— 组所属的通道（`CG-7`）
- [规范 §28](../spec/eapp.md) —— ConsumerGroup 的语义与不变量

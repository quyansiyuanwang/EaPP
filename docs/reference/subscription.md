# Subscription

它是"谁在参与"—— 持有独立游标的消费单元序列。

| | |
|---|---|
| **层** | Interaction Layer |
| **规范** | `§27` |
| **不变量** | `SUB-1…SUB-9` |
| **稳定度** | FROZEN |

## 语义

`Subscription` 是一个消费单元 `T` 的序列（`§27.1`）。`T` MUST 携带 [`AckContext`](./ack-context.md)；在 State 模式下 `T` 即 `StateUpdateEvent`（`§27.1`）。

两种模式被冻结：`exclusive` 是默认，每个订阅持有独立 cursor 并收到全部匹配项；`group` 时同组订阅共享一个 cursor 并竞争消费（`§27.1`）。`mode` 为 `group` 时 `group` MUST 非空（`SUB-4`），且该 Subscription MUST 指名同一 Channel 上的一个 [`ConsumerGroup`](./consumer-group.md)（`CG-8`）。

`cursor` MUST 在 Subscription 创建返回之前被解析为非 undefined 值（`SUB-9`）。锚点的解析方式见 [`Cursor`](./cursor.md) 的 `§26.2`：锚点 MUST 立即解析，MUST NOT 延迟到首次迭代。

三个操作的语义是封闭的：`suspend()` 停止投递而已 yield 未 ack 的项仍然有效，`resume()` 从当前 cursor 继续且 MUST NOT 重投已 ack 的项，`close()` 终止迭代（挂起的 `next()` resolve 为 `done`）且幂等（`§27.2`、`SUB-5`、`SUB-6`、`SUB-7`）。

Subscription MUST NOT 独立于 Channel 存在（`SUB-1`）；`exclusive` 订阅之间互不影响（`SUB-3`）。

## 常见误用

- "认为 `exclusive` 订阅可以省略游标"：`SUB-2` 规定 `mode === 'exclusive'` 时 Subscription MUST 有独立 cursor，`SUB-9` 要求它在创建返回前已解析。
- "把锚点留到首次迭代再解析"：`§26.2` 规则 5 规定锚点 MUST 在订阅创建时立即解析（eager），`SUB-9` 是它的落点。
- "认为 `close()` 之后 ack 会抛错"：`SUB-8` 规定 `close()` 之后对已 yield 项调用 `ack()` MUST 为 no-op，MUST NOT 抛错、MUST NOT 改变 cursor。
- "让 `group` 模式省略组名"：`SUB-4` 规定 `mode === 'group'` 时 `group` MUST 非空，`CG-8` 要求它指向一个 ConsumerGroup。

## 相关

- [`Cursor`](./cursor.md) —— 订阅持有的位置及其锚点解析（`§26.2`）
- [`AckContext`](./ack-context.md) —— 每个消费单元携带的确认句柄（`§29`）
- [`ConsumerGroup`](./consumer-group.md) —— `group` 模式的竞争作用域（`§28`）
- [`Channel`](./channel.md) —— 订阅所属的通道（`SUB-1`）
- [`StateWatcher`](./state-watcher.md) —— 在 Subscription 之上收窄为状态变更（`SW-1`）
- [规范 §27](../spec/eapp.md) —— Subscription 的定义、操作与不变量

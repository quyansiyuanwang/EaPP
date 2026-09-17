# 模式消息

它是三种消息传递模式的冻结信封。

| | |
|---|---|
| **层** | Interaction Layer |
| **规范** | `§23.1` |
| **不变量** | `RQ-1…RQ-4`、`EV-1…EV-3`、`ST-1…ST-4` |
| **稳定度** | FROZEN |

## 语义

`request` / `event` / `stream` 三种消息传递模式各有一个冻结的信封：`RequestMessage`、`ResponseMessage`、`EventMessage`、`StreamMessage`（`§23.1`）。它们属于 Interaction Layer，上层 MUST 使用它们而不得自创形状。

`state` 模式的运行时语义由 State Mode 定义（`§23`），其消费单元是 [`StateWatcher`](./state-watcher.md) 产出的 `StateUpdateEvent`。

请求-应答是一个配对关系：每个 request MUST 有唯一 `correlationId`（`RQ-1`），一个 request MUST 对应 0 或 1 个 response（`RQ-2`），response MUST 携带与 request 相同的 `correlationId`（`RQ-3`），`deadline` 到期后 request MUST 被视为超时（`RQ-4`）。

事件是一次性通知：event MUST NOT 期待响应（`EV-1`），其投递 MAY 为零次（`EV-2`）或多次（`EV-3`）。

流式消息按 [`Cursor`](./cursor.md) 定位：`StreamMessage.cursor` 在 Channel 内全局单调递增（`ST-1`），消费者 MUST 通过 cursor 恢复（`ST-2`），已 ack 的 cursor 之前的消息 MUST NOT 被重新投递（`ST-3`），未 ack 的消息 MAY 在重连后重新投递（`ST-4`）。

实现 MAY 在信封上附加自己的字段，但 `§23.1` 已列出的字段 MUST NOT 被改名或改义。

## 常见误用

- "给信封里的字段改名或改义"：`§23.1` 规定已列出的字段 MUST NOT 被改名或改义。
- "让 event 等待应答"：`EV-1` 规定 event MUST NOT 期待响应。
- "用第二份 response 二次解决同一个调用"：`RQ-2` 规定一个 request 对应 0 或 1 个 response，`§23.2` 要求重复的 response 与对已超时请求的迟到回复 MUST 被丢弃。
- "在 `deadline` 已过之后开始执行请求"：`RQ-4` 规定到期后 request MUST 被视为超时，`§23.2` 要求此时接收方 MUST NOT 开始执行。

## 相关

- [`Channel`](./channel.md) —— 信封流经的模式载体（`§22.1`）
- [`Cursor`](./cursor.md) —— `StreamMessage.cursor` 所携带的位置（`ST-1`）
- [`AckContext`](./ack-context.md) —— 确认 stream 消息的位置（`AK-1`、`AK-2`）
- [`Delivery`](./delivery.md) —— 模式与投递保证的对应关系（`§24`）
- [规范 §23](../spec/eapp.md) —— 四种交互模式与三组信封

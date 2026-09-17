# Transport

它是"消息物理上怎么走"—— 只搬字节、只分配位置。

| | |
|---|---|
| **层** | Interaction Layer |
| **规范** | `§30` |
| **不变量** | `TR-1…TR-9` |
| **稳定度** | FROZEN |

## 语义

`Transport` 由 `id`、能力声明与三个操作构成：`send(channel, msg)`、`readAfter(channel, cursor, pattern)`、`close()`，其中 `send` 的结果是 [`Cursor`](./cursor.md)（`§30.1`）。cursor 由 Transport 分配，`send` 返回的位置 MUST 在该 Channel 内严格大于此前所有位置（`TR-8`）。

读取语义是严格开区间：`readAfter` MUST 只返回 cursor **严格大于**参数的消息（`TR-5`）；`cursor` 参数 MAY 未提供，此时 MUST 解释为"从最早已保留位置开始"（`TR-6`）；无匹配时 MUST 返回空数组且 MUST NOT 阻塞（`TR-7`）。

Transport MUST 声明自己的能力（`TR-2`），MUST NOT 伪装支持（`TR-3`）。能力声明包含 `persistent`、`ordering`、`delivery`、`supportsCursor`、`supportsLease` 与 `durabilityBoundary`（`§30.2`）。

边界是单向的：Transport MUST NOT 定义 Interaction 语义（`TR-1`），Channel MUST NOT 使用超出 Transport 能力的特性（`TR-4`）。不支持时 MUST 返回 `EAPP_UNSUPPORTED`，不支持 cursor 时 MUST 返回 `EAPP_CURSOR_UNSUPPORTED`（`TR-9`）。

`§30.3` 的能力矩阵按 `persistent` / `ordering` / `atLeastOnce` / `replay` / `cursor` / `lease` / `durabilityBoundary` 列出若干自洽组合，它不要求实现落在某一行。

## 常见误用

- "在 Transport 里定义交互语义"：`TR-1` 规定 Transport MUST NOT 定义 Interaction 语义。
- "声明支持而实际不支持"：`TR-3` 规定 Transport MUST NOT 伪装支持，`TR-2` 要求能力必须被声明。
- "让 Channel 使用超出能力声明的特性"：`TR-4` 禁止该用法，不支持的路径由 `TR-9` 给出错误码。
- "为 cursor 分配跨 Channel 可比较的位置"：`CR-1` 把全序限定在 Channel 内，`REV-8` 进一步规定跨 Transport 不可比较。

## 相关

- [`Channel`](./channel.md) —— Transport 承载的交互对象（`TR-4`）
- [`Cursor`](./cursor.md) —— Transport 分配与读取的位置（`TR-5`、`TR-8`）
- [`Delivery`](./delivery.md) —— 能力声明中的投递能力（`§30.2`）
- [`Lease`](./lease.md) —— `supportsLease` 所声明的能力（`§30.2`）
- [`StateTransport`](./state-transport.md) —— 在 Transport 之上扩展状态操作（`TS-7`）
- [规范 §30](../spec/eapp.md) —— Transport 的接口、能力声明与不变量

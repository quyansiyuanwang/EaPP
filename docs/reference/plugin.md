# Plugin

它是"什么样的东西可以被组合"—— 一个可组合实体。

| | |
|---|---|
| **层** | Composition Core |
| **规范** | `§8`、`§50`、`§51` |
| **不变量** | `P-1…P-4`、`OP-1…OP-9` |
| **稳定度** | FROZEN |

## 语义

Plugin 是"一个具有 [`Identity`](./identity.md)、可选地暴露 [`Capability`](./capability.md)、并参与 [`Lifecycle`](./lifecycle.md) 的可组合实体"（`§8.2`）。

它的形态不受约束：in-process module、process、worker、remote service、device、runtime、transport、database、AI model、UI component 均可（`§8.2`），协议不要求这些形态的实现方式相同。

每个 Plugin MUST 有唯一 Identity（`P-1`），Identity MUST NOT 在生命周期内改变（`P-3`）；`capabilities` MAY 为空（`P-2`），MAY 通过显式声明更新（`P-4`）。

`§50` 与 `§51` 把前三部分已经要求过的操作在**形状**上钉死：五个操作组是发现、连接、激活、通信、调用。表面不定义新本体，也不改变前三部分的语义（`OP-3`）；它与前三部分冲突时，以前三部分为准。

因此一个只读过规范的第三方写出的插件，应当能被另一份同样只读过规范的实现直接组合（`OP-7`）。

## 常见误用

- "把 Plugin 等同于具备固定形态的模块或进程"：`§8.2` 列出十余种形态并声明 EaPP 不要求它们实现形态相同。
- "认为 `capabilities` 必须非空"：`P-2` 规定 Plugin 的 `capabilities` MAY be empty。
- "在运行中改写 Plugin 的 Identity"：`P-3` 禁止 Identity 在生命周期内改变；可变的是能力集合（`P-4`）。
- "用范围之外的入口完成组合或调用"：`OP-1` 要求实现 MUST NOT 要求插件作者使用协议未定义的入口，`OP-2` 要求参数与结果中的类型全部在协议内定义。

## 相关

- [`Identity`](./identity.md) —— Plugin 的唯一身份（`P-1`）
- [`Capability`](./capability.md) —— Plugin 暴露的能力，多对多（`§7.3`）
- [`Lifecycle`](./lifecycle.md) —— Plugin 的参与状态与四个操作（`§10`）
- [`Binding`](./binding.md) —— 连接两个 Plugin 的关系（`B-1`）
- [`CompositionCore`](./composition-core.md) —— 表面的五个操作组（`§51`）
- [规范 §8](../spec/eapp.md) 与 [规范 §50](../spec/eapp.md) —— 本体与表面的定义

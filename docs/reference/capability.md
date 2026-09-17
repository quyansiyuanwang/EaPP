# Capability

它是"能做什么"—— 参与组合的能力声明。

| | |
|---|---|
| **层** | Composition Core |
| **规范** | `§7` |
| **不变量** | `C-1…C-7` |
| **稳定度** | FROZEN |

## 语义

`Capability` 描述一个 [`Plugin`](./plugin.md) 可以参与什么类型的组合（`§7.2`）。

它与 [`Plugin`](./plugin.md) 是多对多关系：一个 Plugin MAY 暴露多个 Capability，一个 Capability MAY 被多个 Plugin 暴露（`§7.3`、`C-4`）。

`CapabilityRef` 是对某个 Plugin 暴露的某个 Capability 版本的引用；版本 MUST 参与引用（`§7.4`、`C-5`），因此同一 Plugin MAY 同时暴露 `logging@1.0.0` 与 `logging@2.0.0`。

`Capability.version` 是 `§6.2` 四个维度里 Which revision 的承载者；版本同样参与 [`Binding`](./binding.md) 的 identity（`C-6`）。

`Constraint` 的匹配被冻结为最窄的一种：`kind` 相等**且** `value` 结构相等（`C-7`）。范围、偏序与谓词属于 Extension。

## 常见误用

- "把 Capability 当作 method list / RPC endpoint / HTTP route / 函数签名"：`§7.2` 明确否定这四种读法。
- "在 `CapabilityRef` 里省略 `version`"：`C-5` 要求 `CapabilityRef` MUST 包含 `version`。
- "把 `constraints` 当作范围或谓词匹配"：`C-7` 把 Core 的匹配钉成精确匹配，并规定更丰富的匹配属于 Extension。
- "把 `contract` 当作必需字段"：`C-3` 规定 `contract` 是可选上下文，`§16` 的冻结答案同样回答"否"。

## 相关

- [`Plugin`](./plugin.md) —— 暴露 Capability 的实体（`§7.3`）
- [`Identity`](./identity.md) —— Who 与 Which revision 的分工（`§6.2`）
- [`Binding`](./binding.md) —— `capability` 指向被连接的能力（`B-2`）
- [`Discovery`](./discovery.md) —— `Criteria` 按能力名、版本与 `constraints` 筛选（`§11.1`）
- [规范 §7](../spec/eapp.md) —— Capability、CapabilityRef 与 Constraint

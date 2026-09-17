# Discovery

它是"有哪些东西可以被组合"—— 两个操作，不是新实体。

| | |
|---|---|
| **层** | Composition Core |
| **规范** | `§11` |
| **不变量** | `D-1…D-7` |
| **稳定度** | FROZEN |

## 语义

Discovery 是围绕核心本体的操作集合，不是新实体（`§5`）。它由两个操作构成：`find(criteria, scope)` 返回 PluginRef 列表，`watch(criteria, scope)` 返回 `DiscoveryEvent` 流（`§11.1`）。

`Criteria` 按能力名、SemVer range、`constraints` 与 Identity 的字段子集筛选；`constraints` 逐条按 `C-7` 匹配（`§11.1`）。

`DiscoveryScope` 的 `trustLevel` 取 `L0` / `L1` / `L2`。这是 Trust 与 Deployment 的**分类**，而不是数值等级：`§11.2` 禁止把它解释为 `L2 > L1 > L0`，也禁止由此推导出访问关系（`D-7`）。

`find` MUST 只返回当前 Trust Scope 内可见的 Plugin（`D-1`），`watch` MUST 只对该 Scope 内的事件触发（`D-2`）。缓存 MAY 存在，但 MUST 有失效策略（`D-4`）。

`DiscoveryEvent.type` MUST 是 `added` / `removed` / `changed` 之一（`D-6`）。

## 常见误用

- "把 `trustLevel` 当作授权等级"：`§11.2` 禁止将其解释为有序等级，`D-7` 规定 Trust level MUST NOT imply ordered authorization。
- "认为发现即可组合"：`D-3` 规定 Discovery MUST NOT 保证"发现即可组合"，附录 C 的冻结答案同样为"否"，组合仍须显式 `bind`。
- "用 Discovery 替代 Binding"：`D-5` 规定 Discovery MUST NOT 成为 Binding 的替代品。
- "让 `watch` 越过 Trust Scope 触发"：`D-2` 要求 `watch` 只对当前 Trust Scope 内的事件触发。

## 相关

- [`Plugin`](./plugin.md) —— `find` 返回的对象（`D-1`）
- [`Capability`](./capability.md) —— `Criteria` 按能力名与版本筛选（`§11.1`）
- [`Binding`](./binding.md) —— 发现之后的显式组合动作（`D-3`）
- [`CompositionCore`](./composition-core.md) —— `find` 与 `watch` 所在的接口（`§12.2`）
- [规范 §11](../spec/eapp.md) —— Discovery 的操作、Trust Level 与不变量

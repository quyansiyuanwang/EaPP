# Lifecycle

它是"是否参与当前组合"—— 三态与四个操作。

| | |
|---|---|
| **层** | Composition Core |
| **规范** | `§10` |
| **不变量** | `LC-1…LC-6`、`O-5…O-8` |
| **稳定度** | FROZEN |

## 语义

Composition Core 冻结三个状态：`INACTIVE`、`ACTIVE`、`SUSPENDED`（`§10.1`）。实现 MAY 扩展 `STARTING` / `STOPPING` / `DRAINING` / `FAILED`，但 MUST NOT 破坏 Core 语义。

四个操作各有合法源：`activate` 只从 `INACTIVE`，`deactivate` 从任意状态，`suspend` 只对 `ACTIVE`，`resume` 只对 `SUSPENDED`（`§10.3`、`LC-1`、`LC-2`、`LC-3`、`LC-4`、`LC-6`）。

因此从 `SUSPENDED` 恢复 MUST 使用 `resume`，`activate` MUST NOT 用于该目的（`§10.3`）。`activate` 幂等（`O-5`）。

Lifecycle 与 [`Binding`](./binding.md) 的关系是纯派生的：Plugin 进入 `INACTIVE` 或 `SUSPENDED` 时其所有 Binding 派生为 `DORMANT`，恢复 `ACTIVE` 时重新派生，而 `deactivate` MUST NOT 直接 CLOSE Binding（`§10.4`、`O-6`、`O-7`、`O-8`）。

`SUSPENDED` 的语义是"Plugin 保留 Identity 与 Binding，但不再参与 Active Composition"（`§10.5`）；Composition Core MUST NOT 定义 `Channel` 的暂停、丢弃、缓存、排空或重新投递行为。

## 常见误用

- "用 `activate` 从 `SUSPENDED` 恢复"：`§10.3` 规定 `activate` MUST NOT 用于从 SUSPENDED 恢复，`LC-6` 要求恢复 MUST 使用 `resume`。
- "认为 `deactivate` 会 CLOSE Binding"：`§10.4` 禁止 `deactivate` 直接 CLOSE Binding，它只使 Binding 派生为 `DORMANT`（`O-6`）。
- "把 `suspend` 当作解绑"：`LC-5` 规定 SUSPENDED MUST NOT 解除 Binding，`§16` 的冻结答案同样为"否，只派生为 DORMANT"。
- "在 Core 里规定 Channel 的排空或丢弃行为"：`§10.5` 规定 Composition Core MUST NOT 定义这些行为，它们属于 Interaction Layer。

## 相关

- [`Plugin`](./plugin.md) —— 参与状态依附的实体（`§8.1`）
- [`Binding`](./binding.md) —— 随两端参与状态派生的关系（`B-5`）
- [`Channel`](./channel.md) —— Binding 派生为 DORMANT 后进入 `DRAINING`（`CC-2`）
- [`CompositionCore`](./composition-core.md) —— 四个操作的签名与分组（`§12.2`）
- [规范 §10](../spec/eapp.md) —— Lifecycle 的状态、转移与不变量

# Binding

它是"谁和谁建立了关系"—— 状态由派生规则决定。

| | |
|---|---|
| **层** | Composition Core |
| **规范** | `§9` |
| **不变量** | `B-1…B-9` |
| **稳定度** | FROZEN |

## 语义

`Binding` 是连接两个 [`Plugin`](./plugin.md) 的关系，由 `from`、`to` 与含版本的 `capability` 构成（`§9.1`）。`from` 是提供 Capability 的一方，`to` 是消费它的一方。

Binding 没有命令式的状态字段（`§9.1`）。它的稳定语义状态是 `ACTIVE`、`DORMANT`、`CLOSED`（`§9.2`），由 `§9.4` 的派生规则算出；`OPEN` / `CLOSED` 是基础属性，`OPEN` 不是稳定语义状态（`§9.3`）。

派生规则把触发源统一起来：`from` 或 `to` 进入 `INACTIVE` 或 `SUSPENDED`、或 `from` 撤回 Capability，Binding 都派生为 `DORMANT`；任一条件恢复则回到 `ACTIVE`（`§9.6`、`B-5`）。`CLOSED` 是终结状态（`B-4`）。

同一 `(from, to, capability)` 在任意时刻 MUST NOT 有多个非 CLOSED Binding，且唯一性检查与创建 MUST 原子（`§9.8`、`B-6`、`B-8`）。

Binding MUST NOT 声明消息方向、同步或异步、投递保证与序列化格式（`§9.9`）—— 那些属于 [`Channel`](./channel.md)。

## 常见误用

- "直接写入 Binding 的状态"：`B-3` 规定 Binding 状态 MUST 是派生的，MUST NOT 被直接设置。
- "把 `PENDING` 当作可对外观察的状态"：`§9.2` 规定 `PENDING` MAY 作为 `bind()` 内部事务状态存在，但 MUST NOT 对外可观察（`B-9`）。
- "认为 `suspend` 会解除关系"：`§9.6` 规定 `deactivate` 与 `suspend` 的效果相同，都派生为 `DORMANT`；`LC-5` 规定 SUSPENDED MUST NOT 解除 Binding。
- "在 Binding 上声明投递保证或消息方向"：`§9.9` 列出 Binding MUST NOT 声明的四类内容。

## 相关

- [`Plugin`](./plugin.md) —— Binding 的两端（`B-1`）
- [`Lifecycle`](./lifecycle.md) —— 任一端 INACTIVE 或 SUSPENDED 时 Binding 派生的方向（`B-5`）
- [`Capability`](./capability.md) —— `capability` 必须由 `from` 暴露（`B-2`）
- [`Channel`](./channel.md) —— 由 Binding 派生，并跟随其状态（`CC-1`、`CC-2`）
- [`CompositionCore`](./composition-core.md) —— `bind` / `unbind` / `rewire`
- [规范 §9](../spec/eapp.md) —— Binding 的定义、派生规则与不变量

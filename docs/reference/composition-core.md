# CompositionCore

它是组合层的操作入口 —— 2 个 Discovery 操作与 6 个原语。

| | |
|---|---|
| **层** | Composition Core |
| **规范** | `§12`、`§51` |
| **不变量** | `O-1…O-8`、`B-9` |
| **稳定度** | FROZEN |

## 语义

`CompositionCore` 是 8 个操作的集合：`find`、`watch`、`bind`、`unbind`、`activate`、`deactivate`、`suspend`、`resume`（`§12.2`）。其中 6 个是 Composition / Lifecycle control primitives，2 个是 Discovery operations（`§12.1`）。

操作分为两类（`§12.4`）：面向 Binding 与 Graph 的是 Composition Control（`bind` / `unbind` / `rewire`），面向 Plugin 实例的是 Lifecycle Control（`activate` / `deactivate` / `suspend` / `resume`）。

`bind` MUST 创建 [`Binding`](./binding.md)，其状态由派生规则决定（`O-1`）；`from` 未暴露目标 Capability 时 MUST 失败（`O-2`）。`unbind` MUST 将 Binding 置为 `CLOSED`（`O-3`）且 MUST 幂等（`O-4`）。`deactivate` 与 `suspend` MUST 使其所有 Binding 派生为 `DORMANT`（`O-6`、`O-7`），`resume` MUST 重新评估所有 Binding 的派生状态（`O-8`）。

高阶操作 `replace` 与 `rewire` 由其他操作组合而成，MUST NOT 引入新的语义（`§12.3`）。

`§51` 把这张操作面按五个操作组重新列出：发现、连接、激活、通信、调用。一个操作组 MUST 只含该表列出的操作。

## 常见误用

- "给高阶操作定义新语义"：`§12.3` 规定 `replace` 与 `rewire` MUST NOT 引入新的语义。
- "把 `bind` 的 `from` 理解为需求方"：`§12.2` 规定 `from` 是提供 Capability 的一方；`OP-4` 把它与 `invoke` 的调用方明确区分。
- "认为 `deactivate` 或 `suspend` 会 CLOSE Binding"：`O-6` 与 `O-7` 要求二者只使 Binding 派生为 `DORMANT`。
- "在发现与组合之间加一步注册或转写"：`OP-8` 要求 `find` 的结果 MUST 可直接作为 `bind` 与 `invoke` 的输入。

## 相关

- [`Binding`](./binding.md) —— `bind` / `unbind` 作用的对象（`O-1`、`O-3`）
- [`Lifecycle`](./lifecycle.md) —— 四个 Lifecycle 操作的语义（`LC-1…LC-6`）
- [`Discovery`](./discovery.md) —— `find` 与 `watch`（`§11.1`）
- [`Plugin`](./plugin.md) —— 表面的五个操作组（`§51`）
- [`Channel`](./channel.md) —— `createChannel` 所在的路径（`§32`）
- [规范 §12](../spec/eapp.md) —— Composition Operations 的签名与不变量

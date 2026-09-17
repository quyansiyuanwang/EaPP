# Identity

它是"这是谁"—— 三层身份，不含版本。

| | |
|---|---|
| **层** | Composition Core |
| **规范** | `§6` |
| **不变量** | `ID-1…ID-6` |
| **稳定度** | FROZEN |

## 语义

`Identity` 是 `domain` + `id` + `instance` 三层结构（`§6.1`）。

`domain` 是命名域，`id` 是逻辑身份，`instance` 是运行时实例；`instance` 在同一个 `(domain, id)` 内唯一（`ID-3`）。

身份回答的是 Who。`§6.2` 给出四个维度的承载者：Who 是 Identity，What 是 [`Capability`](./capability.md)，Which revision 是 `Capability.version`，Which runtime 是 `Identity.instance`。

`Identity` 在其生命周期内保持不变（`ID-4`），且 MUST NOT 由 [`Plugin`](./plugin.md) 自身伪造（`ID-5`）。附录 C 同样把身份组成冻结为 `domain + id + instance`（不含版本）。

## 常见误用

- "把版本号写进 `instance`"：`§6.2` 规定版本由 `Capability.version` 表达，`ID-6` 禁止 `Identity` 承载版本语义。
- "用 `Identity` 区分能力"：What 由 `Capability` 承担（`§6.2`），同一 Plugin 的多个 Capability 共享一个 Identity。
- "让 Plugin 自行签发身份"：`ID-5` 规定 `Identity` MUST NOT 由 Plugin 自身伪造；`§15.1` 把 `createIdentity(seed)` 放在 `BootstrapRuntime` 上。
- "只比较 `domain` 与 `id` 判断同一个实体"：`ID-3` 要求 `instance` 在 `(domain, id)` 内唯一，实例是身份的一部分。

## 相关

- [`Plugin`](./plugin.md) —— 持有唯一 Identity 的可组合实体（`P-1`）
- [`Capability`](./capability.md) —— 承载版本语义的一方（`§6.2`）
- [`Binding`](./binding.md) —— `capability.plugin` MUST 等于 `from`（`B-7`）
- [`StateCell`](./state-cell.md) —— `updatedBy` MUST 是已存在的 Identity（`SC-5`）
- [规范 §6](../spec/eapp.md) —— Identity 的定义与不变量

# EaPP

**Everything as a Plugin Protocol** — 万物皆插件协议

> **EaPP 是一份协议规范。** 它规定插件如何被发现、连接、激活、通信与调用，以及组合建立之后
> 各方如何互动、如何共享状态。
>
> **本仓库的交付物是规范性文本。** 它规定语义，不规定实现；语言、运行时与传输介质均不受约束。
> 合规性是实现的行为属性，与实现是否使用某一套代码无关。

---

## 1. 规范

唯一规范性正文：[`docs/spec/eapp.md`](docs/spec/eapp.md)，协议版本 `3.6.0`。

| 分卷 | 内容 |
|---|---|
| 第 I 部分 | **Composition Core**：谁和谁组合。Identity · Capability · Plugin · Binding · Lifecycle · Discovery |
| 第 II 部分 | **Interaction Layer**：组合建立之后如何互动。Channel · Subscription · ConsumerGroup · Delivery · Lease · Cursor · Transport |
| 第 III 部分 | **State Mode**：如何共享状态。StateCell · Revision · StateUpdate · StateWatcher · Snapshot |
| 第 IV 部分 | **插件开发表面**：五个操作组的统一形状。它规定形状，不引入新语义 |

依赖方向单向：

```
Composition Core  →  Interaction Layer  →  State Mode  →  Transport
```

```
不变量        226 条，全部在正文中被陈述（清单见附录 B）
章节          54 节，编号连续
错误码        36 个（登记见附录 D）
```

---

## 2. 五个操作

插件作者的全部组合工作由六个操作组完成（规范 §51）：

| 操作组 | 操作 | 规范出处 |
|---|---|---|
| **装载** | `register`、`unregister` | §8.4 |
| **发现** | `find`、`watch` | §12.2 |
| **连接** | `bind`、`unbind`、`createChannel` | §12.2 · §32 |
| **激活** | `activate`、`deactivate`、`suspend`、`resume` | §12.2 |
| **通信** | `send`、`subscribe`，以及消费单元自带的 `ack` / `nack` | §30.1 · §27.1 · §29 |
| **调用** | `invoke` | §52 |

六个操作组构成的**表面不是第四层**。它不含新的本体，也不改变前三部分的语义：
它把前三部分已经要求过的操作，在名称、参数、结果与错误码上钉死，使两份互不相识的实现所写出的
插件能够互相组合（`OP-1`…`OP-9`）。

---

## 3. 文档

| 目的 | 文档 |
|---|---|
| 理解协议结构 | [概念：分卷与五个操作](docs/guides/concepts.md) |
| 从零开始 | [快速上手](docs/guides/getting-started.md) |
| 编写插件 | [写一个插件](docs/guides/write-a-plugin.md) |
| 实现 Transport | [实现一个 Transport](docs/guides/write-a-transport.md) |
| 用另一种语言实现 | [用另一种语言实现 EaPP](docs/guides/implement-in-another-language.md) |
| 表达协议之外的语义 | [写一个 Extension](docs/guides/write-an-extension.md) |
| 查一个实体的语义 | [参考索引](docs/README.md#参考) |
| 读规范性文本 | [规范](docs/spec/eapp.md) |
| 知道为什么这样定 | [设计依据](docs/rationale.md) |
| 提出语义变更 | [变更提案](rfcs/README.md) |

`docs/spec/` 是唯一的语义来源。参考页与指南都是它的解释，与它冲突时以它为准。

---

## 4. 验证

```bash
npm run verify
```

两个闸门，检查的是**规范文本是否自洽**：

```bash
npm run check:spec   # 章节编号连续；每处 § 引用都能解析；每条声明的不变量都在正文中被陈述；
                     # 正文不链接到 docs/spec/ 之外；正文不点名任何实现
npm run check:docs   # 每条相对链接解析到真实文件；正文语域符合 docs/STYLE.md §5
```

它们**不**检查某个实现是否正确。一个实现的合规性由它自己的测试与一致性声明证明（规范 §3.1、§3.2）：
每个不变量 MUST 至少有一个对应的测试用例，且不适用的不变量 MUST NOT 被静默省略。

---

## 5. 实现与检查工具

本仓库不含实现。两份独立实现与一个语言中立的黑盒检查工具位于 `reference` 分支：

<https://github.com/quyansiyuanwang/EaPP/tree/reference>

它们固定于协议 `3.3.0`（标签 `reference-3.3.0`），尚未同步到当前版本。

第二份实现存在的理由只有一个：**规范正文本身是否足够写出一份实现**。它由没有读过第一份的人、
只对着规范正文写出。两份实现可以互相参照时，它们会在同一个地方一起犯错，然后双双自称合规 ——
而"合规"的判定标准恰恰是它们要共同满足的那个东西。跨实现检查工具不引用任何一方的代码。

规范的历史版本以标签锚定：`spec-3.3.0` 是合并为单一正文之前的三份分层文档。

---

## 6. 仓库结构

```
docs/
├── spec/eapp.md   规范性：唯一的协议正文
├── reference/     非规范性：实体索引，一实体一页
├── guides/        非规范性：按任务组织的指南
├── rationale.md   非规范性：每条规则为什么是这样
└── STYLE.md       非规范性：本仓库怎么写文档

rfcs/              改变语义的规范变更提案
tools/             两个文档闸门，无依赖，只用 Node 内置模块
```

工具链：Node ≥ 20。闸门只用内置模块，因此没有依赖需要安装。

---

## 7. 参与

参见[贡献指南](CONTRIBUTING.md)与[治理](GOVERNANCE.md)。

规范是本项目的主要交付物。修改一处语义的成本高于修改多处实现，因此规范变更所受约束严于代码变更。

---

## 8. 许可

[MIT](LICENSE)

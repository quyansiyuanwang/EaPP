# EaPP

**Everything as a Plugin Protocol** — 万物皆插件协议

> **EaPP 是一套三层插件协议**：Composition Core 定义谁和谁组合，Interaction Layer 定义组合后如何互动，
> State Mode 定义如何共享状态。三层单向依赖，每层可独立替换。
> 任何语言、任何运行时、任何传输，只要实现这些语义，就能互通。
>
> 它不是一个框架，不是一个库，不是一个运行时。**它是协议规范。**

```bash
pnpm install
pnpm run verify   # typecheck + 一致性套件 + 两道闸门
pnpm run demo     # 三个互不相识的插件，端到端跑一遍
```

---

## 三层

```
Composition Core   (v3.0)   谁和谁组合          Identity · Capability · Plugin · Binding · Lifecycle · Discovery
        │  单向依赖
        ▼
Interaction Layer  (v3.1)   组合后如何互动      Channel · Subscription · ConsumerGroup · Delivery · Lease · Cursor
        │
        ▼
State Mode         (v3.2)   如何共享状态        StateCell · Revision · StateUpdate · StateWatcher · CAS
        │
        ▼
Transport                   消息物理上怎么走     Memory · Socket · Redis · NATS
```

五个动作：**发现 · 连接 · 激活 · 通信 · 调用**。

---

## 状态

| 层 | 规范 | 实现 |
|---|---|---|
| v3.0.0-core | ✅ FROZEN | ✅ |
| v3.1.0-interaction | ✅ FROZEN | ✅ |
| v3.2.0-state | ✅ FROZEN | ✅ |

```
不变量覆盖   209 / 209     冻结闸门 PASS
测试         149 passed    typecheck clean    doc links resolve
标签         v3.2.0
```

---

## 文档

| | |
|---|---|
| **[文档总索引](docs/README.md)** | 全部内容的入口 |
| [概念：三层心智模型](docs/guides/concepts.md) | 先读这个 |
| [快速上手](docs/guides/getting-started.md) | 跑起来 |
| [写一个插件](docs/guides/write-a-plugin.md) | 从零写一个可组合的插件 |
| [实现一个 Transport](docs/guides/write-a-transport.md) | 换一种传输 |
| [参考](docs/README.md#参考) | 每个实体一页 |
| [规范](docs/spec/v3.0.0-core.md) | **规范性文本，唯一裁决者** |
| [一致性报告](docs/CONFORMANCE.md) | 声明了什么、没声明什么 |

> `docs/spec/` 是**规范性**的；参考页与指南解释它。
> 两者冲突时**以规范为准**。

---

## 仓库结构

```
docs/
├── spec/          规范性 —— 冻结的协议文本
├── reference/     非规范性 —— 每实体一页
├── guides/        非规范性 —— 教程与操作指南
├── analysis/      非规范性 —— 缺陷分析与评审记录
└── CONFORMANCE.md 一致性声明与已登记的偏离

packages/
├── core/               v3.0 Composition Core
├── interaction/        v3.1 Interaction Layer
├── state/              v3.2 State Mode
├── transport/memory/   参考 Transport
└── runtime/            五个动作的门面（不是第四层）

tests/conformance/      与 docs/spec 一一对应的不变量测试
tools/                  冻结闸门 + 文档链接闸门
examples/               可运行示例
```

---

## 两道闸门

**冻结闸门** —— v3.0 §19.2 是一条冻结条款：*每个不变量 MUST 至少有一个对应的测试用例。*

```bash
pnpm run check:invariants
```

从每份规范的「不变量（冻结全集）」小节提取声明的 ID，与一致性测试中出现的 ID 求集合差。
**差集非空、或存在空测试体，即失败。** 在规范里写下一个新不变量，等于同时承诺一个测试。

**文档闸门** —— 参考页交叉引用密集，Markdown 不会告诉你链错了。

```bash
pnpm run check:docs
```

---

## 开发

```bash
pnpm run typecheck        tsc --noEmit（strict + exactOptionalPropertyTypes）
pnpm test                 vitest（直接跑源码）
pnpm run check:invariants 冻结闸门
pnpm run check:docs       文档链接闸门
pnpm run verify           以上全部
pnpm run demo             端到端演示
```

Node ≥ 20 · pnpm 10 · TypeScript 7 · vitest 5。

---

## 参与

先读 [贡献指南](CONTRIBUTING.md) 与 [治理](GOVERNANCE.md)。

一句话版本：**规范是产品，实现是它的第一份证据。**
改一处语义的成本比改十处实现高得多，所以规范变更比代码变更受到更严格的约束。

---

## 许可

[MIT](LICENSE)

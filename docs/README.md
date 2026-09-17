# EaPP 文档

**Everything as a Plugin Protocol** — 万物皆插件协议

> 一套三层插件协议：**Composition Core** 定义谁和谁组合，**Interaction Layer** 定义组合后如何互动，
> **State Mode** 定义如何共享状态。三层单向依赖，每层可独立替换。
> 任何语言、任何运行时、任何传输，只要实现这些语义，就能互通。
>
> **它不是一个框架，不是一个库，不是一个运行时。它是协议规范。**

---

## 从哪里开始

| 我想… | 读这个 |
|---|---|
| 搞懂这个协议在说什么 | [概念：三层心智模型](./guides/concepts.md) |
| 跑起来看看 | [快速上手](./guides/getting-started.md) |
| 写一个插件 | [指南：写一个插件](./guides/write-a-plugin.md) |
| 换一种传输 | [指南：实现一个 Transport](./guides/write-a-transport.md) |
| 用别的语言实现这个协议 | [指南：用另一种语言实现 EaPP](./guides/implement-in-another-language.md) |
| 查某个实体的确切语义 | [参考](#参考) |
| 读冻结的规范正文 | [规范](#规范) |
| 知道当前实现到什么程度 | [一致性报告](./CONFORMANCE.md) |

---

## 参考

每个实体一页。页首给出行号级来源（规范小节 + 实现文件 + 测试文件），
正文给签名、语义、不变量、错误、可运行示例。

### Composition Core — v3.0

| 实体 | 回答的问题 |
|---|---|
| [`Identity`](./reference/identity.md) | 这是**谁**？（不含版本） |
| [`Capability`](./reference/capability.md) | 它能**做什么**？ |
| [`Plugin`](./reference/plugin.md) | 什么样的东西可以被组合？ |
| [`Binding`](./reference/binding.md) | **谁和谁**建立了关系？ |
| [`Lifecycle`](./reference/lifecycle.md) | 它**是否参与**当前组合？ |
| [`Discovery`](./reference/discovery.md) | 有哪些东西**可以被**组合？ |
| [`CompositionCore`](./reference/composition-core.md) | 以上一切的操作入口 |

### Interaction Layer — v3.1

| 实体 | 回答的问题 |
|---|---|
| [`Channel`](./reference/channel.md) | 交互发生在**哪里**？ |
| [`Subscription`](./reference/subscription.md) | **谁在**参与？ |
| [`ConsumerGroup`](./reference/consumer-group.md) | **谁和谁在竞争**？ |
| [`Delivery`](./reference/delivery.md) | 一次投递**保证**什么？ |
| [`Lease`](./reference/lease.md) | 这份工作**谁领了**、领到什么时候？ |
| [`Cursor`](./reference/cursor.md) | 恢复到**哪里**？ |
| [`AckContext`](./reference/ack-context.md) | 如何**确认**一件事已经完成？ |
| [`Transport`](./reference/transport.md) | 消息**物理上怎么走**？ |
| [模式消息](./reference/messages.md) | request / event / stream 各自的**信封** |

### State Mode — v3.2

| 实体 | 回答的问题 |
|---|---|
| [`StateCell`](./reference/state-cell.md) | 共享的**是什么**？ |
| [`Revision`](./reference/revision.md) | 它的**版本**是什么？ |
| [`StateUpdate`](./reference/state-update.md) | 一次**变更**是什么？ |
| [`StateWatcher`](./reference/state-watcher.md) | 如何**观察**？ |
| [`StateChannel`](./reference/state-channel.md) | 状态模式的**操作面** |
| [`StateSnapshot`](./reference/state-snapshot.md) | 如何**取快照与恢复**？ |
| [`StateTransport`](./reference/state-transport.md) | Transport 要**额外**提供什么？ |

---

## 规范

`docs/spec/` 下的是**规范性文本**。参考页解释它们，示例演示它们；
两者冲突时**以规范为准**。

| 文档 | 状态 | 内容 |
|---|---|---|
| [v3.0.0-core](./spec/v3.0.0-core.md) | **FROZEN** | 五个本体、Discovery、Composition/Lifecycle 操作 |
| [v3.1.0-interaction](./spec/v3.1.0-interaction.md) | **FROZEN** | Channel / Subscription / ConsumerGroup / Delivery / Lease / Cursor |
| [v3.2.0-state](./spec/v3.2.0-state.md) | **FROZEN** | State Mode：CAS 冲突策略、Snapshot/Restore |
| [版本索引与变更记录](./spec/CHANGELOG.md) | — | 三层之间的修订、勘误与映射 |
| [决议记录](./spec/DECISIONS-v3.2.0-r3.md) | — | 每条规则**为什么**是这样 |
| [缺口分析](./analysis/GAP-ANALYSIS-v3.2.0-r2.md) | — | 原始草案的 40 条缺陷与 12 处跨文档冲突 |

```
规范性（normative）       docs/spec/
非规范性（non-normative） docs/reference/ · docs/guides/ · docs/analysis/ · docs/CONFORMANCE.md
```

---

## 一致性

> v3.0 §19.2（冻结条款）：**每个不变量 MUST 至少有一个对应的测试用例。**

这不是口号，是一条可执行的判定：

```bash
pnpm run check:invariants
```

它从每份规范的「不变量（冻结全集）」小节提取声明的 ID，
与该层一致性测试中出现的 ID 求集合差；**差集非空、或存在空测试体，即冻结失败**。

| 层 | 不变量 | 覆盖 |
|---|---|---|
| v3.0.0-core | 51 | **51 / 51** |
| v3.1.0-interaction | 74 | **74 / 74** |
| v3.2.0-state | 84 | **84 / 84** |

完整声明、合规等级与已登记的偏离见 [一致性报告](./CONFORMANCE.md)。

---

## 目录结构

```
docs/
├── guides/        非规范性：教程与操作指南
├── reference/     非规范性：实体参考（每实体一页）
├── spec/          规范性：冻结的协议文本
├── analysis/      非规范性：设计与评审记录
└── CONFORMANCE.md 一致性声明
```

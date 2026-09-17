# EaPP 文档

**Everything as a Plugin Protocol** — 万物皆插件协议

> 一份协议规范：**Composition Core** 定义谁和谁组合，**Interaction Layer** 定义组合建立之后如何互动，
> **State Mode** 定义如何共享状态，**插件开发表面** 把前三部分的操作在形状上钉死。
> 任何语言、任何运行时、任何传输，只要实现这些语义，就能互通。

---

## 从哪里开始

| 目的 | 读这个 |
|---|---|
| 搞懂这个协议在说什么 | [概念：分卷与五个操作](./guides/concepts.md) |
| 从零开始 | [快速上手](./guides/getting-started.md) |
| 写一个插件 | [指南：写一个插件](./guides/write-a-plugin.md) |
| 换一种传输 | [指南：实现一个 Transport](./guides/write-a-transport.md) |
| 用别的语言实现这个协议 | [指南：用另一种语言实现 EaPP](./guides/implement-in-another-language.md) |
| 表达协议之外的语义 | [指南：写一个 Extension](./guides/write-an-extension.md) |
| 查某个实体的确切语义 | [参考](#参考) |
| 读规范性文本 | [规范](./spec/eapp.md) |
| 知道为什么这样定 | [设计依据](./rationale.md) |
| 提出语义变更 | [变更提案](../rfcs/README.md) |
| 知道文档怎么写 | [文档标准](./STYLE.md) |

---

## 参考

`docs/reference/` 下的每一页是一个**索引页**：它说明实体是什么、定义它的规范小节、
它的不变量前缀，以及常见误用。**字段与签名不在那里** —— 它们在规范正文里，
复述一份会随规范改动的字段表是漂移的来源。

### Composition Core — 第 I 部分

| 实体 | 回答的问题 | 规范 |
|---|---|---|
| [`Identity`](./reference/identity.md) | 这是**谁**？ | §6 |
| [`Capability`](./reference/capability.md) | 它能**做什么**？ | §7 |
| [`Plugin`](./reference/plugin.md) | 什么样的东西可以被组合？ | §8 |
| [`Binding`](./reference/binding.md) | **谁和谁**建立了关系？ | §9 |
| [`Lifecycle`](./reference/lifecycle.md) | 它**是否参与**当前组合？ | §10 |
| [`Discovery`](./reference/discovery.md) | 有哪些东西**可以被**组合？ | §11 |
| [`CompositionCore`](./reference/composition-core.md) | 以上一切的操作入口 | §12 |

### Interaction Layer — 第 II 部分

| 实体 | 回答的问题 | 规范 |
|---|---|---|
| [`Channel`](./reference/channel.md) | 交互发生在**哪里**？ | §22 |
| [模式消息](./reference/messages.md) | request / event / stream 各自的**信封** | §23.1 |
| [`Delivery`](./reference/delivery.md) | 一次投递**保证**什么？ | §24 |
| [`Lease`](./reference/lease.md) | 这份工作**谁领了**、领到什么时候？ | §25 |
| [`Cursor`](./reference/cursor.md) | 恢复到**哪里**？ | §26 |
| [`Subscription`](./reference/subscription.md) | **谁在**参与？ | §27 |
| [`ConsumerGroup`](./reference/consumer-group.md) | **谁和谁在竞争**？ | §28 |
| [`AckContext`](./reference/ack-context.md) | 如何**确认**一件事已经完成？ | §29 |
| [`Transport`](./reference/transport.md) | 消息**物理上怎么走**？ | §30 |

### State Mode — 第 III 部分

| 实体 | 回答的问题 | 规范 |
|---|---|---|
| [`Revision`](./reference/revision.md) | 它的**版本**是什么？ | §37 |
| [`StateCell`](./reference/state-cell.md) | 共享的**是什么**？ | §38 |
| [`StateUpdate`](./reference/state-update.md) | 一次**变更**是什么？ | §39 |
| [`StateWatcher`](./reference/state-watcher.md) | 如何**观察**？ | §41 |
| [`StateChannel`](./reference/state-channel.md) | 状态模式的**操作面** | §44 |
| [`StateSnapshot`](./reference/state-snapshot.md) | 如何**取快照与恢复**？ | §43 |
| [`StateTransport`](./reference/state-transport.md) | Transport 要**额外**提供什么？ | §45 |

---

## 规范

`docs/spec/eapp.md` 是**唯一规范性正文**。参考页解释它，指南演示它；
两者冲突时**以规范为准**。

```
分卷             §4–§21    Composition Core
                 §22–§34   Interaction Layer
                 §35–§49   State Mode
                 §50–§54   插件开发表面

附录             A 术语表 · B 不变量全集 · C 冻结语义答案 · D 错误码全集

协议版本         3.5.0
状态             FROZEN；3.4.0 的分卷 IV 与 3.5.0 的错误码条款尚未取得评审，见 CHANGELOG.md
```

读取顺序的两点约定：

- **记法**见 §1.2：操作签名为 `op(args) -> result`，数据结构为逐字段表格，签名不标注异步性。
- **不变量的标识**见 §1.3：`XX-1` 形如的标识符在整个协议范围内唯一、稳定，测试与一致性声明都以它为准。

---

## 规范性与非规范性

```
规范性（normative）       docs/spec/
非规范性（non-normative） docs/reference/ · docs/guides/ · docs/rationale.md · docs/STYLE.md
```

非规范性文档 MUST NOT 引入新规则，也 MUST NOT 逐字复制规范正文。
发现某条语义无处可依时，那说明规范缺一条 —— 补规范，不要在文档里发明它。

---

## 目录结构

```
docs/
├── guides/        非规范性：按任务组织的指南
├── reference/     非规范性：实体索引，一实体一页
├── spec/eapp.md   规范性：唯一的协议正文
├── rationale.md   非规范性：每条规则的依据
└── STYLE.md       非规范性：文档标准

rfcs/              改变语义的提案
tools/             两个文档闸门
```

实现、示例与跨实现检查工具在 `reference` 分支上：
<https://github.com/quyansiyuanwang/EaPP/tree/reference>

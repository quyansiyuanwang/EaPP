# 快速上手

> **非规范性。** 本页给出从零开始的路径：这个仓库交付什么、规范怎么读、想做的事对应哪一节、
> 以及本仓库自己的验证方式。规范正文 [`docs/spec/eapp.md`](../spec/eapp.md) 是唯一裁决者。

---

## 1. 这个仓库交付什么

| 交付物 | 位置 | 说明 |
|---|---|---|
| 规范性正文 | [`docs/spec/eapp.md`](../spec/eapp.md) | EaPP 协议的**唯一**语义来源。协议版本 `3.6.0`，54 节，226 条不变量，四部分与四个附录 |
| 规范闸门 | `tools/check-spec.mjs` | 对那份正文自身的机械检查，见第 4 节 |
| 文档闸门 | `tools/check-docs.mjs` | 相对链接与正文语域，见第 4 节 |

**本仓库不含实现。** 参考实现与跨实现检查工具在 `reference` 分支，见第 5 节。

正文首表给出协议版本、状态与规范用语。协议版本是那份文件声明的唯一版本号，
也是 §3.2 中 `eappVersion` 报告的那个号。

---

## 2. 如何读规范

§1 是规范的读法，三小节各管一件事：

| 小节 | 管什么 |
|---|---|
| §1.1 分卷 | 四部分的职责与依赖方向：Composition Core → Interaction Layer → State Mode → Transport |
| §1.2 记法 | 操作签名、数据结构表格、示例的地位、RFC 2119 约束词 |
| §1.3 不变量的标识 | 形如 `ID-1`、`CR-1`、`CF-3` 的稳定标识符；不变量全集见附录 B |

§1.2 的记法有几条具体后果：

- 操作签名写作 `op(args) -> result`，例如 `bind(request) -> Binding`（§12.2）。
- 签名**不标注异步性**。`->` 之后写的是结果；一个操作是否 MUST 在返回之前完成语义效果，
  由该操作的条款规定，等待本身不是语义的一部分。
- 数据结构以逐字段表格给出，每个字段标注名称、类型与必需性。
- 字段名与操作名是**跨实现契约的一部分**：实现 MUST 使用这些名字，MUST NOT 改名或改义。
- 示例只用于说明，不构成规范要求。只有出现 MUST / MUST NOT / SHOULD / MAY 的陈述才是要求。

每条不变量的标识符在整个协议范围内唯一，且**不随章节调整而改变**：
测试、一致性声明与变更记录都以它为准。附录 B 按不变量首次引入的协议版本分节。

---

## 3. 想做什么就读什么

| 想做 | 起点 |
|---|---|
| 理解协议结构 | §1.1 的分卷表，再按四部分的分节名定位：§4–§21、§22–§34、§35–§49、§50–§54 |
| 写一个插件 | 第 IV 部分 §50–§54：插件开发表面的五个操作组（发现 / 连接 / 激活 / 通信 / 调用），操作清单在 §51。指南：[写一个插件](./write-a-plugin.md) |
| 实现一个 Transport | §30 `Transport` 接口与能力声明、§45 `StateTransport` 接口、§46 能力闸门与能力矩阵。指南：[实现一个 Transport](./write-a-transport.md) |
| 用另一种语言实现 | §3 一致性与合规（§3.1 测试义务、§3.2 一致性声明）、附录 B 的不变量全集。指南：[用另一种语言实现 EaPP](./implement-in-another-language.md) |
| 表达协议之外的语义 | §7.5（`C-7`）、§44.5（`CF-3`）、§49。指南：[写一个 Extension](./write-an-extension.md) |
| 查一个实体的语义 | 附录 A 给一句话定义；正文小节给字段、语义、不变量与错误码 |
| 查错误码 | 各分卷的码表在 §18、§33、§47，每个码的产生条件就在那三张表里；附录 D 是三个分卷的并集，并指出每个码的条件写在哪一节 |

---

## 4. 验证本仓库

```bash
npm run verify
```

`verify` 展开为 `npm run check:spec && npm run check:docs`：两个闸门，各查一件事。
两者都只依赖 Node 内置模块，由 `node` 直接执行，无需安装依赖；
仓库声明的运行时见 `package.json` 的 `engines.node`。

**`npm run check:spec` —— 规范正文的自我一致性。** 它只读 `docs/spec/eapp.md`：

| 规则 | 查什么 |
|---|---|
| 章节编号 | 54 节从 1 连续编到 54，无缺口、无重号 |
| 小节引用 | 正文中每个 `§N.M` 都指向真实存在的节 |
| 不变量 | 附录 B 声明的每个 ID 都在正文中被陈述过，且不被声明两次 |
| 自足性 | 正文 MUST NOT 链接到 `docs/spec/` 之外 |
| 语言中立 | 正文不出现实现引用（包名、实现目录）与语言标记的代码块 |

本页写就时的输出：

```
spec sections: 54, numbered 1..54
spec references: 113 § reference(s) checked, 0 dangling, 0 inside appendix B
spec invariants: 226 declared, 0 declared twice, 0 never stated
spec error codes: 36 registered, 0 without a stated condition
spec self-sufficiency: 0 link(s) out of docs/spec/
spec language neutrality: 0 implementation reference(s), 0 language-tagged block(s)

SPEC GATE: PASS
```

**`npm run check:docs` —— 文档的两条规则。** 它扫描仓库内全部 Markdown，
`docs/reference/_TEMPLATE.md` 除外：

| 规则 | 查什么 |
|---|---|
| 链接 | 每条**相对**链接都落到真实文件。外部 URL 不检查 |
| 语域 | 代码块之外不出现第二人称、口语标记与否定式排比（[`docs/STYLE.md`](../STYLE.md) §5） |

通过时它打印两行摘要（相对链接数、检查的文件数）。失败时以非 0 退出，
并逐条打印 `文件:行号 -> 链接`，或语域违规的原文。
两个闸门都只判定无歧义的标记，判断性的部分仍靠评审。

---

## 5. 想跑一份实现

本仓库不提供可运行的实现。参考实现与跨实现检查工具在 [`reference` 分支](https://github.com/quyansiyuanwang/EaPP/tree/reference)。

两点须注意：

- 它固定于协议 `3.3.0`（tag `reference-3.3.0`），**尚未同步到当前版本 `3.5.0`**。
  第 IV 部分（§50–§54）是 `3.4.0` 引入的分卷，`reference` 分支上还没有对应的插件开发表面。
- 它的目录、依赖与命令按它自己的版本组织，与本仓库无关。
  本仓库的验证命令只有第 4 节那两条。

---

## 下一步

- [概念：三层心智模型](./concepts.md) —— 三个问题与三层分工
- [写一个插件](./write-a-plugin.md) —— 从零写出一个能被发现、连接、激活、调用的插件
- [实现一个 Transport](./write-a-transport.md) —— 使 EaPP 运行于任意消息系统之上
- [文档索引](../README.md) —— 全部文档的入口

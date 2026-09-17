# 贡献指南

EaPP 是**协议规范**，不是框架。这一点决定了贡献的方式：改一处语义的成本，比改多处实现高得多。
**规范是产品，实现是它的证据。**

---

## 1. 先读什么

| 目的 | 文档 |
|---|---|
| 理解协议在说什么 | [`docs/guides/concepts.md`](docs/guides/concepts.md) |
| 知道规则写在哪 | [`docs/spec/eapp.md`](docs/spec/eapp.md) —— 唯一规范性正文 |
| 知道每条规则为什么是这样 | [`docs/rationale.md`](docs/rationale.md) |
| 知道文档怎么写 | [`docs/STYLE.md`](docs/STYLE.md) |
| 提出语义变更 | [`rfcs/README.md`](rfcs/README.md) |

---

## 2. 仓库结构

```
docs/
├── spec/eapp.md   规范性 —— 唯一的协议正文。语义的唯一来源。
├── reference/     非规范性 —— 实体索引，一实体一页。
├── guides/        非规范性 —— 按任务组织的指南。
├── rationale.md   非规范性 —— 每条规则的依据。
└── STYLE.md       非规范性 —— 文档标准。

rfcs/              改变语义的提案。
tools/             两个文档闸门，只用 Node 内置模块。
```

**规范性与非规范性是硬边界。** `docs/spec/` 之外的一切，在与规范冲突时都以规范为准。

**本仓库不含实现。** 实现、示例与跨实现检查工具在 `reference` 分支上，不在此分支的历史里继续演进。

---

## 3. 环境与验证

```bash
node --version    # >= 20
npm run verify    # ← 这就是"绿"的唯一定义
```

闸门只用 Node 内置模块，因此没有依赖需要安装。`verify` 依次执行：

```
npm run check:spec   章节编号连续；每处 § 引用解析到真实小节；
                     每条声明的不变量都在正文中被陈述；正文自足；正文不点名实现
npm run check:docs   每条相对链接解析到真实文件；正文语域符合 docs/STYLE.md §5
```

任一段失败即中断后续段。

**这两个闸门检查的是规范文本，不是任何实现。** 一个实现的正确性由它自己的测试证明，
而它属于实现方的仓库。规范 §3.1 要求每个不变量至少有一个对应的测试用例 ——
那条要求落在实现方，不落在本仓库。

---

## 4. 铁律：不变量必须在正文中被陈述

一条不变量只有两种合法状态：**在正文中被陈述，且在附录 B 中被列出**。
只在附录 B 的清单里出现、正文中没有对应陈述的标识符，是一个读了像规则的编号，
它会被读者和闸门一并当作完整的不变量 —— 这在本项目历史上发生过两次，
v3.1 因此丢掉了两条规则，v3.2 丢掉了十条。

`check:spec` 把它变成判定：附录 B 声明的每个 ID 必须也在附录 B 之外的正文中出现，
否则报 `UNSTATED` 并失败。

### 附带的两条禁令

- **测试与非规范性文档 MUST NOT 逐字复制规范正文。** 复制会分叉；规范改了而复制没改，
  读者就拿到了两个互相矛盾的"权威"。
- **非规范性文档 MUST NOT 引入新规则。** 写参考页时若发现某条语义无处可依，
  那说明规范缺一条 —— 去补规范，不要在文档里发明它。

---

## 5. 修改规范

规范内部按 §2.1 的版本策略分级，属于哪一级决定走哪条路：

```
3.0.x   勘误、文本澄清              就地改正文，在 CHANGELOG.md 留一条
3.x.0   新增不变量 / 等级 / 错误码    先走 rfcs/ 的提案，取得评审后落笔
4.0.0   修改既有不变量 / 分层方向     先走 rfcs/ 的提案，且须逐条论证
```

判据是**是否改变语义**，与改动大小无关。一处"澄清"若会使两个原本都能自称合规的实现
变成只有一方合规，它改变的就是语义。

### 每次规范改动都要做

1. 改变语义的，先在 [`rfcs/`](rfcs/README.md) 取得裁定
2. 改 [`docs/spec/eapp.md`](docs/spec/eapp.md)，并跑 `npm run check:spec`
3. 在 [`CHANGELOG.md`](CHANGELOG.md) 登记，给出协议版本的变化
4. 更新受影响的 `docs/reference/` 页面与 `docs/guides/` 页面
5. 依据若值得留存，写入 `docs/rationale.md`

**未能取得评审时，把缺口写出来。** 在 `rfcs/` 的状态表与规范元信息的状态行里同时写明，
而不是默认为通过。

---

## 6. 写文档

- **参考页是索引页，不复述规范。** 每页给出实体是什么、定义它的 §号、它的不变量前缀，
  以及常见误用。字段表在规范正文里，复述会漂移。
- **提到规范条款时给出具体小节号**，而不是"详见规范"。
- **链接 MUST 解析。** 相对链接指向不存在的文件会被 `check:docs` 拒绝。
  指向实现或示例的链接只能是外部 URL（`reference` 分支），因为那些路径不在本分支上。
- **代码示例与规范的语言中立化一致。** 规范用 `op(args) -> result` 的中立记法和逐字段表格，
  指南中的示例也应如此，或明确标注为说明性的伪代码。
- 中文正文，标识符与 RFC 2119 用语（MUST / MUST NOT / SHOULD / MAY）保持英文。
  详细规则见 [`docs/STYLE.md`](docs/STYLE.md)。

---

## 7. 提交与评审

提交信息用 [Conventional Commits](https://www.conventionalcommits.org/) 前缀：

```
spec(surface): invoke is an operation, not just an envelope pair
fix(spec): an interaction section referenced a §3.5 that never existed
docs(guides): write a plugin against the surface, not against a package
refactor(repo): the implementation and its gates move to the reference branch
```

评审关注四件事，按优先级：

1. **语义是否正确**，以及它是否与某条既有不变量冲突
2. **是否可被第三方判定**：一条规则若无法从外部观察，它就不是可执行的要求
3. **是否有更简单的做法**（协议层面的简洁比实现层面的简洁重要）
4. 文档是否同步

一个 PR 若修改了多处分卷语义而没有逐条论证，**会被要求拆开重来**。
这不是流程洁癖：一次改动 12 条规则时，其中 4 处互相矛盾而无人察觉，
这类矛盾只在逐条论证时才会暴露。

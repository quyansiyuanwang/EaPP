# 贡献指南

EaPP 是**协议规范**，不是框架。这一点决定了贡献的方式：
改一处语义的成本，比改十处实现高得多。**规范是产品，实现是它的第一份证据。**

---

## 1. 先读什么

| 目的 | 文档 |
|---|---|
| 理解协议在说什么 | [`docs/guides/concepts.md`](docs/guides/concepts.md) |
| 跑起来 | [`docs/guides/getting-started.md`](docs/guides/getting-started.md) |
| 知道每条规则写在哪 | [`docs/README.md`](docs/README.md) |
| 知道现在实现到什么程度 | [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) |
| 知道为什么这样定 | [`docs/spec/DECISIONS-v3.2.0-r3.md`](docs/spec/DECISIONS-v3.2.0-r3.md) |

---

## 2. 仓库结构

```
docs/
├── spec/          规范性 —— 冻结的协议文本。唯一的语义来源。
├── reference/     非规范性 —— 每个实体一页，解释并索引规范。
├── guides/        非规范性 —— 教程与操作指南。
├── analysis/      非规范性 —— 缺陷分析与评审记录。
└── CONFORMANCE.md 一致性声明与已登记的偏离。

packages/
├── core/               v3.0 Composition Core
├── interaction/        v3.1 Interaction Layer
├── state/              v3.2 State Mode
├── transport/memory/   参考 Transport（v3.1 + v3.2 接口）
└── runtime/            门面：发现 / 连接 / 激活 / 通信 / 调用

tests/conformance/      一致性测试套件（与 docs/spec 一一对应）
tools/                   冻结闸门
examples/                可运行示例
```

**规范性与非规范性是硬边界。** `docs/spec/` 之外的一切，在与规范冲突时都以规范为准。

---

## 3. 开发环境

```bash
pnpm install
pnpm run verify    # ← 这就是"绿"的唯一定义
```

`pnpm run verify` 依次执行六件事，**任何一段失败都会中断后面的段**：

```
pnpm run typecheck           ① tsc --noEmit，strict + exactOptionalPropertyTypes
pnpm test                    ② vitest（直接跑源码，无需先 build）
pnpm run examples            ③ 5 个示例真的跑得起来，且各自的自检成立
pnpm run check:invariants    ④ 冻结闸门：每条不变量至少一个测试
pnpm run check:docs          ⑤ 文档链接闸门
pnpm run conformance:external ⑥ 跨实现一致性：33 条检查 × 2 套独立实现
```

第 ⑥ 段会 `go run` 那个独立实现，所以**跑 verify 需要 Go 1.24+**。

其他命令：

```bash
pnpm run demo                        # 端到端演示：三个互不相识的插件
pnpm run example:cross-process       # 5 个真进程，跨进程演示
pnpm run conformance:list            # 跨实现检查覆盖了哪些不变量
pnpm test -- --watch                 # 监听模式
```

工具链：Node ≥ 20、pnpm 10、TypeScript 7、vitest 5、Go 1.24+。

**改了 `packages/` 里的东西，第 ⑥ 段会告诉你有没有破坏别的实现。** 它不 import
任何 `@eapp/*`，所以它看见的是协议表面 —— 参考实现内部怎么改都行，
改了行为它就会红。手册见 [`conformance/README.md`](conformance/README.md)：
覆盖了 51 条 v3.0 不变量中的哪 40 条，以及每一条没覆盖的**为什么**。

---

## 4. 铁律：不变量必须可执行

v3.0 §19.2 是一条**冻结条款**：

> 每个不变量 MUST 至少有一个对应的测试用例。

`tools/check-invariants.mjs` 把它变成判定：从每份规范的「不变量（冻结全集）」小节
提取声明的 ID，与该层测试中出现的 ID 求集合差。**差集非空、或存在空测试体，即失败。**

因此，**在规范里写下一个新不变量，等于同时承诺一个测试**。做法是让测试名里带上 ID：

```typescript
test('CG-6: an expired claim returns to the group on its own', async () => { … });
```

不适用的不变量不要静默省略 —— 要么补测试，要么在规范正文中标注
`[covered by: <路径>]` 指向真正的归属层。

### 附带的两条禁令

- **测试体不得为空。** 没有断言的 `test()` 会被闸门拒绝。
- **测试里不得硬编码 `Revision` / `Cursor` 字面量。** `REV-5` 规定它们对消费者不透明；
  在测试里写死 `'r-1'` 会把它冻结成跨 Transport 契约，让任何非内存实现都无法通过。

---

## 5. 修改规范

三层各有自己的修改规则，**互不相同**。

### v3.0.0-core —— 已冻结

§0 明确列出了 3.x 内**允许**的变更：

```
新增不变量（向后兼容扩展）· 新增合规等级 · 新增错误码（不改既有语义）
勘误（澄清歧义，不改变语义）· 新增 Extension 章节
```

以及**必须进入 4.0** 的变更：

```
修改任一不变量 · 修改 Binding 派生规则 · 修改 Lifecycle 状态转移
修改 Identity 结构 · 修改 CapabilityRef 语义 · 修改层级方向
```

### v3.1.0-interaction —— 已冻结

它的冻结方式与 v3.0 不同：**草案正文 + 本文勘误表**。
勘误表（§1）是规范性的，条目形如 `E1-n`，给出「原文 → 替换为 → 理由」。

新增不变量走正常流程；修正既有条目的歧义写进勘误表。

### v3.2.0-state —— 已冻结

r3 相对 r2 做了四**条**改变语义内核的修订（Revision 即日志位置、delete 是一等原语、
snapshot 的 head 序、CRDT 能力收紧）。它们记在
[`DECISIONS-v3.2.0-r3.md`](docs/spec/DECISIONS-v3.2.0-r3.md) 里，含每条的理由。

**任何触及语义内核的改动都必须重新走一遍 Final Review**，而不是打补丁。

### 每次规范改动都要做

1. 在 `docs/spec/CHANGELOG.md` 登记
2. 更新对应的 `docs/reference/` 页面
3. 补上不变量测试（否则闸门会拒绝）
4. 若偏离了规范，在 `docs/CONFORMANCE.md` §5 登记理由

---

## 6. 修改实现

- 实现 MUST NOT 引入规范里没有的语义。若发现规范不足，**先改规范**。
- 分层不可跨越：`core` 不依赖 `interaction`，`interaction` 不依赖 `state`。
  `packages/runtime` 是唯一允许依赖全部三层的包 —— 它是门面，不是第四层。
- 类型一层：`@eapp/core` 是唯一定义 `EappError` **类**的地方；各层只贡献自己的错误码联合。

### 当实现与规范冲突时

先确认是哪一边错了，然后：

- 规范错了 → 走 §5 的流程改规范；
- 实现错了 → 改实现，并补一个会失败的测试。

**不要**让两者无声地分叉。本项目已经出现过 6 次这种情形，全部是规范把语义留白导致的
（见 `docs/CONFORMANCE.md` §7）—— 那类修正往往比补一个 bug 更有价值。

---

## 7. 写文档

参考页 MUST 遵循 [`docs/reference/_TEMPLATE.md`](docs/reference/_TEMPLATE.md)。
要点：

- **不重复规范正文。** 参考页解释、索引、举例。
- **每条规则都要落到一个测试 ID。** 落不到说明它没被实现。
- **示例必须可运行。** 伪代码会腐烂。
- 中文正文，标识符与 RFC 2119 用语（MUST / SHOULD / MAY）保持英文。

---

## 8. 提交与评审

提交信息用 [Conventional Commits](https://www.conventionalcommits.org/) 前缀：

```
feat(interaction): ConsumerGroup as a first-class entity
fix(state): release claims when a group member departs
spec(v3.2): replace the CRDT capability exemption with stricter flags
docs(reference): add the Revision page
```

评审关注四件事，按优先级：

1. **语义是否正确**，以及它是否与某条已冻结的不变量冲突
2. **是否有测试**，且测试名里带不变量 ID
3. **是否有更简单的做法**（协议层面的简洁比实现层面的简洁重要）
4. 文档是否同步

一个 PR 若修改了冻结层的语义而没有逐条论证，**会被要求拆开重来**。
这不是流程洁癖：v3.2 的 r2 一次性改了 12 条规则，其中 4 处互相矛盾，
正是"打包修改"造成的。

# EaPP

**A general plugin composition runtime.** Discover, connect, activate, communicate, invoke — everything is a plugin.

---

## 当前状态

| 层 | 版本 | 自述状态 | 实际 |
|---|---|---|---|
| Composition | v3.0.0-core | FROZEN | ✅ 真冻结（§0） |
| Interaction | v3.1.0-interaction | — | ⚠️ **DRAFT**（文末自述，v3.2 却称其 FROZEN） |
| State | v3.2.0-state | Freeze Candidate r2 | 🟡 Final Review，与 v3.1 有 12 处冲突 |
| Runtime | — | — | ⬜ 未开始 |

工程骨架（pnpm workspace + TS strict + vitest）已就绪，尚无源码。

```
EaPP/
├── docs/
│   ├── analysis/GAP-ANALYSIS-v3.2.0-r2.md    缺口分析：40 条内部缺陷 + 12 处跨文档冲突
│   └── spec/DECISIONS-v3.2.0-r3.md           Final Review 决议：51 条裁定
├── tmp/draft/                                三份设计文档（v3.0 / v3.1 / v3.2-r2）
├── packages/                                ← 待建
│   ├── core/            组合本体：Identity / Capability / Plugin / Binding / Lifecycle / Discovery
│   ├── interaction/     Channel / Cursor / AckContext / Lease / Transport
│   ├── state/           StateCell / Revision / StateWatcher / StateUpdate
│   ├── transport/memory/内存 Transport（含 StateTransport）
│   └── runtime/         Bootstrap + Runtime：发现 / 连接 / 激活 / 通信 / 调用
└── tests/conformance/                       ← 待建
```

---

## 缺失清单（摘要）

完整分析与逐条行号见 `docs/analysis/GAP-ANALYSIS-v3.2.0-r2.md`。

**A. v3.1 没有冻结** — v3.2 头部称 `v3.1.0-interaction SEMANTIC FROZEN`，
但 v3.1 文末自述 **Draft**，§14 标题是「冻结声明（草案）」。
v3.2 把"与 v3.1 的接口一致性验证 ✅"列为已满足的冻结条件，而该基线并不存在。

**A′. v3.1 与 v3.2 有 12 处跨文档冲突** — 其中 5 处 P0：

| # | 冲突 | v3.1 | v3.2 |
|---|---|---|---|
| X-1 | ChannelMode | 已含 `'state'` | 声称自己"扩展"出 `'state'`（不实） |
| X-2 | revision 类型 | `revision: number` | `type Revision = string` |
| X-4 | AckContext | `{ack(), nack()}` | 只有 `ack()` → 不是合法 AckContext |
| X-5 | cursor 推进 | 显式 ack 可跳过中间项 | 禁止跳过（`pending` 结构，实现留空） |
| X-6 | Channel 创建 | MUST 由 Binding 派生 | 只收一个 `binding` 字符串，无实例化路径 |

**B. v3.2 自身未冻结** — 40 条，P0 级 12 条。最关键的几条：

- `delete()` 被实现为 `set({deleted:true})`，导致 `EAPP_STATE_KEY_NOT_FOUND` **结构上不可产生**；
- `readStateAfter` 返回当前值而非变更流，**同一 key 的中间变更永久丢失**，cursor 语义不可实现；
- `updatedBy` 无任何填充路径，SC-5 不可满足，参考实现只能写死占位身份；
- `expectedRevision: null` 在"已删除的 key"上，§6.2 与 §14.4 给出相反结果；
- `snapshot().maxRevision` 用 `''` 作归约种子，空快照产出非法 Revision；
- `restore` 的"overwrite"有两种读法，参考实现只写不删；
- IX-1（禁止修改 Channel）与 IX-5（允许扩展 ChannelMode）互相否证；
- `durabilityBoundary` 被当作既有能力引用，但三份文档从未定义过它。

**C. 工程层缺失** — git 仓库、workspace、构建、测试运行器、CI、文档树。（本轮已补齐骨架）

**D. 代码层缺失** — 5 个包、0 行代码；一致性测试的 helper 全部缺失。

**E. 运行时层缺失** — "发现 / 连接 / 激活 / 通信 / 调用"整体 0 覆盖。
v3.0 只定义了 `CompositionCore`（find/watch/bind/unbind/activate/deactivate/suspend/resume）
与 `BootstrapRuntime` 三个方法，**没有任何一行实现**。

---

## 路线图

```
Step 1  工程骨架       ✅ git init + pnpm workspace + TS strict + vitest + docs 树
Step 2  v3.1 收敛冻结  ← 必须先做。v3.1 是 DRAFT，且与 v3.2 冲突；
                          它一旦先冻结，X-2 / X-4 会变成两层之间的永久不兼容
Step 3  v3.2 r3       在已冻结的 v3.1 之上出 r3 → Final Review → FROZEN
Step 4  实现          packages/{core,interaction,state,transport/memory}
Step 5  一致性        conformance 全绿 + 不变量覆盖差集为空（v3.0 §19.2 的冻结义务）
Step 6  运行时        Bootstrap + Discover / Connect / Activate / Communicate / Invoke
Step 7  冻结报告      ConformanceClaim（v3.0 §19.3 的冻结接口）
```

> **顺序上的硬约束**：v3.0 已冻结，本轮不动它。
> v3.1 是 DRAFT，所以可以**直接修订**而不触发勘误流程；
> 一旦 v3.2 抢先在冲突的 v3.1 上冻结，修复成本会从"改一份草案"变成"协调两个冻结层"。

---

## 开发

```bash
pnpm install
pnpm run typecheck      # tsc --noEmit，strict + exactOptionalPropertyTypes
pnpm test               # vitest run（测试直接跑源码，无需先 build）
pnpm run verify         # typecheck + test
```

---

## 设计原则

> **Composition 决定关系。Interaction 决定互动。State 决定共享。**

```
v3.0.0-core          = Who composes with whom
v3.1.0-interaction   = How composed parties interact
v3.2.0-state         = How composed parties share state
```

规范用语遵循 RFC 2119（MUST / MUST NOT / SHOULD / MAY）。

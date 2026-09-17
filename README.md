# EaPP

**A general plugin composition runtime.** Discover, connect, activate, communicate, invoke — everything is a plugin.

---

## 当前状态

| 层 | 版本 | 状态 |
|---|---|---|
| Composition | v3.0.0-core | ⬜ 未落地 |
| Interaction | v3.1.0-interaction | ⬜ 未落地 |
| State | v3.2.0-state | 🟡 Freeze Candidate r2 → Final Review |
| Runtime | — | ⬜ 未开始 |

工程骨架（pnpm workspace + TS strict + vitest）已就绪，尚无源码。

```
EaPP/
├── docs/
│   ├── analysis/GAP-ANALYSIS-v3.2.0-r2.md   缺口分析：40 条缺陷
│   └── spec/DECISIONS-v3.2.0-r3.md          Final Review 决议：38 条裁定
├── tmp/draft/                               原始设计草案（r2）
├── packages/                                ← 待建
│   ├── core/            组合本体：Identity / Plugin / Registry / Composition
│   ├── interaction/     Channel / Subscription / Cursor / AckContext / Transport
│   ├── state/           StateCell / Revision / StateWatcher / StateUpdate
│   ├── transport/memory/内存 Transport（含 StateTransport）
│   └── runtime/         Runtime：发现 / 连接 / 激活 / 通信 / 调用
└── tests/conformance/                       ← 待建
```

---

## 缺失清单（摘要）

完整分析与逐条行号见 `docs/analysis/GAP-ANALYSIS-v3.2.0-r2.md`。

**A. 前置规范缺失** — v3.0 / v3.1 在仓库中不存在。
v3.2 依赖的 `Channel` / `Subscription` / `Cursor` / `AckContext` / `Transport` /
`Identity` / `EappError` / `SubscriptionMode` 等 17 个符号全部无定义，且全文无一条 `import`。

**B. v3.2 自身未冻结** — 40 条，其中 P0 级 12 条。最关键的几条：

- `delete()` 被实现为 `set({deleted:true})`，导致 `EAPP_STATE_KEY_NOT_FOUND` **结构上不可产生**；
- `readStateAfter` 返回当前值而非变更流，**同一 key 的中间变更永久丢失**，cursor 语义不可实现；
- `updatedBy` 无任何填充路径，SC-5 不可满足，参考实现只能写死占位身份；
- `expectedRevision: null` 在"已删除的 key"上，§6.2 与 §14.4 给出相反结果；
- `snapshot().maxRevision` 用 `''` 作归约种子，空快照产出非法 Revision；
- `restore` 的"overwrite"有两种读法，参考实现只写不删；
- IX-1（禁止修改 Channel）与 IX-5（允许扩展 ChannelMode）互相否证。

**C. 工程层缺失** — git 仓库、workspace、构建、测试运行器、CI、文档树。（本轮已补齐骨架）

**D. 代码层缺失** — 5 个包、0 行代码；一致性测试的 helper 全部缺失。

**E. 运行时层缺失** — "发现 / 连接 / 激活 / 通信 / 调用"整体 0 覆盖，共 10 项能力。

---

## 路线图

```
Step 1  工程骨架     ✅ git init + pnpm workspace + TS strict + vitest + docs 树
Step 2  三层联合收敛  v3.0 / v3.1 / v3.2 规范冻结（先定 Cursor/Revision/日志模型）
Step 3  实现         packages/{core,interaction,state,transport/memory}
Step 4  一致性       conformance 全绿 + 不变量覆盖差集为空
Step 5  运行时       E1…E10（发现 / 连接 / 激活 / 通信 / 调用）
Step 6  冻结报告     v3.2.0 FROZEN
```

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

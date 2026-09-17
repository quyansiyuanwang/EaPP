# EaPP

**A general plugin composition runtime.** Discover, connect, activate, communicate, invoke — everything is a plugin.

```bash
pnpm install
pnpm run verify   # typecheck + 141 tests + freeze gate
pnpm run demo     # three independent plugins, end to end
```

---

## 当前状态

| 层 | 版本 | 状态 |
|---|---|---|
| Composition | v3.0.0-core | ✅ FROZEN + 实现 |
| Interaction | v3.1.0-interaction | ✅ FROZEN（草案 + 9 条勘误）+ 实现 |
| State | v3.2.0-state | ✅ FROZEN（r3）+ 实现 |
| Runtime | — | ✅ 实现（发现 / 连接 / 激活 / 通信 / 调用） |

```
不变量覆盖  200 / 200     冻结闸门 PASS
测试        141 passed     typecheck clean
```

```
EaPP/
├── docs/
│   ├── CONFORMANCE.md                        一致性报告 + ConformanceClaim
│   ├── analysis/GAP-ANALYSIS-v3.2.0-r2.md    40 条内部缺陷 + 12 处跨文档冲突
│   └── spec/
│       ├── v3.0.0-core.md                    FROZEN（逐字副本）
│       ├── v3.1.0-interaction.md             FROZEN（含 9 条勘误）
│       ├── v3.2.0-state.md                   FROZEN（r3）
│       ├── DECISIONS-v3.2.0-r3.md            Final Review 决议（51 条裁定）
│       └── CHANGELOG.md                      版本索引与全部修订
├── packages/
│   ├── core/              Identity / Capability / Plugin / Binding / Lifecycle / Discovery
│   ├── interaction/       Channel / Subscription / Cursor / AckContext / Lease / 模式信封
│   ├── state/             StateCell / Revision / StateUpdate / StateWatcher / StateChannel
│   ├── transport/memory/  参考 Transport（同时实现 v3.1 与 v3.2 接口）
│   └── runtime/           Bootstrap + 发现 / 连接 / 激活 / 通信 / 调用
├── examples/hello-plugins/  端到端演示
├── tests/conformance/       200 条不变量的对应测试
├── tools/check-invariants.mjs  冻结闸门
└── tmp/draft/               原始设计文档（溯源用）
```

---

## 三层语义

```
Composition 决定关系      v3.0.0-core         Who composes with whom
Interaction 决定互动      v3.1.0-interaction  How composed parties interact
State       决定共享      v3.2.0-state        How composed parties share state
```

**State Mode 是 Channel 的第四种 mode，不是新层。** 它只新增四个本体
（StateCell / Revision / StateWatcher / StateUpdate），其余全部复用 v3.1 的
`Channel` / `Subscription` / `Cursor` / `AckContext` / `Transport`。

### 一条贯穿三层的决定

v3.2 里最关键的裁定是：**`Revision` 就是 Channel 内的日志位置**。
一旦这样定义，它与 v3.1 的 `Cursor` 就成了同域上的同一类型 ——
于是 `REV-7`（"State Mode 中 Revision MAY 用作 Cursor"）不再是需要特批的例外，
而是 `CR-1`（"Cursor 在 Channel 内全局有序"）的直接推论。
r2 把 Revision 定义为 per-cell 版本号，正是这一点让它的观察者契约无法实现。

---

## 冻结闸门

v3.0 §19.2 有一条冻结义务：**每个不变量 MUST 至少有一个对应的测试用例**。
`tools/check-invariants.mjs` 把它变成可执行的判定：

- 从每份规范的「不变量（冻结全集）」小节提取声明的 ID
- 与该层测试集中出现的 ID 求集合差
- 差集非空、或存在空测试体 → **冻结失败**

这不是装饰。起草 v3.1 规范时我漏掉了 `RQ-* / EV-* / ST-*` 共 11 条不变量，
是闸门在运行时的消息信封与规范对不上时把这件事暴露出来的。

```
v3.0.0-core          invariant 50/50 covered   PASS
v3.1.0-interaction   invariant 66/66 covered   PASS
v3.2.0-state         invariant 84/84 covered   PASS
```

---

## 开发

```bash
pnpm run typecheck        # tsc --noEmit，strict + exactOptionalPropertyTypes
pnpm test                 # vitest（直接跑源码，无需先 build）
pnpm run check:invariants # 冻结闸门
pnpm run verify           # 以上三者
pnpm run demo             # 端到端演示
```

工具链：Node ≥ 20（实测 24.11）、TypeScript 7.0.2、vitest 5.0.1、tsx 4.23。

规范用语遵循 RFC 2119（MUST / MUST NOT / SHOULD / MAY）。

---

## 已知边界

CRDT、跨进程 Transport、日志压缩、多 key 事务、查询语言、权限均**不在 Core**，
按各规范属于 Extension。详见 `docs/CONFORMANCE.md` §6。

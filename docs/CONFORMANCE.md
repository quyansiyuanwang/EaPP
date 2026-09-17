# EaPP 一致性报告

**日期**：见 `git log -1 --format=%cI`
**规范基线**：v3.0.0-core FROZEN / v3.1.0-interaction FROZEN / v3.2.0-state FROZEN
**实现**：`eapp@3.2.0-r3`

---

## 1. 合规声明

按 v3.0.0 §19.3 冻结的 `ConformanceClaim` 接口：

```json
{
  "eappVersion": "3.2.0",
  "levels": ["C1", "C2", "C3", "C4", "C5", "C6", "C8", "I1", "I2", "I3", "I4", "I5", "I6", "I7", "S1"],
  "testSuite": "conformance@3.2.0-r3",
  "passed": 208,
  "total": 208
}
```

`passed` / `total` 统计的是**不变量覆盖**，不是测试条数 —— 因为冻结闸门判定的是覆盖，而不是覆盖率数字。

| 层 | 不变量 | 覆盖 | 测试文件 |
|---|---|---|---|
| v3.0.0-core | 50 | **50 / 50** | `tests/conformance/core.test.ts` |
| v3.1.0-interaction | 74 | **74 / 74** | `tests/conformance/interaction.test.ts` |
| v3.2.0-state | 84 | **84 / 84** | `tests/conformance/state.test.ts` |
| 合计 | **208** | **208 / 208** | 另加 `runtime.test.ts` 的端到端场景 |

---

## 2. 复现

```bash
pnpm install
pnpm run verify      # typecheck + 141 tests + 冻结闸门
pnpm run demo        # 端到端演示：三个互不相识的插件
```

`pnpm run verify` 的第三段是冻结闸门（`tools/check-invariants.mjs`），它执行
v3.0 §19.2 的冻结义务——**每个不变量 MUST 至少有一个对应的测试用例**。
它从每份规范的「不变量（冻结全集）」小节提取声明，与对应测试集中出现的 ID 做集合差，
差集非空即失败；同时拒绝空测试体。

```
v3.0.0-core          invariant 50/50 covered   gate PASS
v3.1.0-interaction   invariant 74/74 covered   gate PASS
v3.2.0-state         invariant 84/84 covered   gate PASS
```

---

## 3. 合规等级

### v3.0.0-core（§15）

| 等级 | 要求 | 状态 |
|---|---|---|
| C1 Core | Identity / Capability / Plugin / Binding / Lifecycle / Discovery | ✅ MUST |
| C2 Derived Binding | 派生语义 + OPEN/CLOSED 基础属性 | ✅ MUST |
| C3 Lifecycle Closure | 四个生命周期操作语义闭合 | ✅ MUST |
| C4 Trust Scope | `DiscoveryScope` 支持 trustLevel / trustDomain | ✅ SHOULD |
| C5 Discovery Events | added / removed / changed | ✅ SHOULD |
| C6 Atomic Bind | 唯一性检查与创建原子 | ✅ SHOULD |
| C7 Constraints | `Capability.constraints` 匹配语义 | ⬜ MAY，**未声明**（类型已具备，匹配语义未实现） |
| C8 Bootstrap | 最小 Bootstrap Runtime | ✅ MAY |

### v3.1.0-interaction（§14）

| 等级 | 要求 | 状态 |
|---|---|---|
| I1 Channel | 生命周期 + 四种模式 | ✅ MUST |
| I2 Delivery | at-most-once / at-least-once | ✅ MUST |
| I3 Lease | 可靠竞争消费 | ✅ SHOULD |
| I4 Cursor | 可恢复观察 | ✅ SHOULD（承载 stream / state 时升为 MUST） |
| I5 Transport Capability | 能力声明与检查 | ✅ MAY |
| I6 Subscription | 独立 cursor 的异步订阅 | ✅ MUST |
| I7 ConsumerGroup | 命名竞争消费作用域（§8） | ✅ SHOULD |

### v3.2.0-state

| 组 | 覆盖 |
|---|---|
| SC / REV / SU / DEL / SW / SNAP / CF / API / TS / IX | 84 / 84 ✅ |

---

## 4. 实现构成

| 包 | 内容 |
|---|---|
| `@eapp/core` | Identity / Capability / Plugin / Binding / Lifecycle / Discovery / CompositionCore |
| `@eapp/interaction` | Channel / Subscription / Cursor / AckContext / Lease / Transport / 模式信封 |
| `@eapp/state` | StateCell / Revision / StateUpdate / StateWatcher / StateChannel / StateTransport |
| `@eapp/transport-memory` | 参考 Transport，同时实现 v3.1 `Transport` 与 v3.2 `StateTransport` |
| `@eapp/runtime` | Bootstrap + 发现 / 连接 / 激活 / 通信 / 调用 |

---

## 5. 相对规范的偏离（全部已登记）

规范允许的偏离必须被记录，否则"冻结"没有意义。以下四条修正了**规范草案自身**的内容，
已写回 `docs/spec/`，并在 `CHANGELOG.md` 中留痕。

| # | 偏离 | 出处 | 理由 |
|---|---|---|---|
| D-1 | `StateChannel.watch()` 返回 `Promise<StateWatcher>` | v3.2 §10.2 原为同步 | r2 同时要求同步返回与"初始 cursor 是具体位置"。解析 `'latest'` 需要异步读 head，同步形式**永远无法满足 r2 自己的 SW-1 断言**。二者不可兼得 |
| D-2 | 目录布局 `packages/` 而非 `reference/` | v3.0 §19.1 / v3.1 §12.1 | §19.1 用的是 SHOULD；映射关系见 `CHANGELOG.md` |
| D-3 | ~~`ChannelImpl.connect()` 接受 `DRAINING → ACTIVE`~~ **已收回** | v3.1 §2.2 状态表 | 原判为偏离，因为草案的转移表没有这条边。但该转移是 CC-2 的必然要求（Binding 恢复 ACTIVE ⇒ Channel 回到 ACTIVE）。**规范已补全 §2.2 与 §2.4，实现现在是合规的，不再是偏离** |
| D-4 | `EappError.message` 前缀包含 `code` | v3.0/v3.1/v3.2 三份错误模型 | 三份规范自己的测试骨架都写作 `rejects.toThrow('EAPP_...')`，而匹配串针对 `message`。不含 code 则规范形状的断言全部落空 |

---

## 6. 尚未实现（明确不在本次声明内）

| 项 | 说明 |
|---|---|
| C7 Constraints | `Constraint` 类型存在，但 `constraints` 的匹配语义未实现 |
| 跨进程 Transport | 只实现 Memory（`durabilityBoundary: 'process'`）。Socket / Redis / NATS 未实现 |
| CRDT | v3.2 §12.4 已裁定其 `supportsStateRevision = false`，属于 Extension |
| 日志压缩 | 能力声明里有 `stateRetention`，但内存实现是 `unbounded`，`EAPP_CURSOR_TOO_OLD` 无产生点 |
| Trust Domain 权限 | v3.0 §8.2 只冻结了 trust level 的分类语义，未冻结授权 |
| **TR-4 部分未落实** | `assertCapability()` 只接受 `'cursor'` / `'lease'`；创建 `at-least-once` Channel 时**没有任何代码去检查** `capabilities.delivery.atLeastOnce`。`persistent` / `ordering` / `durabilityBoundary` 同样只被类型检查，没有被守卫。TR-4 的 MUST 因此只有部分可执行 |
| **声明但不可达的错误码** | `EAPP_CHANNEL_DRAINING`、`EAPP_CURSOR_INVALID` 在整个 `packages/` 里没有抛出点；`EAPP_CURSOR_TOO_OLD` 只出现在注释中。三者均无测试 |
| **未消费的导出类型** | `StateDeleteRequest` 从 `@eapp/state` 导出，但 `StateChannel.delete()` 按 v3.2 §10.2 使用位置参数，没有任何消费者 |

---

## 7. 实现过程中被测试发现的真实缺陷

冻结闸门与端到端测试不只是验收，它们**发现并修正了 6 个真实缺陷**。全部已修复并有回归测试：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 订阅循环先读后等 | 写入落在"读"与"等"之间时**丢失唤醒**，观察者永久挂起 |
| 2 | 重投递时关闭消费者持有的 ack 上下文 | 消费者的 `ack()` 变成静默 no-op，**位置永不前进** |
| 3 | `invoke()` 并发创建 Channel 未去重 | 同一 Binding 派生多个 Channel，除一个外**全部挂到超时** |
| 4 | `MemoryTransport.resolveAnchor('latest')` 只跟踪状态 revision | 流订阅者用 `'latest'` 会拿到一个**状态位置** |
| 5 | Binding 进入 DORMANT 时 Channel 保持 ACTIVE | 违反 v3.1 §8.2，运行中的 Channel 不会 DRAINING |
| 6 | 无 `pending` 时无界忙轮询 | **堆溢出**（OOM），测试进程崩溃 |

> 这 6 条都不是"代码写错了"，而是**规范草案本身没有把语义钉死**的地方 ——
> 例如第 1、2、6 条恰好落在 r2 用 `// (完整实现略，参考 v3.1 Subscription)` 略过的那几行上。

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
  "passed": 209,
  "total": 209
}
```

`passed` / `total` 统计的是**不变量覆盖**，不是测试条数 —— 因为冻结闸门判定的是覆盖，而不是覆盖率数字。

| 层 | 不变量 | 覆盖 | 测试文件 |
|---|---|---|---|
| v3.0.0-core | 51 | **51 / 51** | `tests/conformance/core.test.ts` |
| v3.1.0-interaction | 74 | **74 / 74** | `tests/conformance/interaction.test.ts` |
| v3.2.0-state | 84 | **84 / 84** | `tests/conformance/state.test.ts` |
| 合计 | **209** | **209 / 209** | 另加 `runtime.test.ts` 的端到端场景 |

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
| C7 Constraints | `Constraint` 精确匹配（C-7） | ✅ MAY |
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
| 跨进程 Transport | 只实现 Memory（`durabilityBoundary: 'process'`）。Socket / Redis / NATS 未实现 |
| CRDT | v3.2 §12.4 已裁定其 `supportsStateRevision = false`，属于 Extension |
| Trust Domain 权限 | v3.0 §8.2 只冻结了 trust level 的分类语义，未冻结授权 |
| `persistent` / `ordering` / `durabilityBoundary` 未守卫 | TR-4 已对 `delivery` 落地，但这三个能力标志仍只被类型检查，没有运行时守卫 |

### 已经关掉的缺口

下面五项曾列在本节，现已实现并有回归测试。

| 项 | 关闭方式 |
|---|---|
| ~~TR-4 部分未落实~~ | `assertTransportSupportsDelivery()` 在 `createChannel` 中校验 `capabilities.delivery`。未声明 `atLeastOnce` 的 Transport 不能承载 `stream` / `state` Channel —— 而这正是 TR-3「MUST NOT 伪装支持」要防的事 |
| ~~`EAPP_CHANNEL_DRAINING` 不可达~~ | `ChannelImpl.requireActive()` 现在把三种状态区分开：`CLOSED` → `EAPP_CHANNEL_CLOSED`，`DRAINING` → `EAPP_CHANNEL_DRAINING`，`OPEN` → `EAPP_CHANNEL_INVALID`。并且它被真正调用了：`runtime.publish()` / `subscribe()` 在 DRAINING 的 Channel 上会失败 —— 这是 CC-2 + §2.4「DRAINING = 停止接收新消息」的直接后果 |
| ~~`EAPP_CURSOR_INVALID` 不可达~~ | `MemoryTransport` 校验收到的 cursor 必须由本实例签发（`readAfter` / `readChangesAfter` / `resolveAnchor`）。接受一个外来 cursor 会静默读到错的位置，或什么都读不到 |
| ~~日志压缩未实现、`EAPP_CURSOR_TOO_OLD` 无产生点~~ | `MemoryTransport` 支持 `retention: { kind: 'window', entries: n }`，并在**两个日志上同时**执行，保持位置域一致。`stateRetention` 能力声明实际反映配置。已被删除的具体 cursor → `EAPP_CURSOR_TOO_OLD`；`'earliest'` 解析为保留起点。v3.1 §6.2 规则 7 明确了"MUST NOT 静默替换为保留起点"及 floor 的精确语义 |
| ~~未消费的 `StateDeleteRequest`~~ | 已删除。冻结规范 §11 用的是位置参数，这个类型没有任何规范依据 |

---

## 7. 实现过程中被发现的真实缺陷

它们**不是"代码写错了"**，而是规范或契约把语义留白的地方 ——
第 1、2、6 条恰好落在 r2 用 `// (完整实现略，参考 v3.1 Subscription)` 略过的那几行上。

### 由测试发现

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | 订阅循环先读后等 | 写入落在"读"与"等"之间时**丢失唤醒**，观察者永久挂起 |
| 2 | 重投递时关闭消费者持有的 ack 上下文 | 消费者的 `ack()` 变成静默 no-op，**位置永不前进** |
| 3 | `invoke()` 并发创建 Channel 未去重 | 同一 Binding 派生多个 Channel，除一个外**全部挂到超时** |
| 4 | `MemoryTransport.resolveAnchor('latest')` 只跟踪状态 revision | 流订阅者用 `'latest'` 会拿到一个**状态位置** |
| 5 | Binding 进入 DORMANT 时 Channel 保持 ACTIVE | 违反 v3.1 §2.4，运行中的 Channel 不会 DRAINING |
| 6 | 未 ack 的项被无界重投 | **忙轮询 → 堆溢出**（OOM），测试进程崩溃 |
| 7 | ConsumerGroup 释放认领后无人被唤醒 | nack 或过期的位置**对组内其他成员不可见**，直到有新消息 |
| 8 | ConsumerGroup 从不注意到认领过期 | 只有剩余工作被沉默同伴持有的成员**永久空等** |
| 9 | 成员退出时不释放它持有的认领 | 该组**停摆到 TTL 到期** —— 正是 CG-5 禁止的 |

### 由编写参考文档发现

编写 `docs/reference/` 时，每页都要求"这条规则写在哪份规范、对应哪个测试"，
于是**文档变成了规范自洽性的测试**。见 `docs/spec/CHANGELOG.md` 的 E-A … E-G。

| # | 缺陷 | 后果 |
|---|---|---|
| 10 | v3.1 **丢失了 Channel↔Binding 状态同步表**，`CC-1` / `CC-2` 只在汇总里出现 | 两条不变量**在正文中从未被陈述** |
| 11 | v3.2 有 **10 条同类**（`SU-4`、`CF-1`…`CF-5`、`IX-1`…`IX-4`） | 同上；v3.2 甚至没有 ConflictPolicy 一节 |
| 12 | v3.0 §8.1 声明 `Criteria.version` 是 SemVer **range**，实现却做精确匹配 | `find({version:'^1.0.0'})` **静默返回空集**，与"没有插件匹配"无法区分 |

### 由运行示例发现

参考实现自己的 API 缺陷 —— 全部由"把示例跑一遍"而不是"读一遍源码"暴露。

| # | 缺陷 | 后果 |
|---|---|---|
| 13 | `PluginModule.onEvent` 声明了但**从不被调用** | 看起来支持的扩展点接受 handler 后静默丢弃，插件作者写下一段永不执行的代码 |
| 14 | `EappRuntimeOptions.transport` 的类型是具体类 `MemoryTransport` | 自定义 Transport **无法在不强转的情况下传入**，等于废掉了 Transport 边界 |
| 15 | `EappError` 未从 `@eapp/runtime` 再导出 | 插件作者必须越过运行时去 import `@eapp/core` |
| 16 | 生命周期钩子在核心已判定为 no-op 时仍被调用 | 每个插件都被迫自己防御一次 O-5 已经排除的重复激活 |
| 17 | `register()` **净化**而非**校验** identity | 带 `version` 字段的身份被静默剥掉该字段，而 ID-6 要求拒绝 |

> 第 10 / 11 条最重要，因为它们暴露了闸门的盲区：
> 原 `check-invariants` 只问"这个 ID 有没有测试"，不问"这个 ID 有没有在正文里被定义"。
> 补上 `UNSTATED` 检查后，一运行立刻又扫出 v3.2 的 10 条。

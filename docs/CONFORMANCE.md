# EaPP 一致性报告

**日期**：见 `git log -1 --format=%cI`
**规范基线**：v3.0.0-core FROZEN / v3.1.0-interaction FROZEN / v3.2.0-state FROZEN
**实现**：`eapp@3.2.0-r3`（TypeScript 参考实现）· `eapp-go`（Go 独立实现，Composition Core）

---

## 0. 两份证据

一份实现证明不了协议。它只能证明"这么写能跑通"——声明与实现出自同一支笔时，
两者之间的分歧要靠人来发现，而人恰好是写它们的那个人。

所以仓库里有**两份独立实现**，以及一个**不属于任何一方**的检查工具：

| | 是什么 | 由谁检查 |
|---|---|---|
| `packages/` | TypeScript 参考实现，三层完整 | `tests/conformance/`（同一作者写的单元测试） |
| `implementations/go/` | Go 独立实现，只做 Composition Core | 无 —— 它就是被检查的对象 |
| `conformance/` | 语言中立的 driver 协议 + harness | 不检查任何实现，只按协议问问题 |

Go 那份是**从规范正文写出来的**：写它的人被明确禁止阅读 TypeScript 实现。
这不是流程洁癖 —— 一旦可以互相参考，两套实现就会在同一个地方一起错，
而那正是"两份证据"要排除的情况。

```bash
pnpm run conformance:external     # 33 条检查 × 2 套实现
```

`conformance/README.md` 逐条列出这 33 条覆盖了 v3.0 的 51 条不变量中的**哪 40 条**，
以及每一条没覆盖的**为什么**。

---

## 1. 合规声明

按 v3.0.0 §19.3 冻结的 `ConformanceClaim` 接口：

```json
{
  "eappVersion": "3.2.0",
  "levels": ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "I1", "I2", "I3", "I4", "I5", "I6", "I7"],
  "testSuite": "conformance@3.2.0-r3",
  "passed": 210,
  "total": 210
}
```

这份声明是**参考实现**的。Go 实现只做 Composition Core，所以它的声明会小得多 ——
level 只到 `C1`–`C3`，`passed` / `total` 只算 v3.0 那一层的 40 条可外部检查的不变量。
**不做的事不声明**，见 §6。

`levels` 只列规范定义过的等级：v3.0 §15 定义 `C1`–`C8`，v3.1 §15 定义 `I1`–`I7`。
v3.2 没有定义独立的等级前缀（它的 §14 是不变量分组，不是等级）。本轮更正了两处：
删除了此前误写的 `"S1"` —— 这个字符串在任何一份规范中都不存在；并按 §3 的等级表补入 `"C7"`。

`passed` / `total` 统计的是**不变量覆盖**，不是测试条数 —— 因为冻结闸门判定的是覆盖，而不是覆盖率数字。

| 层 | 不变量 | 覆盖 | 测试文件 |
|---|---|---|---|
| v3.0.0-core | 51 | **51 / 51** | `tests/conformance/core.test.ts` |
| v3.1.0-interaction | 75 | **75 / 75** | `tests/conformance/interaction.test.ts` |
| v3.2.0-state | 84 | **84 / 84** | `tests/conformance/state.test.ts` |
| 合计 | **210** | **210 / 210** | 另加 `runtime.test.ts` 的端到端场景 |

---

## 2. 复现

```bash
pnpm install
pnpm run verify               # typecheck + 测试 + 5 个示例 + 冻结闸门 + 链接闸门
pnpm run conformance:external # 语言中立的 harness：33 条检查 × 2 套独立实现
pnpm run demo                 # 端到端演示：三个互不相识的插件
```

`pnpm run verify` 共六段（typecheck / test / examples / check:invariants / check:docs
/ conformance:external），第四段是冻结闸门（`tools/check-invariants.mjs`），它执行
v3.0 §19.2 的冻结义务——**每个不变量 MUST 至少有一个对应的测试用例**。
它从每份规范的「不变量（冻结全集）」小节提取声明，与对应测试集中出现的 ID 做集合差，
差集非空即失败；同时拒绝空测试体。

```
v3.0.0-core          invariant 51/51 covered   gate PASS
v3.1.0-interaction   invariant 75/75 covered   gate PASS
v3.2.0-state         invariant 84/84 covered   gate PASS
    note             named but not declared: SUB-5, SUB-6, SUB-7, SUB-8, SUB-9
```

v3.2 的 `note` 行不是失败：它列出测试集命名、但该层规范未声明的 ID ——
这里是 v3.1 §7 的 `SUB-5`…`SUB-9`（`state.test.ts` 用它们检验 StateWatcher 的
Subscription 合规，对应 `SW-1`）。

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

### v3.1.0-interaction（§15）

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
| `@eapp/transport-socket` | 跨进程 Transport：一个 broker 进程持有日志，其余进程通过 TCP 拿到 `SocketTransport` |
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
| CRDT | v3.2 §12.4 已裁定其 `supportsStateRevision = false`，属于 Extension |
| Trust Domain 权限 | v3.0 §8.2 只冻结了 trust level 的分类语义，未冻结授权 |

两者都是 Extension，不是缺口。

### 跨进程：哪些成立

`@eapp/transport-socket` + `examples/cross-process/`
（broker 进程 + 两个 worker 进程 + 一个 provider 进程 + 本进程）。

| 成立 | 怎么证 |
|---|---|
| 一本共享的、全序的日志 | 四个进程读写同一本；位置连续 |
| Cursor 是共享位置，在哪个进程都有效 | 一个进程分配的位置，另一个进程直接读 |
| **跨进程 CAS 不丢更新** | 两个 worker 同时 read-modify-write 同一个 key，计数器与期望值一致 |
| **跨进程竞争消费（CG-3）** | 两个 worker 进程加入**同一个**组，每条消息恰好被一个成员持有 |
| 组游标、成员数跨进程共享（CG-2） | 两个成员数得到同一个 memberCount；组游标由 broker 推进 |
| **跨进程 request/response** | 调用方注册 provider 为 remote 并 invoke；handler 在 provider 进程执行，回复经 Channel 回来 |
| 投递保证、保留窗口、`EAPP_CURSOR_TOO_OLD` | 与内存实现同一套语义，同一批测试 |
| 错误码跨边界保持 | `EAPP_REVISION_CONFLICT` 连同 `retryable` 原样到达调用方 |

跨过去的每一项，用的都是同一条原则：**"谁拥有什么"只能在数据所在的那一侧决定**。

| 需要归属的东西 | 归属放在哪 | 不这么做会怎样 |
|---|---|---|
| 位置分配 | broker 独占发号 | 两边都发出"位置 5"，`readAfter` 返回无意义的结果 |
| Channel 的 id | 由 Binding 推导 | 各进程的第一个 Channel 都叫 `ch-1`，各自读自己那本日志 |
| 竞争认领（CG-3） | broker 的组注册表 | 每个进程以为持有同一位置，消息处理两次 |
| 服务者身份（request 模式） | broker 的服务者角色 | 两个进程都跑 handler，重复回复被 correlation tracker 丢掉，调用方看不出 |
| 请求路由的"该不该应答" | 区分**可寻址**与**本进程执行**（`registerRemote` / `runtime.hosts`） | 调用方的 dispatcher 抢答 `EAPP_CAPABILITY_NOT_EXPOSED`，与真正的回复竞争 |

后两项是本轮补上的。前四项、以及"服务者角色由连接断开释放"，都遵循同一个形状：
**判定的地方必须和数据待在一起；漏掉任何一条，错误都是安静的。**

实现上：

- 组的共享状态（组游标 + 认领表）是可注入的 [`GroupStore`](../packages/interaction/src/group-store.ts)。
  默认 `LocalGroupStore` 是进程内内存；socket Transport 提供 broker 版本。
- 服务者身份是可选的 Transport 扩展
  [`ServerRoleProvider`](../packages/interaction/src/transport.ts)。Transport 声明
  `sharesServerRole` 并实现 `claimServerRole()` / `releaseServerRole()`，
  角色由连接持有，断开即释放。
- `runtime.serve(binding)` 是 provider 进程的入口；`runtime.registerRemote(manifest)`
  让调用方可以寻址一个自己并不执行的插件。两者缺一，拒绝都比假装能做更好。

### 已经关掉的缺口

下面十项曾列在本节，现已实现并有回归测试。

| 项 | 关闭方式 |
|---|---|
| ~~跨进程 Transport~~ | `@eapp/transport-socket`：一个 broker 进程独占位置分配，其余进程通过 TCP 拿到一个**真正的** `SocketTransport`（v3.1 + v3.2 全部方法）。它把 `durabilityBoundary` 诚实地声明为 `'machine'` —— 同一台机器上的每个进程都看得到，但它不持久、也不跨集群。`examples/cross-process/` 用四个真进程验证 |
| ~~跨进程的 ConsumerGroup~~ | 竞争状态（组游标 + 认领表）从进程内内存提取为可注入的 `GroupStore`，默认实现保持逐字不变的行为，socket Transport 提供 broker 版本。于是 CG-3 跨得过进程边界。在此之前这条路径会**明确失败**（TR-4），因为认领表从未出过进程 |
| ~~跨进程的请求分发~~ | 两处：`registerRemote()` / `runtime.hosts()` 把"**可寻址**"与"**本进程执行**"分开（此前调用方的 dispatcher 会为别人的 provider 抢答 `EAPP_CAPABILITY_NOT_EXPOSED`），`runtime.serve()` 是 provider 进程的入口。**每个 Channel 恰好一个服务者**由 broker 的服务者角色仲裁（`ServerRoleProvider`），连接断开即释放。两个进程同时 serve 是明确失败，不是 handler 执行两次 |
| ~~TR-4 部分未落实~~ | `assertTransportSupportsDelivery()` 在 `createChannel` 中校验 `capabilities.delivery`。未声明 `atLeastOnce` 的 Transport 不能承载 `stream` / `state` Channel —— 而这正是 TR-3「MUST NOT 伪装支持」要防的事 |
| ~~`EAPP_CHANNEL_DRAINING` 不可达~~ | `ChannelImpl.requireActive()` 现在把三种状态区分开：`CLOSED` → `EAPP_CHANNEL_CLOSED`，`DRAINING` → `EAPP_CHANNEL_DRAINING`，`OPEN` → `EAPP_CHANNEL_INVALID`。并且它被真正调用了：`runtime.publish()` / `subscribe()` 在 DRAINING 的 Channel 上会失败 —— 这是 CC-2 + §2.4「DRAINING = 停止接收新消息」的直接后果 |
| ~~`EAPP_CURSOR_INVALID` 不可达~~ | `MemoryTransport` 校验收到的 cursor 必须由本实例签发（`readAfter` / `readChangesAfter` / `resolveAnchor`）。接受一个外来 cursor 会静默读到错的位置，或什么都读不到 |
| ~~日志压缩未实现、`EAPP_CURSOR_TOO_OLD` 无产生点~~ | `MemoryTransport` 支持 `retention: { kind: 'window', entries: n }`，并在**两个日志上同时**执行，保持位置域一致。`stateRetention` 能力声明实际反映配置。已被删除的具体 cursor → `EAPP_CURSOR_TOO_OLD`；`'earliest'` 解析为保留起点。v3.1 §6.2 规则 7 明确了"MUST NOT 静默替换为保留起点"及 floor 的精确语义 |
| ~~未消费的 `StateDeleteRequest`~~ | 已删除。冻结规范 §11 用的是位置参数，这个类型没有任何规范依据 |
| ~~C7 Constraints 匹配语义~~ | 原报告写的是"未实现"，**这一条是错的**：`constraintSatisfied()` 一直在做精确匹配。真正缺的是规范从未定义"匹配"指什么。v3.0 新增 **C-7** 把它钉成「`kind` 相等 + `value` 结构相等」，C7 合规等级因此终于有规则可依 |
| ~~`persistent` / `ordering` / `durabilityBoundary` 未守卫~~ | `assertCapabilitiesCoherent()` 在 Interaction Layer 构造时执行。它拒绝两种**自相矛盾**的声明：`supportsCursor` + `ordering: 'none'`（cursor 命名的是有序序列中的位置），以及 `persistent: false` + `durabilityBoundary: 'cluster' \| 'global'`（只在内存里的东西跨不过集群边界）。TR-3「MUST NOT 伪装支持」不仅能靠单个标志撒谎，也能靠组合撒谎 |

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
于是**文档变成了规范自洽性的测试**。见 `docs/spec/CHANGELOG.md` 的 E-A … E-J。

> 最后一轮又补出两条。**E-I**（`Constraint` 匹配语义从未定义）与 **E-J** 是同一类问题的
> 不同形态：后者由写 [`implement-in-another-language.md`](./guides/implement-in-another-language.md)
> 逼出 —— 那一页要求给出一个真实的 `ConformanceClaim` 样例，而"真实"意味着它必须
> 真的成立于当前版本；一比之下发现 v3.0 §19.3 冻结的接口把 `eappVersion` 钉成 `'3.0.0'`、
> 把 `levels` 限定为 `C1`–`C8`，**v3.1 / v3.2 的实现做不出合法声明**。

| # | 缺陷 | 后果 |
|---|---|---|
| 10 | v3.1 **丢失了 Channel↔Binding 状态同步表**，`CC-1` / `CC-2` 只在汇总里出现。**已修复（r3，见 `docs/spec/CHANGELOG.md` E-A）**：恢复为 v3.1 §2.4，并在 §12 的规则块中给 `CC-1` / `CC-2` 加上指引 | 当时两条不变量**在正文中从未被陈述** |
| 11 | v3.2 有 **10 条同类**（`SU-4`、`CF-1`…`CF-5`、`IX-1`…`IX-4`、`IX-6`）。**已修复（r3，见 `docs/spec/CHANGELOG.md` E-G）**：补 §5.4 的 `SU-4`，新增 §10.5「冲突策略」（`CF-1`…`CF-5`）与 §15.1「层级隔离」（`IX-1`…`IX-4`、`IX-6`；`IX-5` 已随 R-1 删除） | 同上；当时 v3.2 甚至没有 ConflictPolicy 一节 |
| 12 | v3.0 §8.1 声明 `Criteria.version` 是 SemVer **range**，实现却做精确匹配。**已修复（r3，见 `docs/spec/CHANGELOG.md` E-E）**：`matchesCriteria` 改用 `packages/core/src/semver.ts` 的 range 匹配，不支持的语法由 `isValidRange` 明确拒绝；回归测试在 `core.test.ts` 的 §8.1 一节 | 当时 `find({version:'^1.0.0'})` **静默返回空集**，与"没有插件匹配"无法区分 |

### 由运行示例发现

参考实现自己的 API 缺陷 —— 全部由"把示例跑一遍"而不是"读一遍源码"暴露。

| # | 缺陷 | 后果 |
|---|---|---|
| 13 | `PluginModule.onEvent` 声明了但**从不被调用**。**已修复（r3）**：该扩展点已删除，`PluginModule` 不再声明 `onEvent`（`packages/runtime/src/plugin.ts`），事件与流消费走 `runtime.subscribe()`；回归测试 `runtime.test.ts` › `'the plugin contract has no onEvent hook'` | 当时它看起来是受支持的扩展点，接受 handler 后静默丢弃 |
| 14 | `EappRuntimeOptions.transport` 的类型是具体类 `MemoryTransport`。**已修复（r3）**：类型改为 v3.1 / v3.2 的接口 `StateTransport`（`packages/runtime/src/runtime.ts`）；回归测试 `runtime.test.ts` › `'the runtime accepts any StateTransport, not just the reference implementation'` | 当时自定义 Transport **无法在不强转的情况下传入**，等于废掉了 Transport 边界 |
| 15 | `EappError` 未从 `@eapp/runtime` 再导出。**已修复（r3）**：`packages/runtime/src/index.ts` 再导出 `EappError` / `isEappError`；回归测试 `runtime.test.ts` › `'the runtime re-exports the protocol error so a plugin needs one import'` | 当时插件作者必须越过运行时去 import `@eapp/core` |
| 16 | 生命周期钩子在核心已判定为 no-op 时仍被调用。**已修复（r3）**：`activate` / `deactivate` / `suspend` / `resume` 只在核心真的发生了状态转移时才调用插件钩子（`packages/runtime/src/runtime.ts`）；回归测试 `runtime.test.ts` › `'a lifecycle hook fires only when the state actually changes'` | 当时每个插件都被迫自己防御一次 O-5 已经排除的重复激活 |
| 17 | `register()` **净化**而非**校验** identity。**已修复（r3）**：`register()` 经 `assertValidIdentity` 校验，超出 `domain` / `id` / `instance` 的字段（如 `version`）抛 `EAPP_IDENTITY_INVALID`（`packages/core/src/identity.ts`）；回归测试 `runtime.test.ts` › `'register rejects an identity carrying fields beyond domain/id/instance'` | 当时带 `version` 字段的身份被静默剥掉该字段，而 ID-6 要求拒绝 |

> 第 10 / 11 条最重要，因为它们暴露了闸门的盲区：
> 原 `check-invariants` 只问"这个 ID 有没有测试"，不问"这个 ID 有没有在正文里被定义"。
> 补上 `UNSTATED` 检查后，一运行立刻又扫出 v3.2 的 10 条。

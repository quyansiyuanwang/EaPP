# EaPP — 规范版本索引与变更记录

本文件记录三个冻结层的版本、来源与全部修订。
`docs/spec/` 下的文档是**规范性**的。
三份草案原文**不在工作树中**，保留在提交 `9b78d40` 里 —— 引用它们的形式是
`git show "9b78d40:tmp/draft/<文件名>"`。

---

## 版本索引

| 版本 | 文档 | 状态 | 来源 |
|---|---|---|---|
| **v3.0.0-core** | `docs/spec/v3.0.0-core.md` | FROZEN | 冻结于协议 3.0.0。补入 C-7（E-I）与 §19.3 一致性声明接口的修正（E-J） |
| **v3.1.0-interaction** | `docs/spec/v3.1.0-interaction.md` | FROZEN | 冻结于协议 3.1.0。恢复 §2.4（E-A）、补全 §2.2 转移表（E-B）、新增 §6.2 规则 7（E-H） |
| **v3.2.0-state** | `docs/spec/v3.2.0-state.md` | FROZEN | 冻结于协议 3.2.0。补入 §5.4、§10.5、§15.1（E-G） |
| — | `../analysis/DECISIONS-v3.2.0-r3.md` | 决议记录 | Final Review 的全部裁定（D-01…D-38、R-0…R-13） |

> **关于 r2 草案。** 冻结候选 r2 存在 40 条内部缺陷（F-01…F-39）与 12 处跨文档冲突
> （X-1…X-12），已在 r3 全部关闭。逐条的裁定与理由见 `DECISIONS-v3.2.0-r3.md`；
> 该草案本身已从工作树移除，其内容不再构成任何规范文本的一部分。

---

## v3.2.0-state（r2 → r3）

### 语义内核的四条变更

| # | r2 | r3 | 关闭 |
|---|---|---|---|
| C-1 | `Revision` 是 per-cell 版本号，`REV-7` 是"例外" | `Revision` 就是 Channel 内的**日志位置**，与 v3.1 `Cursor` 同域同型 | F-05, X-2, X-3 |
| C-2 | `delete` = `set({deleted:true})` | `delete` 是 Transport **一等原语** | F-20, F-21, F-27 |
| C-3 | `maxRevision` 由 cells 归约得出（恒真式） | `maxRevision` = 读取 cells **之前**的 head | F-03, F-29 |
| C-4 | CRDT 获得 `⚠️` 豁免 | 取消豁免，收紧能力标志 | F-11 |

### 其余修订（按缺陷编号）

| 缺陷 | 修订 |
|---|---|
| F-01 | `expectedRevision: null` 只表示"从未存在"，删除参考实现里的 `!current.deleted` 例外 |
| F-02 | 引入 actor 来源链 `update.actor ?? channel.owner` |
| F-04 | `StateSnapshot` 增加 `pattern`；`restore` 增加 `mode: 'merge' \| 'replace'` |
| F-06 | 定义 `WatchOptions`；`CursorAnchor` 字面量优先解析 |
| F-07 | no-op delete 不分配 revision、不产生变更 |
| F-08 | 删除边界情况由 3 行表补全为 8 行完整表 |
| F-09 | `restore` 的每次写入 MUST 追加变更 |
| F-10 | API-4 改写为"delete 不重置计数器，返回操作后该 key 的当前 revision" |
| F-12 | 错误码归一：分层联合 + 单一 `EappError` 类 |
| F-13 | 初始 cursor 在 `watch()` 返回前 eager 解析 |
| F-14 | 删除 `pending` 结构 |
| F-15 | 新增可选 `waitForChange`，否则有界轮询 |
| F-16 | pattern 校验逐字段，拒绝 `{all:false}` / `{key:''}` |
| F-17 | `value` 存在性按属性存在判定 |
| F-18 | 测试 MUST NOT 硬编码 revision 字面量 |
| F-19 | SW-1 的 `expect(w.cursor).toBeDefined()` 因 F-13 而可满足 |
| F-22 | `EappError` 由 interface 补为 class |
| F-23 | `get`/`list` MUST 返回已逻辑删除的 cell（SC-6 / API-1 / API-2） |
| F-24 | IX-1 重写为"不得修改任何既有成员" |
| F-25 | SU-6 区分"对外无条件写入"与"revision 钉定内部原语" |
| F-26 | `nextRevision` 单参数 |
| F-28 | `expectedRevision` 只从 `StateUpdate` 读取 |
| F-30 | 新增 SUB-5/6/7/8：suspend / close / close 后 ack 的语义 |
| F-31 | 每个能力标志 MUST 有唯一的运行时后果 |
| F-32 | 寻址 MUST 用 `(channel, key)` 二元组，禁止字符串拼接（TS-13） |
| F-33 | Channel 创建路径补齐为三段式（v3.1 §11 + v3.2 §10.1） |
| F-34 | 测试体 MUST NOT 为空；REV-6 改为标注 `[covered by:]` |
| F-35 | 错误面完整性 + `retryable` 赋值规则 |
| F-36 | 投递语义对齐 v3.1 §4.3/§4.4（DL-4 / DL-5） |
| F-38 | `readChangesAfter` / `getState` / `listState` 的语义补全（TS-9…TS-15） |
| F-39 | `restoreState` 从 Transport 移除，restore 唯一入口在 Channel 层 |

### 新增不变量

```
SC-6    get / list MUST include logically-deleted cells.
SU-9    deleted, when present, MUST be true.
SW-10   StateWatcher MUST implement the full v3.1 AckContext.
SW-11   close() MUST be idempotent; no delivery after close().
SW-12   ack() / nack() after close() MUST be a no-op.
SNAP-7  restore MUST be the only public path to an unconditional write.
SNAP-8  restore MUST append a change for every write.
SNAP-9  restore MUST reject a snapshot from another channel.
TS-9..TS-15   readChangesAfter / head / nextRevision / addressing semantics.
IX-6    StateChannel MUST be a narrowing view of Channel.
```

### 删除的不变量

```
IX-5    "ChannelMode MAY be extended to include 'state'" —— 谎言：v3.1 §2.1 早已包含 'state'。
```

---

## v3.1.0-interaction（Draft → FROZEN）

草案自述为 **Draft**（文末「EaPP v3.1.0 Interaction Layer — Draft」），
而 v3.2 的文档头却称其 "SEMANTIC FROZEN"。冻结链条因此断裂 —— 见 `DECISIONS-v3.2.0-r3.md` R-0。

### 勘误

| # | 修订 |
|---|---|
| E1-1 | `StateMessage.revision` 由 `number` 改为 `Revision`（与 `Cursor` 同域） |
| E1-2 | 删除"v3.2 扩展出第四种 ChannelMode"的表述；`'state'` 是 v3.1 既有成员 |
| E1-3 | 任何消费端事件类型 MUST 同时提供 `ack()` 与 `nack()` |
| E1-4 | cursor 推进以草案 §6.4 为准：显式 ack 更靠后的位置允许放弃中间项 |
| E1-5 | 补齐 `Binding → Channel` 的创建路径（本文 §11） |
| E1-6 | 新增 `Subscription` / `SubscriptionMode` / `SubscriptionState`（本文 §7） |
| E1-7 | `durabilityBoundary` 补入 `TransportCapabilities` |
| E1-8 | 目录布局由 `reference/` 归一为 `packages/`（§19.1 用的是 SHOULD，允许偏离） |
| E1-9 | 下一版本号由 `v3.2.0 transport-capability` 更正为 `v3.2.0-state` |

### 新增不变量

```
DL-6     创建 stream / state Channel 时指定 at-most-once MUST 返回 EAPP_DELIVERY_UNSUPPORTED。
SUB-1..SUB-9   Subscription 语义。
TR-5..TR-8     Transport 读写语义。
CC-3..CC-9     Channel 创建路径。
```

### 新增错误码

```
EAPP_CURSOR_TOO_OLD        日志已压缩到无法定位请求位置
EAPP_SUBSCRIPTION_INVALID  Subscription 构造参数非法
```

### 目录布局映射

| 规范路径（草案 §12.1） | 实现路径 |
|---|---|
| `spec/` | `docs/spec/` |
| `reference/core/*` | `packages/core/src/*` |
| `reference/interaction/*` | `packages/interaction/src/*` |
| `reference/interaction/modes/state.ts` | `packages/state/src/*`（独立包，v3.2 的决定） |
| `reference/transport/memory.ts` | `packages/transport/memory/src/*` |
| `tests/conformance/*` | `tests/conformance/*` |
| `examples/*` | `examples/*` |

---

## v3.0.0-core

未改动。§0 自述「本文自发布之日起冻结」，本轮**逐字复制**，未作任何修订。

---

## 冻结后的勘误 —— 编写参考文档时发现

写 `docs/reference/` 的 23 个实体页时，每一页都要求"这条规则写在哪份规范的哪一条"，
并且要指向一个真实存在的测试。这个约束把三处**闸门查不出**的缺陷逼了出来 ——
闸门只检查"不变量有没有测试"，不检查"不变量有没有在正文里被陈述过"。

| # | 层 | 缺陷 | 修正 | 性质 |
|---|---|---|---|---|
| E-A | v3.1 | §2.4 的 Channel↔Binding 状态同步表在 r1 重写时**整段丢失**。`CC-1` / `CC-2` 只出现在 §14 的不变量汇总里，**正文中从未被陈述过** | 恢复为 §2.4，并在 §12 的规则块中给 CC-1/CC-2 加上指引 | 恢复丢失的规范性内容 |
| E-B | v3.1 | §2.2 的生命周期表缺 `DRAINING → ACTIVE`。该转移是 CC-2 的必然要求（Binding 恢复 ⇒ Channel 回到服务） | 补入 §2.2；`CONFORMANCE.md` 的 D-3 由"已登记偏离"改为"**已收回**，实现现在合规" | 补全 |
| E-C | v3.2 | §12.2 的能力闸门表写 `supportsStateWatch=false` 时 `watch()` **同步抛**，但 §10.2 / D-1 已让 `watch()` 返回 Promise | 改为"同步 API 同步抛，返回 Promise 的 API 拒绝" | 措辞澄清，不改变语义 |
| E-D | v3.2 | §12.3 仍使用改名前的标志名 `providesStateRevision`，而 §12.1 明确命名应为 `supportsStateRevision` | 统一为 `supportsStateRevision` | 措辞澄清，不改变语义 |
| E-E | v3.0 | §8.1 声明 `Criteria.version` 是 **SemVer range**，但实现对它做精确匹配（仅额外支持 `'*'`）。于是 `find({version:'^1.0.0'})` **静默返回空集** —— 与"没有插件匹配"无法区分 | 实现 SemVer range 匹配（`packages/core/src/semver.ts`）。不支持的语法由 `isValidRange` **明确拒绝**，而不是静默不匹配 | 补实现以符合冻结规范 |
| E-F | v3.1 / v3.2 | 四处源码注释与一个测试名引用了重编号前的章节（`§9` 应为 `§10`、`§8` 应为 `§9`、`§13` 应为 `§14`），另有一处注释称 cursor 宽度为 20 字符，实为 16 | 逐处更正 | 非规范性，仅影响可读性 |
| E-G | v3.2 | **同类缺陷，同一轮被闸门扫出**：`SU-4`、`CF-1`…`CF-5`、`IX-1`…`IX-4`、`IX-6` 共 10 条只出现在 §14 的汇总里，正文从未陈述。v3.2 甚至没有 ConflictPolicy 这一节 | 补 `§5.4` 的 `SU-4`、新增 `§10.5 冲突策略`（CF）、新增 `§15.1 层级隔离`（IX） | 恢复丢失的规范性内容 |
| E-H | v3.1 | §6.2 只说了"日志压缩到无法定位 `'earliest'` 时返回 `EAPP_CURSOR_TOO_OLD`"，**没有规定已被删除的具体 Cursor 该怎么办** —— 而这正是会丢消息的那一半 | 新增 §6.2 规则 7：具体 Cursor 早于保留起点时 MUST 返回 `EAPP_CURSOR_TOO_OLD`，**MUST NOT 被静默替换为保留起点**；并补上 floor 的精确语义 | 新增规则（3.x 内允许，`EAPP_CURSOR_TOO_OLD` 此前无处可产生） |
| E-I | v3.0 | §4.1 定义了 `Constraint { kind, value }`，§8.1 允许用 `Criteria.constraints` 筛选，但**从未说过"匹配"指什么**。两个实现可以各自理解成子集 / 范围 / 谓词，而都自称合规 | 新增 **C-7**：匹配 MUST 是「`kind` 相等 **且** `value` 结构相等」；更丰富的匹配属于 Extension | 新增不变量（3.x 内允许；此前 §15 的 C7 合规等级无对应规则） |
| E-J | v3.0 | §19.3 冻结的 `ConformanceClaim` 把 `eappVersion` 钉成字面量 `'3.0.0'`、把 `levels` 限定为 `C1`–`C8`。于是 **v3.1 / v3.2 的实现做不出合法声明** —— 而 v3.1 §15 恰恰定义了 `I1`–`I7` 并要求实现声明它们。声明接口由最底层拥有，却描述不了它上面的两层 | `eappVersion` 改为 `string`；`levels` 扩充为 `C1`–`C8` ∪ `I1`–`I7`，并明确 v3.2 不定义等级前缀（其覆盖度由不变量计数表达） | 修正规范自身的矛盾（补全，不新增语义） |
| E-K | v3.2 | §12.4 的能力矩阵把 Socket 一行写成状态能力全 ❌，而 `@eapp/transport-socket` 五项全 ✅、`stateConsistency: 'strong'`、`durabilityBoundary: 'machine'`。**规范与参考实现直接矛盾**：按矩阵实现 Socket 的读者会得到一个与仓库交付物不同的东西，且无从判断谁对 | 矩阵改述为"自洽的组合形状，不列举实现"，并为 Socket 给出两行（仅承载消息 / broker 持有状态）。传输介质不决定能力，两种都合法 | 修正规范自身的矛盾（补全，不新增语义） |

**E-A 与 E-G 是同一类缺陷**，它们暴露了原闸门的盲区：
`check-invariants` 验证的是"声明的 ID 有没有测试"，
**不验证"声明的 ID 有没有在规范正文里被定义"**。
一个只存在于汇总列表里的不变量，在闸门眼里和一条完整的不变量没有区别。

闸门已补上检查：从汇总中提取的每个 ID，必须也在**汇总小节之外的正文**中出现，
否则报 `UNSTATED` 并判定失败。加上这一条之后，v3.2 立刻又暴露出 10 条（E-G）。

E-A / E-B / E-G 属于**恢复丢失的规范性内容**，E-E 是补实现以符合冻结规范，
两者都不是新增语义，因此在 3.x 内允许；
E-C / E-D / E-F 是纯措辞与引用更正。


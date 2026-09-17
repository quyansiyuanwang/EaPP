# EaPP 缺口分析 — 基于 v3.2.0 State Mode Freeze Candidate r2

**依据**：`tmp/draft/EaPP v3.2.0 State Mode — Freeze Candidate r2.md`（1739 行）
**工具链实测**：node v24.11.1 / pnpm 10.33.0 / npm 11.6.2 / git 2.52.0
**方法**：全文符号索引 + 交叉引用核对 + 参考实现（§14）与规范条文（§3–§13）逐条对撞

---

## 0. 一句话结论

仓库里**只有一份设计草案**。这份草案写作时假定 `v3.0.0-core` 与 `v3.1.0-interaction` 已经冻结，
但这两层在仓库中**完全不存在**——不是"没实现"，是"连文字都没有"。

同时，State Mode 自身**也还不能实现**：它有 5 个 P0 级的未定义/自相矛盾点，
照抄 §14 的参考实现会直接违反 §3–§13 的规范条文。

要交付"万物皆插件"的 EaPP Runtime，缺的不是一个补丁，而是三样东西：

1. **前置规范**（v3.0 组合本体 + v3.1 交互层）——State Mode 是它们的第四种 mode，没有前两层，它悬空；
2. **v3.2 的最后一次语义收敛**——Final Review 要处理的是下面 F-01…F-18，而不是走流程；
3. **整个工程与运行时本体**——0 行代码、0 个测试、无 git、无构建。

---

## 1. 现状盘点

| 资产 | 状态 | 证据 |
|---|---|---|
| `v3.0.0-core` 规范 | ❌ 不存在 | 全仓库仅 1 个文件 |
| `v3.1.0-interaction` 规范 | ❌ 不存在 | 同上 |
| `v3.2.0-state` 草案 | ✅ 1 份（r2） | `tmp/draft/…r2.md` 51965 字节 |
| 源码 | ❌ 0 行 | 无 `packages/` |
| 测试 | ❌ 0 个 | 无 `tests/` |
| 构建配置 | ❌ 无 | 无 `package.json` / `tsconfig.json` |
| git 仓库 | ❌ 无 | `fatal: not a git repository` |
| CI | ❌ 无 | — |
| docs 树 | ❌ 无 | 规范/审查记录/changelog 无处安放 |

> 注：v3.0.0 / v3.1.0 两份文档在分析过程中被补入 `tmp/draft/`，
> §2 已据此重写（初版曾判定"前置规范不存在"，该判定已作废）。
> 结论没有变好，只是从"缺失"变成了"存在但互相冲突"——见 §2b。

---

## 2. 缺口 A：前置规范的状态

三份文档现在都在手上。逐条核对后的真实状态是：

| 层 | 文档 | 自述状态 | 证据 |
|---|---|---|---|
| Composition | v3.0.0 | **FROZEN**（真） | §0 L21「本文自发布之日起冻结」；§0 L37-44 列出须进 4.0 的变更 |
| Interaction | v3.1.0 | **DRAFT**（v3.2 说是 FROZEN，**不实**） | §14 L1128「冻结声明（**草案**）」；文末 L1176「**Draft**」；L1180「下一步：一致性测试通过后，标记 v3.1.0 FROZEN」 |
| State | v3.2.0-r2 | Freeze Candidate | — |

**v3.2 的文档头声称**：

```
前置：v3.0.0-core FROZEN / v3.1.0-interaction SEMANTIC FROZEN
```

**v3.1 的正文亲口否认**：

```
L1128:  ## 14. 冻结声明（草案）
L1130:  一旦 I1-I4 通过一致性测试：
L1176:  **EaPP v3.1.0 Interaction Layer — Draft**
L1180:  **下一步：一致性测试通过后，标记 v3.1.0 FROZEN。**
```

> 这不是文字瑕疵。v3.2 的 §16 把"与 v3.1 的接口一致性验证 ✅"列为已满足的冻结条件，
> 而它所依赖的那个基线**自己还没冻结**，并且**已经和 v3.2 冲突**（§2b）。
> State Mode 无法"冻结在一个未冻结的父层之上"。

### 2.1 v3.2 中被依赖但确实无定义的符号

三份文档合起来看，仍有以下符号从未被任何一份定义：

| 符号 | 依赖位置 | 状态 |
|---|---|---|
| `WatchOptions` | v3.2 §9.2 / §10.2 / §14.1 / §14.2 | ❌ 三份都没有 |
| `durabilityBoundary` | v3.2 §11.3 / §11.4 / TS-5 | ❌ 全仓库仅出现在 v3.2 自身，且**没有任何一份文档声明过它** |
| `Subscription` / `SubscriptionMode` / `SubscriptionState` | v3.2 §5.1 / §14.2 | ❌ 三份都没有（v3.1 定义的是 `Cursor` / `AckContext` / `Lease`，没有 Subscription） |
| `Tuple` 序列化约束 | v3.2 SC-4「与 v3.0 Tuple 约束一致」 | ❌ v3.0 只说 Tuple Space 在 Interaction 层（§11.2），无约束定义 |
| `EappError` **类** | v3.2 §14 的 13 处 `new EappError(...)` | ❌ v3.0 §16 / v3.1 §11 / v3.2 §13 三份都只声明 `interface`，三份都**没有类** |
| `MemoryTransport` 基类 | v3.2 §14.4 `extends MemoryTransport` | ❌ 三份都没有 |
| 测试 helper `makeStateChannel` / `collect` / `compareRevision` | v3.2 §15 全篇 | ❌ 三份都没有 |

### 2.2 一个此前被低估的连带影响

v3.1 §4.4 把 `state` 模式的投递保证限死为 `at-least-once`，§4.3 又要求
`at-least-once 消费者 MUST ack`（DL-4）、`MUST 幂等处理`（DL-5）。
v3.2 全篇没有一处提到 `delivery` 或这两条义务 —— State Mode 的 ack 语义
**还没有和 v3.1 的投递语义对齐**。

---

## 2b. 缺口 A′：v3.1 与 v3.2 的跨文档冲突

这些不是"缺定义"，是**两份文档同时成立时不可能**。全部逐字核对过。

| # | 冲突 | v3.1 说 | v3.2 说 | 裁定 |
|---|---|---|---|---|
| X-1 | **ChannelMode** | §2.1 L105 已经包含 `'state'`：`type ChannelMode = 'request' \| 'event' \| 'stream' \| 'state'` | §9.3 L661-668 说 v3.1 只有三种，v3.2 **扩展**出第四种，「这是唯一修改」 | v3.1 为准。v3.2 的 §9.3 / IX-5 是对既成事实的错误描述——`'state'` **早已存在**，不存在"扩展" |
| X-2 | **revision 类型** | §3.4 L274：`revision: number; // 单调递增` | §4.1 L219：`type Revision = string; // opaque token` | 直接冲突。v3.2 必须显式**勘误** v3.1 §3.4 |
| X-3 | **Cursor 类型** | §6.2 L425：`type Cursor = string; // 不透明字符串，全局有序`；CR-1「MUST 在 Channel 内全局有序」 | REV-5 要求 Revision opaque；REV-7 允许 Revision 当 Cursor | 不冲突，但**只有把 Revision 定义为 Channel 内的日志位置**（见 D-01）才能让两者重合；否则 REV-7 无法落地 |
| X-4 | **AckContext** | §7.1 L470-473：`{ ack(): Promise<void>; nack(): Promise<void> }`，AK-1…AK-5 | §5.1 / L1208：只给 `ack()`，没有 `nack()` | v3.1 为准。v3.2 的 `StateUpdateEvent` **不是合法的 v3.1 AckContext**，违反 SW-1 |
| X-5 | **cursor 推进规则** | §6.1 L420「Cursor MUST NOT 随收到消息自动前移，只随 ack 前移」；§6.4 L458「ack 一个更新的 cursor 意味着放弃中间未 ack 的消息」 | §14.2 L1185「只推进到第一个 PENDING 之前」(完整实现略) | 二者语义不同。v3.1 §6.4 是**显式跳过**，v3.2 的注释是**禁止跳过**。以 v3.1 为准，v3.2 的 `pending` 结构应整体删除 |
| X-6 | **Channel 创建路径** | §8.1 L497「Channel MUST 由 Binding 派生」；CC-1 L644「Channel MUST NOT 独立于 Binding 存在」 | §10.1 只给 `StateChannelOptions{binding, mode, conflictPolicy}`；§14.1 构造函数收的是**已建好的 Channel** | 两者都不完整：v3.2 缺一条 `Binding → Channel` 的实例化路径。必须补，且必须经 v3.0 的 `bind()` |
| X-7 | **delivery** | §4.4 L338：state 模式**只允许** `at-least-once` | 全篇未提 delivery | v3.1 为准；v3.2 需补上并强制 |
| X-8 | **TransportCapabilities** | §9.2 L545-559：`{persistent, ordering, delivery{atMostOnce,atLeastOnce,replay}, supportsCursor, supportsLease}` | §11.2 L808-816：`{providesStateStorage, providesStateRevision, providesStateWatch, providesStateSnapshot, stateConsistency}` | 需要合成一个接口。且命名风格不一致（v3.1 用 `supportsX`，v3.2 用 `providesX`） |
| X-9 | **`durabilityBoundary`** | 无此概念 | §11.3 / TS-5 把它当作既有能力（"State consistency MUST be consistent with durabilityBoundary"） | v3.2 凭空引用了不存在的字段。要么在 v3.1 补定义，要么从 v3.2 删除 |
| X-10 | **错误模型** | v3.0 §16 + v3.1 §11 各有一份 `EappErrorCode` / `EappError`（均为 `interface`） | §13 第三份 `EappStateErrorCode` + `EappError` | 三份重复声明同名类型，且三份都没有**类**。必须收敛为单一定义 + 各自扩展码 |
| X-11 | **目录结构** | v3.0 §19.1 L913-933 / v3.1 §12.1 L688-723：`eapp/{spec, reference/{core,interaction,transport}, tests, examples}` | §14 路径：`packages/state/src/...`、`packages/transport/memory/src/state.ts` | v3.2 换了一套布局且未声明。需归一 |
| X-12 | **下一版本号** | v3.1 §14 L1136：`Next: v3.2.0 transport-capability` | 实际 v3.2 = State Mode | 版本规划漂移，需在 changelog 里记录 |

**结论**：v3.2 无法在原样不动的情况下冻结。要冻结，必须先做一次
**v3.1 → v3.1.1 勘误 + v3.2 r3** 的联合收敛，其中 X-1 / X-2 / X-4 / X-5 / X-6 是 P0。

---

## 3. 缺口 B：v3.2 自身的未冻结点

§0 声称 6 P0 + 6 P1 已全部修正。**事实并非如此**——下面是 r3 必须处理的问题。
每条都给出可核对的原文行号。

### P0 —— 不解决就无法一致实现

**F-01　`expectedRevision: null` 在"已逻辑删除的 key"上行为自相矛盾**
- §6.2（L397-417）：`null → key MUST NOT exist → 若 key 已存在，MUST 返回 EAPP_REVISION_CONFLICT`
- §14.4（L1277-1281）：`if (current && !current.deleted) throw …`
  参考实现只在 key **未删除**时冲突，即**允许用 `null` 复活一个已删除的 key**。
- 两处对同一输入给出相反结果。而 DEL-6 又明确规定 `delete 后 set` 必须用旧 revision 做 CAS（L529）。
  → 必须二选一并删掉另一处。

**F-02　`updatedBy` 无法被填充，SC-5（L210）不可满足**
- SC-5 要求 `updatedBy MUST be an existing Identity`；
- 但 `StateUpdate`（§6.1 L385）**没有 actor / updatedBy 字段**，
  `writeStateWithRevision()`（§11.1 L796）**也没有 actor 参数**；
- §14.4（L1301）只能写死占位符 `{ domain:'x', id:'x', instance:'x' }`。
- → 要么 `StateUpdate` 增加 actor，要么 Transport 从上下文注入。当前无路可走。

**F-03　`snapshot()` 的归约种子 `''` 是非法 Revision，空快照无定义**
- §14.1（L1051-1057）：`cells.reduce((max, c) => compareRevision(c.revision, max) > 0 ? … , '' as Revision)`
- `Revision` 是 opaque token（REV-5 L264），`''` 从未被定义为合法值；
  §14.4 的 `compareRevision` 靠 `BigInt('') === 0n` 侥幸不炸，其它 Transport 没有这个运气。
- 零匹配 cell 时 `maxRevision === ''`，违反 SNAP-2（L593）"MUST include maxRevision"。
- → 必须定义：空快照的 `maxRevision` 取值，以及 `compareRevision` 的前置条件。

**F-04　Snapshot 不含 pattern；restore 是否删除多余 cell 未定义**
- `StateSnapshot`（L538-543）只有 `{channel, cells, maxRevision, takenAt}`，**没有 `pattern`**；
- API-8（L765）声明 `restore MUST overwrite current state`，
  但 §14.1 的 `restore`（L1069-1081）**只写 snapshot 里的 cell，从不删除多余的 cell**。
- → "overwrite" 到底是"覆盖同 key"还是"整体替换（含删除）"？当前两种读法都成立。

**F-05　没有历史，cursor 语义事实上不可实现 ∎ 最严重**
- `readStateAfter()`（§11.1 L789 / §14.2 L1162）返回 `StateCell[]`——**当前值数组**，不是变更序列；
- 若 watcher 落后期间 `k` 被写两次，`readStateAfter` 只能返回最后一次的值，
  **中间的变更永久丢失**，而 SW-4（L370）要求 watcher 有独立 cursor、
  §14.2 的 `pending` / `advanceCursor` 又假定存在有序的 per-update 位置。
- 更根本：§14.2 的 `cursor = cell.revision`（L1166）把 Cursor 绑到了 cell，
  而同一个 revision 可能被多个 key 拥有，**Revision 不是全局全序**，
  无法作为"观察位置"（§2.2 L152 恰恰把 Cursor 定义为"观察者的位置"）。
- → 必须引入 channel 级单调序号（log offset / sequence）作为 Cursor，
  Revision 只做乐观并发控制。这是 r3 最重要的设计决定。

### P1 —— 会导致两份实现分叉

**F-06　`WatchOptions` 未定义，且 `'earliest' | 'latest'` 与 `Cursor` 字面量冲突**
- §5.4（L332-350）定义 `cursor = 'earliest' | 'latest' | Cursor`；
  但 `Cursor` 若为 `string`，`'earliest'` 本身就是一个合法 Cursor，无法判别。
- → `Cursor` 必须是 branded type，`WatchOptions` 必须显式写出。

**F-07　no-op delete 是否分配新 revision / 是否发事件未定义**
- DEL-5（L528）"delete already-deleted key MUST be no-op success"；
- DEL-2（L525）"delete MUST produce `type='deleted'` event"；
- §7.2（L475-487）delete 流程一律 `revision 增加` + 产生 update。
- → no-op 若是真 no-op（不增 revision、不发事件），必须写成 DEL-2 的显式例外。

**F-08　delete 时 `expectedRevision = null` 对"存在但已删除"的 key 未定义**
- §7.5（L516-520）三行只覆盖：不存在+null、已删除+匹配、已删除+不匹配。
- 漏了：**已删除 + null**。（结合 F-01，这块整体需要重写。）

**F-09　`restore` 是否向 watcher 发事件未定义**
- §14.1 restore 走 `writeStateWithRevision()` 绕过 CAS；
  §7.4（L507-512）只规定 `delete` 必须通知 watcher。restore 的通知义务空白。

**F-10　`API-4` 与 §7.2 / §10.4 字面冲突**
- API-4（L761）：`delete MUST preserve revision`；
- §7.2（L475-487）：`revision 增加`；§10.4（L750）：`delete` 返回**新 revision**。
- → API-4 想表达的是 SC-3"删除不清零版本"，措辞却是"保持版本"。必须改写。

**F-11　Revision 严格单调与 CRDT eventual 无豁免条款**
- REV-1 / REV-2 / REV-4（L259-262）要求严格单调、不回退；
- TS-4（L857）+ §11.4（L836）却把 CRDT 的 revision 标为 `⚠️`、consistency = `eventual`。
- → 需要显式豁免："REV-1/2/4 在 `stateConsistency = 'eventual'` 时降级为 …"。

**F-12　§13 错误码表不完整**
- §14.1 抛 `EAPP_MODE_INVALID`（L993）与 `EAPP_UNSUPPORTED`（L996），
  两者**都不在** §13（L954-965）的 `EappStateErrorCode` 联合里。
- 反之 §13 的 `EAPP_STATE_UNSUPPORTED` / `EAPP_WATCH_UNSUPPORTED` 在 §14 中从未出现。

**F-13　watcher 的"当前时刻"起点无法表达**
- §5.4 默认"从当前时刻开始"，SW-9（L378）再次冻结该默认；
- §14.2 注释写"由 Transport 在首次迭代时提供 'now' 位置"，
  但 `readStateAfter(channel, cursor, pattern)` 的 **`cursor === undefined` 语义未定义**：
  是"从最早"还是"从此刻"？Transport 无从判断调用者意图。

**F-14　`pending` 以 `cell.key` 为键，同一 key 多次更新会互相覆盖**
- §14.2（L1128-1131, L1172）：`pending.set(cell.key, …)`，
  而 ack 粒度是 **update**（§5.3 L312-330）。键必须是 cursor / 序号。

**F-15　无界忙轮询**
- §14.2（L1156-1180）：`while (ACTIVE) { await readStateAfter(...) }` 无任何等待或背压，
  空转 100% CPU，且 §11.4 的 Socket Transport（不支持 watch）会静默返回空数组而非报错。
- §11.6（L850）要求不支持 watch 时 `MUST 返回 EAPP_WATCH_UNSUPPORTED`——参考实现没做。

**F-16　`validatePattern` 放行 `{ all: false }`**
- §14.1（L1084-1092）只检查"键数量为 1 且键名 ∈ {key, prefix, all}"，
  于是 `{ all: false }` 通过校验，语义却是"不选任何东西"。

**F-17　合法 `undefined` 值不可写**
- §14.1（L1098）`hasValue = update.value !== undefined`。
  若要写入的语义值就是 `undefined`，会被判成 SU-2 违规。
- → SU-2 需要改成"字段存在性"（`'value' in update`）而非 undefined 判定。

**F-18　参考实现把内部表示泄漏成了规范**
- §14.4（L1318-1322）`BigInt(a.replace('r-',''))`，§14.4（L1293）`r-${counter}`。
- REV-5（L264）要求 Revision 对消费者 opaque；但测试 §15（L1629）
  直接断言 `t.compareRevision('r-1','r-2') < 0`，把 `r-<n>` 格式**写进了一致性测试**，
  等于把内存实现的私有格式冻结为跨 Transport 契约。
- → 测试应改用 `nextRevision()` 取真实 revision，而非硬编码字面量。

---

## 3b. 补充发现（独立对抗性评审第二轮）

第二轮以 §14 参考实现与 §3–§13 条文**逐行对撞**，又发现 20 条，编号 F-20 … F-39。
其中 **F-20 / F-21 / F-23 是新的 P0**，且 F-20 会让 r2 的一致性测试**在结构上不可能通过**。

### P0

**F-20　`delete()` 被实现为 `set({deleted:true})`，DEL-4 结构上不可满足**
- §14.1（L1033-1041）：`delete()` 直接 `return this.set({ key, deleted: true, expectedRevision })`；
- 而 Transport 端（L1295-1304）无法区分"删除"与"创建"：两者都是同一个 `StateUpdate`；
- 于是 DEL-4（L527）"delete non-existent key MUST return `EAPP_STATE_KEY_NOT_FOUND`"
  与 §15 的测试（L1521-1522）**永远无法满足**——Transport 只会返回 `EAPP_REVISION_CONFLICT`。
- → 删除必须是 Transport 的**一等原语**，不能是 set 的语法糖。

**F-21　§6.4 / §7.5 / DEL-4 对同一物理情形给出三种不同错误**
- §6.4（L435）：`if key not exists: throw EAPP_REVISION_CONFLICT`（无条件）；
- §7.5（L518）：delete 不存在的 key + `null` → `EAPP_STATE_KEY_NOT_FOUND`；
- DEL-4（L527）：delete non-existent key → `EAPP_STATE_KEY_NOT_FOUND`（无条件，与 §6.4 冲突）。
- → 错误码取决于 `expectedRevision` 的形状，但三处表述都写成了无条件句式。

**F-23　`get` / `list` 是否返回已逻辑删除的 cell 未定义**
- API-1（L759）"get MUST return current value or null" 的自然读法是"已删除 ⇒ null"；
- 但 §7.5（L519）要求调用方**拿出已删除 cell 的 revision** 才能命中 "no-op 成功" 分支，
  这只有在 `get` 返回已删除 cell 时才可能。
- → 两种读法导致完全不同的实现，且直接决定 DEL-5 是否可测。

### P1

**F-22　`EappError` 被声明为 `interface` 却被 `new` 构造**
- §13（L967-972）是 `interface EappError { code: string; ... }`；
- §14 却 13 次 `new EappError("CODE")` / `new EappError("CODE","msg")`。
- 且 `message: string` 非可选，但 L1087 / L1091 / L1097 / L1102 / L1280 / L1285 / L1288 都没传；
  若真去 `new` 一个 interface，运行时直接 `TypeError`。规范必须给出**类**定义。

**F-24　IX-1 与 IX-5 互相否证**
- IX-1（L91）：`State Mode MUST NOT modify v3.1 Channel interface.`（绝对禁止）；
- IX-5（L947）：`ChannelMode MAY be extended to include 'state' as the only modification.`（允许修改）；
- 且 `StateChannel.mode: 'state'`（L642）本身就是对继承成员类型的一次收窄。
- → 绝对句与许可句不能同时冻结。

**F-25　SU-6 与 `writeStateWithRevision` 互相否证**
- SU-6（L458）：`Unconditional write MUST NOT exist in Core.`；
- 但 `writeStateWithRevision`（L794 / L1243）**没有 CAS 参数**，正是 §14.1 restore（L1072）的写入路径。
- → Core 既禁止又依赖无条件写入。

**F-26　`nextRevision` 的元数在 §4.3 与接口声明处不一致**
- §4.3（L241）：`newRevision = transport.nextRevision(channel, key)`（两个参数）；
- §11.1（L792）/ §14.3（L1240）：`nextRevision(channel: string)`（一个参数）。
- → 规范条文无法对声明调用。

**F-27　`StateDelete`（L469-472）是死类型**
- §7.1 定义了 `interface StateDelete`，全文再未引用；
- 实际的 delete 形状是 `delete(key, expectedRevision)`。
- → 同一份冻结文本里存在两个互不兼容的"删除请求"描述。

**F-28　`expectedRevision` 被传递两次且无优先级规则**
- §14.1 `set()`（L1029）传 `update.expectedRevision`，
  同时 §11.1 `setStateWithCAS(channel, update, expectedRevision)`（L1228）又收一个参数。
- → 两者不同时以谁为准？未定义。

**F-29　snapshot 的"read-consistent"定义是循环的，无法被违反**
- §8.2（L559-562）：`snapshot 内所有 cell 的 revision <= maxRevision`，
  而 §14.1（L1049-1061）中 `cells` 与 `maxRevision` **来自同一次读取**。
- → 该不等式是恒真式；Transport 可以返回任意不一致的 cell 集合而"满足"SNAP-1。

**F-30　`close()` / `suspend()` 与在途投递、`ack()` 的关系未定义**
- §14.2 只在 `while` 顶部检查状态（L1157），`close()`（L1196-1200）清空 `pending`；
- 但在途的 `yield`（L1179）不受影响，且 `close()` 之后调用 `ack()` 会**重新写回**刚被清空的 map（L1175）。
- → 关闭后的投递语义、重复 ack、ack-after-close 全都未定义。

**F-31　能力标志没有运行时后果，`providesStateRevision` 从未被检查**
- §11.6（L850-852）要求不支持时返回标准错误，但没说**在哪一层、以何种形式**返回；
- `providesStateRevision === false` 时 CAS 的命运（是抛错还是降级）未定义（L851 只说" MUST NOT 用于 CAS"）；
- `watch()` 是同步方法（L648），却要求异步迭代时才可能抛 `EAPP_WATCH_UNSUPPORTED`（L852）。
- → 四个能力标志中只有 `providesStateStorage` 有隐约的落点。

**F-32　参考实现的 key 命名空间会跨 channel 串键**
- §14.4（L1272）：`const key = \`${channel}:${update.key}\``；
- 于是 `channel="a"`, `key="b:c"` 与 `channel="a:b"`, `key="c"` 命中同一个 cell；
- 而 SC 的不变量声称 `key` 在同一 Channel 内唯一（L198）。
- → 未做长度前缀/转义的字符串拼接使跨 channel 污染成为可能。

**F-33　承诺的 channel 创建 API 从未交付**
- §10.1（L696-700）定义了 `StateChannelOptions`，
- 但 §14.1 的构造器（L987-990）收的是**已建好的 `Channel` + 另一种 `StateChannelConfig`**；
- → "如何从 options 得到 StateChannel"这一步在规范里是空的。

**F-34　一致性套件对多数不变量零覆盖，且两条测试体为空**
- REV-6（L1367-1369）与 REV-8（L1379-1384）**测试体为空**，不 assert 任何东西；
- SNAP-2/3/5/6、CF-1..4、TS-1..6、SW-4/5/8、SU-1/2/5、DEL-1/3/6、IX-1..5 **没有任何测试**。
- → §16 把 "Conformance Tests" 列为冻结闸门，但套件本身不构成闸门。

**F-35　四个错误码无任何产生点，`retryable` 从未被赋值**
- `EAPP_STATE_UNSUPPORTED` / `EAPP_WATCH_UNSUPPORTED` / `EAPP_INTERNAL` / `EAPP_STATE_KEY_NOT_FOUND`
  在 §14 中一次都没出现；`EappError.retryable?`（L971）没有任何赋值规则。
- → 错误面无法被消费者使用。

**F-36　state 变更的投递/持久/恢复语义整体缺位**
- §1.2（L63）声明"不涉及投递语义"，但 `StateChannel` 继承 `delivery: DeliveryGuarantee`（L630）；
- `ack()` 的唯一已述效果是"推进 cursor"（L328），
  未 ack / 重复投递 / close 后 / 从 cursor 恢复 的行为全部未定义。

**F-37　`{\"all\":false}` / `{key:""}` 可以通过 pattern 校验**
- 已并入 F-16，此处仅记录第二轮独立复现，佐证该缺陷为真。

**F-38　`getState` / `listState` / `readChangesAfter` / `writeStateWithRevision` / `restoreState`
五个 Transport 方法只有签名，没有语义**
- §14.4 结尾直接 `// ... 其他方法`（L1324）放弃实现。
- → 排序、过滤、cursor 排他性、已删除可见性全部留给实现者自由发挥。

**F-39　`restoreState`（L801）与 §14.1 的 restore 循环（L1069-1081）是两个互相竞争的实现入口，关系未定义**
- Transport 层有一个 `restoreState`，Channel 层又自己循环调 `nextRevision` + `writeStateWithRevision`。
- → 到底谁负责 restore？两个都实现会不会双写？

---

## 4. 缺口 C：工程层

| 项 | 状态 | 说明 |
|---|---|---|
| git 仓库 | ❌ | 无版本历史 ⇒ "FROZEN" 无不可变锚点，冻结语义形同虚设 |
| pnpm workspace | ❌ | 文档假定 `packages/*` 布局，但无 `pnpm-workspace.yaml` |
| TypeScript 配置 | ❌ | 无 `tsconfig.json`（文档大量使用 `satisfies`/branded type 需要 strict） |
| 测试运行器 | ❌ | 文档用 vitest 风格 API（`describe/test/expect`），未声明依赖 |
| Lint / format | ❌ | 规范中 60+ 不变量（SC/REV/SW/SU/DEL/SNAP/CF/API/TS/IX）需要机检 |
| CI | ❌ | 无法在冻结提交上重放 conformance |
| 文档树 | ❌ | 无 `docs/spec/`、无审查记录、无 changelog |

---

## 5. 缺口 D：代码层

文档给出的是**骨架片段**，且有 3 处 `// ... 其他方法` / `(完整实现略)` 的占位：

| 包 | 文档引用位置 | 状态 |
|---|---|---|
| `packages/state` | §14.1 / §14.2 | ❌ 0 行 |
| `packages/transport/memory` | §14.4 | ❌ 0 行（且 `MemoryTransport` 基类缺失） |
| `packages/core` | 隐含（Identity / Tuple） | ❌ 0 行 |
| `packages/interaction` | 隐含（Channel / Subscription / Cursor / AckContext / Transport） | ❌ 0 行 |
| `tests/conformance` | §15 | ❌ 0 行，且 helper 全缺 |
| 错误码注册表 | §13 | ❌ 仅字符串联合，无代码 |

---

## 6. 缺口 E：运行时层 —— 目标本体的 100% 空白

你的目标是"让彼此独立的 Plugin 可以被**发现、连接、激活、通信、调用**"，
即"万物皆插件"。这属于 v3.0 组合层，**当前零覆盖**。
v3.2 只解决"共享状态"这一件事（还是第四种 mode）。

| # | 能力 | 依赖的规范概念 | 状态 |
|---|---|---|---|
| E1 | Plugin 描述与清单（manifest / 版本 / 能力声明） | `Identity` | ❌ |
| E2 | 发现 Discovery（注册表 / 扫描 / 动态加载） | — | ❌ |
| E3 | 连接 Connection / Binding（端口、契约匹配） | `Channel` / `binding` | ❌ |
| E4 | 激活 Activation（register→resolve→activate→deactivate→dispose） | `ChannelState` | ❌ |
| E5 | 通信 Communication（request/event/stream/state 四模式运行时） | `ChannelMode` | ❌ |
| E6 | 调用 Invocation（超时 / 取消 / 错误传播） | — | ❌ |
| E7 | 组合 Composition（依赖图 / 拓扑排序 / 环检测） | v3.0 core | ❌ |
| E8 | 隔离与信任 Trust Domain | §17.1 提到"权限属于 Trust Domain" | ❌ |
| E9 | Host / Kernel（宿主、加载器、生命周期容器） | — | ❌ |
| E10 | 可观测性（日志 / 追踪 / 诊断） | — | ❌ |

---

## 7. 缺口 F：流程层

| 项 | 状态 | 说明 |
|---|---|---|
| Final Review 记录 | ❌ | §16（L1637-1672）要求"通过 Final Review"，但无评审对象/结论载体 |
| Semantic Freeze 标记 | ❌ | 无机制把某次提交钉成 "SEMANTIC FROZEN" |
| 不变量机检 | ❌ | 60+ 条不变量是散文；无法在 CI 中回归 |
| 版本索引 / changelog | ❌ | r1 → r2 → r3 的演进无留存 |
| Conformance 报告 | ❌ | §15 骨架未落地 |

---

## 8. 建议的恢复顺序

```
Step 1  工程骨架     git init + pnpm workspace + TS strict + vitest + docs 树
Step 2  v3.2 收敛    解决 F-01…F-18  →  docs/spec/v3.2.0-state.md (FROZEN)
Step 3  前置重建     v3.0.0-core / v3.1.0-interaction 规范（标注 reconstructed）→ FROZEN
Step 4  实现         packages/{core,interaction,state,transport-memory}
Step 5  一致性       §15 conformance 全绿 + v3.0/v3.1 自测
Step 6  运行时       E1…E10（发现/连接/激活/通信/调用）
Step 7  冻结报告     v3.2.0 FROZEN + Conformance Report + Changelog
```

> **顺序上的一个判断**：Step 2 与 Step 3 谁先都行，但 **Step 3 不能跳过**。
> 没有 v3.1 的 `Cursor` / `AckContext` / `Subscription` / `Transport` 定义，
> Step 4 的 `packages/interaction` 无从写起，`packages/state` 也没有基类可继承。
> 而 F-05（历史模型）的确定又会反过来改 `Cursor` 的定义——所以
> **建议 Step 2 与 Step 3 合并成一次"三层联合收敛"，先定 Cursor/Revision/序号模型，再分头冻结**。

---

## 9. 需要确认的三件事

| # | 问题 | 我的建议 |
|---|---|---|
| Q1 | v3.0 / v3.1 是否有原文可以放进来？ | 若无可依据 v3.2 引用**反向重建**，并在文件头标注 `reconstructed` |
| Q2 | 运行时本体的范围：先做最小可运行内核，还是一次做全 E1…E10？ | 先 Step 1–5 打通"能跑 + 全绿"，再攻 E1…E10 |
| Q3 | 技术栈确认：TypeScript + pnpm + vitest（文档已假定）？ | 确认，且 TS 开 `strict` + `exactOptionalPropertyTypes` |

---

*本报告由仓库实测生成；所有行号对应 `tmp/draft/EaPP v3.2.0 State Mode — Freeze Candidate r2.md`。*

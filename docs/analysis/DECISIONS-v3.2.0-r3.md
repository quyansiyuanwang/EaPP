# EaPP v3.2.0-r3 — Final Review 决议记录

**输入**：v3.2.0 冻结候选 r2 的评审结果（40 条内部缺陷 F-01 … F-39，12 处跨文档冲突 X-1 … X-12）
**输出**：v3.2.0 语义冻结所需的全部裁定
**状态**：已并入 —— D-01…D-38 已写入 `docs/spec/v3.2.0-state.md`，
R-0…R-13 已写入 `docs/spec/v3.1.0-interaction.md` 与 `docs/spec/CHANGELOG.md`。
本文保留为**裁定过程的记录**：它解释每条规则为什么是这样，而规范正文只陈述规则是什么。

> 本文只记录**决定**与**理由**，不重复 r2 的原文。
> 每条决定标注它关闭哪个缺陷。

---

## 第一部分：核心架构决定（贯穿三层）

### D-01　State 的 Cursor 模型：Revision 就是日志位置　【关闭 F-05 / F-11】

**问题**：r2 一方面要求 watcher 有独立 cursor（SW-4）、ack 粒度是 per-update（§5.3），
另一方面 `readStateAfter()` 返回 `StateCell[]`（当前值），**同一 key 的中间变更不可表达**；
同时 §14.2 把 `cell.revision` 当 cursor，而 Revision 在 r2 中只是"每个 cell 各自的版本号"，
不是全序 ⇒ 无法充当观察位置。

**决定**：

```
State 层的 Revision MUST 被定义为 Channel 内状态日志的位置（append-only log offset）。

  1. 每个 (Transport, Channel) MUST 维护一个单调递增的日志序号，写入即 +1。
  2. Revision 就是这条写入在日志中的位置，MUST 在 (Transport, Channel) 内唯一且全序。
  3. StateCell.revision = 该 key 最后一次写入的日志位置。
  4. 因此 REV-7 自然成立：Revision 可以直接用作 Cursor —— 不是例外，
     而是因为 Revision 被定义成了位置。
```

**接口修正**：

```ts
// 取代 r2 §11.1 的 readStateAfter(...): Promise<StateCell[]>
interface StateTransport extends Transport {
  /** 返回 cursor 之后、匹配 pattern 的变更记录，按 revision 升序。 */
  readChangesAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: StatePattern,
  ): Promise<StateChange[]>;

  /** Channel 当前日志头，即"此刻"的位置。 */
  head(channel: string): Promise<Revision>;
}

interface StateChange {
  readonly channel: string;
  readonly revision: Revision;      // 日志位置
  readonly key: string;
  readonly type: 'set' | 'deleted';
  readonly value?: unknown;         // 当且仅当 type === 'set'
}
```

**日志保留**：Transport MAY 压缩日志。若请求的 cursor 早于可服务范围，
MUST 以 `EAPP_CURSOR_TOO_OLD` 失败（**新增错误码**），StateWatcher 的迭代器 MUST 抛出该错误。
Transport MUST 在能力声明中给出保留窗口：

```ts
stateRetention: { kind: 'unbounded' } | { kind: 'window'; entries: number };
```

**理由**：这是唯一能让"独立 cursor + per-update ack + 删除事件可观察"三者同时成立、
且不需要引入第二条时间轴的模型。它使 REV-6 / REV-7 从"例外"变成"推论"。

---

### D-02　v3.1 `SubscriptionMode` 的定义　【关闭缺口 A 中的该符号】

r2 只出现过字面量 `'exclusive'`，未定义。重建 v3.1 时冻结为：

```ts
type SubscriptionMode =
  | 'exclusive'   // 默认。每个订阅持有独立 cursor，收到全部匹配变更
  | 'group';      // 同 group 的订阅共享一个 cursor，竞争消费（每条变更只投递给一个成员）

interface SubscriptionOptions {
  mode?: SubscriptionMode;   // 默认 'exclusive'
  group?: string;            // mode === 'group' 时 MUST 指定
  cursor?: 'earliest' | 'latest' | Cursor;   // 默认 'latest'
}
```

**理由**：StateWatcher 默认 `'exclusive'` + SW-4（独立 cursor）+ SW-5（互不影响）
在 `'exclusive'` = "独立 cursor" 的语义下完全自洽。若把 `'exclusive'` 解成"独占 channel"，
则 SW-5 与 §14.2 的默认值互相矛盾。

---

### D-03　Cursor 必须是 branded type　【关闭 F-06】

```ts
declare const cursorBrand: unique symbol;
export type Cursor = string & { readonly [cursorBrand]: 'opaque' };
```

**理由**：r2 §5.4 允许 `cursor = 'earliest' | 'latest' | Cursor`。
若 `Cursor = string`，`'earliest'` 自身就是合法 Cursor，无法判别，两份实现必然分叉。
branded type 让字面量无法冒充 Cursor，从类型系统层面消除歧义。

---

### D-04　初始 cursor 在 `watch()` 调用时刻**立即**解析　【关闭 F-13 / F-19】

**问题**：r2 §5.4 默认"从当前时刻开始"，§14.2 注释说"由 Transport 在首次迭代时提供 'now'"，
且构造后 `this._cursor = options?.cursor` ⇒ **未指定时为 `undefined`**，
而一致性测试 SW-1（L1395）断言 `expect(w.cursor).toBeDefined()`。**r2 的参考实现通不过自己的测试。**

**决定**：

```
WatchOptions.cursor 省略  → 等价于 'latest'
初始 cursor MUST 在 watch() 返回之前解析完成（eager），MUST NOT 延迟到首次迭代。

推论：
  1. watch() 返回后，任何已提交的变更 MUST 被投递；
  2. watch() 返回后 StateWatcher.cursor MUST 非 undefined —— SW-1 因此可满足；
  3. 'earliest' MUST 解析为"日志中最早仍可服务的位置"；
  4. 'latest' MUST 解析为 head(channel)。
```

**若 `watch()` 时日志已被压缩到无法定位 'earliest'**：MUST 抛 `EAPP_CURSOR_TOO_OLD`。

---

## 第二部分：CAS 与删除语义

### D-05　`expectedRevision = null` 只表示"从未存在"　【关闭 F-01】

**裁定**：以 §6.2 为准，**删除 §14.4 中 `if (current && !current.deleted)` 的写法**。

```
expectedRevision === null  ⇔  key MUST NOT exist（存在即冲突，无论是否已逻辑删除）
expectedRevision === Revision ⇔ key MUST exist 且 revision 精确匹配
```

**理由**：
1. 若 `null` 允许复活已删除的 key，则 CAS 不再能表达"这是首次创建"这一意图，
   `null` 失去唯一含义（P0-4 的修正目的正是让 `null` 有唯一含义）；
2. DEL-6 已规定 `delete 后 set` 必须携带旧 revision，说明规范本来就要求用 revision 复活；
3. 两个读法不能同时保留，§14.4 是"参考实现"，规范条文优先。

**连带**：`delete` 不存在的 key 且 `expectedRevision = null` → `EAPP_STATE_KEY_NOT_FOUND`（DEL-4 保留）。

---

### D-06　删除边界情况完整表（重写 §7.5）　【关闭 F-08】

| key 当前状态 | `expectedRevision` | 结果 |
|---|---|---|
| 不存在 | `null` | `EAPP_STATE_KEY_NOT_FOUND` |
| 不存在 | `Revision` | `EAPP_REVISION_CONFLICT` |
| 存在且未删除（rev = r） | `null` | `EAPP_REVISION_CONFLICT` |
| 存在且未删除（rev = r） | `r` | 成功；新 revision；发 `deleted` 变更 |
| 存在且未删除（rev = r） | `r' ≠ r` | `EAPP_REVISION_CONFLICT` |
| 已删除（rev = r） | `null` | `EAPP_REVISION_CONFLICT` |
| 已删除（rev = r） | `r` | **no-op 成功**；见 D-07 |
| 已删除（rev = r） | `r' ≠ r` | `EAPP_REVISION_CONFLICT` |

**统一规则**（可机检）：

```
不存在        → null:: KEY_NOT_FOUND      | Revision:: REVISION_CONFLICT
存在已删除    → null:: REVISION_CONFLICT  | 匹配:: no-op 成功 | 不匹配:: REVISION_CONFLICT
存在未删除    → null:: REVISION_CONFLICT  | 匹配:: 成功       | 不匹配:: REVISION_CONFLICT
```

---

### D-07　no-op delete 不分配 revision、不产生变更　【关闭 F-07】

```
删除一个"已删除"的 key 且 revision 匹配时：
  MUST NOT 分配新 revision
  MUST NOT 产生 type='deleted' 变更
  MUST NOT 通知 StateWatcher
  MUST 返回传入的 expectedRevision（不变量：返回值 == key 当前 revision）
```

**规则收敛**：`delete` 的返回值 MUST 恒等于操作完成后 key 的当前 revision。
→ 成功删除返回新 revision；no-op 返回旧 revision。这条比 r2 的两次描述都更强且可测。

**DEL-2 改写**：`delete MUST produce a 'deleted' change — except when it is a no-op (D-07).`

---

### D-08　`delete()` 的 actor　【关闭 F-02 的一半】

```ts
delete(key: string, expectedRevision: ExpectedRevision, options?: { actor?: Identity }): Promise<Revision>
```

---

## 第三部分：Identity 与写入者

### D-09　actor 来源链　【关闭 F-02】

**问题**：SC-5 要求 `updatedBy` 是"已存在的 Identity"，但 `StateUpdate` 没有 actor 字段，
`writeStateWithRevision()` 也没有 actor 参数 ⇒ r2 §14.4 只能写死 `{domain:'x',id:'x',instance:'x'}`（L1301），
这既是占位符也是**未定义符号 `Identity` 的伪造实例**。

**决定**：

```ts
interface StateChannelOptions {
  binding: string;
  mode: 'state';
  conflictPolicy?: 'cas';
  owner: Identity;               // 必需：Channel 的拥有者身份
}

interface StateUpdate {
  key: string;
  value?: unknown;
  deleted?: boolean;
  expectedRevision: ExpectedRevision;
  actor?: Identity;              // 可选：显式写入者
}

interface StateTransport extends Transport {
  setStateWithCAS(
    channel: string,
    update: StateUpdate,
    expectedRevision: ExpectedRevision,
    actor: Identity,             // 必需：由 Channel 解析后传入
  ): Promise<Revision>;
}
```

**解析规则**：`actor = update.actor ?? channelConfig.owner`；
`Channel.owner` MUST 在创建时校验为**已注册的 Identity**（SC-5 因此恒可满足）。
若两者皆缺 → `EAPP_STATE_ACTOR_REQUIRED`（**新增错误码**）。

`Identity` 由 v3.0 core 定义（重建）：`{ domain: string; id: string; instance: string }`。

---

## 第四部分：Snapshot / Restore

### D-10　`maxRevision` = snapshot 时刻的 channel head　【关闭 F-03】

**问题**：r2 §14.1 用 `reduce(..., '' as Revision)` 求 max，`''` 不是合法 Revision，
零匹配时 `maxRevision === ''` 违反 SNAP-2；且其它 Transport 的 `compareRevision` 未必接受 `''`。

**裁定**：

```
maxRevision MUST be taken as head(channel) at snapshot time,
MUST NOT be derived by reducing over the matched cells.

理由：SNAP-1 要求的是"所有 cell 的 revision <= maxRevision"这一上界语义，
      而 head(channel) 天然是上界，对空匹配集也成立。
```

**SNAP-2 改写**：`snapshot MUST include maxRevision, defined as head(channel) at snapshot time.`

### D-11　`StateSnapshot` 必须携带 pattern 与 scope　【关闭 F-04】

```ts
interface StateSnapshot {
  readonly channel: string;
  readonly pattern: StatePattern;    // 新增：本快照的选择范围
  readonly cells: StateCell[];
  readonly maxRevision: Revision;
  readonly takenAt: number;
}
```

### D-12　`restore` 的两种模式　【关闭 F-04 / F-09】

**问题**：API-8 说 `restore MUST overwrite current state`，但 §14.1 的实现只写快照里的 cell，
从不删除多余 cell。"overwrite" 有两种读法，必须二选一 —— 所以两个都给出，显式选择。

```ts
restore(snapshot: StateSnapshot, options?: { mode?: 'merge' | 'replace' }): Promise<void>;
// 默认 'merge'
```

| 模式 | 语义 |
|---|---|
| `'merge'` | 对快照内的每个 cell 分配**新 revision** 并写入；快照范围外的 cell 不动 |
| `'replace'` | 先执行 `'merge'`，再把 `snapshot.pattern` 范围内、不在快照中的 cell 全部逻辑删除 |

**API-8 改写**：`restore MUST overwrite the state covered by snapshot.pattern.`

**通知（F-09）**：`restore` 产生的每一次写入 MUST 追加一条日志变更，
因此 StateWatcher MUST 观察到 restore 的效果（`'replace'` 模式下的隐式删除为逐条 `deleted` 变更）。

**revision**：restore MUST NOT 回退 revision；每个被写入的 cell MUST 获得由
`nextRevision(channel)` 分配的新 revision（SNAP-4 / SNAP-5 保留）。

---

## 第五部分：Transport 能力与一致性

### D-13　取消 CRDT 的"⚠️ 豁免"，改为能力声明收紧　【关闭 F-11】

**问题**：REV-1/2/4 要求 Revision 严格单调不回退；§11.4 却把 CRDT 的 revision 标为 `⚠️`、
consistency 标为 `eventual`，二者不能共存。

**裁定**：不再给 REV-1/2/4 开豁免，而是让**能力声明严格化**：

```
providesStateRevision === true  ⟺  Revision 在 Channel 内构成全序且单调（REV-1/2/3/4/8 成立）
providesStateRevision === false ⟹  MUST NOT 用于 CAS；set / delete / watch MUST 返回 EAPP_STATE_UNSUPPORTED
```

**TS-4 改写**：`A Transport whose revision ordering is not total per channel MUST declare
providesStateRevision = false. Such a Transport MUST declare stateConsistency = 'eventual'
and MUST NOT claim CAS support.`

**理由**：CAS 的正确性**就是**建立在全序之上。允许"eventual 的 revision + CAS"等于是允许
一个会静默丢更新的 CAS。Core 只有 CAS 一种策略（CF-1），所以能力标志必须与它对齐。

**§11.4 能力矩阵相应修正**：CRDT 行改为 `stateRevision ❌`、`consistency eventual`，
并注明它属于 Extension 层（§9.4 已把 `crdt` 列为 Extension 策略）。

---

### D-14　错误码表补全与归一　【关闭 F-12】

```ts
type EappErrorCode =
  // v3.0 / v3.1
  | 'EAPP_INTERNAL'
  | 'EAPP_UNSUPPORTED'            // 能力不支持（通用）
  | 'EAPP_MODE_INVALID'           // Channel.mode 与操作不匹配
  | 'EAPP_CAPABILITY_MISSING'
  | 'EAPP_WATCH_UNSUPPORTED'      // v3.1 定义：Transport 不支持 watch
  // State Mode
  | 'EAPP_STATE_UNSUPPORTED'      // Transport 不支持状态存储
  | 'EAPP_STATE_KEY_INVALID'      // key 为空
  | 'EAPP_STATE_KEY_NOT_FOUND'
  | 'EAPP_STATE_VALUE_INVALID'    // value/deleted 互斥、均缺
  | 'EAPP_STATE_PATTERN_INVALID'
  | 'EAPP_STATE_ACTOR_REQUIRED'   // 新增（D-09）
  | 'EAPP_REVISION_INVALID'       // expectedRevision 非法、或写入 revision 非递增
  | 'EAPP_REVISION_CONFLICT'
  | 'EAPP_CURSOR_TOO_OLD'         // 新增（D-01）
  | 'EAPP_SNAPSHOT_INVALID';
```

**理由**：r2 §14 抛了 `EAPP_MODE_INVALID` / `EAPP_UNSUPPORTED`，两者都不在 §13 的联合里；
反之 §13 的 `EAPP_STATE_UNSUPPORTED` / `EAPP_WATCH_UNSUPPORTED` 在 §14 从未出现。
错误码是跨包契约，必须单点定义。

---

## 第六部分：观察者实现细节

### D-15　`pending` 以 cursor（revision）为键　【关闭 F-14】

```
r2:  pending.set(cell.key, ...)              ← 同一 key 多次未 ack 的变更互相覆盖
r3:  pending.set(change.revision, ...)       ← ack 粒度 == 变更粒度（§5.3）
```

`advanceCursor()` MUST 推进到**第一个未 ack 的变更之前**，MUST NOT 跳过它。

### D-16　通知模型：可选 `waitForChange`，否则有界轮询　【关闭 F-15】

```ts
interface StateTransport extends Transport {
  /**
   * 可选。阻塞直到 cursor 之后出现变更或 signal 中止。
   * 未实现时 StateWatcher MUST 以 WatchOptions.pollIntervalMs 轮询（默认 50ms，MUST > 0）。
   */
  waitForChange?(channel: string, cursor: Cursor | undefined, signal?: AbortSignal): Promise<void>;
}
```

`StateWatcherImpl` 的迭代循环 MUST NOT 无等待忙轮询。

### D-17　能力闸门在 `watch()` 同步抛出　【关闭 F-15 的另一半】

```
providesStateWatch === false  ⟹  watch() MUST 同步抛 EAPP_WATCH_UNSUPPORTED
```

**理由**：`watch()` 是同步方法（§10.2 返回 `StateWatcher` 而非 Promise），
若把错误推迟到迭代器，调用方会先拿到一个"看起来正常"的 watcher 再异步失败。
§11.6 的 `MUST 返回 EAPP_WATCH_UNSUPPORTED` 因此落点明确。

---

## 第七部分：校验与测试

### D-18　`validatePattern` 必须拒绝未知形状　【关闭 F-16】

```
合法：{ key: <非空 string> } | { prefix: <string> } | { all: true }
非法：任何其它形状 ⇒ EAPP_STATE_PATTERN_INVALID
  - 键数 ≠ 1
  - 键名不在 {key, prefix, all}
  - { all: false }
  - { key: "" }
```

**理由**：r2 只检查键名，`{ all: false }` 会通过校验却表示"什么都不选"。必须逐字段校验。

### D-19　`value` 的存在性用字段存在性判定　【关闭 F-17】

```
r2:  hasValue = update.value !== undefined     ← 无法写入语义值 undefined
r3:  hasValue = 'value' in update              ← 允许显式 { value: undefined } 作为合法值
     hasDeleted = update.deleted === true
```

SU-2 改写：`StateUpdate MUST carry the 'value' property or set deleted = true.`

### D-20　一致性测试 MUST NOT 硬编码 revision 字面量　【关闭 F-18】

```
r2 §15:  ch.set({ key:'k', value:2, expectedRevision:'r-999' })   ← 假定 'r-<n>' 格式
         t.compareRevision('r-1','r-2')                            ← 把内存实现格式冻结为跨 Transport 契约

r3:  冲突用例 MUST 用 nextRevision() 索取一个必然不匹配的 revision；
     compareRevision 用例 MUST 使用 Transport 真实产出的 revision。
```

**理由**：REV-5 要求 Revision 对消费者 opaque。测试里写死 `'r-1'` 等于把内部表示冻结为规范，
会让任何非内存 Transport 无法通过 conformance。

### D-21　测试 helper 契约（补齐缺口 A）　【关闭 F-19 的测试侧】

```ts
// tests/conformance/helpers.ts
makeStateChannel(options?): Promise<StateChannel>
collect(watcher, count, timeoutMs?): Promise<StateUpdateEvent[]>   // count=0 ⇒ 等到超时后返回 []
compareRevision(a, b): number                                       // 取自当前 Transport
```

---

## 第八部分：第二轮评审补充决议（F-20 … F-39）

### D-22　删除是一等原语，不是 `set` 的语法糖　【关闭 F-20 / F-21 / F-27 / F-28】

**问题**：r2 §14.1 把 `delete()` 实现成 `set({deleted:true})`，
Transport 无法区分"删除"与"创建"，于是 `EAPP_STATE_KEY_NOT_FOUND`（DEL-4）**结构上不可产生**。

**裁定**：

```ts
interface StateTransport extends Transport {
  /** expectedRevision 只从 update 读取，不再有第二个参数（F-28）。 */
  setStateWithCAS(channel: string, update: StateUpdate, actor: Identity): Promise<Revision>;

  deleteStateWithCAS(
    channel: string,
    request: StateDeleteRequest,
    actor: Identity,
  ): Promise<Revision>;
}

interface StateDeleteRequest {          // 取代 r2 §7.1 的死类型 StateDelete（F-27）
  key: string;
  expectedRevision: ExpectedRevision;
  actor?: Identity;
}
```

**§6.4 的错误码改为条件式**（关闭 F-21）：

```
SET:
  expectedRevision === null     → key 已存在          → EAPP_REVISION_CONFLICT
                                  key 不存在          → 成功
  expectedRevision is Revision  → key 不存在          → EAPP_REVISION_CONFLICT
                                  revision 不匹配      → EAPP_REVISION_CONFLICT
                                  revision 匹配        → 成功
DELETE:
  expectedRevision === null     → key 不存在          → EAPP_STATE_KEY_NOT_FOUND
                                  key 存在（含已删除）→ EAPP_REVISION_CONFLICT
  expectedRevision is Revision  → key 不存在          → EAPP_REVISION_CONFLICT
                                  revision 不匹配      → EAPP_REVISION_CONFLICT
                                  revision 匹配且未删除→ 成功
                                  revision 匹配且已删除→ no-op 成功
```

**DEL-4 改写**：`delete with expectedRevision = null on a key that has never existed
MUST return EAPP_STATE_KEY_NOT_FOUND.`（原文写成无条件句，与 §6.4 冲突。）

---

### D-23　`get` / `list` MUST 返回已逻辑删除的 cell　【关闭 F-23】

**问题**：API-1 的"current value or null"可读成"已删除 ⇒ null"，
但 §7.5 的 "no-op 成功" 分支要求调用方**能拿到已删除 cell 的 revision**。两种读法互斥。

**裁定**：

```
get(key)  → 若 key 从未存在        → null
            若 key 存在（deleted 为 true 或 false）→ 返回该 StateCell（含 deleted 标记）
list(pattern) → 同样 MUST 包含已逻辑删除的 cell
```

**API-1 改写**：`get MUST return the current StateCell — including logically-deleted cells —
or null if the key has never existed.`
**API-2 改写**：`list MUST return all matching StateCells, including logically-deleted ones.`

**理由**：SC-3 规定删除只置标记、不丢 revision，说明"已删除"是一种**可见状态**而非消失。
若 `get` 对已删除返回 null，DEL-5 的 no-op 分支将永远不可达，DEL-6 的"复活"也无从携带 revision。

---

### D-24　IX-1 重写：区分"修改既有成员"与"扩展联合/收窄视图"　【关闭 F-24】

**问题**：IX-1（绝对禁止修改 v3.1 Channel 接口）与 IX-5（允许扩展 ChannelMode）
以及 `StateChannel.mode: 'state'`（收窄继承成员）互相否证。

**裁定**（三段式，取代 r2 的 IX-1 + IX-5）：

```
IX-1  State Mode MUST NOT modify, remove or retype any existing member of the v3.1 Channel interface.
IX-5  ChannelMode MAY be widened by adding the member 'state'.
      This widening is the ONLY permitted change to any v3.1 type, and it MUST be monotone (只增不改).
IX-6  StateChannel MUST be a narrowing view of Channel. Narrowing `mode` to the literal 'state'
      MUST NOT be considered a modification under IX-1.
```

---

### D-25　SU-6 重写：区分"对外无条件写入"与"内部 revision 钉定写入"　【关闭 F-25】

**问题**：SU-6 说 Core 中不存在无条件写入，但 `writeStateWithRevision`（无 CAS 参数）
正是 §14.1 restore 的写入路径。

**裁定**：

```
SU-6  Core MUST NOT expose any unconditional, client-facing write operation.
      A Transport MAY provide a revision-pinned internal write primitive, provided that:
        (a) it MUST reject any revision <= head(channel) with EAPP_REVISION_INVALID;
        (b) it MUST NOT be reachable from StateChannel's public API except through restore().
```

---

### D-26　`nextRevision` 元数归一　【关闭 F-26】

§4.3 的分配规则改为与接口一致：

```
newRevision = transport.nextRevision(channel)
```

（r2 写作 `nextRevision(channel, key)`，与 §11.1 / §14.3 的单参数声明矛盾。）

---

### D-27　snapshot 一致性去循环化　【关闭 F-29】

**问题**：`cells` 与 `maxRevision` 来自同一次读取，`cell.revision <= maxRevision` 是恒真式，无法被违反。

**裁定**：

```
snapshot MUST, in this order:
  1. P := head(channel)                 ← 先取日志头
  2. cells := listState(channel, pattern) 过滤到 revision <= P
  3. maxRevision := P

MUST NOT compute maxRevision by reducing over the returned cells.
```

**SNAP-1 改写**：`Every returned cell's revision MUST be <= maxRevision,
and maxRevision MUST be the channel head observed BEFORE the cell read.`

**理由**：把 head 的读取放在 cell 读取**之前**，就在两个操作之间打开了一个真实的竞态窗口，
使该不变量**可被违反也因而可被测试**。这同时修掉 F-03 的空快照问题（D-10）。

---

### D-28　`suspend` / `resume` / `close` 的投递语义　【关闭 F-30】

```
suspend()  MUST 停止投递新变更；迭代器 MUST NOT 再 yield，直到 resume()。
           已 yield 但未 ack 的变更仍然有效，对其 ack() MUST 照常工作。
resume()   MUST 从 watcher 当前 cursor 继续；MUST NOT 重投已 ack 的变更。
close()    MUST 终止迭代（挂起的 next() MUST resolve 为 done）；
           close() 之后的 ack() MUST 为 no-op（MUST NOT 抛错、MUST NOT 改写 pending）；
           close() MUST 幂等。
```

---

### D-29　能力标志的运行时后果表　【关闭 F-31 / S-13】

**问题**：r2 的四个能力标志中只有 `providesStateStorage` 有隐约落点；
`providesStateRevision` 从未被检查；同步的 `watch()` 无处抛 `EAPP_WATCH_UNSUPPORTED`。

**裁定**：每个标志 MUST 有唯一的运行时后果，逐条如下。

| 标志 | `false` 时的强制行为 |
|---|---|
| `providesStateStorage` | `get` / `list` / `set` / `delete` / `snapshot` / `restore` / `watch` 全部抛 `EAPP_STATE_UNSUPPORTED` |
| `providesStateRevision` | `set` / `delete` / `restore` 抛 `EAPP_STATE_UNSUPPORTED`（CAS 不可能成立，见 D-13）；`get` / `list` 仍可用 |
| `providesStateWatch` | `watch()` **同步抛** `EAPP_WATCH_UNSUPPORTED` |
| `providesStateSnapshot` | `snapshot()` / `restore()` 抛 `EAPP_UNSUPPORTED` |

**TS-2 改写**：`Each capability flag MUST have exactly one mandated runtime consequence,
  and it MUST be enforced at the earliest possible call, synchronously where the API is synchronous.`

---

### D-30　Channel 创建 API　【关闭 F-33 / M-2】

```ts
function createStateChannel(
  transport: StateTransport,
  options: StateChannelOptions,
): StateChannel;
```

MUST 在创建时校验：`options.mode === 'state'`、`transport.capabilities.providesStateStorage === true`、
`options.owner` 是已注册 Identity（D-09）；
违反分别抛 `EAPP_MODE_INVALID` / `EAPP_STATE_UNSUPPORTED` / `EAPP_STATE_ACTOR_REQUIRED`。

---

### D-31　key 命名空间 MUST 结构化，MUST NOT 字符串拼接　【关闭 F-32 / M-7】

**问题**：§14.4 用 `` `${channel}:${update.key}` `` 作 Map 键，
于是 `(channel="a", key="b:c")` 与 `(channel="a:b", key="c")` 命中同一 cell，跨 channel 污染。

**裁定**：`StateTransport` MUST 按 `(channel, key)` 二元组寻址，MUST NOT 拼接为单一字符串。
内存实现 MUST 使用嵌套 Map。

---

### D-32　`validateUpdate` 重写　【关闭 F-17 / S-7】

```
hasValue   = Object.hasOwn(update, 'value')
hasDeleted = update.deleted === true

SU-2 (改写)  StateUpdate MUST have a 'value' property or set deleted = true.
             显式 { value: undefined } 是合法写入。
SU-3 (保持)  MUST NOT carry both 'value' and deleted = true → EAPP_STATE_VALUE_INVALID.
SU-9 (新增)  deleted, when present, MUST be true；deleted === false MUST be rejected
             with EAPP_STATE_VALUE_INVALID.
SC-4 (收窄)  可序列化约束只适用于 type === 'set' 的变更；
             已删除 cell 的 value MUST be undefined。
```

---

### D-33　错误面的完整性　【关闭 F-35 / M-5】

```
每个错误码 MUST 在规范正文中至少有一个明确的产生点。
EappError.retryable 的赋值规则：
  EAPP_REVISION_CONFLICT  → retryable = true   （CAS 冲突可重试）
  EAPP_CURSOR_TOO_OLD     → retryable = false  （必须重新同步）
  EAPP_UNSUPPORTED / EAPP_STATE_UNSUPPORTED / EAPP_WATCH_UNSUPPORTED → false
  EAPP_INTERNAL           → false
  其余                     → false（默认）
```

---

### D-34　投递与恢复语义　【关闭 F-36 / M-6】

```
State 变更的投递语义为 at-least-once，作用域为「单个 StateWatcher 的两条 ack 之间」。
未 ack 的变更 MUST 在下一次迭代中重投，MUST NOT 丢失。
close() 之后 MUST NOT 再投递。
watcher.cursor 是恢复的唯一权威：
  以 cursor = C 新建的 watcher MUST 恰好收到 revision > C 且仍被保留的匹配变更。
```

---

### D-35　REV-6 / REV-8 的测试归属与可测性　【关闭 F-34 的一半】

**问题**：r2 §15 中 REV-6 与 REV-8 两个测试**测试体为空**，不 assert 任何东西。

```
REV-6  属于 v3.1 的管辖范围。v3.2 conformance MUST NOT 包含空测试体，
       改为在规范中标注 [covered by: tests/interaction/rev6.test.ts]。
REV-8  在 v3.2 中可测且 MUST 被测试：
       compareRevision MUST throw EAPP_REVISION_INVALID if either argument
       was not issued by this Transport instance.
       （内存实现通过 revision 中携带的 transport 实例标识来识别外来值。）
```

---

### D-36　`restoreState` 从 Transport 移除　【关闭 F-39】

```
r2 有两个互相竞争的 restore 入口：StateTransport.restoreState（L801）
与 StateChannel.restore 的自建循环（L1069-1081）。

r3: 移除 StateTransport.restoreState。
    restore MUST 只在 Channel 层组合 nextRevision + writeStateWithRevision + deleteStateWithCAS 实现，
    MUST 有唯一入口。
```

---

### D-37　Transport 五个方法的语义补全　【关闭 F-38 / M-3】

```
getState(channel, key)          → 语义同 D-23；channel 不存在时返回 null（MUST NOT 抛错）
listState(channel, pattern)     → MUST 按 key 字典序稳定排序；MUST 包含已删除 cell
readChangesAfter(ch, cursor, p) → MUST 按 revision 严格升序；
                                  MUST 只返回 revision > cursor 的变更（严格大于，不含 cursor 本身）；
                                  cursor === undefined MUST 解释为"从最早已保留位置"；
                                  无匹配时返回空数组（MUST NOT 阻塞）
writeStateWithRevision(...)     → MUST 追加一条新日志变更；revision MUST > head（否则 EAPP_REVISION_INVALID）；
                                  actor 由调用方（Channel）提供
```

---

### D-38　一致性覆盖义务与冻结闸门　【关闭 F-34】

```
每条不变量（SC-* / REV-* / SW-* / SU-* / DEL-* / SNAP-* / CF-* / API-* / TS-* / IX-*）
MUST 满足以下之一：
  (a) tests/conformance/state.test.ts 中至少一条测试直接命名该不变量；
  (b) 规范正文中带 [covered by: <路径>] 标注，指向其它套件。

MUST NOT 存在空的测试体（无 assert 的 test MUST 被删除或补全）。
冻结报告 MUST 由脚本从规范正文提取不变量清单，与测试名做集合差；差集非空即冻结失败。
```

---

## 第九部分：跨文档收敛决议（X-1 … X-12）

v3.0 / v3.1 补入后重新核对，发现第二类问题：**两份文档各自都说得通，但放在一起不可能同时成立**。
本节逐条裁定。**其中 R-0 是所有其它决议的前提。**

---

### R-0　顺序裁定：v3.1 必须先冻结，v3.2 才能冻结

```
v3.2 头部声明：  前置：v3.0.0-core FROZEN / v3.1.0-interaction SEMANTIC FROZEN
v3.1 的正文：    §14 冻结声明（草案）
                 文末：「**EaPP v3.1.0 Interaction Layer — Draft**」
                       「**下一步：一致性测试通过后，标记 v3.1.0 FROZEN。**」
```

**裁定**：v3.1 **没有冻结**。v3.2 §16 把"与 v3.1 的接口一致性验证 ✅"列为已满足的冻结条件，
而该基线尚不存在，且**已经与 v3.2 冲突**（X-1 / X-2 / X-4 / X-5 / X-6 均为 P0）。

```
冻结顺序 MUST 为：

  v3.0.0-core           FROZEN  ✅（§0 已自述冻结，本轮不做任何修改）
        ↓
  v3.1.0-interaction    先收敛为一致、自洽、通过一致性测试的版本 → FROZEN   ← 必须补课
        ↓
  v3.2.0-state          在已冻结的 v3.1 之上做 r3 → FROZEN
```

**理由**：v3.1 处于 DRAFT 状态，因此它可以被直接修订而不触发勘误流程；
一旦 v3.2 抢先在冲突的 v3.1 上冻结，X-2（`revision: number` vs `Revision = string`）
和 X-4（`AckContext.nack`）就会变成两个冻结层之间的**永久不兼容**。

---

### R-1　`ChannelMode` 不存在"扩展"　【裁定 X-1】

**v3.1 §2.1 L105 已经含 `'state'`**：

```typescript
type ChannelMode = 'request' | 'event' | 'stream' | 'state';
```

v3.2 §9.3 却写「v3.1 ChannelMode = request | event | stream」，并声称自己扩展出了第四种、
且「这是唯一修改」。

**裁定**：

```
v3.2 MUST NOT 修改 ChannelMode。
'state' 是 v3.1 的既有成员，v3.2 不存在任何"扩展"。
§9.3 整节与 IX-5 作废。
```

**IX 系列收敛为两条**（取代 r2 的 IX-1 / IX-5，并与 D-24 合并）：

```
IX-1  State Mode MUST NOT modify, remove or retype any existing member of any v3.0 or v3.1 type.
IX-2  State Mode MUST reuse v3.1 Subscription / Cursor / AckContext semantics.
IX-3  State Mode MUST NOT introduce new primitives into Channel.
IX-4  StateTransport MUST extend v3.1 Transport.
IX-6  StateChannel MUST be a narrowing view of Channel; narrowing mode to 'state'
      MUST NOT be considered a modification under IX-1.
```

---

### R-2　`revision` 的类型：v3.2 必须修订 v3.1 的 `number`　【裁定 X-2】

```
v3.1 §3.4 L271-276:  interface StateMessage { key: string; value: unknown;
                                              revision: number;   // 单调递增
                                              deleted?: boolean; }
v3.2 §4.1   L219:    type Revision = string;   // opaque token, Transport-local
```

**裁定**：以 v3.2 为准，**修订 v3.1**。理由：

1. `Revision` 要能承载"日志位置"，而 v3.1 §6.2 已把同层的 `Cursor` 定为 `string`；
2. v3.2 的 D-01 要求 Revision 与 Cursor 同域，否则 REV-7 无法落地；
3. v3.1 尚未冻结，直接修订不触发勘误流程（见 R-0）。

```
v3.1.0 L274 修订为：  revision: Revision;   // 见 v3.2.0 §4；等价于 Channel 内的 Cursor 位置
```

---

### R-3　Revision 与 Cursor 同域　【裁定 X-3，强化 D-01】

```
v3.1 §6.2 L425:  type Cursor = string;   // 不透明字符串，全局有序
v3.1 CR-1 L632:  Cursor MUST be globally ordered within Channel.
```

**裁定**：v3.1 的 CR-1 与 v3.2 的 REV-1/REV-2/REV-4 是**同一条规律的两个侧面**。
只要按 D-01 把 `Revision` 定义为"Channel 内日志位置"，则：

```
Cursor  = Channel 内日志位置
Revision = Channel 内日志位置
⇒ Revision 与 Cursor 是同一域上的同一类型
⇒ REV-7 不再是"例外"，而是 CR-1 的直接推论
⇒ REV-6（Revision MUST NOT 用作 v3.1 模式的 Cursor）自动成立：
  request / event / stream 没有 Revision 这一概念，谈不上混用
```

**这是一次真正的语义收敛，而不是打补丁。**

---

### R-4　`StateUpdateEvent` MUST 实现完整 `AckContext`　【裁定 X-4，修正 D-15】

```
v3.1 §7.1 L470-473:  interface AckContext { ack(): Promise<void>; nack(): Promise<void>; }
                     AK-1 ack() 幂等 / AK-2 nack() 幂等
                     AK-3 ack() 后 MUST NOT nack() / AK-4 nack() 后 MUST NOT ack()
                     AK-5 已终结的 AckContext 再次调用 MUST 返回 EAPP_LEASE_CLOSED

v3.2 §5.1 / L1203-1209:  interface StateUpdateEvent { ...; ack(): Promise<void>; }   ← 缺 nack
```

**裁定**：

```typescript
interface StateUpdateEvent extends AckContext {
  readonly type: 'set' | 'deleted';
  readonly key: string;
  readonly revision: Revision;
  readonly value?: unknown;
}
```

```
nack()  不推进 cursor；该变更 MUST 在下一次迭代中重投。
ack()   幂等（AK-1）；nack() 幂等（AK-2）；AK-3/AK-4/AK-5 全部适用。
```

**若缺 `nack()`，v3.2 的 StateWatcher 不是合法的 v3.1 AckContext，SW-1 直接不成立。**

---

### R-5　cursor 推进规则以 v3.1 §6.4 为准，删除 `pending`　【裁定 X-5，取代 D-15】

```
v3.1 §6.1 L420:  Cursor MUST NOT 随收到消息自动前移。它只随 ack 前移。
v3.1 §6.4 L456-458:  ack(E3) → cursor = E3
                     「ack 一个更新的 cursor 意味着放弃中间未 ack 的消息」
v3.1 CR-3 L634:  Cursor MUST NOT skip unacked messages **implicitly**（注意：隐式）

v3.2 §14.2 L1185: 「按 cursor 顺序推进，只推进到第一个 PENDING 之前」
```

**裁定**：

```
1. CR-3 禁止的是"隐式跳过"（自动前移）。
   显式 ack 一个更靠后的变更并因此放弃中间项，是 v3.1 §6.4 明确允许的行为。
2. 因此 StateWatcher.ack() MUST 将 cursor 置为该变更的 revision（单调取 max）。
3. `pending` 结构整体删除 —— 它不是 v3.1 的模型，且无法表达 §6.4 的显式跳过。
```

**D-15 作废。**

---

### R-6　Channel 创建路径：必须经 v3.0 的 `bind()`　【裁定 X-6，取代 D-30】

```
v3.1 §8.1 L497:  Channel **MUST** 由 Binding 派生（引用的是 Binding，不是 binding 字符串）
v3.1 CC-1 L644:  Channel MUST NOT exist independently of Binding.
v3.0 §6.1 L260-266:  Binding { id, from, to, capability, contract? }
v3.0 §9.2 L535:      bind(request: BindRequest): Promise<Binding>

v3.2 §10.1 L696-700: StateChannelOptions { binding: string; mode: 'state'; conflictPolicy? }
v3.2 §14.1 L987-990: constructor(base: Channel, transport, config)   ← 收已建好的 Channel
```

**裁定**：v3.2 缺一条完整的 `Binding → Channel` 实例化路径。冻结为三段式：

```
① Composition Core（v3.0）
     const binding = await core.bind({ from, to, capability });

② Interaction Layer（v3.1）
     const ref = await interaction.deriveChannel(binding, {
       mode: 'state',
       delivery: 'at-least-once',        // v3.1 §4.4 强制
     });

③ State Mode（v3.2）
     const ch = await interaction.instantiate(ref, { conflictPolicy: 'cas', owner: identity });
```

```
MUST NOT 接受裸 binding 字符串。
若 binding 未处于 ACTIVE，deriveChannel MUST 返回 EAPP_BINDING_INVALID。
```

**D-30 作废，由本节取代。**

---

### R-7　state 模式的 delivery 恒为 `at-least-once`　【裁定 X-7】

```
v3.1 §4.4 L338:  | state | at-least-once |
v3.1 DL-4 L621:  at-least-once MUST ack.
v3.1 DL-5 L622:  at-least-once consumer MUST be idempotent.
```

**裁定**：

```
StateChannel.delivery MUST === 'at-least-once'（MUST NOT 为 'at-most-once'）。
创建时指定其它值 MUST 返回 EAPP_DELIVERY_UNSUPPORTED。
StateWatcher MUST ack（DL-4），其消费方 MUST 幂等（DL-5）。
```

v3.2 全篇未提 delivery —— 此条为新增义务。

---

### R-8　`TransportCapabilities` 合成单一定义，命名统一为 `supports*`　【裁定 X-8】

```typescript
interface TransportCapabilities {
  // ---- v3.1 既有 ----
  persistent: boolean;
  ordering: 'none' | 'per-source' | 'global';
  delivery: { atMostOnce: boolean; atLeastOnce: boolean; replay: boolean };
  supportsCursor: boolean;
  supportsLease: boolean;
  // ---- v3.2 新增（命名风格与 v3.1 对齐） ----
  supportsState: boolean;
  supportsStateRevision: boolean;
  supportsStateWatch: boolean;
  supportsStateSnapshot: boolean;
  stateConsistency: 'strong' | 'eventual';
  stateRetention: { kind: 'unbounded' } | { kind: 'window'; entries: number };
  durabilityBoundary: 'process' | 'machine' | 'cluster' | 'global';   // 见 R-9
}
```

**理由**：v3.1 用 `supportsCursor` / `supportsLease`，v3.2 用 `providesStateStorage` /
`providesStateRevision`。同一接口内两套命名不合规范；统一为 `supports*`。

---

### R-9　`durabilityBoundary` 必须在 v3.1 补定义　【裁定 X-9】

`durabilityBoundary` **只出现在 v3.2 自己的正文里**（§11.3 / §11.4 / TS-5），
v3.0 与 v3.1 从未声明过它，但 TS-5 却把它当作既成能力来引用。

**裁定**：概念保留（能力矩阵确实需要它），但**归属 v3.1** 并加入 `TransportCapabilities`（见 R-8）。

**TS-5 改写**：

```
A Transport MUST NOT declare stateConsistency = 'strong' beyond its durabilityBoundary.
即：durabilityBoundary = 'process' 的 Transport MUST NOT 被表述为跨进程强一致。
```

---

### R-10　错误模型：保持三层各自扩展，但只定义一个 `EappError` 类　【裁定 X-10】

```
v3.0 §16 L801:  interface EappError { code: string; message: string; details?: unknown; retryable?: boolean }
v3.1 §11 L674:  interface EappError { ... }        ← 同名重复声明
v3.2 §13 L967:  interface EappError { ... }        ← 第三次重复
三份文档中，只有 interface，没有 class；而三份的参考实现都在 `new EappError(...)`。
```

**裁定**：**不改动 v3.0 的冻结文本**（`interface` 是类型，可以被类实现）：

```
1. 在共享包中定义唯一运行时实现：
   class EappError extends Error implements EappError { ... }

2. 三个 code 联合保持分层，且 MUST 可相加：
   type EappErrorCode = EappCoreErrorCode | EappInteractionErrorCode | EappStateErrorCode;

3. v3.0 §16 / v3.1 §11 的既有码 MUST NOT 被重命名或改义；
   层内新增码 MUST 只追加。
```

**新增的 State 码**：`EAPP_CURSOR_TOO_OLD`、`EAPP_STATE_ACTOR_REQUIRED`（见 D-14）。
**复用 v3.1 既有码**：`EAPP_UNSUPPORTED`、`EAPP_MODE_INVALID`、`EAPP_DELIVERY_UNSUPPORTED`
（v3.2 §14 抛的 `EAPP_MODE_INVALID` / `EAPP_UNSUPPORTED` 因此合法，无需新增）。

---

### R-11　目录布局归一为 `packages/`　【裁定 X-11】

```
v3.0 §19.1 L913-933  与  v3.1 §12.1 L688-723 一致给出：
    eapp/{spec, reference/{core,interaction,transport}, tests/conformance, examples}

v3.2 §14 给出的是：
    packages/state/src/state-channel.ts
    packages/transport/memory/src/state.ts
    tests/conformance/state.test.ts
```

**裁定**：

```
采用 packages/ 布局。v3.0 §19.1 用的是 SHOULD（"参考实现 SHOULD 位于"），
因此偏离 MUST 不视为违规，但 MUST 在 changelog 中登记映射关系。
```

| 规范路径（v3.0/v3.1） | 实现路径 |
|---|---|
| `reference/core/identity.ts` … | `packages/core/src/identity.ts` … |
| `reference/interaction/channel.ts` | `packages/interaction/src/channel.ts` |
| `reference/interaction/modes/state.ts` | `packages/state/src/*`（独立包，v3.2 的决定） |
| `reference/transport/memory.ts` | `packages/transport/memory/src/*` |
| `tests/conformance/{core,interaction}.test.ts` | 同名保留 |

---

### R-12　版本规划漂移登记　【裁定 X-12】

```
v3.1 §14 L1136:  Next: v3.2.0 transport-capability
实际:            v3.2.0-state
```

**裁定**：登记进 changelog，`transport-capability` 顺延。
不修改 v3.1 文本（该行位于"草案"块内，随 v3.1 冻结时一并更新）。

---

### R-13　v3.0 §19.2 已经把"不变量必须有机检测试"写进冻结文本

```
v3.0 §19.2 L937:  每个不变量 MUST 至少有一个对应的测试用例
```

**裁定**：这条是 **v3.0 的冻结义务**，对 v3.1 与 v3.2 同样生效。
它把 D-38 从"我建议的闸门"升级为"已冻结的合规要求"：

```
每条不变量 MUST 至少有一条测试。
v3.0 §19.3 的 ConformanceClaim 是冻结接口，冻结报告 MUST 产出该结构：
    interface ConformanceClaim { eappVersion; levels; testSuite; passed; total }
```

---

## 附：被本部分取代或修正的早期决议

| 早期决议 | 状态 | 取代者 |
|---|---|---|
| D-02 `SubscriptionMode = 'exclusive' \| 'group'` | ⚠️ 修订 | v3.1 全无 `Subscription` 类型；本决议把它登记为 **v3.1 新增**，而非"重建 v3.1 既有定义"；取值不变 |
| D-03 `Cursor` 为 branded type | ❌ 作废 | **R-3**。v3.1 §6.2 已冻结 `type Cursor = string`，不得改。改为定义 `CursorAnchor = 'earliest' \| 'latest' \| Cursor`，并规定**字面量优先解析** |
| D-14 错误码表 | ⚠️ 修订 | **R-10**。改为"分层联合 + 单一类"，复用 v3.1 既有码 |
| D-15 `pending` 以 cursor 为键 | ❌ 作废 | **R-5**。`pending` 整体删除 |
| D-24 IX-1 重写 | ⚠️ 修订 | **R-1**。IX 收敛为六条 |
| D-30 `createStateChannel(transport, options)` | ❌ 作废 | **R-6**。改为经 `bind()` 的三段式路径 |

---

## 附：缺陷 → 决议 对照（完整）

| 缺陷 | 决议 | 缺陷 | 决议 | 缺陷 | 决议 | 缺陷 | 决议 |
|---|---|---|---|---|---|---|---|
| F-01 | D-05 | F-11 | D-13 | F-21 | D-22 | F-31 | D-29 |
| F-02 | D-09 | F-12 | D-14 | F-22 | D-14（补类定义） | F-32 | D-31 |
| F-03 | D-10 + D-27 | F-13 | D-04 | F-23 | D-23 | F-33 | D-30 |
| F-04 | D-11 + D-12 | F-14 | D-15 | F-24 | D-24 | F-34 | D-35 + D-38 |
| F-05 | **D-01** | F-15 | D-16 + D-17 | F-25 | D-25 | F-35 | D-33 |
| F-06 | D-03 | F-16 | D-18 | F-26 | D-26 | F-36 | D-34 |
| F-07 | D-07 | F-17 | D-19 + D-32 | F-27 | D-22 | F-37 | D-18 |
| F-08 | D-06 | F-18 | D-20 | F-28 | D-22 | F-38 | D-37 |
| F-09 | D-12 | F-19 | D-04 + D-21 | F-29 | D-27 | F-39 | D-36 |
| F-10 | D-07 | F-20 | **D-22** | F-30 | D-28 | | |

**全部 F-01 … F-39 已关闭。**

### 其中改变了 r2 语义内核的决定（只有四条）

| 决定 | r2 原文 | r3 之后 |
|---|---|---|
| **D-01** | Revision 是 per-cell 版本号；REV-7 是"例外" | Revision 就是 Channel 内日志位置；REV-7 成为推论 |
| **D-22** | `delete` = `set({deleted:true})` | `delete` 是 Transport 一等原语 |
| **D-27** | `maxRevision` 由 cells 归约得出（恒真） | `maxRevision` = 读取 cells **之前**的 head（可证伪） |
| **D-13** | CRDT 获得 `⚠️` 豁免，允许 eventual + revision | 取消豁免；能力标志收紧，`providesStateRevision=false` 即禁止 CAS |

其余 34 条均为消除歧义、补齐定义或修正自相矛盾，不改变语义方向。

### 冻结前的最后一道工序

D-38 要求：冻结报告 MUST 由脚本从规范正文提取不变量清单，
与测试名做集合差；**差集非空即冻结失败**。
这是把 §16 路线图上那句"Conformance Tests"从口号变成闸门的唯一办法。

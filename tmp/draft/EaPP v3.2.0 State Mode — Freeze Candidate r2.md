# EaPP v3.2.0 State Mode — Freeze Candidate r2

**Independent Review Corrections**

版本：3.2.0-r2  
状态：Freeze Candidate  
前置：v3.0.0-core FROZEN / v3.1.0-interaction SEMANTIC FROZEN  
规范用语：MUST / MUST NOT / SHOULD / SHOULD NOT / MAY（RFC 2119）

> **Composition 决定关系。**
> **Interaction 决定互动。**
> **State 决定共享。**

---

## 0. 本轮修订摘要

Independent Review 提出的 6 P0 + 6 P1 全部接受。修正如下：

| 编号 | 问题                                             | 修正                                                                 |
| ---- | ------------------------------------------------ | -------------------------------------------------------------------- |
| P0-1 | StateWatcher.mode 与 v3.1 Subscription.mode 冲突 | 保留 `mode` 为 SubscriptionMode，新增 `kind: 'state'`                |
| P0-2 | `deriveCursor` 违反 REV-6                        | 显式承认 State Mode 例外：Revision MAY 作为位置；删除 `deriveCursor` |
| P0-3 | `restore` 违反 REV-4                             | restore MUST 重新分配 revision                                       |
| P0-4 | CAS 初始状态未定义                               | `expectedRevision: Revision \| null`，null = key MUST NOT exist      |
| P0-5 | StateTransport 与 v3.1 Transport 关系未定义      | StateTransport extends Transport                                     |
| P0-6 | StateWatcher.ack 签名冲突                        | 采用 v3.1 AckContext，`ack()` 无参数                                 |
| P1-1 | StatePattern 组合语义未定义                      | union type，字段互斥                                                 |
| P1-2 | value + deleted 同时存在                         | MUST NOT 同时指定                                                    |
| P1-3 | delete 后 set 未定义                             | revision 继续递增，deleted 变 false                                  |
| P1-4 | 跨 Transport 比较问题                            | Revision 是 Transport-local                                          |
| P1-5 | StateChannel 与 Channel 关系                     | 扩展 Channel，MUST NOT 新建包装类型                                  |
| P1-6 | StateWatcher 初始 cursor 未定义                  | 显式冻结默认行为                                                     |

---

## 1. 范围与定位

### 1.1 State Mode 解决什么

v3.1 冻结了三种交互模式：

- `request`：请求-响应
- `event`：发布-订阅
- `stream`：有序流

这三种都是**消息传递**模型。它们回答：

> 一个参与者如何向另一个参与者发送信息？

但有一类场景不是消息传递：

> 多个参与者如何共享、观察、修改同一份状态？

这是 **State Mode** 要解决的问题。

### 1.2 非目标

State Mode **不是**：

- 数据库（不做查询语言、事务、索引）
- CRDT 协议（不默认最终一致）
- 消息队列（不涉及投递语义）
- 缓存（不涉及淘汰策略）

State Mode **是**：

> 一种最小的、可观察的、带版本的状态共享语义，作为 Interaction Layer 的第四种模式。

### 1.3 分层位置

```
Composition Core（v3.0）
    ↓
Interaction Layer（v3.1）
    ├── request
    ├── event
    ├── stream
    └── state          ← v3.2 新增
    ↓
Transport
```

**State Mode 是 Channel 的第四种 mode。** 它不是新层。

### 1.4 与 v3.1 的关系

**冻结原则**：

```
IX-1  State Mode MUST NOT modify v3.1 Channel interface.
IX-2  State Mode MUST reuse v3.1 Subscription semantics.
IX-3  State Mode MUST NOT introduce new primitives into Channel.
IX-4  StateTransport MUST extend v3.1 Transport.
```

State Mode：

- **复用** v3.1 的 Channel / Subscription / Cursor / AckContext
- **新增** StateCell / Revision / StateUpdate
- **不修改** v3.1 的任何接口

---

## 2. 核心本体

State Mode 引入**四个概念**：

```
StateCell          带版本的状态单元
Revision           单调递增的版本号（Transport-local）
StateWatcher       状态观察者（v3.1 Subscription 子类型）
StateUpdate        一次状态变更
```

### 2.1 因果链

```
Channel (mode = state)
    │
    │ open
    ▼
StateCell                    ← 命名状态单元
    │
    ├── Revision             ← 版本号（State 层，Transport-local）
    ├── Value                ← 当前值
    │
    └── StateWatcher         ← 观察者（v3.1 Subscription 子类型）
           │
           └── Cursor        ← 观察位置（Interaction 层）
```

### 2.2 Revision 与 Cursor 的关系（P0-2 修正）

**冻结**：

```
Revision    = StateCell 的版本号（State 层语义，Transport-local）
Cursor      = 观察者的位置（Interaction 层语义）
```

**State Mode 例外**：

```
REV-6 的原始意图是防止 v3.1 模式中 Revision/Cursor 混用。
State Mode MUST 显式声明例外：
    Revision MAY be used as Cursor position in State Mode.
    This exception MUST be explicit and frozen.
```

**具体规则**：

- State Mode 中，Cursor MAY be derived from Revision。
- 该派生 MUST 由 State Mode 定义，MUST NOT 由 v3.1 Interaction Layer 定义。
- 派生规则 MUST 显式冻结（见 §7.3）。
- 其他 v3.1 模式（request / event / stream）MUST NOT 使用 Revision 作为 Cursor。

### 2.3 关系图

```
                Channel (state)
                     │
        ┌────────────┼────────────┐
        │            │            │
    StateCell    StateCell    StateCell
        │            │            │
    Revision      Revision     Revision
   (Transport-   (Transport-  (Transport-
    local)        local)       local)
        │            │            │
        └────────────┴────────────┘
                     │
              StateWatcher              ← v3.1 Subscription 子类型
                     │
                  Cursor                ← Interaction 层语义
```

---

## 3. StateCell

### 3.1 定义

```typescript
interface StateCell {
  key: string; // 命名空间内的键
  revision: Revision; // 当前版本（Transport-local）
  value: unknown; // 当前值（可序列化）
  deleted: boolean; // 逻辑删除标记
  updatedAt: number; // 最后更新时间
  updatedBy: Identity; // 最后更新者
}
```

### 3.2 语义

- 一个 StateCell MUST 有唯一 `key`。
- `key` MUST 在同一 Channel 内唯一。
- `revision` MUST 单调递增（在 Transport 内）。
- `deleted = true` MUST 保留 `revision`。
- `value` MUST 可序列化（与 v3.0 Tuple 约束一致）。

### 3.3 不变量

- **SC-1**：`key` MUST NOT 为空。
- **SC-2**：`revision` MUST 单调递增。
- **SC-3**：`deleted = true` MUST 保留 `revision`。
- **SC-4**：`value` MUST 可序列化。
- **SC-5**：`updatedBy` MUST 是已存在的 Identity。

---

## 4. Revision

### 4.1 定义

```typescript
type Revision = string; // opaque token, Transport-local
```

**关键约束（P1-4 修正）**：

```
Revision 是 Transport-local 的。
Revision MUST NOT be compared across Transports.
Revision 的比较 MUST 由 Transport 提供。
```

### 4.2 语义

- 每次写操作 MUST 分配一个新 revision。
- 新 revision MUST 大于当前 revision（在同一 Transport 内）。
- Revision MUST NOT 回退（在同一 Transport 内）。
- Revision MUST NOT 由客户端分配。
- Revision MUST be opaque to consumers。

### 4.3 分配规则

```
写入时：
    newRevision = transport.nextRevision(channel, key)
```

### 4.4 比较

**Revision 的比较 MUST 由 Transport 提供**：

```typescript
interface StateTransport {
  compareRevision(a: Revision, b: Revision): number;
  // 返回：负数 = a < b；0 = 相等；正数 = a > b
}
```

消费者 MUST NOT 直接比较 Revision 字符串。

### 4.5 不变量

- **REV-1**：Revision MUST be monotonic within a Transport。
- **REV-2**：New revision MUST > current revision。
- **REV-3**：Revision MUST be assigned by Transport。
- **REV-4**：Revision MUST NOT roll back within a Transport。
- **REV-5**：Revision MUST be opaque to consumers。
- **REV-6**：Revision MUST NOT be used as Cursor in v3.1 modes。
- **REV-7**（新增）：Revision MAY be used as Cursor in State Mode。
- **REV-8**（新增）：Revision MUST NOT be compared across Transports。

---

## 5. StateWatcher（P0-1 / P0-6 修正）

### 5.1 定义

StateWatcher **MUST 实现 v3.1 Subscription 接口**。

**P0-1 修正**：

- MUST NOT 覆盖 `Subscription.mode`。
- 新增 `kind: 'state'` 字段标识 State Mode。

**P0-6 修正**：

- `ack` MUST 使用 v3.1 AckContext 语义。
- `ack()` MUST NOT take parameters。

```typescript
interface StateWatcher extends Subscription {
  kind: "state"; // 新增，标识 State Mode
  mode: SubscriptionMode; // v3.1 SubscriptionMode，保留语义
  pattern: StatePattern;
  // ack 通过 v3.1 AckContext 提供，不带参数
}
```

### 5.2 消费接口

**正确用法（P0-6 修正）**：

```typescript
for await (const update of watcher) {
  // update 携带 v3.1 AckContext
  await update.ack(); // 无参数
}
```

**错误用法（MUST NOT）**：

```typescript
await watcher.ack(update); // ← 不允许
```

### 5.3 StateWatcher 的 ack 语义

```
update.ack():
    表示观察者已处理该 update
    推进 StateWatcher 的 cursor
    不影响 StateCell
    不影响其他 StateWatcher
```

**关键区别**：

| 概念                      | 作用对象 | 效果          |
| ------------------------- | -------- | ------------- |
| `Lease.ack`（v3.1）       | Delivery | 删除 Delivery |
| `AckContext.ack`（v3.1）  | Delivery | 推进 Cursor   |
| `AckContext.ack`（state） | Update   | 推进 Cursor   |

**语义一致**：State Mode 复用 v3.1 AckContext，不引入新的 ack 类型。

### 5.4 StateWatcher 的初始位置（P1-6 修正）

**冻结**：

```
StateWatcher 的初始位置由 options.cursor 决定：

    cursor 未指定      → 从当前时刻开始（只看未来）
    cursor = 'earliest' → 从第一条开始
    cursor = 'latest'   → 从当前时刻开始
    cursor = Cursor     → 从该 cursor 之后开始
```

**默认行为**：

```
未指定 cursor → 从当前时刻开始
```

### 5.5 与 Subscription 的关系

```
Subscription (v3.1)              ← 基础接口
    ├── mode: SubscriptionMode
    ├── cursor
    └── ...

StateWatcher (v3.2)              ← Subscription 子类型
    ├── kind: 'state'
    ├── mode: SubscriptionMode    ← 继承
    ├── pattern
    └── ...
```

### 5.6 不变量

- **SW-1**：StateWatcher MUST implement v3.1 Subscription。
- **SW-2**：StateWatcher MUST have `kind = 'state'`。
- **SW-3**：StateWatcher MUST NOT override `Subscription.mode`。
- **SW-4**：StateWatcher MUST have independent cursor。
- **SW-5**：StateWatcher MUST NOT affect other StateWatchers。
- **SW-6**：`ack()` MUST NOT take parameters。
- **SW-7**：`ack()` MUST NOT modify StateCell。
- **SW-8**：StateWatcher MUST receive deleted events。
- **SW-9**：StateWatcher's default initial position MUST be "from now"。

---

## 6. StateUpdate（P0-4 / P1-1 / P1-2 修正）

### 6.1 定义

```typescript
interface StateUpdate {
  key: string;
  value?: unknown; // 新值
  deleted?: boolean; // 逻辑删除
  expectedRevision: ExpectedRevision;
}

type ExpectedRevision = Revision | null;
// null 表示：key MUST NOT exist
// Revision 表示：key MUST exist 且 revision 匹配
```

### 6.2 CAS 初始状态（P0-4 修正）

**冻结**：

```
expectedRevision: null
    → key MUST NOT exist
    → 若 key 已存在，MUST 返回 EAPP_REVISION_CONFLICT

expectedRevision: Revision
    → key MUST exist 且 revision 匹配
    → 若不匹配，MUST 返回 EAPP_REVISION_CONFLICT
```

**初始写入示例**：

```typescript
await ch.set({ key: "k", value: 1, expectedRevision: null });
```

**MUST NOT** 使用字符串 `'0'` 表示不存在。`null` 是唯一表示。

### 6.3 value / deleted 互斥（P1-2 修正）

**冻结**：

```
StateUpdate MUST NOT specify both value and deleted=true.
违反 MUST 返回 EAPP_STATE_VALUE_INVALID.
```

### 6.4 CAS 语义

```
写入时：
    if expectedRevision === null:
        if key exists: throw EAPP_REVISION_CONFLICT
    else:
        if key not exists: throw EAPP_REVISION_CONFLICT
        if currentRevision != expectedRevision: throw EAPP_REVISION_CONFLICT

    assign new revision
    apply update
```

### 6.5 原子性

**冻结**：

```
CAS check + set MUST be atomic in Transport.
StateChannel MUST NOT 自行执行 CAS.
```

### 6.6 不变量

- **SU-1**：StateUpdate MUST specify key。
- **SU-2**：StateUpdate MUST specify value or deleted。
- **SU-3**：StateUpdate MUST NOT specify both value and deleted=true。
- **SU-4**：CAS failure MUST return `EAPP_REVISION_CONFLICT`。
- **SU-5**：CAS failure MUST NOT modify state。
- **SU-6**：Unconditional write MUST NOT exist in Core。
- **SU-7**：CAS check + set MUST be atomic in Transport。
- **SU-8**：`expectedRevision` MUST be `Revision | null`。

---

## 7. 删除语义

### 7.1 定义

```typescript
interface StateDelete {
  key: string;
  expectedRevision: ExpectedRevision;
}
```

### 7.2 语义

```
delete(K, expectedRevision):
    CAS check
    if 通过：
        StateCell K.deleted = true
        revision 增加
        产生 type='deleted' 的 update
    else:
        throw EAPP_REVISION_CONFLICT
```

### 7.3 delete 后 set（P1-3 修正）

**冻结**：

```
delete(K) 后再 set(K, v):
    - revision MUST 单调递增（不重置）
    - deleted MUST become false
    - value MUST be the new value
```

**示例**：

```
set('k', 1, null)       → revision = r1, deleted = false
delete('k', r1)         → revision = r2, deleted = true
set('k', 3, r2)         → revision = r3, deleted = false, value = 3
```

### 7.4 观察通知

```
delete(K) 产生 type='deleted' 的 update。
watcher MUST 收到 deleted 事件。
```

### 7.5 边界情况

| 场景                                           | 行为                                 |
| ---------------------------------------------- | ------------------------------------ |
| delete 不存在的 key（expectedRevision = null） | MUST 返回 `EAPP_STATE_KEY_NOT_FOUND` |
| delete 已删除的 key（revision 匹配）           | MUST 返回 no-op，成功                |
| delete 已删除的 key（revision 不匹配）         | MUST 返回 `EAPP_REVISION_CONFLICT`   |

### 7.6 不变量

- **DEL-1**：delete MUST perform CAS。
- **DEL-2**：delete MUST produce `type='deleted'` event。
- **DEL-3**：StateWatcher MUST receive deleted events。
- **DEL-4**：delete non-existent key MUST return `EAPP_STATE_KEY_NOT_FOUND`。
- **DEL-5**：delete already-deleted key MUST be no-op success。
- **DEL-6**：delete followed by set MUST increment revision and clear deleted flag。

---

## 8. Snapshot / Restore（P0-3 修正）

### 8.1 定义

```typescript
interface StateSnapshot {
  channel: string;
  cells: StateCell[];
  maxRevision: Revision;
  takenAt: number;
}
```

### 8.2 Snapshot 语义

**冻结**：

```
snapshot 返回 Read-consistent 快照。
MUST 包含 maxRevision。
MUST NOT 保证 linearizable。
```

**Read-consistent 的定义**：

```
snapshot 内所有 cell 的 revision <= maxRevision。
MUST NOT 保证所有 cell 反映同一时刻的状态。
MUST 保证 maxRevision 是 snapshot 时刻的有效上界。
```

### 8.3 Restore 语义（P0-3 修正）

**冻结**：

```
restore MUST NOT roll back revisions.
restore MUST assign new revisions to all restored cells.
restore MUST preserve relative ordering.
```

**Restore 实现**：

```typescript
async restore(snapshot: StateSnapshot): Promise<void> {
  for (const cell of snapshot.cells) {
    const newRevision = await this.transport.nextRevision(this.channel.id);
    await this.transport.writeStateWithRevision(
      this.channel.id,
      cell.key,
      cell.value,
      cell.deleted,
      newRevision,
    );
  }
}
```

### 8.4 不变量

- **SNAP-1**：snapshot MUST be read-consistent。
- **SNAP-2**：snapshot MUST include maxRevision。
- **SNAP-3**：snapshot MUST NOT claim linearizability。
- **SNAP-4**（新增）：restore MUST NOT roll back revisions。
- **SNAP-5**（新增）：restore MUST assign new revisions。
- **SNAP-6**（新增）：restore MUST preserve relative ordering。

---

## 9. ConflictPolicy

### 9.1 定义

```typescript
interface StateChannelConfig {
  conflictPolicy: ConflictPolicy;
}

type ConflictPolicy = "cas"; // Core 只有这一种
```

### 9.2 接口隔离

**冻结**：

```
State Mode MUST NOT modify v3.1 Channel interface.
State Mode MUST inject configuration via StateChannelConfig.
```

**v3.1 Channel 保持冻结**：

```typescript
interface Channel {
  id: string;
  binding: string;
  mode: ChannelMode; // 扩展为包含 'state'
  delivery: DeliveryGuarantee;
  state: ChannelState;
}
```

**State Mode 通过 Config 注入**：

```typescript
// StateChannel 是 Channel 在 mode='state' 时的视图
// MUST NOT 是新的包装类型（P1-5 修正）

interface StateChannel extends Channel {
  mode: "state";
  // 扩展方法
  get(key: string): Promise<StateCell | null>;
  list(pattern: StatePattern): Promise<StateCell[]>;
  set(update: StateUpdate): Promise<Revision>;
  delete(key: string, expectedRevision: ExpectedRevision): Promise<Revision>;
  watch(pattern: StatePattern, options?: WatchOptions): StateWatcher;
  snapshot(pattern: StatePattern): Promise<StateSnapshot>;
  restore(snapshot: StateSnapshot): Promise<void>;
}
```

### 9.3 Channel.mode 扩展

**v3.1 ChannelMode**：

```typescript
type ChannelMode = "request" | "event" | "stream";
```

**v3.2 扩展**：

```typescript
type ChannelMode = "request" | "event" | "stream" | "state";
```

**冻结**：这是 ChannelMode 的**唯一**修改，MUST NOT 引入其他修改。

### 9.4 冲突策略

| 策略              | 是否 Core | 位置      |
| ----------------- | --------- | --------- |
| `cas`             | ✅        | Core      |
| `unconditional`   | ❌        | Extension |
| `last-write-wins` | ❌        | Extension |
| `merge`           | ❌        | Extension |
| `crdt`            | ❌        | Extension |
| `quorum`          | ❌        | Extension |

### 9.5 不变量

- **CF-1**：Core MUST only support CAS。
- **CF-2**：CAS failure MUST return `EAPP_REVISION_CONFLICT`。
- **CF-3**：Other policies MUST be defined in Extension。
- **CF-4**：Policy MUST be specified at Channel creation。
- **CF-5**：StateChannel MUST extend Channel, MUST NOT be a wrapper type。

---

## 10. State Mode API

### 10.1 Channel 创建

```typescript
interface StateChannelOptions {
  binding: string;
  mode: "state";
  conflictPolicy?: "cas"; // 默认 'cas'
}
```

### 10.2 操作

**StateChannel 是 Channel 的扩展视图**（P1-5 修正）：

```typescript
interface StateChannel extends Channel {
  mode: "state";

  // 读取
  get(key: string): Promise<StateCell | null>;
  list(pattern: StatePattern): Promise<StateCell[]>;

  // 写入（CAS）
  set(update: StateUpdate): Promise<Revision>;

  // 删除（CAS）
  delete(key: string, expectedRevision: ExpectedRevision): Promise<Revision>;

  // 观察
  watch(pattern: StatePattern, options?: WatchOptions): StateWatcher;

  // 快照
  snapshot(pattern: StatePattern): Promise<StateSnapshot>;

  // 恢复
  restore(snapshot: StateSnapshot): Promise<void>;
}
```

### 10.3 StatePattern（P1-1 修正）

**冻结**：StatePattern MUST be a union type，字段互斥。

```typescript
type StatePattern =
  | { key: string } // 精确匹配
  | { prefix: string } // 前缀匹配
  | { all: true }; // 全部
```

**违反 MUST 返回 `EAPP_STATE_PATTERN_INVALID`。**

### 10.4 返回值语义

| 操作       | 返回                 |
| ---------- | -------------------- |
| `get`      | StateCell 或 null    |
| `list`     | StateCell 数组       |
| `set`      | 新 revision          |
| `delete`   | 新 revision          |
| `watch`    | StateWatcher         |
| `snapshot` | Read-consistent 快照 |
| `restore`  | void                 |

### 10.5 不变量

- **API-1**：`get` MUST return current value or null。
- **API-2**：`list` MUST return matching StateCells。
- **API-3**：`set` MUST return new revision。
- **API-4**：`delete` MUST preserve revision。
- **API-5**：`watch` MUST return a v3.1-compatible Subscription。
- **API-6**：`snapshot` MUST be read-consistent。
- **API-7**：`snapshot` MUST include maxRevision。
- **API-8**：`restore` MUST overwrite current state。
- **API-9**（新增）：StatePattern MUST be union type。

---

## 11. Transport 能力（P0-5 修正）

### 11.1 定义

**StateTransport MUST extend v3.1 Transport**（P0-5 修正）：

```typescript
interface StateTransport extends Transport {
  // State-specific methods
  getState(channel: string, key: string): Promise<StateCell | null>;
  listState(channel: string, pattern: StatePattern): Promise<StateCell[]>;
  setStateWithCAS(
    channel: string,
    update: StateUpdate,
    expectedRevision: ExpectedRevision,
  ): Promise<Revision>;
  readStateAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: StatePattern,
  ): Promise<StateCell[]>;
  nextRevision(channel: string): Promise<Revision>;
  compareRevision(a: Revision, b: Revision): number;
  writeStateWithRevision(
    channel: string,
    key: string,
    value: unknown,
    deleted: boolean,
    revision: Revision,
  ): Promise<void>;
  restoreState(channel: string, snapshot: StateSnapshot): Promise<void>;
}
```

### 11.2 能力声明

```typescript
interface TransportCapabilities {
  // ... v3.1 已有

  // State Mode 相关
  providesStateStorage: boolean;
  providesStateRevision: boolean;
  providesStateWatch: boolean;
  providesStateSnapshot: boolean;
  stateConsistency: "strong" | "eventual";
}
```

### 11.3 一致性边界

**冻结**：

```
State consistency MUST be consistent with durabilityBoundary.
'strong' 意味着在 durabilityBoundary 内 strong。
```

### 11.4 能力矩阵

| Transport | stateStorage | stateRevision | stateWatch | stateSnapshot | consistency | durabilityBoundary |
| --------- | ------------ | ------------- | ---------- | ------------- | ----------- | ------------------ |
| Memory    | ✅           | ✅            | ✅         | ✅            | strong      | process            |
| Socket    | ❌           | ❌            | ❌         | ❌            | —           | machine            |
| Redis     | ✅           | ✅            | ✅         | ✅            | strong      | cluster            |
| NATS KV   | ✅           | ✅            | ✅         | ✅            | strong      | cluster            |
| CRDT      | ✅           | ⚠️            | ✅         | ⚠️            | eventual    | global             |

### 11.5 CAS 原子性

**冻结**：

```
CAS MUST be implemented atomically in Transport.
StateChannel MUST NOT 自行执行 CAS.
```

### 11.6 不支持时的处理

- 不支持 state storage → MUST 返回 `EAPP_STATE_UNSUPPORTED`。
- 不支持 revision → MUST NOT 用于 CAS。
- 不支持 watch → MUST 返回 `EAPP_WATCH_UNSUPPORTED`。

### 11.7 不变量

- **TS-1**：Transport MUST declare state capabilities。
- **TS-2**：Unsupported MUST return standard error。
- **TS-3**：MUST NOT fake support。
- **TS-4**：CRDT revision MUST be declared eventual。
- **TS-5**：State consistency MUST be consistent with durabilityBoundary。
- **TS-6**：CAS MUST be implemented atomically in Transport。
- **TS-7**（新增）：StateTransport MUST extend Transport。
- **TS-8**（新增）：Revision comparison MUST be provided by Transport。

---

## 12. 不变量（汇总）

```
SC-1    StateCell.key MUST NOT be empty.
SC-2    StateCell.revision MUST be monotonic.
SC-3    deleted=true MUST preserve revision.
SC-4    value MUST be serializable.
SC-5    updatedBy MUST be an existing Identity.

REV-1   Revision MUST be monotonic within a Transport.
REV-2   New revision MUST > current revision.
REV-3   Revision MUST be assigned by Transport.
REV-4   Revision MUST NOT roll back within a Transport.
REV-5   Revision MUST be opaque to consumers.
REV-6   Revision MUST NOT be used as Cursor in v3.1 modes.
REV-7   Revision MAY be used as Cursor in State Mode.
REV-8   Revision MUST NOT be compared across Transports.

SW-1    StateWatcher MUST implement v3.1 Subscription.
SW-2    StateWatcher MUST have kind = 'state'.
SW-3    StateWatcher MUST NOT override Subscription.mode.
SW-4    StateWatcher MUST have independent cursor.
SW-5    StateWatcher MUST NOT affect other StateWatchers.
SW-6    ack() MUST NOT take parameters.
SW-7    ack() MUST NOT modify StateCell.
SW-8    StateWatcher MUST receive deleted events.
SW-9    StateWatcher's default initial position MUST be "from now".

SU-1    StateUpdate MUST specify key.
SU-2    StateUpdate MUST specify value or deleted.
SU-3    StateUpdate MUST NOT specify both value and deleted=true.
SU-4    CAS failure MUST return EAPP_REVISION_CONFLICT.
SU-5    CAS failure MUST NOT modify state.
SU-6    Unconditional write MUST NOT exist in Core.
SU-7    CAS check + set MUST be atomic in Transport.
SU-8    expectedRevision MUST be Revision | null.

DEL-1   delete MUST perform CAS.
DEL-2   delete MUST produce type='deleted' event.
DEL-3   StateWatcher MUST receive deleted events.
DEL-4   delete non-existent key MUST return EAPP_STATE_KEY_NOT_FOUND.
DEL-5   delete already-deleted key MUST be no-op success.
DEL-6   delete followed by set MUST increment revision and clear deleted flag.

SNAP-1  snapshot MUST be read-consistent.
SNAP-2  snapshot MUST include maxRevision.
SNAP-3  snapshot MUST NOT claim linearizability.
SNAP-4  restore MUST NOT roll back revisions.
SNAP-5  restore MUST assign new revisions.
SNAP-6  restore MUST preserve relative ordering.

CF-1    Core MUST only support CAS.
CF-2    CAS failure MUST return EAPP_REVISION_CONFLICT.
CF-3    Other policies MUST be defined in Extension.
CF-4    Policy MUST be specified at Channel creation.
CF-5    StateChannel MUST extend Channel, MUST NOT be a wrapper type.

API-1   get MUST return current value or null.
API-2   list MUST return matching StateCells.
API-3   set MUST return new revision.
API-4   delete MUST preserve revision.
API-5   watch MUST return a v3.1-compatible Subscription.
API-6   snapshot MUST be read-consistent.
API-7   snapshot MUST include maxRevision.
API-8   restore MUST overwrite current state.
API-9   StatePattern MUST be union type.

TS-1    Transport MUST declare state capabilities.
TS-2    Unsupported MUST return standard error.
TS-3    MUST NOT fake support.
TS-4    CRDT revision MUST be declared eventual.
TS-5    State consistency MUST be consistent with durabilityBoundary.
TS-6    CAS MUST be implemented atomically in Transport.
TS-7    StateTransport MUST extend Transport.
TS-8    Revision comparison MUST be provided by Transport.

IX-1    State Mode MUST NOT modify v3.1 Channel interface.
IX-2    State Mode MUST reuse v3.1 Subscription semantics.
IX-3    State Mode MUST NOT introduce new primitives into Channel.
IX-4    StateTransport MUST extend v3.1 Transport.
IX-5    ChannelMode MAY be extended to include 'state' as the only modification.
```

---

## 13. 错误模型

```typescript
type EappStateErrorCode =
  | "EAPP_STATE_UNSUPPORTED"
  | "EAPP_REVISION_CONFLICT"
  | "EAPP_REVISION_INVALID"
  | "EAPP_STATE_KEY_INVALID"
  | "EAPP_STATE_KEY_NOT_FOUND"
  | "EAPP_STATE_VALUE_INVALID"
  | "EAPP_STATE_PATTERN_INVALID"
  | "EAPP_WATCH_UNSUPPORTED"
  | "EAPP_SNAPSHOT_INVALID"
  | "EAPP_INTERNAL";

interface EappError {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}
```

---

## 14. 参考实现骨架

### 14.1 StateChannel（扩展 Channel）

```typescript
// packages/state/src/state-channel.ts

export class StateChannelImpl implements StateChannel {
  readonly mode = "state" as const;

  constructor(
    private base: Channel, // v3.1 Channel
    private transport: StateTransport, // extends Transport
    private config: StateChannelConfig = { conflictPolicy: "cas" },
  ) {
    if (base.mode !== "state") {
      throw new EappError("EAPP_MODE_INVALID", "Not a state Channel");
    }
    if (config.conflictPolicy !== "cas") {
      throw new EappError("EAPP_UNSUPPORTED", "Only CAS is supported in Core");
    }
  }

  // 委托 v3.1 Channel 字段
  get id() {
    return this.base.id;
  }
  get binding() {
    return this.base.binding;
  }
  get delivery() {
    return this.base.delivery;
  }
  get state() {
    return this.base.state;
  }

  async get(key: string): Promise<StateCell | null> {
    return this.transport.getState(this.base.id, key);
  }

  async list(pattern: StatePattern): Promise<StateCell[]> {
    validatePattern(pattern);
    return this.transport.listState(this.base.id, pattern);
  }

  async set(update: StateUpdate): Promise<Revision> {
    validateUpdate(update);
    // CAS 原子性由 Transport 保证
    return this.transport.setStateWithCAS(
      this.base.id,
      update,
      update.expectedRevision,
    );
  }

  async delete(
    key: string,
    expectedRevision: ExpectedRevision,
  ): Promise<Revision> {
    return this.set({
      key,
      deleted: true,
      expectedRevision,
    });
  }

  watch(pattern: StatePattern, options?: WatchOptions): StateWatcher {
    validatePattern(pattern);
    return new StateWatcherImpl(this.base.id, pattern, this.transport, options);
  }

  async snapshot(pattern: StatePattern): Promise<StateSnapshot> {
    validatePattern(pattern);
    const cells = await this.transport.listState(this.base.id, pattern);
    const maxRevision = cells.reduce(
      (max, c) =>
        this.transport.compareRevision(c.revision, max) > 0 ? c.revision : max,
      "" as Revision,
    );
    return {
      channel: this.base.id,
      cells,
      maxRevision,
      takenAt: Date.now(),
    };
  }

  async restore(snapshot: StateSnapshot): Promise<void> {
    if (snapshot.channel !== this.base.id) {
      throw new EappError("EAPP_SNAPSHOT_INVALID", "Channel mismatch");
    }
    // SNAP-4 / SNAP-5 / SNAP-6: 重新分配 revision
    for (const cell of snapshot.cells) {
      const newRevision = await this.transport.nextRevision(this.base.id);
      await this.transport.writeStateWithRevision(
        this.base.id,
        cell.key,
        cell.value,
        cell.deleted,
        newRevision,
      );
    }
  }
}

// ---- validation ----
function validatePattern(pattern: StatePattern): void {
  const keys = Object.keys(pattern);
  if (keys.length !== 1) {
    throw new EappError("EAPP_STATE_PATTERN_INVALID");
  }
  const k = keys[0];
  if (k !== "key" && k !== "prefix" && k !== "all") {
    throw new EappError("EAPP_STATE_PATTERN_INVALID");
  }
}

function validateUpdate(update: StateUpdate): void {
  if (!update.key) {
    throw new EappError("EAPP_STATE_KEY_INVALID");
  }
  const hasValue = update.value !== undefined;
  const hasDeleted = update.deleted === true;
  if (!hasValue && !hasDeleted) {
    throw new EappError("EAPP_STATE_VALUE_INVALID");
  }
  if (hasValue && hasDeleted) {
    throw new EappError("EAPP_STATE_VALUE_INVALID", "MUST NOT specify both");
  }
  if (update.expectedRevision === undefined) {
    throw new EappError("EAPP_REVISION_INVALID", "expectedRevision required");
  }
}
```

### 14.2 StateWatcher（实现 v3.1 Subscription）

```typescript
// packages/state/src/state-watcher.ts

export class StateWatcherImpl implements StateWatcher {
  readonly id = crypto.randomUUID();
  readonly kind = "state" as const;
  readonly channel: string;
  readonly mode: SubscriptionMode; // v3.1 语义
  readonly pattern: StatePattern;

  private _cursor?: Cursor;
  private _state: SubscriptionState = "ACTIVE";
  private pending = new Map<
    string,
    {
      cursor: Cursor;
      state: "PENDING" | "ACKED";
    }
  >();

  constructor(
    channel: string,
    pattern: StatePattern,
    private transport: StateTransport,
    options?: WatchOptions,
  ) {
    this.channel = channel;
    this.pattern = pattern;
    this.mode = options?.mode ?? "exclusive"; // v3.1 SubscriptionMode
    this._cursor = options?.cursor;
    // P1-6: 未指定 cursor → 从当前时刻开始
    // 由 Transport 在首次迭代时提供 "now" 位置
  }

  get cursor(): Cursor | undefined {
    return this._cursor;
  }
  get state(): SubscriptionState {
    return this._state;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<StateUpdateEvent> {
    while (this._state === "ACTIVE") {
      const updates = await this.transport.readStateAfter(
        this.channel,
        this._cursor,
        this.pattern,
      );

      for (const cell of updates) {
        // P0-2 / REV-7: State Mode 例外，Revision 作为 Cursor
        const cursor = cell.revision as unknown as Cursor;

        const event: StateUpdateEvent = {
          type: cell.deleted ? "deleted" : "set",
          key: cell.key,
          revision: cell.revision,
          value: cell.value,
          // v3.1 AckContext 语义
          ack: async () => {
            this.pending.set(cell.key, { cursor, state: "PENDING" });
            this.advanceCursor();
          },
        };
        yield event;
      }
    }
  }

  private advanceCursor(): void {
    // 按 cursor 顺序推进，只推进到第一个 PENDING 之前
    // (完整实现略，参考 v3.1 Subscription)
  }

  async suspend(): Promise<void> {
    this._state = "SUSPENDED";
  }
  async resume(): Promise<void> {
    this._state = "ACTIVE";
  }

  async close(): Promise<void> {
    if (this._state === "CLOSED") return;
    this._state = "CLOSED";
    this.pending.clear();
  }
}

interface StateUpdateEvent {
  type: "set" | "deleted";
  key: string;
  revision: Revision;
  value?: unknown;
  ack(): Promise<void>; // v3.1 AckContext 语义
}
```

### 14.3 StateTransport（extends Transport）

```typescript
// packages/state/src/transport.ts

export interface StateTransport extends Transport {
  // State-specific methods
  getState(channel: string, key: string): Promise<StateCell | null>;
  listState(channel: string, pattern: StatePattern): Promise<StateCell[]>;

  /**
   * TS-6: CAS MUST be atomic
   */
  setStateWithCAS(
    channel: string,
    update: StateUpdate,
    expectedRevision: ExpectedRevision,
  ): Promise<Revision>;

  readStateAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: StatePattern,
  ): Promise<StateCell[]>;

  /**
   * TS-8: Revision comparison MUST be provided by Transport
   */
  nextRevision(channel: string): Promise<Revision>;
  compareRevision(a: Revision, b: Revision): number;

  writeStateWithRevision(
    channel: string,
    key: string,
    value: unknown,
    deleted: boolean,
    revision: Revision,
  ): Promise<void>;

  restoreState(channel: string, snapshot: StateSnapshot): Promise<void>;
}
```

### 14.4 Memory State Transport

```typescript
// packages/transport/memory/src/state.ts

export class MemoryStateTransport
  extends MemoryTransport
  implements StateTransport
{
  private cells = new Map<string, StateCell>();
  private revisionCounter = 0n;

  async setStateWithCAS(
    channel: string,
    update: StateUpdate,
    expectedRevision: ExpectedRevision,
  ): Promise<Revision> {
    const key = `${channel}:${update.key}`;

    // ---- 同步临界区开始 ----
    const current = this.cells.get(key);

    if (expectedRevision === null) {
      // key MUST NOT exist
      if (current && !current.deleted) {
        throw new EappError("EAPP_REVISION_CONFLICT");
      }
    } else {
      // key MUST exist 且 revision 匹配
      if (!current) {
        throw new EappError("EAPP_REVISION_CONFLICT");
      }
      if (this.compareRevision(current.revision, expectedRevision) !== 0) {
        throw new EappError("EAPP_REVISION_CONFLICT");
      }
    }

    this.revisionCounter += 1n;
    const newRevision = `r-${this.revisionCounter}`;

    const cell: StateCell = {
      key: update.key,
      revision: newRevision,
      value: update.deleted ? undefined : update.value,
      deleted: update.deleted ?? false,
      updatedAt: Date.now(),
      updatedBy: current?.updatedBy ?? { domain: "x", id: "x", instance: "x" },
    };

    this.cells.set(key, cell);
    // ---- 同步临界区结束 ----

    return newRevision;
  }

  async nextRevision(_channel: string): Promise<Revision> {
    this.revisionCounter += 1n;
    return `r-${this.revisionCounter}`;
  }

  /**
   * TS-8: Revision comparison
   */
  compareRevision(a: Revision, b: Revision): number {
    const na = BigInt(a.replace("r-", ""));
    const nb = BigInt(b.replace("r-", ""));
    return na < nb ? -1 : na > nb ? 1 : 0;
  }

  // ... 其他方法
}
```

---

## 15. 一致性测试骨架

```typescript
// tests/conformance/state.test.ts

describe("EaPP v3.2.0 State Mode Conformance", () => {
  // ============================================================
  // SC: StateCell
  // ============================================================
  describe("SC: StateCell", () => {
    test("SC-2: revision is monotonic", async () => {
      const ch = await makeStateChannel();
      const r1 = await ch.set({ key: "k", value: 1, expectedRevision: null });
      const r2 = await ch.set({ key: "k", value: 2, expectedRevision: r1 });
      expect(compareRevision(r2, r1)).toBeGreaterThan(0);
    });

    test("SC-3: deleted preserves revision", async () => {
      const ch = await makeStateChannel();
      const r1 = await ch.set({ key: "k", value: 1, expectedRevision: null });
      const r2 = await ch.delete("k", r1);
      const cell = await ch.get("k");
      expect(cell?.revision).toBe(r2);
      expect(cell?.deleted).toBe(true);
    });
  });

  // ============================================================
  // REV: Revision vs Cursor
  // ============================================================
  describe("REV: Revision vs Cursor", () => {
    test("REV-5: revision is opaque", async () => {
      const ch = await makeStateChannel();
      const r = await ch.set({ key: "k", value: 1, expectedRevision: null });
      expect(typeof r).toBe("string");
    });

    test("REV-6: revision not used as cursor in v3.1 modes", () => {
      // 由 v3.1 保证，v3.2 不做额外测试
    });

    test("REV-7: revision MAY be used as cursor in State Mode", async () => {
      const ch = await makeStateChannel();
      const r = await ch.set({ key: "k", value: 1, expectedRevision: null });
      const w = ch.watch({ key: "k" });
      // State Mode 例外，允许
      expect(w).toBeDefined();
    });

    test("REV-8: revision not compared across Transports", () => {
      // Transport-local 语义，跨 Transport 比较 MUST 失败
      const t1 = new MemoryStateTransport();
      const t2 = new MemoryStateTransport();
      // 不同 Transport 的 Revision MUST NOT 直接比较
    });
  });

  // ============================================================
  // SW: StateWatcher
  // ============================================================
  describe("SW: StateWatcher", () => {
    test("SW-1: implements v3.1 Subscription", async () => {
      const ch = await makeStateChannel();
      const w = ch.watch({ key: "k" });
      expect(w.kind).toBe("state");
      expect(w.mode).toBeDefined(); // SubscriptionMode
      expect(w.cursor).toBeDefined();
      expect(typeof w.suspend).toBe("function");
      expect(typeof w.resume).toBe("function");
      expect(typeof w.close).toBe("function");
    });

    test("SW-2: kind = state", async () => {
      const ch = await makeStateChannel();
      const w = ch.watch({ key: "k" });
      expect(w.kind).toBe("state");
    });

    test("SW-3: does NOT override Subscription.mode", async () => {
      const ch = await makeStateChannel();
      const w = ch.watch({ key: "k" }, { mode: "exclusive" });
      expect(w.mode).toBe("exclusive"); // 不是 'state'
    });

    test("SW-6: ack() does not take parameters", async () => {
      const ch = await makeStateChannel();
      const w = ch.watch({ key: "k" });
      await ch.set({ key: "k", value: 1, expectedRevision: null });

      for await (const update of w) {
        expect(update.ack.length).toBe(0); // 无参数
        await update.ack();
        break;
      }
    });

    test("SW-7: ack does not modify StateCell", async () => {
      const ch = await makeStateChannel();
      const w = ch.watch({ key: "k" });
      await ch.set({ key: "k", value: 1, expectedRevision: null });

      for await (const update of w) {
        const before = await ch.get("k");
        await update.ack();
        const after = await ch.get("k");
        expect(after?.revision).toBe(before?.revision);
        break;
      }
    });

    test("SW-9: default initial position is from now", async () => {
      const ch = await makeStateChannel();
      await ch.set({ key: "k", value: 1, expectedRevision: null });
      const w = ch.watch({ key: "k" }); // 未指定 cursor
      // 不应收到历史 update
      const updates = await collect(w, 0, 50);
      expect(updates).toHaveLength(0);
    });
  });

  // ============================================================
  // SU: StateUpdate
  // ============================================================
  describe("SU: StateUpdate", () => {
    test("SU-3: value and deleted must not coexist", async () => {
      const ch = await makeStateChannel();
      await expect(
        ch.set({ key: "k", value: 1, deleted: true, expectedRevision: null }),
      ).rejects.toThrow("EAPP_STATE_VALUE_INVALID");
    });

    test("SU-4: CAS failure returns EAPP_REVISION_CONFLICT", async () => {
      const ch = await makeStateChannel();
      await ch.set({ key: "k", value: 1, expectedRevision: null });
      await expect(
        ch.set({ key: "k", value: 2, expectedRevision: "r-999" }),
      ).rejects.toThrow("EAPP_REVISION_CONFLICT");
    });

    test("SU-6: unconditional write not in Core", async () => {
      const ch = await makeStateChannel();
      await expect(ch.set({ key: "k", value: 1 } as any)).rejects.toThrow(
        "EAPP_REVISION_INVALID",
      );
    });

    test("SU-7: CAS is atomic", async () => {
      const ch = await makeStateChannel();
      const r1 = await ch.set({ key: "k", value: 1, expectedRevision: null });

      const results = await Promise.allSettled(
        Array.from({ length: 100 }, (_, i) =>
          ch.set({ key: "k", value: i, expectedRevision: r1 }),
        ),
      );

      const ok = results.filter((r) => r.status === "fulfilled");
      expect(ok).toHaveLength(1);
    });

    test("SU-8: expectedRevision can be null", async () => {
      const ch = await makeStateChannel();
      const r = await ch.set({ key: "k", value: 1, expectedRevision: null });
      expect(r).toBeDefined();
    });

    test("SU-8: null expectedRevision fails if key exists", async () => {
      const ch = await makeStateChannel();
      await ch.set({ key: "k", value: 1, expectedRevision: null });
      await expect(
        ch.set({ key: "k", value: 2, expectedRevision: null }),
      ).rejects.toThrow("EAPP_REVISION_CONFLICT");
    });
  });

  // ============================================================
  // DEL: Delete
  // ============================================================
  describe("DEL: Delete", () => {
    test("DEL-2: delete produces deleted event", async () => {
      const ch = await makeStateChannel();
      const w = ch.watch({ key: "k" });
      const r = await ch.set({ key: "k", value: 1, expectedRevision: null });
      await ch.delete("k", r);

      const updates = await collect(w, 2);
      expect(updates[1].type).toBe("deleted");
    });

    test("DEL-4: delete non-existent key returns EAPP_STATE_KEY_NOT_FOUND", async () => {
      const ch = await makeStateChannel();
      await expect(ch.delete("nope", null)).rejects.toThrow(
        "EAPP_STATE_KEY_NOT_FOUND",
      );
    });

    test("DEL-5: delete already-deleted key is no-op", async () => {
      const ch = await makeStateChannel();
      const r1 = await ch.set({ key: "k", value: 1, expectedRevision: null });
      const r2 = await ch.delete("k", r1);
      await ch.delete("k", r2); // 不抛
    });

    test("DEL-6: set after delete increments revision", async () => {
      const ch = await makeStateChannel();
      const r1 = await ch.set({ key: "k", value: 1, expectedRevision: null });
      const r2 = await ch.delete("k", r1);
      const r3 = await ch.set({ key: "k", value: 3, expectedRevision: r2 });
      expect(compareRevision(r3, r2)).toBeGreaterThan(0);

      const cell = await ch.get("k");
      expect(cell?.deleted).toBe(false);
      expect(cell?.value).toBe(3);
    });
  });

  // ============================================================
  // SNAP: Snapshot / Restore
  // ============================================================
  describe("SNAP: Snapshot / Restore", () => {
    test("SNAP-1: snapshot is read-consistent", async () => {
      const ch = await makeStateChannel();
      await ch.set({ key: "k1", value: 1, expectedRevision: null });
      await ch.set({ key: "k2", value: 2, expectedRevision: null });

      const snap = await ch.snapshot({ prefix: "k" });
      for (const cell of snap.cells) {
        expect(
          compareRevision(cell.revision, snap.maxRevision),
        ).toBeLessThanOrEqual(0);
      }
    });

    test("SNAP-4: restore does not roll back revision", async () => {
      const ch = await makeStateChannel();
      await ch.set({ key: "k", value: 1, expectedRevision: null });
      const snap = await ch.snapshot({ key: "k" });

      await ch.set({
        key: "k",
        value: 2,
        expectedRevision: (await ch.get("k"))!.revision,
      });

      const beforeRestore = (await ch.get("k"))!.revision;
      await ch.restore(snap);
      const afterRestore = (await ch.get("k"))!.revision;

      expect(compareRevision(afterRestore, beforeRestore)).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // CF: ConflictPolicy
  // ============================================================
  describe("CF: ConflictPolicy", () => {
    test("CF-5: StateChannel extends Channel", async () => {
      const ch = await makeStateChannel();
      expect(ch.id).toBeDefined();
      expect(ch.binding).toBeDefined();
      expect(ch.mode).toBe("state");
      // MUST NOT be a wrapper
      expect(ch.state).toBeDefined();
      expect(ch.delivery).toBeDefined();
    });
  });

  // ============================================================
  // API: StatePattern
  // ============================================================
  describe("API: StatePattern", () => {
    test("API-9: pattern must be union type", async () => {
      const ch = await makeStateChannel();
      await expect(ch.list({ key: "k", prefix: "p" } as any)).rejects.toThrow(
        "EAPP_STATE_PATTERN_INVALID",
      );
    });

    test("API-9: all alone is valid", async () => {
      const ch = await makeStateChannel();
      const cells = await ch.list({ all: true });
      expect(Array.isArray(cells)).toBe(true);
    });
  });

  // ============================================================
  // TS: Transport
  // ============================================================
  describe("TS: Transport", () => {
    test("TS-7: StateTransport extends Transport", () => {
      const t = new MemoryStateTransport();
      expect(t.capabilities).toBeDefined();
      expect(typeof t.write).toBe("function"); // v3.1 Transport
      expect(typeof t.setStateWithCAS).toBe("function"); // v3.2
    });

    test("TS-8: revision comparison provided by transport", () => {
      const t = new MemoryStateTransport();
      expect(typeof t.compareRevision).toBe("function");
      expect(t.compareRevision("r-1", "r-2")).toBeLessThan(0);
    });
  });
});
```

---

## 16. 冻结路线图

```
v3.2.0-state
    │
    │  Design Draft
    ▼
    │  Semantic Review 1
    ▼
    │  r1
    ▼
    │  Independent Review
    ▼
    │  r2（本文）← 现在
    ▼
    │  Final Review
    ▼
    │  Semantic Freeze
    ▼
    │  Implementation
    ▼
    │  Conformance Tests
    ▼
    v3.2.0-state FROZEN
```

**进入 Semantic Freeze 的条件**：

- P0-1 到 P0-6 全部修正 ✅
- P1-1 到 P1-6 全部接受 ✅
- 不变量一致 ✅
- 与 v3.1 的接口一致性验证 ✅
- 通过 Final Review

---

## 17. 边界与非目标

### 17.1 明确不做

- 查询语言（不做 SQL / GraphQL）
- 事务（不做 ACID）
- 索引（不做 secondary index）
- Schema 验证（属于 Extension）
- 冲突自动合并（属于 Extension）
- 分发策略（属于 Extension）
- 权限（属于 Trust Domain）
- 无条件写入（属于 Extension）
- CRDT（属于 Extension）

### 17.2 与 v3.1 的关系

| 维度           | v3.1                     | v3.2                                              |
| -------------- | ------------------------ | ------------------------------------------------- |
| Channel 模式   | request / event / stream | + state                                           |
| 新增本体       | —                        | StateCell / Revision / StateWatcher / StateUpdate |
| 复用           | —                        | Channel / Subscription / Cursor / AckContext      |
| 冲突策略       | —                        | CAS（Core only）                                  |
| 修改 v3.1 接口 | —                        | 仅 ChannelMode 扩展                               |
| Transport 关系 | —                        | StateTransport extends Transport                  |

### 17.3 已知限制

| 限制                     | 影响                      | 缓解           |
| ------------------------ | ------------------------- | -------------- |
| 无查询语言               | 复杂查询需应用层          | Extension      |
| 无事务                   | 多 key 原子性不足         | Extension      |
| CAS 可能失败             | 需重试                    | 应用层重试     |
| 无索引                   | 大 state 慢               | Extension      |
| 无无条件写入             | 简单场景需要 CAS          | Extension      |
| Snapshot 非 linearizable | 强一致场景不足            | Extension      |
| Revision Transport-local | 跨 Transport 无法直接比较 | 通过应用层映射 |

---

## 18. 宣言

> **State Mode 是 Interaction Layer 的第四种模式。**
> **它不是数据库，不是 CRDT，不是消息队列。**
> **它是：最小、可观察、带版本的状态共享语义。**

### 18.1 四条核心原则

1. **版本是乐观并发的唯一机制** — CAS 是唯一策略
2. **观察是 Subscription 的具体化** — 复用 v3.1 Cursor / AckContext
3. **Revision 是 Transport-local** — 不跨 Transport 比较
4. **StateWatcher 是 Subscription 的子类型** — MUST NOT 覆盖 mode

### 18.2 与 v3.0 / v3.1 的关系

```
v3.0.0-core          = Who composes with whom
v3.1.0-interaction   = How composed parties interact
v3.2.0-state         = How composed parties share state
```

### 18.3 语义内核

> **StateCell defines what is shared.**
> **Revision defines its version.**
> **StateUpdate defines a change.**
> **StateWatcher defines observation.**
> **CAS defines conflict resolution.**

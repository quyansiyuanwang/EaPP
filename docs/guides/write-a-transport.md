# 实现一个 Transport

> **本页的读者**：要在某种消息系统之上承载 EaPP 的实现方。
> 规则本身在 [`docs/spec/eapp.md`](../spec/eapp.md) 里；本页只说明怎么照着做。

前置阅读：[概念：三层心智模型](./concepts.md) 的 §2 与 §7。
本页的规范依据是 [`eapp.md`](../spec/eapp.md) 的 §14.1、§26、§30、§37、§39、§45、§46。
本页属于非规范性文档，与规范冲突时以规范为准。

---

## 1. Transport 在哪一层

依赖方向是单向的（§1.1）：
`Composition Core → Interaction Layer → State Mode → Transport`。
§14.1 规定，组合确定之后由上层派生 `ChannelRef`，Channel 再由 Transport 实现。
`CHB-1` 规定 Composition Core MUST NOT 定义 Channel 的交互语义；
`TR-1` 规定 Transport MUST NOT 定义 Interaction 语义（§30.4）。
因此 Transport 的职责只有两件事（§30.1）：

```
① 追加一条消息，并为这次追加分配一个位置（cursor）
② 返回某个位置之后、匹配某个 pattern 的消息
```

它 MUST NOT 定义的事与它做的事同等重要（`TR-1`）。模式与信封属于 Interaction Layer
（§22、§23）；投递保证属于 §24、§25，由订阅与 Lease 实现；同一位置只交给一个消费者属于
Lease（§25）与 ConsumerGroup（§28）；"cursor 随收到消息前移"被 `CR-3` 禁止（§26.4）；
冲突策略与快照的构造顺序属于 State Mode（§43、§44.5）。

§30.4 还给出四条直接约束：

```
TR-1  Transport MUST NOT 定义 Interaction 语义。
TR-2  Transport MUST 声明自己的能力。
TR-3  Transport MUST NOT 伪装支持。
TR-4  Channel MUST NOT 使用超出 Transport 能力的特性。
```

`TR-4` 是**调用侧**的义务。Transport 能做的，是在自己的调用点拒绝它没有声明的能力，
而不是在运行时静默降级。

---

## 2. `Transport` 的最小操作集

**`TransportMessage`**（§30.1）

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `cursor` | `Cursor` | 是 | 该消息在 Channel 内的位置 |
| `payload` | 任意值 | 是 | 消息体 |

**`Transport`**（§30.1）

| 成员 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `id` | string | 是 | Transport 标识 |
| `capabilities` | `TransportCapabilities` | 是 | 能力声明 |
| `send(channel, msg)` | 操作，结果为 `Cursor` | 是 | 发送一条消息；Transport 负责分配 cursor |
| `readAfter(channel, cursor, pattern)` | 操作，结果为 `TransportMessage` 列表 | 是 | 返回 cursor 之后、匹配 pattern 的消息，按 cursor 升序 |
| `close()` | 操作 | 是 | 关闭 |

**`Pattern`**（§30.1）：`{ all: true }` 匹配全部消息；`{ type: string }` 匹配给定类型。
`readAfter` 的 `cursor` 参数 MAY 为"未提供"，含义见 `TR-6`。

```
TR-5  readAfter MUST 只返回 cursor 严格大于参数的消息。
TR-6  cursor === undefined MUST 解释为"从最早已保留位置开始"。
TR-7  readAfter 无匹配时 MUST 返回空数组，MUST NOT 阻塞。
TR-8  send 返回的 cursor MUST 在该 Channel 内严格大于此前所有 cursor。
```

四条各有对应的失败模式：返回参数位置本身，会让重读重复处理同一条消息；
把"未提供"读成"从当前位置开始"，会让首次读取静默跳过已有消息；无匹配时阻塞，
会让上层的读取循环停止推进；两次 `send` 返回同一位置，
会让 `readAfter` 的结果取决于内部遍历顺序。

§51 把 `send` 与 `subscribe` 列入"通信"操作组，
并要求表面上的操作 MUST 使用 §51 表格与各定义处给出的名称与参数。`readAfter` 不在表面上 —— 它由 `Subscription` 的实现使用，但它仍是 Transport MUST 提供的操作之一（§30.1）。
本页引用的其他操作名（锚点解析、变更等待）不在 §30.1 的操作集内，属实现自由，见 §8。

---

## 3. 如实声明 `TransportCapabilities`

**`TransportCapabilities`**（§30.2）

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `persistent` | boolean | 是 | 是否跨进程存活 |
| `ordering` | `none` \| `per-source` \| `global` | 是 | 顺序保证的范围 |
| `delivery` | 见下 | 是 | 投递能力 |
| `supportsCursor` | boolean | 是 | 是否支持位置 |
| `supportsLease` | boolean | 是 | 是否支持认领 |
| `durabilityBoundary` | `process` \| `machine` \| `cluster` \| `global` | 是 | 持久化边界的可见范围 |

`delivery` 的三个字段是 `atMostOnce`、`atLeastOnce`、`replay`，均为 boolean。
§30.3 的矩阵给出五种传输的**自洽组合**（Memory / Socket / Redis Streams /
NATS JetStream / NATS Core），它描述组合的形状，不要求任何传输落在某一行。

`TS-2`（§46.2）要求**每个能力标志恰好有一个强制的运行时后果**，
且该后果 MUST 在最早的调用点被强制。该条写在 State Mode 的 §46.2，
适用于 §46.1 的六个状态标志。§30.2 的字段另有对应规则：

| 标志 | `false` 时的规范后果 | 依据 |
|---|---|---|
| `supportsCursor` | 需要位置的操作 MUST 返回 `EAPP_CURSOR_UNSUPPORTED` | `CR-5`、`TR-9` |
| `supportsLease` | 需要认领的操作 MUST 返回 `EAPP_UNSUPPORTED` | `TR-9` |
| `delivery.atLeastOnce` | 该 Transport 上 MUST NOT 创建 `at-least-once` 的 Channel | `TR-4` |
| `delivery.atMostOnce` | 该 Transport 上 MUST NOT 创建 `at-most-once` 的 Channel | `TR-4` |
| `delivery.replay` | 该 Transport 上 MUST NOT 依赖重放能力 | `TR-4` |
| `ordering` | `none` 表示不保证顺序；`per-source` 只保证同源顺序 | §30.2 的取值定义 |
| `durabilityBoundary` | 各层声明的一致性 MUST NOT 超出实际可见范围 | `TS-5` |

`TR-9` 给出错误码的落点：不支持时 MUST 返回 `EAPP_UNSUPPORTED`，
不支持 cursor 时 MUST 返回 `EAPP_CURSOR_UNSUPPORTED`。
因此"不具备某项能力"有两种落点：一般不支持的路径报前一个码，
位置相关的路径报后一个码（`CR-5`）。
**"不支持"必须是显式失败，而不是静默降级。** `TR-3` 禁止伪装支持：
一个声明 `supportsCursor: true` 却记不住位置的实现，会让上层的恢复语义静默失效。

---

## 4. Cursor 契约

### 4.1 契约本身

**`Cursor`** —— 一个不透明字符串，在 Channel 内全局有序。它的字面形式由实现定义，
消费者 MUST NOT 解析它（§26.1）。

```
CR-1  Cursor MUST be globally ordered within Channel.
CR-2  Cursor MUST be persistable and recoverable.
CR-3  Cursor MUST NOT skip unacked messages implicitly.
CR-4  Resume MUST continue from cursor.
CR-5  If Transport does not support cursor, MUST return EAPP_CURSOR_UNSUPPORTED.
```

对实现方的要求：同一 Channel 内构成全序（`CR-1`），每次 `send` 分配的值严格大于此前所有值
（`TR-8`）；位置可持久化、可恢复（`CR-2`），它编码的是**日志位置**而不是"内存里的下标"；
`CR-4` 要求恢复从 cursor 继续，因此匹配范围由 `TR-5` 钉死。

`CR-3` 禁止的是**隐式**跳过：cursor 只随显式 ack 前移（§26.4）。ack 语义属于上层，
Transport 的义务是如实返回严格大于参数的消息，
MUST NOT 因为"投递过了"就自行推进任何位置。

### 4.2 锚点

**`CursorAnchor`**（§26.2）有三个取值：`earliest`、`latest`、一个 `Cursor` 值。
解析规则是 MUST，且顺序重要：

```
1. 先比较字面量：'earliest' / 'latest'  MUST 被识别为锚点，MUST NOT 当作 Cursor 值。
2. 其余字符串 MUST 被当作 Cursor 处理。
3. 'earliest'  MUST 解析为"Channel 中仍可服务的最早位置"。
4. 'latest'    MUST 解析为 Channel 当前头位置。
5. 锚点 MUST 在订阅创建时立即解析（eager），MUST NOT 延迟到首次迭代。
6. 若日志已压缩到无法定位 'earliest'，MUST 返回 EAPP_CURSOR_TOO_OLD。
7. 一个具体 Cursor 若已被删除（早于保留起点），MUST 返回 EAPP_CURSOR_TOO_OLD，
   MUST NOT 被静默替换为保留起点。
```

规则 5 是形状要求：订阅返回时 `cursor` 必须是一个具体位置（`SUB-9`），
因此锚点的求值 MUST 在订阅创建返回之前完成。

规则 6 与 7 是同一件事的两半，而后者后果更重。压缩不是错误，假装没有压缩过才是：
调用方传入一个已被删除的位置时，它以为自己从中断处继续，实际读到的却是被截断的历史，
中间的变更永久丢失而它不会知道。因此这种情况 MUST 失败。

由此得到保留语义的精确形状（§26.2）：

```
保留起点（floor） = 已被丢弃的最新位置
   位置 > floor  → 可读
   位置 = floor  → 可读（读的是 floor 之后的内容；floor 本身已丢弃）
   位置 < floor  → EAPP_CURSOR_TOO_OLD
   'earliest' / cursor === undefined → 解析为 floor
```

`TR-6` 的"最早已保留位置"就是这张表里的 floor。
`TransportCapabilities` 本身没有保留策略字段；§46.1 的 `stateRetention` 约束 State Mode
的日志保留，而 §26.2 要求能力声明与实际行为一致：声明 `unbounded` 就 MUST NOT 丢任何位置。

### 4.3 推进规则

推进只由 `ack` 决定（§26.4）：`ack(c)` MUST 将 cursor 置为 `max(当前 cursor, c)`；
`nack()` MUST NOT 推进 cursor，该项回到可用并在下一次迭代重新投递。
`CR-3` 禁止的只是隐式跳过，因此显式 ack 一个更靠后的位置、因而放弃中间未 ack 的项
MUST 被允许 —— "已确认到此处"就是这个意思。§26.4 还明确：
任何"只推进到第一个未 ack 项之前"的实现 MUST 被视为违反本节。

---

## 5. `StateTransport` 多出的操作

§45 给出 `StateTransport`：它在 `Transport`（§30.1）之上增加状态操作（`TS-7`），
并新增 `StateChange` 这一条日志记录。

| `StateChange` 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `channel` | string | 是 | 所属 Channel |
| `revision` | `Revision` | 是 | 日志位置 |
| `key` | string | 是 | 键 |
| `type` | `set` \| `deleted` | 是 | 变更种类 |
| `value` | 任意值 | 否 | 当且仅当 `type` 为 `set` |

| 操作 | 结果 | 语义 |
|---|---|---|
| `getState(channel, key)` | `StateCell` 或"不存在" | 读取一个 cell |
| `listState(channel, pattern)` | `StateCell` 列表 | 按 pattern 读取 |
| `head(channel)` | `Revision` | Channel 当前头位置 |
| `setStateWithCAS(channel, update, actor)` | `Revision` | 带 CAS 的写入 |
| `deleteStateWithCAS(channel, key, expectedRevision, actor)` | `Revision` | 带 CAS 的删除 |
| `readChangesAfter(channel, cursor, pattern)` | `StateChange` 列表 | 返回变更流 |
| `nextRevision(channel)` | `Revision` | 预留一个位置 |
| `compareRevision(a, b)` | 负数 / 0 / 正数 | 比较由 Transport 提供（`TS-8`） |
| `writeStateWithRevision(channel, key, value, deleted, revision, actor)` | 无 | 钉位写入 |
| `waitForChange(channel, cursor, signal)` | 无 | 可选 |

```
TS-9   readChangesAfter MUST 按 revision 严格升序返回。
TS-10  readChangesAfter MUST 只返回 revision 严格大于 cursor 的变更（不含 cursor 本身）。
TS-11  cursor === undefined MUST 解释为"从最早已保留位置开始"。
TS-12  readChangesAfter 无匹配时 MUST 返回空数组，MUST NOT 阻塞。
TS-13  寻址 MUST 按 (channel, key) 二元组；MUST NOT 把二者拼接为单一字符串。
TS-14  head 在 Channel 尚无任何变更时 MUST 返回一个可比较的初始 revision。
TS-15  nextRevision MUST 返回一个严格大于当前 head 的位置。
```

三处容易做错的形状：**`readChangesAfter` 返回变更流，不是 `StateCell` 列表** ——
后像无法表达同一 key 的两次变更，中间那次永久丢失，cursor 语义因此不可实现（§45）；
**寻址是 `(channel, key)` 二元组**（`TS-13`），把二者拼接为单一字符串会让
`(channel="a", key="b:c")` 与 `(channel="a:b", key="c")` 命中同一个 cell；
**`head` 在空 Channel 上 MUST 返回可比较的初始 revision**（`TS-14`），
它 MUST NOT 抛错，也 MUST NOT 是 `compareRevision` 无法接受的值。

`TS-6` 要求 CAS 的比较与写入在 Transport 内原子完成；`TS-8` 要求 Revision 的比较
由 Transport 提供；§37.2 补充：Consumer MUST NOT 直接比较 Revision 字符串，
`compareRevision` 的入参不是本 Transport 实例签发的值时 MUST 返回
`EAPP_REVISION_INVALID`（`REV-8`）。

`nextRevision` 与 `writeStateWithRevision` 是给 `restore` 用的钉位写入路径（§37.3、§39.5）：
前者预留一个位置，后者必须使用它，并在收到 `<= head` 的 revision 时
MUST 抛 `EAPP_REVISION_INVALID`。
§43.4 规定 `StateTransport` MUST NOT 提供 `restoreState`：`restore` 在 StateChannel 层唯一实现。

---

## 6. `StateTransportCapabilities`

§46.1 在 `TransportCapabilities` 之上增加六个字段：
| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `supportsState` | boolean | 是 | 是否支持状态操作 |
| `supportsStateRevision` | boolean | 是 | 是否支持可全序比较的位置 |
| `supportsStateWatch` | boolean | 是 | 是否支持观察 |
| `supportsStateSnapshot` | boolean | 是 | 是否支持快照与恢复 |
| `stateConsistency` | `strong` \| `eventual` | 是 | 一致性强度 |
| `stateRetention` | `{ kind: 'unbounded' }` 或 `{ kind: 'window', entries: number }` | 是 | 日志保留策略 |

§46.2 的能力闸门 —— 每个标志 MUST 有唯一的运行时后果：

| 标志 | `false` 时的强制行为 |
|---|---|
| `supportsState` | `get`/`list`/`set`/`delete`/`snapshot`/`restore`/`watch` 全部抛 `EAPP_STATE_UNSUPPORTED` |
| `supportsStateRevision` | `set`/`delete`/`restore` 抛 `EAPP_STATE_UNSUPPORTED`（CAS 不可能成立）；`get`/`list` 仍可用 |
| `supportsStateWatch` | `watch()` 以 `EAPP_WATCH_UNSUPPORTED` 失败 —— 在能立即报告的时刻报告 |
| `supportsStateSnapshot` | `snapshot()` / `restore()` 抛 `EAPP_UNSUPPORTED` |

```
TS-1  Transport MUST declare state capabilities.
TS-2  Each capability flag MUST have exactly one mandated runtime consequence,
      enforced at the earliest possible call.
TS-3  MUST NOT fake support.
TS-5  A Transport MUST NOT declare stateConsistency = 'strong' beyond its durabilityBoundary.
```

`TS-2` 的"在能立即报告的时刻报告"落到实现上：能力检查 MUST 发生在最早可报告的调用点，
API 本身是同步的地方 MUST 同步报告，而不是等到第一次数据操作才失败。
`TS-5` 是一条不等式：`stateConsistency = 'strong'` 的可见范围 MUST NOT 超出
`durabilityBoundary`。若一个 Transport 只在单进程内可见，而一致性声明为跨集群强一致，
上层据此做的 CAS 会让两个进程各自通过检查，同一个更新被执行两次。

### 6.1 `supportsStateRevision = false` 意味着什么

§46.3 收紧了一致性能力：

```
supportsStateRevision === true   ⟺  Revision 在 Channel 内构成全序且单调（REV-1/2/3/4/8 成立）
supportsStateRevision === false  ⟹  MUST NOT 用于 CAS
```

```
TS-4  A Transport whose revision ordering is not total per channel MUST declare
      supportsStateRevision = false, MUST declare stateConsistency = 'eventual',
      and MUST NOT claim CAS support.
```

因此声明 `supportsStateRevision = false` 意味着三件事同时成立：
`set` / `delete` / `restore` MUST 抛 `EAPP_STATE_UNSUPPORTED`（§46.2），
这是 CAS 不可能成立时的强制行为，不是可选的降级；
`stateConsistency` MUST 声明为 `'eventual'`（`TS-4`）；
而读取仍然可用，`get` / `list` 在 `supportsStateRevision = false` 时仍然工作（§46.2）。

§46.3 明确了取消豁免的理由：允许"eventual 的 revision + CAS"共存，
等于允许一个会静默丢更新的 CAS。CAS 的正确性建立在全序之上。
§46.4 的矩阵中，CRDT 形态因此声明 `supportsStateRevision: false`、
`stateConsistency: 'eventual'` 与 `supportsStateSnapshot: false`。
最后一项不是可选项：`restore` 的实现路径经过 `nextRevision` 与 `writeStateWithRevision`，
两者在非全序的实现上无法给出正确语义（§43.4）。

---

## 7. 完整示例：一个最小 Transport

下面的伪代码用中立记法写，说明每个操作**做什么**；它不是规范正文，
也不指定实现语言、进程模型或存储形态。

**状态。** 每个 Channel 一本日志：`日志[channel]` 是条目列表，条目为 `{ cursor, payload }`；
`序号` 是唯一的分配点；`保留起点[channel]` 是已被丢弃的最新位置。

**位置编码。** `Cursor` 的字面形式由实现定义，而 §26.1 只要求它在 Channel 内全局有序、
消费者不解析它。下面的实现把它编码成**等宽零填充序号**加一个实例前缀：

```
分配():
    序号 = 序号 + 1
    返回 实例id + "!" + 零填充(序号, 16)
```

等宽让字典序等于数值序，因此位置比较可以退化为一次字符串比较；
前缀让比较操作能识别一个值是不是本实例签发的，从而对**外来值**明确失败（`REV-8`）。
反例的后果是静默的：不填充时 `'10'` 会排在 `'2'` 之前，任何一次"取 max"都会得到错误结论。
`id` 与 `capabilities` 返回构造时确定的值，后者 MUST 与实际行为一致（`TR-2`、`TR-3`）。

```
send(channel, msg):
    位置 = 分配()
    追加({ cursor: 位置, payload: msg }) 到 日志[channel]
    返回 位置                                  # TR-8：严格大于此前所有位置

readAfter(channel, cursor, pattern):
    起点 = (cursor 未提供) ? 保留起点[channel] : cursor     # TR-6
    如果 cursor 是本实例签发的值但早于保留起点：
        抛 EAPP_CURSOR_TOO_OLD                            # §26.2 规则 7
    返回 [ 条目 in 日志[channel]
           where 条目.cursor 严格大于 起点                 # TR-5
           and 匹配(条目.payload, pattern) ]               # 升序；TR-7：无匹配即空数组
```

`TR-5` 的比较是**严格大于**：把起点本身返回，会让恢复语义在每次重读时重复处理同一位置。
`TR-7` 要求无匹配时立即返回空数组，MUST NOT 阻塞；等待由上层处理，
§41.5 给了它一条可选路径，阻塞到出现变更或信号中止。
**`close()`** 关闭这个 Transport；§30.1 只把它列为必需操作，没有规定关闭之后各操作的行为，
实现 MUST 选择一种可观察的行为并遵守能力声明（§8 第 1 条）。

**可选：锚点解析。** `CursorAnchor` 的两个字面量 MUST 被识别（§26.2 规则 1）。
若实现选择把它们集中在一个操作里解析：

```
解析锚点(channel, anchor):
    如果 anchor == 'earliest': 返回 保留起点[channel]            # 规则 3
    如果 anchor == 'latest':   返回 该 Channel 上最新分配的位置  # 规则 4
    返回 anchor                                                # 规则 2
```

`'latest'` 必须回答"这条 Channel 上最新的东西在哪"，它同时覆盖消息与状态写入。
只跟踪状态 revision 的实现会在一条只有消息的 Channel 上给出错误答案。

**`StateTransport` 的追加操作。** 完整操作集与 `TS-9`…`TS-15` 见 §5，本页不重复。
三条最容易写错的判定：

- **`set` 的 `expectedRevision`。** `null` 只表示"从未存在"（§39.2）：
  已逻辑删除的 key 仍然算存在，因此 MUST 返回 `EAPP_REVISION_CONFLICT`；
  一个具体 Revision 则要求 key 存在且精确匹配。比较与写入之间 MUST NOT 有等待（`TS-6`）。
- **`delete` 的边界表（§40.2）。** 从未存在 + `null` 返回 `EAPP_STATE_KEY_NOT_FOUND`（`DEL-4`），
  其余不匹配返回 `EAPP_REVISION_CONFLICT`（`CF-2`）；删除已删除的 key 是 no-op，
  MUST NOT 分配新位置（`DEL-5`）；返回值恒为操作后该 key 的当前 revision（§40.4）。
- **钉位写入。** `nextRevision` 预留一个位置（`TS-15`），`writeStateWithRevision` 必须使用它，
  并在收到 `<= head` 的 revision 时 MUST 抛 `EAPP_REVISION_INVALID`（§37.3）。
  `compareRevision` 的入参不是本实例签发的值时同样 MUST 抛 `EAPP_REVISION_INVALID`（`REV-8`）。
  `restore` 不在 `StateTransport` 上（§43.4）：这两个操作是它的构件，
  公开入口只有 StateChannel 层的 `restore`。
- **`head` 在空 Channel 上。** 返回一个排序在所有已分配位置之前的哨兵，
  并且 `compareRevision` MUST 接受它（`TS-14`）。
- **`readChangesAfter`。** 起点仍按"未提供即最早已保留位置"解析（`TS-11`），
  只返回 revision 严格大于起点的变更（`TS-9`、`TS-10`），无匹配时不阻塞（`TS-12`）。

---

## 8. 三处规范留白

下面三处，规范正文没有给出实现方需要的全部答案。三条都记在这里，作为实现方的选择点。

1. **`close()` 之后的行为。** §30.1 把 `close()` 列为必需操作，
   没有规定关闭之后 `send` / `readAfter` 的行为。实现 MUST 选择一种可观察的行为，
   并让它与能力声明一致。"关闭后静默成功"会让"已关闭"与"仍开着"从调用方看完全一样。
2. **锚点解析的操作名与 `waitForChange` 的位置。** §30.1 的操作集不含锚点解析。
   §26.2 只规定两个字面量 MUST 被识别，§41.5 只说 `waitForChange` 是可选的。
   两者的名称与形态由实现决定。
3. **Pattern 的校验强度。** §30.1 给出 `Pattern` 的两个取值，
   未规定非法形状（既非 `all` 又非 `type`）的错误码。实现 MUST 选择一种行为并公开它；
   静默当作"匹配全部"会让一次调用错误变成一次全量读取。

---

## 9. 检查清单

每一条都是规范要求的 MUST，附规范小节或 ID。逐条自查即可，不需要其它仓库的实现或测试套件。

| # | MUST | 依据 |
|---|---|---|
| 1 | `send` 返回的位置在该 Channel 内严格大于此前所有位置 | `TR-8` |
| 2 | `readAfter` 只返回严格大于参数的消息，结果按 cursor 升序，无匹配时返回空数组且不阻塞 | `TR-5`、`TR-7`、§30.1 |
| 3 | `cursor` 未提供时从最早已保留位置开始 | `TR-6` |
| 4 | `Pattern` 的两种取值都被支持；消费者不需要解析位置的内部结构 | §30.1、§26.1 |
| 5 | `capabilities` 声明 §30.2 的全部六个字段；声明与行为一致，缺失能力时显式失败，未声明的能力不会被使用 | `TR-2`、`TR-3`、`TR-4` |
| 6 | `supportsCursor = false` 时返回 `EAPP_CURSOR_UNSUPPORTED`；其他不支持的情形返回 `EAPP_UNSUPPORTED` | `CR-5`、`TR-9` |
| 7 | `stateConsistency = 'strong'` 未超出 `durabilityBoundary` | `TS-5` |
| 8 | 同一 Channel 内的位置构成全序，可持久化，重启后仍有效；实现不随"收到消息"自行推进任何位置；恢复从 cursor 继续 | `CR-1`…`CR-4` |
| 9 | `'earliest'` / `'latest'` 在当作 Cursor 之前被识别，并解析为最早可服务位置与当前头位置 | §26.2 规则 1、3、4 |
| 10 | 锚点在订阅创建时立即解析；无法定位请求位置时返回 `EAPP_CURSOR_TOO_OLD`，不静默替换为保留起点 | §26.2 规则 5、6、7 |
| 11 | 保留语义与 `stateRetention` 的声明一致；`ack` 把位置置为 `max(当前, c)`，`nack` 不推进位置 | §26.2、§26.4 |
| 12 | `getState` / `listState` 在 `supportsStateRevision = false` 时仍然可用 | §46.2 |
| 13 | `set` / `delete` 在 `supportsStateRevision = false` 时抛 `EAPP_STATE_UNSUPPORTED` | §46.2 |
| 14 | `snapshot` / `restore` 在 `supportsStateSnapshot = false` 时抛 `EAPP_UNSUPPORTED` | §46.2 |
| 15 | `watch` 在 `supportsStateWatch = false` 时以 `EAPP_WATCH_UNSUPPORTED` 失败 | §46.2 |
| 16 | 非全序的 revision 声明 `supportsStateRevision = false` 与 `'eventual'`，且不声称支持 CAS | `TS-4` |
| 17 | 每个能力标志恰好对应一个强制的运行时后果 | `TS-2` |
| 18 | `set` / `delete` 的 CAS 比较与写入之间没有等待 | `TS-6` |
| 19 | `readChangesAfter` 按 revision 严格升序，不含 cursor 本身，无匹配时不阻塞，未提供 cursor 时从最早已保留位置开始 | `TS-9`…`TS-12` |
| 20 | cell 的寻址按 `(channel, key)` 二元组 | `TS-13` |
| 21 | `head` 在空 Channel 上返回可比较的初始 revision；`nextRevision` 严格大于当前 head | `TS-14`、`TS-15` |
| 22 | `compareRevision` 由 Transport 提供，且拒绝外来值 | `TS-8`、`REV-8` |
| 23 | `writeStateWithRevision` 收到 `<= head` 的 revision 时抛 `EAPP_REVISION_INVALID` | §37.3 |
| 24 | `StateTransport` 上不提供 `restoreState`，且它扩展 `Transport` 而不修改其既有成员 | §43.4、`TS-7`、`IX-4` |
| 25 | Transport 不定义模式、投递保证、租约或游标策略；`send` / `readAfter` 使用 §30.1 给出的名称与参数 | `TR-1` |

---

## 相关

- [概念：三层心智模型](./concepts.md) —— 层与层的方向，以及什么不属于 Core
- [用另一种语言实现 EaPP](./implement-in-another-language.md) —— 换语言时要重新裁决的部分
- [`docs/spec/eapp.md`](../spec/eapp.md) —— 唯一规范性正文：§14、§26、§30、§37、§39、§45、§46
- [`Transport`](../reference/transport.md) · [`Cursor`](../reference/cursor.md) ·
  [`Revision`](../reference/revision.md) · [`StateCell`](../reference/state-cell.md)

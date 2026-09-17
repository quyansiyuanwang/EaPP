# 写一个插件

> 本页说明如何按 §50–§54 的**插件开发表面**写一个插件：插件声明什么、如何被组合、
> 面对哪些操作、错误如何浮现。

前置阅读：[概念：三层心智模型](./concepts.md)。
[`docs/spec/eapp.md`](../spec/eapp.md) 是唯一裁决者；本页解释它，不新增规则。
示例使用 §1.2 的语言中立记法，或明确标注为说明性伪代码。

---

## 1. 插件是什么（§8）

Plugin 是"一个具有 Identity、可选地暴露 Capability、并参与 Lifecycle 的可组合实体"（§8.2）。

- 形态不受约束：in-process module、process、worker、remote service、device、runtime、transport、database、AI model、UI component 都可以（§8.2）。协议不要求这些形态的实现方式相同。
- 每个 Plugin MUST 有唯一 Identity（`P-1`），Identity MUST NOT 在生命周期内改变（`P-3`）。
- `capabilities` MAY 为空（`P-2`），MAY 通过显式声明更新（`P-4`）。

Lifecycle 有三个状态：`INACTIVE`、`ACTIVE`、`SUSPENDED`（§10.1）。实现 MAY 扩展 `STARTING` / `STOPPING` / `DRAINING` / `FAILED`，但 MUST NOT 破坏 Core 语义（§10.1）。

四个操作构成状态机（§10.3）：

| 操作 | 合法源状态 | 结果 |
|---|---|---|
| `activate` | `INACTIVE` only | `ACTIVE` |
| `deactivate` | `ACTIVE` / `SUSPENDED` / `INACTIVE` | `INACTIVE` |
| `suspend` | `ACTIVE` only | `SUSPENDED` |
| `resume` | `SUSPENDED` only | `ACTIVE` |

`activate` MUST NOT 用于从 `SUSPENDED` 恢复，从 `SUSPENDED` 恢复 MUST 使用 `resume`（§10.3、`LC-6`）。`activate` MUST 幂等（`O-5`），`deactivate` MUST 从任意状态进入 `INACTIVE`（`LC-2`）。

---

## 2. 声明 Identity（§6）与 Capability（§7）

### 2.1 Identity：三个字段，不含版本

[`Identity`](../reference/identity.md) 由 `domain`、`id`、`instance` 三个字段组成（§6.1）。

- `domain` MUST NOT 为空（`ID-1`）；`id` MUST NOT 为空（`ID-2`）。
- `instance` MUST 在同一个 `(domain, id)` 内唯一（`ID-3`）。
- Identity MUST 在其生命周期内保持不变（`ID-4`），MUST NOT 由 Plugin 自身伪造（`ID-5`）。
- **Identity MUST NOT 承载版本信息**（§6.2、`ID-6`）。版本由 `Capability.version` 表达。

插件声明的是 `domain` / `id` / `instance` 这三项载体信息；签发身份的一方在插件之外（`ID-5`）。

### 2.2 Capability：可以参与什么类型的组合

[`Capability`](../reference/capability.md) 有四个字段（§7.1）：`name`（必需）、`version`（必需，SemVer）、`contract`（可选）、`constraints`（可选）。

- `name` MUST NOT 为空（`C-1`）；`version` MUST 是合法 SemVer（`C-2`）。
- `contract` 是可选上下文，含 `name` 与 `version`（§7.1），用途是给人和工具看的（`C-3`）。Core 不规定它的 `schema` 格式（§7.1）。
- `constraints` 用于匹配。Core 的匹配语义是最窄的一种：`kind` 相等且 `value` 结构相等（`C-7`）。范围、偏序、谓词属于 Extension，MUST NOT 混入 Core（`C-7`）。

Capability 不描述方法列表、RPC 端点或 HTTP 路由（§7.2）。一个 Plugin MAY 暴露多个 Capability，一个 Capability MAY 被多个 Plugin 暴露（§7.3）。

### 2.3 CapabilityRef：版本 MUST 参与引用

`CapabilityRef` 含 `plugin`、`name`、`version` 三个字段（§7.4）。

- 版本 MUST 参与引用（`C-5`）。同一个 Plugin 可以同时暴露 `logging@1.0.0` 与 `logging@2.0.0`（§7.4）。
- 版本 MUST 参与 Binding identity（`C-6`）。`casing.apply@1.0.0` 与 `casing.apply@2.0.0` 是两个不同的能力：升级版本不会接管旧关系。

---

## 3. 被组合：Binding 与 Lifecycle（§9、§10）

### 3.1 Binding 的字段与派生状态

`bind(request)` 创建关系，`BindRequest` 含 `from`、`to`、`capability` 与可选的 `contract`（§12.2）。`from` 是提供 Capability 的一方，`to` 是消费它的一方（§9.1）。

[`Binding`](../reference/binding.md) 不含命令式的 `state` 字段（§9.1）。稳定语义状态是 `ACTIVE` / `DORMANT` / `CLOSED`（§9.2），由派生规则算出（§9.4）：

```
CLOSED   已被显式 unbind
ACTIVE   OPEN，且 from 与 to 都是 ACTIVE，且 from 仍暴露该 Capability
DORMANT  OPEN，且 ACTIVE 的条件不满足
```

`PENDING` MAY 作为 `bind()` 的内部事务状态存在，MUST NOT 对外可观察（§9.2、`B-9`）。

与插件作者直接相关的约束：

- `from` 与 `to` MUST 是已存在的 Plugin（`B-1`），`capability` MUST 由 `from` 暴露（`B-2`），且 `Binding.capability.plugin` MUST 等于 `Binding.from`（`B-7`）。违反时 `bind()` MUST 以 `EAPP_BINDING_INVALID` 失败（§9.7）。
- 同一 `(from, to, capability)` 在任意时刻 MUST NOT 有多个非 `CLOSED` Binding（`B-6`），唯一性检查与创建 MUST 原子（`B-8`）。并发 `bind` 时，最多一个创建新的非 CLOSED Binding，其他请求 MUST 返回既有 Binding 或以 `EAPP_BINDING_DUPLICATE` 失败（§9.8）。
- `unbind(bindingId)` MUST 把 Binding 置为 `CLOSED`（`O-3`）且 MUST 幂等（`O-4`）；`CLOSED` 是终结状态（`B-4`）。
- Binding MUST NOT 声明消息方向、同步或异步、投递保证与序列化格式（§9.9）。那些属于 [`Channel`](../reference/channel.md)。

### 3.2 Lifecycle 如何影响 Binding

- Plugin 进入 `INACTIVE` 或 `SUSPENDED` 时，它的所有 Binding 派生为 `DORMANT`（§9.6、`O-6`、`O-7`）。`deactivate` 与 `suspend` 对 Binding 的效果相同（§9.6）。
- Plugin 回到 `ACTIVE` 时，所有 Binding MUST 被重新评估（`O-8`）。
- `deactivate` MUST NOT 直接 CLOSE Binding（§10.4）；`SUSPENDED` MUST NOT 解除 Binding（`LC-5`、`OP-6`）。

因此"先 `bind` 后 `activate`"是正常顺序：`bind` 之后 Binding 处于 `DORMANT`，两端 `activate` 之后它自行变为 `ACTIVE`。

---

## 4. 插件作者面对的操作（§51）

五组操作，名称与参数取自 §51 与各自的定义处。

### 4.1 发现：`find` / `watch`（§11.1、§12.2）

```
find(criteria, scope)    ->  PluginRef 列表
watch(criteria, scope)   ->  DiscoveryEvent 流
```

`Criteria` 的字段（§11.1）：`capability`（能力名）、`version`（SemVer range）、`constraints`（逐条按 `C-7` 匹配）、`identity`（Identity 的字段子集，出现的字段相等）。

`DiscoveryScope` 含 `trustLevel`（`L0` / `L1` / `L2`）与 `trustDomain`（§11.1）。它们是信任分类，MUST NOT 被解释为 `L2 > L1 > L0` 的数值等级，也不得自动推导出 `L2 can access L1` 这类结论（§11.2、`D-7`）。

`DiscoveryEvent` 含 `type` 与 `plugin`；`type` MUST 是 `added` / `removed` / `changed` 之一（§11.1、`D-6`）。

`find` MUST 只返回当前 Trust Scope 内可见的 Plugin（`D-1`），`watch` MUST 只对当前 Trust Scope 内的事件触发（`D-2`）。Discovery MUST NOT 保证"发现即可组合"（`D-3`），MUST NOT 成为 Binding 的替代品（`D-5`）。

### 4.2 连接：`bind` / `unbind` / `createChannel`（§12.2、§32）

```
bind(request)            ->  Binding
unbind(bindingId)        ->  ()
createChannel(request)   ->  Channel
```

`CreateChannelRequest` 含 `binding`（`Binding.id`，来自 `bind()`）、`mode` 与可选的 `delivery`（§32）。

- `binding` MUST 是已存在且未被 `CLOSED` 的 Binding。不存在时 MUST 返回 `EAPP_BINDING_INVALID`（`CC-6`），已 `CLOSED` 时 MUST 返回 `EAPP_BINDING_CLOSED`（`CC-7`）。
- `mode` MUST 由调用方显式指定，取 `request` / `event` / `stream` / `state` 之一（`CC-3`、§22.1）。
- `delivery` 省略时，`stream` 与 `state` 推导为 `at-least-once`，其余推导为 `at-most-once`（`CC-4`）。给 `stream` / `state` 指定 `at-most-once` MUST 返回 `EAPP_DELIVERY_UNSUPPORTED`（`CC-5`、`DL-6`）。
- Channel 创建后处于 `OPEN`，`connect()` 后进入 `ACTIVE`（`CC-8`）。一个 Binding MAY 派生多个 Channel，各自 `mode` 不同（`CC-9`）。
- `mode` 与 `delivery` MUST NOT 在 Channel 生命周期内改变（`CH-5`、`CH-6`）。

### 4.3 激活：四个操作（§12.2）

```
activate(plugin)     ->  ()
deactivate(plugin)   ->  ()
suspend(plugin)      ->  ()
resume(plugin)       ->  ()
```

合法源状态与结果见第 1 节的表（§10.3）。四个操作的语义 MUST 与 §10 一致（`OP-6`）；`suspend` MUST NOT 断开 Binding（`OP-6`、`LC-5`）。

### 4.4 通信：`send` / `subscribe` 与消费单元的 `ack` / `nack`

```
send(channel, msg)                   ->  Cursor
subscribe(channel, pattern, options) ->  Subscription
ack()                                ->  ()    消费单元自带，无参数
nack()                               ->  ()    消费单元自带，无参数
```

- `send` 由 Transport 分配 cursor；返回的 cursor MUST 在该 Channel 内严格大于此前所有 cursor（§30.1、`TR-8`）。
- `subscribe` 的 `SubscriptionOptions` 含 `mode`（`exclusive` / `group`）、`group`、`cursor`（默认 `latest`）（§27.1）。`mode` 为 `group` 时 `group` MUST 指定（`SUB-4`），且 MUST 指名同一 Channel 上的一个 [`ConsumerGroup`](../reference/consumer-group.md)（`CG-8`）。
- 每个 [`Subscription`](../reference/subscription.md) 有 `id` / `channel` / `mode` / `cursor` / `state`，以及 `suspend()` / `resume()` / `close()`（§27.1）。`close()` MUST 幂等（`SUB-6`），`close()` 之后 MUST NOT 再投递（`SUB-7`）。

`Transport` 的 `readAfter` 不在表面上（§51）：它由 `Subscription` 的实现使用，插件作者不调用它。

消费循环只有一条推进规则：**cursor 只随 `ack` 前移**（§26.4）。

```
循环取得消费单元 T：            ← 说明性伪代码
  处理 T.payload
  成功  →  T.ack()
  失败  →  T.nack()
```

- `ack()` MUST 幂等（`AK-1`），把 cursor 置为 max(当前 cursor, 该项位置)（§26.4）。`nack()` MUST 幂等（`AK-2`）且 MUST NOT 推进 cursor；该项回到可用，并在下一次迭代重新投递（§26.4）。
- `ack()` 之后 MUST NOT 允许 `nack()`；`nack()` 之后 MUST NOT 允许 `ack()`（`AK-3`、`AK-4`）。对已终结的消费单元再次调用 MUST 返回 `EAPP_LEASE_CLOSED`（`AK-5`）。
- `at-least-once` 的消费者 MUST 幂等处理（`DL-5`）；`exactly-once` MUST NOT 出现在 Core（`DL-2`）。
- [`Cursor`](../reference/cursor.md) 是不透明字符串，消费者 MUST NOT 解析它（§26.1）。已 ack 位置之前的消息 MUST NOT 被重新投递（`ST-3`）；未 ack 的消息 MAY 在重连后重新投递（`ST-4`）。
- `event` 模式 MUST NOT 期待响应；它的投递 MAY 为零次，也 MAY 为多次（`EV-1`、`EV-2`、`EV-3`）。

### 4.5 调用：`invoke`（§52）

```
invoke(from, to, capability, request, options)   ->  response
```

| 参数 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `from` | `PluginRef` | 是 | **调用方** |
| `to` | `PluginRef` | 是 | 被调用方 |
| `capability` | `CapabilityRef` | 是 | 被调用的能力 |
| `request` | 任意值 | 是 | 请求体，放入 `RequestMessage.payload` |
| `options.timeoutMs` | number | 否 | 截止时间，从调用开始计 |
| `options.correlationId` | string | 否 | 显式指定关联标识；省略时由实现分配 |

结果是 `ResponseMessage.result`（成功）或一个 `EappError`（失败）（§52）。

**`bind` 与 `invoke` 的 `from` 指向相反的一方。** `bind` 描述能力的提供方向，`invoke` 描述请求的发出方向；两个操作的 `to` 都指向被调用方所暴露的能力（`OP-4`、§52）。

```
invoke(from, to, capability)  ⟺  bind(from = to, to = from, capability) 之上的 request
```

每个 request MUST 有唯一 `correlationId`（`RQ-1`）；一个 request MUST 对应 0 或 1 个 response（`RQ-2`）；response MUST 携带与 request 相同的 `correlationId`（`RQ-3`）。deadline 到期后 request MUST 被视为超时（`RQ-4`）：截止时间到达时 `invoke` MUST 以 `EAPP_TIMEOUT` 结束，MUST NOT 静默挂起，MUST NOT 返回形态未定义的值（`OP-5`）；迟到的应答 MUST 按 `RQ-2` 被丢弃（§52）。

### 4.6 `state` 模式不另立操作组（§53）

含 `state` 模式的 Channel 复用 `send` / `subscribe` / `ack`（§53），[`StateWatcher`](../reference/state-watcher.md) 就是一个 `Subscription`（`SW-1`）。它由三段式路径构造（§32、§44.1）：

```
① bind(from, to, capability)                                     ->  Binding
② createChannel({ binding, mode: 'state',
                  delivery: 'at-least-once' })                   ->  Channel
③ configure(channel, { conflictPolicy: 'cas', owner })            ->  StateChannel
```

`get` / `list` / `set` / `delete` / `watch` / `snapshot` / `restore` 是 [`StateChannel`](../reference/state-channel.md) 视图上的操作，MUST NOT 出现在裸 Channel 上（`IX-3`、§44.2）。

---

## 5. 错误如何浮现（§18、§33、§47、附录 D）

### 5.1 错误的形状

`EappError` 有四个字段（§18）：`code`（必需）、`message`（必需）、`details`（可选）、`retryable`（可选，缺省 `false`）。`code` 的取值范围是附录 D 登记的全集（§18）。

错误的构造 MUST 在实现内只定义一次，三层共用（§18、附录 D）。各层的码联合按层扩展，MUST NOT 重命名或改义既有码（§33）。附录 D 是各层错误码的并集，用于避免同一语义在不同层被赋予两个码（附录 D）。

### 5.2 `retryable` 的赋值规则

```
EAPP_REVISION_CONFLICT  → true   （CAS 冲突可重试）
其余                    → false
```

`retryable` 为 `true` 时，重试同一操作在语义上是有意义的；为 `false` 时，调用方 MUST 改变输入或重新同步，而不是重试（附录 D.4）。

### 5.3 正文给出触发条件的码

| 错误码 | 触发条件 | 出处 |
|---|---|---|
| `EAPP_BINDING_INVALID` | `Binding.capability.plugin` 不等于 `Binding.from`；`createChannel` 的 binding 不存在 | §9.7、`CC-6` |
| `EAPP_BINDING_DUPLICATE` | 并发 `bind` 同一 `(from, to, capability)` 时未返回既有 Binding | §9.8 |
| `EAPP_BINDING_CLOSED` | `createChannel` 的 binding 已 `CLOSED` | `CC-7` |
| `EAPP_DELIVERY_UNSUPPORTED` | 给 `stream` / `state` 指定 `at-most-once` | `DL-6`、`CC-5` |
| `EAPP_TIMEOUT` | 截止时间到达 | §52、`OP-5`、`RQ-4` |
| `EAPP_CURSOR_TOO_OLD` | 日志已压缩到无法定位请求位置；或请求的具体 Cursor 已被删除 | §26.2 规则 6、规则 7 |
| `EAPP_CURSOR_UNSUPPORTED` | Transport 不支持 cursor | `CR-5`、`TR-9` |
| `EAPP_UNSUPPORTED` | 特性不被支持（含 `supportsStateSnapshot` 为 false 时的 `snapshot` / `restore`） | `TR-9`、§46.2 |
| `EAPP_MODE_INVALID` | `channel.mode` 与操作不匹配 | §44.1 |
| `EAPP_STATE_UNSUPPORTED` | `supportsState` 为 false；或 `supportsStateRevision` 为 false 时的 `set` / `delete` / `restore` | §46.2 |
| `EAPP_WATCH_UNSUPPORTED` | `supportsStateWatch` 为 false | §46.2 |
| `EAPP_STATE_ACTOR_REQUIRED` | `configure` 的 `owner` 不是已注册 Identity | §44.1 |
| `EAPP_STATE_KEY_NOT_FOUND` | `delete` 的 `expectedRevision` 为 `null`，而 key 从未存在 | `DEL-4`、§40.2 |
| `EAPP_STATE_VALUE_INVALID` | `StateUpdate` 同时携带 `value` 与 `deleted = true`；或 `deleted === false` | `SU-3`、`SU-9` |
| `EAPP_STATE_PATTERN_INVALID` | `StatePattern` 不满足 §42 的逐字段校验 | §42 |
| `EAPP_REVISION_CONFLICT` | CAS 失败，含 `expectedRevision` 与当前 revision 不匹配 | §39.2、§40.2、`SU-4` |
| `EAPP_REVISION_INVALID` | `compareRevision` 收到非本 Transport 签发的值；`writeStateWithRevision` 收到 `<= head` 的 revision | §37.2、§37.3 |
| `EAPP_SNAPSHOT_INVALID` | `restore` 收到 `channel` 与目标不同的快照 | `SNAP-9` |
| `EAPP_LEASE_CLOSED` | 对已终结的 `AckContext` 再次调用 `ack` / `nack` | `AK-5` |

下列码只登记在 §18 / §33 / §47 的清单里，正文没有给出单独的触发条款：

```
EAPP_IDENTITY_INVALID        EAPP_IDENTITY_DUPLICATE     EAPP_CAPABILITY_NOT_FOUND
EAPP_CAPABILITY_NOT_EXPOSED  EAPP_PLUGIN_NOT_FOUND       EAPP_PLUGIN_INACTIVE
EAPP_LIFECYCLE_INVALID       EAPP_DISCOVERY_SCOPE_INVALID EAPP_INTERNAL
EAPP_CHANNEL_INVALID         EAPP_CHANNEL_CLOSED         EAPP_CHANNEL_DRAINING
EAPP_CURSOR_INVALID          EAPP_SUBSCRIPTION_INVALID   EAPP_LEASE_EXPIRED
EAPP_LEASE_CONFLICT          EAPP_STATE_KEY_INVALID
```

它们是可用的失败信号；正文没有为它们规定唯一的触发条件。

---

## 6. 插件 MUST NOT 做的事

| 禁止 | 依据 |
|---|---|
| 自行签发 Identity | `ID-5`：Identity MUST NOT 由 Plugin 自身伪造（§6.3） |
| 把版本写进 Identity | `ID-6`（§6.2）；版本由 `Capability.version` 表达（§6.2） |
| 在生命周期内改变 Identity | `ID-4`、`P-3`（§6.3、§8.3） |
| 省略 `CapabilityRef.version` | `C-5`（§7.4）；版本 MUST 参与 Binding identity（`C-6`） |
| 期待 Core 提供更丰富的 constraint 匹配 | `C-7`（§7.5）：范围、偏序、谓词属于 Extension，MUST NOT 混入 Core |
| 直接设置 Binding 状态 | `B-3`（§9.10）：Binding 状态 MUST 是派生的，MUST NOT 被直接设置 |
| 让 `PENDING` 对外可观察 | `B-9`（§9.2） |
| 在同一 `(from, to, capability)` 上并存多个非 CLOSED Binding | `B-6`（§9.8） |
| 在 Binding 上声明消息方向、同步性、投递保证或序列化格式 | §9.9 |
| 用 `activate` 从 `SUSPENDED` 恢复 | §10.3、`LC-6` |
| 认为 `deactivate` 或 `suspend` 会解除 Binding | §10.4、`LC-5`、`OP-6` |
| 把发现当作可组合或可调用的保证 | `D-3`、`D-5`（§11.3） |
| 把 `trustLevel` 当数值等级或授权顺序 | `D-7`（§11.2） |
| 在 Channel 生命周期内改变 `mode` 或 `delivery` | `CH-5`、`CH-6`（§22.3） |
| 期待 `exactly-once` | `DL-2`（§24）；`at-least-once` 的消费 MUST 幂等（`DL-5`） |
| 解析 Cursor | §26.1 |
| 让 cursor 随收到消息隐式前移，或用最小未了结位置替代组 cursor | §26.4、§28.3、`CR-3` |
| 使用超出 Transport 能力的特性 | `TR-4`（§30.4）；Transport MUST NOT 伪装支持（`TR-3`） |
| 期待 `event` 模式的响应 | `EV-1`（§23.2） |
| 期待 Core 提供无条件写入 | `SU-6`（§39.5）；Core MUST 只支持 CAS（`CF-1`） |
| 直接比较 Revision 字符串，或跨 Transport 比较 Revision | §37.2、`REV-5`、`REV-8` |
| 在非 `state` 模式把 Revision 当 Cursor 用 | `REV-6`（§37.1） |
| 在裸 Channel 上使用 `get` / `set` / `watch` / `snapshot` | `IX-3`（§48.1） |
| 把确认写成由 watcher 代收集的形式 | §41.2 |
| 引入 `pending` 结构来推迟 cursor | §26.4、§41.3 |
| 要求插件作者使用协议未定义的入口，或访问实现的内部对象 | `OP-1`、`OP-2`（§54） |
| 重命名或改义既有错误码 | §33 |

表面只规定形状，上表的约束来自前三部分；表面与它们冲突时以前三部分为准（§50）。

---

## 7. 速查表：操作 → 规范小节 → 不变量前缀

| 操作 | 规范 | 不变量前缀 |
|---|---|---|
| `find` | §11.1、§12.2 | `D-` |
| `watch` | §11.1、§12.2 | `D-` |
| `bind` | §9、§12.2 | `B-`、`O-` |
| `unbind` | §9、§12.2 | `B-`、`O-` |
| `createChannel` | §22、§32 | `CC-`、`CH-` |
| `activate` / `deactivate` / `suspend` / `resume` | §10、§12.2 | `LC-`、`O-` |
| `send` | §30.1 | `TR-` |
| `subscribe` | §27.1 | `SUB-`、`CG-` |
| `ack` / `nack` | §26.4、§29 | `AK-`、`CR-`、`L-` |
| `invoke` | §52 | `RQ-`、`OP-` |

表面自身的九条不变量是 `OP-1`…`OP-9`（附录 B.4）。全部不变量的清单与各前缀的含义见附录 B；各层的合规等级见 §17、§34、§53。

---

## 8. 相关

- [概念：三层心智模型](./concepts.md) —— 层与层的分工，以及表面为什么不是第四层
- [快速上手](./getting-started.md) —— 五个操作组的实际形态
- [实现一个 Transport](./write-a-transport.md) —— 换掉消息怎么走
- [写一个 Extension](./write-an-extension.md) —— 协议之外的语义如何表达
- [规范正文 §50–§54](../spec/eapp.md) —— 表面的定义
- 实体索引：[`Plugin`](../reference/plugin.md) · [`Identity`](../reference/identity.md) ·
  [`Capability`](../reference/capability.md) · [`Binding`](../reference/binding.md) ·
  [`Lifecycle`](../reference/lifecycle.md) · [`Discovery`](../reference/discovery.md) ·
  [`Channel`](../reference/channel.md) · [`Subscription`](../reference/subscription.md) ·
  [`Cursor`](../reference/cursor.md) · [`AckContext`](../reference/ack-context.md) ·
  [`StateChannel`](../reference/state-channel.md)

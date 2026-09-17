# 概念：三层心智模型

> 这套协议要解决的是：**让彼此独立写出来的插件，能被组合起来用**。
> 它不依赖中心注册表，也不需要预定义契约；语言与运行时由各实现自行选择。

---

## 1. 为什么需要"协议"而不是"框架"

框架给出的答案通常是：所有插件都依赖同一套抽象。问题因此变成"由谁来定义那套抽象"。

协议的答案不同：**每一层只回答一个问题，并把这个问题答死。** 谁来回答、用什么语言回答、跑在哪个进程里，协议不管。

本仓库里，三样东西各司其职：

```
规范正文      docs/spec/eapp.md —— 唯一的规范性来源
合规声明      由实现方给出，字段见 §3.2
一致性测试    由实现方提供，位于实现方的仓库（§3.1）
```

规范之外的任何文本 —— 指南、参考页、变更记录、评审意见 —— 在与 [`docs/spec/eapp.md`](../spec/eapp.md) 冲突时，以规范为准（§1）。

规范要求**每个不变量 MUST 至少有一个对应的测试用例**（§3.1），并要求实现声称合规时声明 `eappVersion`、`levels`、`testSuite`、`passed`、`total`（§3.2）。规范的价值在于它能被实现，也能被验证。

实现与检查工具不在本仓库。参考实现位于 `reference` 分支：
<https://github.com/quyansiyuanwang/EaPP/tree/reference>。

---

## 2. 三个问题

三层各自回答一个问题。这是理解整个协议最快的方式。

```
Composition Core   ──►  谁和谁组合？                    §4–§21
Interaction Layer  ──►  组合建立之后，它们如何互动？      §22–§34
State Mode         ──►  它们如何共享状态？               §35–§49
```

再往下是 **Transport**：消息物理上怎么走（§30）。

```
Composition Core      Identity / Capability / Plugin / Binding / Lifecycle / Discovery
        │  单向依赖
        ▼
Interaction Layer     Channel / Subscription / ConsumerGroup / Delivery / Lease / Cursor
        │
        ▼
State Mode            StateCell / Revision / StateUpdate / StateWatcher / Snapshot
        │
        ▼
Transport             传输介质
```

依赖方向是单向的，且 **MUST NOT** 反向（§1.1、§4.3）。下层 MUST NOT 定义上层语义。

Transport 的边界值得单独说清：

- Transport MUST 声明自己的能力（§30.2）。不支持某个特性时 MUST 返回 `EAPP_UNSUPPORTED`；不支持 cursor 时 MUST 返回 `EAPP_CURSOR_UNSUPPORTED`（§30.4 `TR-9`）。
- Transport MUST NOT 定义 Interaction 语义（`TR-1`）。投递保证、[`Cursor`](../reference/cursor.md)、[`Lease`](../reference/lease.md) 属于 Interaction Layer。
- 组合确定之后，Composition Core 只承认 `ChannelRef`（§13.1）。[`Channel`](../reference/channel.md) MUST NOT 独立于 [`Binding`](../reference/binding.md) 存在（`CC-1`），它由 `createChannel` 从 Binding 派生（§32），并跟随 Binding 的状态（§22.4、`CC-2`）。

---

## 3. 五个操作组

插件作者的全部组合、互动与调用工作由五个操作组完成（§51）：

| 操作组 | 操作 | 定义处 |
|---|---|---|
| **发现** | `find`、`watch` | §12.2 |
| **连接** | `bind`、`unbind`、`createChannel` | §12.2、§32 |
| **激活** | `activate`、`deactivate`、`suspend`、`resume` | §12.2 |
| **通信** | `send`、`subscribe`，以及消费单元自带的 `ack` / `nack` | §30.1、§27.1、§29 |
| **调用** | `invoke` | §52 |

组名是给读者的分类，不是新的本体（§51）。一个操作组 MUST 只含上表列出的操作，且这些操作 MUST 使用上表与各定义处给出的名称与参数（§51）。实现 MAY 提供额外的操作，但插件作者完成组合、互动与调用 MAY 不需要它们（§51、`OP-1`、`OP-2`）。

其中前四组的语义与形状在前三部分已经完全给出；第 IV 部分补上第五组，它此前有信封而没有操作名（§51）。`invoke` 的签名是 `invoke(from, to, capability, request, options) -> response`，其中 `from` 是调用方（§52）。

第 8 节说明这五组构成的表面为什么不是第四层。

---

## 4. Composition Core：关系

五个本体，一个方向：

```
Identity ──► Plugin ──► Binding
               │           ▲
               ▼           │
          Capability ──────┘

          Lifecycle 决定 Plugin 是否参与
          Discovery 找出哪些 Plugin 可以被组合
```

四个决定：

**Identity 不含版本。** `{domain, id, instance}` 只回答"这是谁"（§6.1）。版本属于 `Capability.version`（§6.2、`ID-6`）。版本进入身份，会让升级变成换了一个身份。

**Capability 描述可以参与什么类型的组合。** 它不描述方法列表、RPC 端点或 HTTP 路由（§7.2）。一个 [`Plugin`](../reference/plugin.md) MAY 暴露多个 [`Capability`](../reference/capability.md)，一个 Capability MAY 被多个 Plugin 暴露（§7.3）。

**Binding 的状态是派生的。** `B-3` 要求 Binding 状态 MUST 是派生的，MUST NOT 被直接设置。`ACTIVE` 由三件事推出：是否已被显式 `unbind`、两端是否 `ACTIVE`、`from` 是否仍暴露该 Capability（§9.4）。

**发现是必要条件。** 发现得到的结论是"可以被组合"，不是"已经可以调用"（`D-3`）。Discovery MUST NOT 成为 Binding 的替代品（`D-5`）。

---

## 5. Interaction Layer：互动

四种模式（§23）：

```
request   一个发送方，一个接收方，一个响应
event     一个发送方，多个接收方，不期待响应
stream    一个发送方，有序序列，可恢复
state     多个参与者共享一份带版本的状态（语义见第 6 节）
```

一个 Channel MUST 恰好有一种模式（§23.1）。

消息传递的四个本体：

```
Channel         交互发生在哪里（§22）
Delivery        一次投递保证什么（§24）
Lease           这份工作谁领了、领到什么时候（§25）
Cursor          恢复到哪个位置（§26）
```

两处常见的误解：

**Cursor 的位置是"确认到哪"，不是"读到哪"。** 收到消息不等于已确认，`CR-3` 禁止 cursor 随收到消息隐式前移，推进只由 `ack` 决定（§26.4）。显式 ack 一个更靠后的位置、因而放弃中间未确认的项，MUST 被允许（§26.4）。任何"只推进到第一个未 ack 项之前"的实现 MUST 被视为违反 §26.4。

**ConsumerGroup 是竞争的载体（§28）。** 组之间，每个组都收到全部消息，各自持有独立 Cursor（`CG-4`）；组之内，每条消息只交给一个成员（`CG-3`）。排他性没有另立机制：一次 claim 就是一次 Lease，`L-2` 直接使它成立（§28.3）。

模式消息的形状是冻结的。`RequestMessage` / `ResponseMessage` / `EventMessage` / `StreamMessage` 各自的信封定义在 §23.1；实现 MAY 在信封上附加自己的字段，但 §23.1 已列出的字段 MUST NOT 被改名或改义。

---

## 6. State Mode：共享

**它是 Interaction Layer 的第四种 mode，不是新层**（§35.3、§48.1）。四个本体，外加 Core 里唯一一种冲突策略（§36、§44.5）：

```
StateCell      共享的是什么（§38）
Revision       它的版本是什么（§37）
StateUpdate    一次变更是什么（§39）
StateWatcher   如何观察（§41）
CAS            冲突怎么解决（§44.5）
```

### 一条改变了语义的裁定

> **`Revision` 就是这次写入在 Channel 状态日志里的位置**（§36.2）。

把 Revision 定义成每个 cell 自己的版本号看起来更直观，但那样它既不是全序，也无法充当观察位置（§36.2）。一旦它被定义成日志位置，`Revision` 与 `Cursor` 就是同一域上的同一类型，于是 `REV-7`（Revision MAY 在 State Mode 里当 Cursor 用）不再是例外，而是 `CR-1` 的推论（§36.2）。

[`Revision`](../reference/revision.md) 是不透明的（`REV-5`），消费者 MUST NOT 直接比较它的字符串；比较由 Transport 提供（`compareRevision`，§37.2），且 MUST NOT 跨 Transport 比较（`REV-8`）。

### CAS 是唯一的冲突策略

`conflictPolicy` 是冻结的字面量 `cas`（§44.5、`CF-1`、`CF-4`）。Core MUST NOT 对外暴露无条件写入（`SU-6`）。没有全序的 Transport MUST 声明 `supportsStateRevision = false` 与 `stateConsistency = 'eventual'`（`TS-4`），于是 `set` / `delete` / `restore` 以 `EAPP_STATE_UNSUPPORTED` 失败（§46.2）。

### 删除是可见状态

`deleted: true` 的 cell 仍然存在，仍然有 revision，`get` / `list` 仍然返回它（`SC-6`）。只有从未存在的 key 才返回 `null`（§38.2）。

---

## 7. 什么不属于 Core

以下语义明确列在规范的"不做"清单里（§4.2、§20.1、§49），它们属于 **Extension** 或 **Trust Domain**：

```
数据库         查询语言 · 事务 · 索引
消息队列       投递语义之外的排队策略
一致性算法     CRDT · 共识
RPC            schema 校验 · 代码生成
插件市场       分发 · 版本选择策略
沙箱           隔离 · 资源限制
PKI            信任根 · 证书
```

判断标准：**如果它不是"让插件能组合并互动"所必需的，它就不在 Core。** 这些语义在协议里的位置是 Extension：`CF-3` 把 CAS 之外的冲突策略交给 Extension，`DL-2` 把 `exactly-once` 排除在 Core 之外。

---

## 8. 表面不是第四层

第 IV 部分**插件开发表面**是前三部分已经要求过的操作，在名称、参数、结果与错误码上的统一形状（§50）。

它不定义新的本体，不改变前三部分的任何语义，也不引入新的状态（§50、`OP-3`）。任何一条表面规则与前三部分冲突时，以前三部分为准，且该冲突是表面的缺陷，不是前三部分的例外（§50）。

依赖方向因此保持不变：

```
Composition Core  →  Interaction Layer  →  State Mode  →  Transport
```

表面的价值是可判定的：**一个只读过规范的第三方，写出的插件应当能被另一份同样只读过规范的实现直接组合**，中间不需要任何适配代码（§50）。这一点由三条不变量落实：

- `OP-7`：同一组合语义的两份实现 MUST 能只经由表面互通；表面 MUST NOT 要求实现特有的握手、能力协商或序列化约定。
- `OP-8`：`find` 的结果 MUST 可直接作为 `bind` 与 `invoke` 的输入，MUST NOT 需要额外的注册、转换或转写步骤。
- `OP-2`：五个操作的参数与结果中的类型 MUST 全部在协议内定义，插件作者 MUST 无需访问实现的内部对象即可完成组合、互动与调用。

---

## 9. 接下来

- [快速上手](./getting-started.md) —— 跑起来，并看懂演示的每一行
- [写一个插件](./write-a-plugin.md) —— 按 §50–§54 的表面写一个插件
- [实现一个 Transport](./write-a-transport.md) —— 换掉消息怎么走
- [用另一种语言实现 EaPP](./implement-in-another-language.md) —— 必须实现什么、可以跳过什么
- [写一个 Extension](./write-an-extension.md) —— 协议之外的语义如何用既有机制表达
- [参考索引](../README.md#参考) —— 查某个实体的确切语义
- [规范正文](../spec/eapp.md) —— 唯一的规范性来源

# 概念：三层心智模型

> 这套协议要解决的是：**让彼此独立写出来的插件，能被组合起来用** ——
> 不靠中心注册表，不靠预定义契约，不靠大家用同一种语言。

---

## 1. 为什么需要"协议"而不是"框架"

框架的答案通常是：所有人都依赖我的抽象。于是问题变成"谁来实现我的接口"。

协议的答案不同：**每一层只回答一个问题，并把它答死。** 谁来回答、用什么语言回答、
跑在哪个进程里，协议不管。

所以在本项目里：

```
规范是一件产品           docs/spec/
参考实现是它的一份证据     packages/
一致性套件是证据的检验     tests/conformance/
```

**一份不能被实现、也不能被验证的规范没有价值。**

---

## 2. 三个问题

三层各自回答一个问题。这是理解整个协议最快的方式。

```
Composition Core   ──►  谁和谁组合？
Interaction Layer  ──►  组合之后，它们如何互动？
State Mode         ──►  它们如何共享状态？
```

再往下是 **Transport**：消息物理上怎么走。

```
Composition Core      Identity / Capability / Plugin / Binding / Lifecycle / Discovery
        │  单向依赖
        ▼
Interaction Layer     Channel / Subscription / ConsumerGroup / Delivery / Lease / Cursor
        │
        ▼
State Mode            StateCell / Revision / StateUpdate / StateWatcher / CAS
        │
        ▼
Transport             Memory（进程内） · Socket（跨进程）
```

Transport 的**接口**是冻结的（v3.1 §10 / v3.2 §11），协议本身与实现无关。
本仓库交付了两种，它们之间的差别正好说明"接口稳定、实现自由"是什么意思：

| 实现 | 位置域 | `durabilityBoundary` |
|---|---|---|
| `@eapp/transport-memory` | 一个进程 | `'process'` |
| `@eapp/transport-socket` | 一台机器上的所有进程 | `'machine'` |

同一个 `EappRuntime`、同一批不变量测试、同一套语义，换掉最下面一层即可 ——
见 [实现一个 Transport §7.1](./write-a-transport.md) 与
[`examples/cross-process/`](../../examples/cross-process/index.ts)。
Redis / NATS 形态的实现仍然是**可能的**（接口允许），只是本仓库没有交付。

**下层 MUST NOT 反向定义上层语义。** Transport 只搬字节，它不定义投递保证、
不定义 Cursor、不定义 Lease —— 那些是 Interaction Layer 的职责。

---

## 3. 五个动词

从使用者的角度，整套协议就是五个操作：

```
发现 discover    有哪些插件可以被组合？          v3.0 Discovery
连接 connect     让其中两个建立关系。            v3.0 bind()  +  v3.1 createChannel()
激活 activate    让它们进入当前组合。            v3.0 Lifecycle
通信 communicate 让它们交换消息或共享状态。       v3.1 Channel  +  v3.2 StateChannel
调用 invoke      请求-响应，带关联与超时。        v3.1 request 模式
```

`@eapp/runtime` 将这五个操作封装为一个门面，位于上述三层之上，不构成第四层。
它没有引入任何规范之外的语义。

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

### 四个决定

**Identity 不含版本。** `{domain, id, instance}` 只回答"这是谁"。
版本属于 `Capability.version`。把版本塞进身份，会让"升级"变成"换了一个人"。

**Capability 不是接口。** 它描述"一个 Plugin 可以参与什么类型的组合"，
不是方法列表、不是 RPC 端点、不是 HTTP 路由。一个 Plugin MAY 暴露多个 Capability；
一个 Capability MAY 被多个 Plugin 暴露。

**Binding 的状态是派生的，不是设置的。** 没有人能"把 Binding 设为 ACTIVE"。
它由三件事推导出来：是否已 `unbind`、两端是否 ACTIVE、`from` 是否仍暴露该 Capability。
这消除了整整一类状态机 bug。

**Discovery 只是必要条件。** 发现得到的是"可以被组合"，不是"已经可以调用"。

---

## 5. Interaction Layer：互动

### 四种模式

```
request   一个发送方，一个接收方，一个响应
event     一个发送方，多个接收方，即发即忘
stream    一个发送方，有序序列，可恢复
state     多个参与者共享一份带版本的状态
```

**一个 Channel 恰好有一种模式。** 一个 Binding MAY 派生多个 Channel，各自模式不同。

### 消息传递的四个本体

```
Channel         交互发生在哪里
Delivery        一次投递保证什么（at-most-once / at-least-once）
Lease           这份工作谁领了、领到什么时候
Cursor          恢复到哪个位置
```

### 两个容易搞错的点

**Cursor 不是"我读到哪"，而是"我确认到哪"。**

```
收到消息 ≠ 已确认

Cursor MUST NOT 随收到消息自动前移。它只随 ack 前移。
```

这是 CR-3 的全部含义。它禁止的是**隐式**前移；
显式 ack 一个更靠后的位置、因而放弃中间未确认的项，是允许的，也是恢复语义的定义。

**ConsumerGroup 是「竞争」的载体。**

```
组之间：每个组都收到全部消息，各自持有独立 Cursor
组之内：每条消息只交给一个成员
```

排他性没有被重新发明 —— 一次 claim 就是一次 Lease，
所以"同一位置不被两个 ACTIVE Lease 持有"这条既有规则直接使它成立。

### 模式消息的形状是冻结的

`RequestMessage` / `ResponseMessage` / `EventMessage` / `StreamMessage` 各有信封，
定义在本层。上层 MAY 附加自己的字段，但**不得给既有字段改名或改义**。

---

## 6. State Mode：共享

**它是 Interaction Layer 的第四种 mode，不是新层。**
四个核心本体（v3.2 §2），外加 Core 里唯一一种冲突策略 `CAS`（v3.2 §10.5）：

```
StateCell      共享的是什么
Revision       它的版本是什么
StateUpdate    一次变更是什么
StateWatcher   如何观察
CAS            冲突怎么解决（Core 里唯一一种）
```

### 唯一一条真正改变了语义的决定

> **`Revision` 就是这次写入在 Channel 状态日志里的位置。**

把它定义成"每个 cell 自己的版本号"看起来更直观，但那样它既不是全序、
也无法充当观察位置 —— 于是"独立 Cursor + 逐条 ack + 删除事件可观察"三者无法同时成立。

一旦它被定义成**日志位置**：

```
Revision 与 Cursor 成为同一域上的同一类型
⇒ "Revision 可以在 State Mode 里当 Cursor 用" 不再是例外，
  而是 "Cursor 在 Channel 内全局有序" 的直接推论
```

### CAS 是唯一的冲突策略

Core 里没有 unconditional write、没有 last-write-wins、没有 merge。
**没有全序的 Transport 就不能做 CAS** —— 它的能力声明里必须写 `supportsStateRevision: false`，
于是 `set` / `delete` 直接失败。一个"最终一致但号称能 CAS"的存储会静默丢更新，
所以这里不给豁免。

### 删除是可见状态

`deleted: true` 的 cell 仍然存在，仍然有 revision，`get` 仍然返回它。
只有"从未存在"才返回 `null`。否则"删除已删除的 key"这类分支永远不可达。

---

## 7. 什么不属于 Core

以下全部属于 **Extension** 或 **Trust Domain**，不属于这三层：

```
数据库         查询语言 · 事务 · 索引
消息队列       投递语义之外的排队策略
一致性算法     CRDT · 共识
RPC            schema 校验 · 代码生成
插件市场       分发 · 版本选择策略
沙箱           隔离 · 资源限制
PKI            信任根 · 证书
```

判断标准很简单：**如果它不是"让插件能组合并互动"所必需的，它就不在 Core。**

---

## 8. 接下来

- [快速上手](./getting-started.md) —— 跑起来，并看懂演示的每一行
- [写一个插件](./write-a-plugin.md)
- [实现一个 Transport](./write-a-transport.md)
- [参考](../README.md#参考) —— 查某个实体的确切语义
- [规范](../spec/v3.0.0-core.md) —— 唯一的规范性来源

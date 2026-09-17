# EaPP — 万物皆插件协议

**Everything as a Plugin Protocol**

| | |
|---|---|
| 协议版本 | `3.5.0` |
| 状态 | FROZEN。`3.4.0` 的分卷 IV 与 `3.5.0` 的错误码条款尚未取得 §2.3 要求的评审，见 `CHANGELOG.md` |
| 规范用语 | MUST / MUST NOT / SHOULD / SHOULD NOT / MAY（RFC 2119） |
| 适用范围 | 任何语言、任何运行时、任何传输 |

> 本文件是 EaPP 的**唯一规范性正文**。它规定语义，不规定实现；语言、运行时与传输介质均不受约束。
> 合规性是实现的行为属性，与实现是否使用某一套代码无关。
>
> 本文件之外的任何文本——指南、参考页、变更记录、评审意见——在与本文件冲突时，以本文件为准。

---

## 1. 本规范的读法

### 1.1 分卷

| 分卷 | 内容 |
|---|---|
| 第 I 部分 | **Composition Core**：谁和谁组合。Identity / Capability / Plugin / Binding / Lifecycle / Discovery |
| 第 II 部分 | **Interaction Layer**：组合建立之后如何互动。Channel / Subscription / ConsumerGroup / Delivery / Lease / Cursor / Transport |
| 第 III 部分 | **State Mode**：如何共享状态。StateCell / Revision / StateUpdate / StateWatcher / Snapshot |
| 第 IV 部分 | **插件开发表面**：插件作者面对的操作集合。它规定形状，不引入新语义 |

依赖方向单向，且 **MUST NOT** 反向：

```
Composition Core  →  Interaction Layer  →  State Mode  →  Transport
```

下层 MUST NOT 定义上层语义。第 IV 部分不是第四层：它是前三部分的剖面，把已经要求过的操作在形状上钉死，使不同实现写出的插件可以互相组合。

### 1.2 记法

**操作签名**使用语言中立记法：

```
操作名(参数, 参数)  ->  结果
```

参数与结果中的类型名（`PluginRef`、`Channel`、`Cursor` 等）在本文件内定义。每个操作除签名外 MUST 有一节规范性描述，给出输入、输出、错误码与适用不变量。

签名**不标注异步性**。一个操作是否 MUST 在返回之前完成其语义效果，由该操作的条款规定；`->` 之后写的是结果，等待本身不是语义的一部分。

**数据结构**以逐字段表格给出，每个字段标注名称、类型、必需性。字段名与操作名是**跨实现契约的一部分**：实现 MUST 使用这些名字，MUST NOT 改名或改义。

**示例**用于说明，不构成规范要求。示例中的类型标注表示**语义类别**（可比较的有序值、可序列化的值、不可透明解析的标识），不要求实现使用同名类型。

**约束词**按 RFC 2119 解释。凡陈述中出现 MUST / MUST NOT / SHOULD / SHOULD NOT / MAY，即为规范要求；其余说明性文字不构成要求。

### 1.3 不变量的标识

每条不变量有一个形如 `XX-1` 的标识符，在整个协议范围内**唯一**。标识符是稳定的：它不随章节调整而改变，测试、一致性声明与变更记录都以它为准。

不变量按前缀分组。全部不变量的清单与各前缀的含义见附录 B。

---

## 2. 协议版本与冻结

### 2.1 版本策略

协议版本是本文件所声明的**唯一版本号**，也是 §3.2 中 `eappVersion` 所报告的那个号。

| 版本类型 | 变更范围 |
|---|---|
| **3.0.x** | 勘误、文本澄清，不改变语义 |
| **3.x.0** | 新增不变量、新增合规等级、新增错误码、新增分卷或章节 |
| **4.0.0** | 修改任一既有不变量、修改分层方向、修改核心概念、修改操作语义 |

一次发布对应一个不可变的 git 标签 `spec-<协议版本>`。本文件不因版本推进而改名：版本是标签的属性，不是文件名的属性。

附录 B 按不变量**首次引入**的协议版本分节。

### 2.2 冻结范围

本文件声明的下列内容 MUST NOT 在 3.x 系列内发生不兼容变更：

- 五个核心概念：Identity / Capability / Plugin / Binding / Lifecycle
- Discovery 的语义与操作集合
- Composition / Lifecycle 的操作语义
- 分层方向
- 全部不变量（附录 B）

### 2.3 变更流程

任何拟议变更 MUST：

1. 提交至规范仓库（Issue / RFC）
2. 明确属于 2.1 表中哪一类
3. 由至少两名独立实现者评审
4. 通过一致性测试套件验证
5. 合并入下一版本

### 2.4 勘误

`3.0.x` 允许：澄清歧义文本、修正拼写与示例与格式、补充非规范性附录。

`3.0.x` **MUST NOT**：修改不变量、修改操作语义、修改派生规则。

一条"澄清"若会使两个原本都能自称合规的实现变成只有一方合规，它改变的是语义，MUST 走 §2.3 的流程，而不是勘误。

---

## 3. 一致性与合规

### 3.1 一致性要求

**每个不变量 MUST 至少有一个对应的测试用例。**

测试由实现方提供，位于实现方的仓库。本文件不规定测试框架、语言或目录结构；它要求的是每个不变量都有一条可执行的判定，且该判定的失败能够被观察。

不适用的不变量 MUST NOT 被静默省略：要么补测试，要么在实现的一致性声明中登记为未覆盖并给出理由。

Composition Core 的不变量按下列测试类型检验；表外的分组由各层自行指定，实现 MAY 采用任何等效的判定形式：

| 不变量 | 测试类型 |
|---|---|
| ID-1 ~ ID-6 | 单元测试 |
| C-1 ~ C-6 | 单元测试 |
| P-1 ~ P-4 | 单元测试 |
| B-1 ~ B-9 | 单元测试 + 并发测试 |
| LC-1 ~ LC-6 | 状态机测试 |
| D-1 ~ D-7 | 集成测试 |
| O-1 ~ O-8 | 幂等性测试 + 并发测试 |
| CHB-1 | 结构测试 |
| BR-1 ~ BR-3 | 启动测试 |

### 3.2 一致性声明

实现声称合规时 MUST 声明：

| 字段 | 类型 | 语义 |
|---|---|---|
| `eappVersion` | `string` | 实现所覆盖到的协议版本 |
| `levels` | `string[]` | 已声明的合规等级，取值必须出自本文件定义过的等级 |
| `testSuite` | `string` | 所用一致性测试套件的标识与版本 |
| `passed` | `number` | 通过的测试用例数 |
| `total` | `number` | 测试用例总数 |

`levels` 中**只允许出现本文件定义过的等级**。第 I 部分定义 `C1`–`C8`，第 II 部分定义 `I1`–`I7`，第 IV 部分定义 `CS1`–`CS5`。State Mode 不定义等级前缀，它的覆盖度由不变量计数表达。

声明一个本文件没有定义过的等级不是扩展，是伪造合规：跨实现互通依赖这些名字，任何实现都可以自行发明名字，就等于没有名字可用。

`eappVersion` 报告的是实现**覆盖到**的协议版本。只实现 Composition Core 的实现报告 `3.0.0`，覆盖全部分卷的实现报告当前版本。两者都能满足本节的声明要求，而声明的强弱不同。

---

## 第 I 部分 Composition Core

## 4. 范围与定位

### 4.1 本文冻结什么

EaPP Composition Core 定义**插件组合语义**：

- 一个 Plugin 是什么
- 一个 Plugin 如何声明自身
- 一个 Plugin 如何暴露能力
- 两个 Plugin 如何建立关系
- 一个 Plugin 如何参与或被移出当前组合
- 可组合实体如何被发现

### 4.2 本文不冻结什么

- Interaction 语义（request / event / stream / state）
- Transport 实现（Memory / Socket / Redis / NATS / Tuple Space）
- Delivery 语义（at-most-once / at-least-once）
- Persistence / Replay
- Schema / Contract 验证
- Federation
- Encryption / Authentication 机制
- CRDT
- RPC
- `namespace` 语义

### 4.3 分层

```
Bootstrap Runtime
       ↓
EaPP Composition Core
       ↓  组合确定后，派生 ChannelRef
Interaction Layer
       ↓
Transport
```

**下层 MUST NOT 反向定义上层语义。**

---

## 5. 核心本体

EaPP Composition Core 只冻结五个概念：

```
Identity
Capability
Plugin
Binding
Lifecycle
```

Discovery 是围绕这些概念的操作集合，不是新实体。

### 5.1 关系图

```
                  Capability
                      │
                      │ exposed by
                      ▼
   Identity ────► Plugin ◄──── Lifecycle
                      │
                      │ participates in
                      ▼
                   Binding
                      │
                      │ connects two
                      ▼
                   Plugin
```

---

## 6. Identity

### 6.1 定义

**`Identity`** —— 三层身份，MUST NOT 承载版本。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `domain` | string | 是 | 命名域，例如 `com.example` |
| `id` | string | 是 | 逻辑身份，例如 `logger` |
| `instance` | string | 是 | 运行时实例，例如 `logger-7f92` |

### 6.2 语义

**Identity MUST NOT 承载版本信息。** 版本由 `Capability.version` 表达。

| 维度 | 承载者 |
|---|---|
| Who | Identity |
| Which revision | Capability.version |
| What | Capability |
| Which runtime | Identity.instance |

### 6.3 不变量

- **ID-1**：`domain` MUST NOT 为空。
- **ID-2**：`id` MUST NOT 为空。
- **ID-3**：`instance` MUST 在同一个 `(domain, id)` 内唯一。
- **ID-4**：Identity MUST 在其生命周期内保持不变。
- **ID-5**：Identity MUST NOT 由 Plugin 自身伪造。
- **ID-6**：Identity MUST NOT 包含版本语义。

---

## 7. Capability

### 7.1 定义

**`Capability`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `name` | string | 是 | 能力名 |
| `version` | string | 是 | SemVer |
| `contract` | `ContractRef` | 否 | 可选上下文 |
| `constraints` | `Constraint` 列表 | 否 | 匹配约束，语义见 `C-7` |

**`ContractRef`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `name` | string | 是 | — |
| `version` | string | 是 | — |
| `schema` | 任意值 | 否 | 契约描述；本协议不规定其格式 |

**`Constraint`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `kind` | string | 是 | 约束种类 |
| `value` | 任意值 | 是 | 约束值；匹配规则见 `C-7` |

### 7.2 语义

Capability 描述：一个 Plugin 可以参与什么类型的组合。

Capability **不等于** method list、RPC endpoint、HTTP route、函数签名。

### 7.3 与 Plugin 的关系

**一个 Plugin MAY 暴露多个 Capability。**
**一个 Capability MAY 被多个 Plugin 暴露。**

多对多。

### 7.4 CapabilityRef

**`CapabilityRef`** —— 对某个 Plugin 暴露的某个 Capability 版本的引用。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `plugin` | `Identity` | 是 | 暴露该能力的 Plugin |
| `name` | string | 是 | 能力名 |
| `version` | string | 是 | SemVer |

**版本 MUST 参与引用。** 同一 Plugin 可以同时暴露 `logging@1.0.0` 与 `logging@2.0.0`。

### 7.5 不变量

- **C-1**：`name` MUST NOT 为空。
- **C-2**：`version` MUST 是合法 SemVer。
- **C-3**：`contract` 是可选上下文。
- **C-4**：Capability MAY 被多个 Plugin 暴露。
- **C-5**：`CapabilityRef` MUST 包含 `version`。
- **C-6**：Capability version MUST 参与 Binding identity。
- **C-7**：`Constraint` 的匹配 MUST 是"`kind` 相等 **且** `value` 结构相等"。
  更丰富的匹配（范围、偏序、谓词）属于 Extension，MUST NOT 混入 Core。

**C-7 的由来**：§7.1 定义了 `Constraint { kind, value }`，§11.1 允许
`Criteria.constraints` 用它筛选，但原文本从未说过"匹配"到底指什么。
两个实现可以各自理解成"子集""范围""谓词"而都自称合规 ——
于是这里把 Core 的语义钉成最窄的一种：**精确匹配**。

> 之所以选最窄的，是因为它**可判定且无歧义**：`kind` 是字符串相等，
> `value` 是结构相等（对象按键递归、数组按序递归、否则 `Object.is`）。
> 任何比这更聪明的规则都需要一个语义协商机制，而那属于 Extension。

---

## 8. Plugin

### 8.1 定义

**`Plugin`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `identity` | `Identity` | 是 | 唯一身份 |
| `capabilities` | `Capability` 列表 | 是 | MAY 为空 |
| `lifecycle` | `LifecycleState` | 是 | 当前参与状态 |

### 8.2 语义

Plugin 是：

> 一个具有 Identity、可选地暴露 Capability、并参与 Lifecycle 的可组合实体。

Plugin 可以是：

```
in-process module · process · worker · remote service
device · runtime · transport · database · AI model
UI component · 另一个 plugin system
```

EaPP **不要求**它们具有相同的实现形态。

### 8.3 不变量

- **P-1**：每个 Plugin MUST 有唯一 Identity。
- **P-2**：Plugin 的 `capabilities` MAY be empty。
- **P-3**：Plugin Identity MUST NOT 在生命周期内改变。
- **P-4**：Capability 集合 MAY 在生命周期内变化（通过显式声明更新）。

---

## 9. Binding

### 9.1 定义

**`Binding`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `id` | string | 是 | Binding 标识 |
| `from` | `PluginRef` | 是 | 提供 Capability 的一方 |
| `to` | `PluginRef` | 是 | 消费 Capability 的一方 |
| `capability` | `CapabilityRef` | 是 | 含 version |
| `contract` | `ContractRef` | 否 | 可选上下文 |

**Binding 不含命令式 `state` 字段。**

### 9.2 Binding 的稳定语义状态

```text
ACTIVE
DORMANT
CLOSED
```

`PENDING` MAY 作为 `bind()` 内部事务状态存在，但 **MUST NOT 对外可观察**。

### 9.3 基础属性：OPEN / CLOSED

```text
OPEN    iff Binding 未被显式 unbind
CLOSED  iff Binding 已被显式 unbind
```

- `CLOSED` 是终结状态。
- `OPEN` 是基础属性，不是稳定语义状态。

### 9.4 派生规则

```
CLOSED   iff 已被显式 unbind

ACTIVE   iff OPEN
         and from.lifecycle == ACTIVE
         and to.lifecycle   == ACTIVE
         and from 仍暴露 capability

DORMANT  iff OPEN
         and ACTIVE 条件不满足
```

### 9.5 状态图

```
                 Binding
                    │
             ┌──────┴──────┐
             │             │
          CLOSED          OPEN
                           │
                    ┌──────┴──────┐
                    │             │
                 ACTIVE        DORMANT
```

### 9.6 触发源统一

| 触发源 | 结果 |
|---|---|
| `from` 进入 INACTIVE | DORMANT |
| `from` 进入 SUSPENDED | DORMANT |
| `to` 进入 INACTIVE | DORMANT |
| `to` 进入 SUSPENDED | DORMANT |
| `from` 撤回 Capability | DORMANT |
| 上述任一恢复 | ACTIVE |

**deactivate 与 suspend 对 Binding 的效果相同：进入 DORMANT。**

### 9.7 Binding / CapabilityRef 一致性

```text
Binding.capability.plugin == Binding.from
```

否则 `bind()` MUST fail with `EAPP_BINDING_INVALID`。

### 9.8 Binding 唯一性

对于同一 `(from, to, capability)`，在任意时刻最多存在一个**非 CLOSED** Binding。

**Uniqueness check + creation MUST 原子。**

并发 `bind(A,B,X) / bind(A,B,X)`：

- 最多一个创建新的非 CLOSED Binding。
- 其他请求 MUST return existing Binding 或 fail with `EAPP_BINDING_DUPLICATE`。

### 9.9 Binding 不携带交互方式

Binding MUST NOT 声明：

- 消息方向
- 同步 / 异步
- 投递保证
- 序列化格式

### 9.10 不变量

- **B-1**：`from` / `to` MUST 是已存在的 Plugin。
- **B-2**：`capability` MUST 由 `from` 暴露。
- **B-3**：Binding 状态 MUST 是派生的，MUST NOT 被直接设置。
- **B-4**：CLOSED 是终结状态。
- **B-5**：任一端 INACTIVE 或 SUSPENDED，Binding MUST 派生为 DORMANT。
- **B-6**：同一 `(from, to, capability)` 在任意时刻 MUST NOT 有多个非 CLOSED Binding。
- **B-7**：`Binding.capability.plugin` MUST equal `Binding.from`。
- **B-8**：Binding uniqueness check + creation MUST be atomic。
- **B-9**：PENDING Binding MUST NOT be externally observable。

---

## 10. Lifecycle

### 10.1 状态

```text
INACTIVE
ACTIVE
SUSPENDED
```

实现 MAY 扩展 STARTING / STOPPING / DRAINING / FAILED，但 MUST NOT 破坏 Core 语义。

### 10.2 状态转移

```
INACTIVE  --activate-->   ACTIVE
ACTIVE    --suspend-->    SUSPENDED
SUSPENDED --resume-->     ACTIVE

ACTIVE    --deactivate--> INACTIVE
SUSPENDED --deactivate--> INACTIVE
INACTIVE  --deactivate--> INACTIVE
```

### 10.3 操作语义

| 操作 | 合法源 | 结果 |
|---|---|---|
| `activate` | **INACTIVE only** | ACTIVE |
| `deactivate` | ACTIVE / SUSPENDED / INACTIVE | INACTIVE |
| `suspend` | ACTIVE only | SUSPENDED |
| `resume` | **SUSPENDED only** | ACTIVE |

**`activate` MUST NOT 用于从 SUSPENDED 恢复 Plugin。**
**从 SUSPENDED 恢复 MUST 使用 `resume`。**

### 10.4 Lifecycle 与 Binding 的关系

- Plugin 进入 INACTIVE 或 SUSPENDED：其所有 Binding 派生为 DORMANT。
- Plugin 恢复 ACTIVE：其所有 Binding 重新派生。
- `deactivate` MUST NOT 直接 CLOSE Binding。

### 10.5 SUSPENDED 语义边界

Composition Core 对 `SUSPENDED` 的定义：

> Plugin 保留 Identity 与 Binding，但不再参与 Active Composition。

**Composition Core MUST NOT 定义 Channel 的具体暂停、丢弃、缓存、排空或重新投递行为。**

### 10.6 不变量

- **LC-1**：`activate` MUST 从 INACTIVE 进入 ACTIVE。
- **LC-2**：`deactivate` MUST 从任意状态进入 INACTIVE。
- **LC-3**：`suspend` 只对 ACTIVE 有效。
- **LC-4**：`resume` 只对 SUSPENDED 有效。
- **LC-5**：SUSPENDED MUST NOT 解除 Binding。
- **LC-6**：`activate` applies only to INACTIVE；`resume` applies only to SUSPENDED。

---

## 11. Discovery

### 11.1 定义

**`Discovery`** —— 两个操作：

```
find(criteria, scope)   ->  PluginRef 列表
watch(criteria, scope)  ->  DiscoveryEvent 流
```

**`Criteria`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `capability` | string | 否 | 能力名 |
| `version` | string | 否 | SemVer range |
| `constraints` | `Constraint` 列表 | 否 | 逐条按 `C-7` 匹配 |
| `identity` | `Identity` 的字段子集 | 否 | 出现的字段相等 |

**`DiscoveryScope`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `trustLevel` | `L0` \| `L1` \| `L2` | 否 | 信任分类 |
| `trustDomain` | string | 否 | 信任域 |

**`DiscoveryEvent`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `type` | `added` \| `removed` \| `changed` | 是 | 事件种类（`D-6`） |
| `plugin` | `PluginRef` | 是 | 事件针对的 Plugin |

### 11.2 Trust Level 语义

```
L0
L1
L2
```

是 Trust / Deployment **分类**，而不是数值等级。

它们：

```
MUST NOT
```

被解释为：

```
L2 > L1 > L0
```

也不得自动推导出：

```
L2 can access L1
L1 can access L0
```

### 11.3 不变量

- **D-1**：`find` MUST 返回当前 Trust Scope 内可见的 Plugin。
- **D-2**：`watch` MUST 只对当前 Trust Scope 内的事件触发。
- **D-3**：Discovery MUST NOT 保证"发现即可组合"。
- **D-4**：Discovery MAY 缓存，但 MUST 有失效策略。
- **D-5**：Discovery MUST NOT 成为 Binding 的替代品。
- **D-6**：`DiscoveryEvent.type` MUST 是 added / removed / changed 之一。
- **D-7**：Trust level MUST NOT imply ordered authorization。

---

## 12. Composition Operations

### 12.1 语义分组

```
Discovery
├── find
└── watch

Composition
├── bind
└── unbind

Lifecycle
├── activate
├── deactivate
├── suspend
└── resume
```

> Composition Core 定义 **6 个 Composition/Lifecycle control primitives**，以及 **2 个 Discovery operations**。

### 12.2 核心接口

**`CompositionCore`** —— 8 个操作：

```
find(criteria, scope)     ->  PluginRef 列表
watch(criteria, scope)    ->  DiscoveryEvent 流
bind(request)             ->  Binding
unbind(bindingId)         ->  ()
activate(plugin)          ->  ()
deactivate(plugin)        ->  ()
suspend(plugin)           ->  ()
resume(plugin)            ->  ()
```

**`BindRequest`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `from` | `PluginRef` | 是 | 提供 Capability 的一方 |
| `to` | `PluginRef` | 是 | 消费 Capability 的一方 |
| `capability` | `CapabilityRef` | 是 | 要建立关系的 Capability |
| `contract` | `ContractRef` | 否 | 可选上下文 |

### 12.3 高阶操作（非 Core Primitive）

```
replace(old, next)              ->  ()
rewire(bindingId, next)         ->  ()
```

高阶操作由其他操作组合而成，MUST NOT 引入新的语义。

### 12.4 Composition Control vs Lifecycle Control

| 操作对象 | 操作类型 | API |
|---|---|---|
| Binding / Graph | Composition Control | `bind` / `unbind` / `rewire` |
| Plugin Instance | Lifecycle Control | `activate` / `deactivate` / `suspend` / `resume` |

### 12.5 不变量

- **O-1**：`bind` MUST 创建 Binding，状态由派生规则决定。
- **O-2**：`bind` MUST 失败，如果 `from` 未暴露目标 Capability。
- **O-3**：`unbind` MUST 将 Binding 置为 CLOSED。
- **O-4**：`unbind` MUST 幂等。
- **O-5**：`activate` MUST 幂等。
- **O-6**：`deactivate` MUST 使其所有 Binding 派生为 DORMANT。
- **O-7**：`suspend` MUST 使其所有 Binding 派生为 DORMANT。
- **O-8**：`resume` MUST 重新评估所有 Binding 的派生状态。

---

## 13. Channel 边界

### 13.1 Composition Core 只承认 ChannelRef

**`ChannelRef`** —— Composition Core 唯一可观察的 Channel 形态。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `id` | string | 是 | Channel 标识 |
| `binding` | string | 是 | 派生它的 Binding 的 `id` |

### 13.2 不属于 Composition Core 的 Channel 属性

```
request / event / stream / state
delivery guarantee
ordering
serialization
ack
lease
cursor
```

### 13.3 不变量

- **CHB-1**：Composition Core MUST NOT define Channel interaction semantics。

---

## 14. 与 Interaction / Transport 的关系

### 14.1 方向

```
Composition Core
      │ 组合确定后，派生 ChannelRef
      ▼
Interaction Layer
      │ Channel 由以下实现
      ▼
Transport
```

### 14.2 Tuple Space 的位置

```
EaPP
├── Composition Core
│
└── Interaction Layer
    └── Tuple Space
        ├── Tuple
        ├── Lease
        ├── Event
        └── Cursor
```

**Tuple Space 不是 EaPP 的本体。** Tuple Space 本身可以是一个 Plugin。

---

## 15. Bootstrap Runtime

### 15.1 定义

**`BootstrapRuntime`** —— 三个操作：

```
createIdentity(seed)        ->  Identity
loadFirstPlugin(ref)        ->  Plugin
provideInitialDiscovery()   ->  Discovery
```

`seed` 的取值由实现定义，本协议不规定其形态。

### 15.2 最小原则

Bootstrap Runtime MUST 尽可能小。MUST NOT 承担 Composition Core / Interaction Layer / Transport 的职责。

### 15.3 可替换性

一旦加载第一个 Plugin，SHOULD 允许该 Plugin 提供新的 Discovery，并逐步替换初始 Discovery。

**根可以是可替换的，但它必须先存在。**

### 15.4 不变量

- **BR-1**：Bootstrap MUST NOT 被 Plugin 替换为不存在的东西。
- **BR-2**：Bootstrap MUST NOT 依赖任何 Plugin。
- **BR-3**：Bootstrap MUST 提供至少一个初始 Discovery。

---

## 16. 冻结语义的九个问题

```text
1. Plugin 身份组成？
2. Capability 与 Plugin 关系？
3. Binding 是否要求 contract？
4. SUSPENDED 是否解除 Binding？
5. Discovery 是否保证组合？
6. Plugin 是否可被多 Binding？
7. deactivate / suspend 对 Binding 的效果？
8. activate 是否可从 SUSPENDED 恢复？
9. Binding 状态是命令式还是派生？
```

**冻结答案**：

```text
1. Identity = domain + id + instance（不含版本）
2. 多对多
3. 否，contract 可选
4. 否，只派生为 DORMANT
5. 否，发现只是必要条件
6. 是，Binding 不是独占关系
7. 均派生为 DORMANT
8. 否，从 SUSPENDED 恢复 MUST 用 resume
9. 派生；PENDING 不可观察
```

---

## 17. 合规等级

| 等级 | 要求 | 状态 |
|---|---|---|
| **C1 Core** | Identity / Capability / Plugin / Binding / Lifecycle / Discovery | MUST |
| **C2 Derived Binding** | Binding 状态派生语义 + OPEN/CLOSED 基础属性 | MUST |
| **C3 Lifecycle Closure** | activate/suspend/resume/deactivate 语义闭合 | MUST |
| **C4 Trust Scope** | DiscoveryScope 支持 trustLevel / trustDomain | SHOULD |
| **C5 Discovery Events** | DiscoveryEvent 支持 added / removed / changed | SHOULD |
| **C6 Atomic Bind** | Binding 唯一性原子语义 | SHOULD |
| **C7 Constraints** | Capability.constraints 支持 | MAY |
| **C8 Bootstrap** | Bootstrap Runtime 最小契约 | MAY |

实现 MUST 支持 C1-C3。SHOULD 支持 C4-C6。MAY 支持 C7-C8。

---

## 18. 错误模型

**`EappError`** —— 三层共用的错误对象。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `code` | string | 是 | 错误码，取值范围见附录 D |
| `message` | string | 是 | 面向人的说明 |
| `details` | 任意值 | 否 | 附加上下文，形态由产生方定义 |
| `retryable` | boolean | 否 | 重试是否有意义；缺省 `false` |

错误的构造 MUST 在实现内只定义一次，三层共用。若各层分别声明一个同名结构而不定义如何构造它，错误的产生将无从成立。

**本层错误码与它们的产生条件**：

| 错误码 | 何时返回 |
|---|---|
| `EAPP_IDENTITY_INVALID` | `domain` 或 `id` 为空（`ID-1`、`ID-2`） |
| `EAPP_IDENTITY_DUPLICATE` | 同一个 `(domain, id)` 内已存在相同的 `instance`（`ID-3`） |
| `EAPP_CAPABILITY_NOT_FOUND` | `CapabilityRef` 所指的能力在任何已注册 Plugin 上都不存在 |
| `EAPP_CAPABILITY_NOT_EXPOSED` | 该能力存在，但 `bind` 的 `from` 一方未暴露它（`O-2`、`B-2`） |
| `EAPP_PLUGIN_NOT_FOUND` | `PluginRef` 所指的 Plugin 不在当前 Trust Scope 内（`D-1`、`B-1`） |
| `EAPP_PLUGIN_INACTIVE` | 操作要求该 Plugin 处于 ACTIVE，而它处于 INACTIVE |
| `EAPP_BINDING_INVALID` | 目标 Binding 不存在（`CC-6`） |
| `EAPP_BINDING_DUPLICATE` | 已存在一个非 CLOSED 的同 `(from, to, capability)` Binding（`B-6`） |
| `EAPP_BINDING_CLOSED` | 目标 Binding 已是 CLOSED（`CC-7`） |
| `EAPP_LIFECYCLE_INVALID` | 请求的状态转移不在 `LC-1`–`LC-4` 之内（`LC-6`） |
| `EAPP_DISCOVERY_SCOPE_INVALID` | `DiscoveryScope.trustLevel` 不是 `L0` / `L1` / `L2` 之一（§11.2） |
| `EAPP_UNSUPPORTED` | 操作依赖的能力不被该 Transport 支持（`TR-9`） |
| `EAPP_INTERNAL` | 实现遇到无法归入其他任何码的失败。MUST NOT 用它替代本文件已为某种情况规定的码 |

```
ER-1  实现为一个条件返回的错误码 MUST 是本文件为该条件规定的那个码。
ER-2  每个在附录 D 中登记的错误码 MUST 在本文件中被某一条款规定其产生条件。
```

`ER-2` 由 `check:spec` 的第八条规则机械检查；`ER-1` 由实现方的测试检查。

---

## 19. 心智模型

```
                 Capability
                      │
                      ▼
Identity ─────────► Plugin
                      │
                      │ participates through
                      ▼
                    Binding
                   /       \
              ACTIVE      DORMANT
                   \       /
                    └──┬──┘
                       │
                   ChannelRef
                       │
                       ▼
                  Interaction
                       │
                       ▼
                   Transport
```

术语映射：

```
Identity    = Who
Capability  = What
Plugin      = Entity
Binding     = Relation
Lifecycle   = Participation
Discovery   = Findable
ChannelRef  = Runtime interaction reference
Interaction = How composed entities interact
Transport   = Mechanism
```

形式化：

```
Plugin Graph = (V, E)
V = Plugins
E = Bindings
```

> **EaPP Composition Core 定义一个动态 Plugin Graph，以及这个 Graph 如何被发现、建立、激活、暂停和拆除。**

---

## 20. 边界与非目标

### 20.1 明确不做

- Interaction 语义
- Transport 实现
- Delivery 语义
- Persistence / Replay
- Schema / Contract 验证
- Federation
- Encryption / Authentication 机制
- CRDT
- RPC
- 具体插件类型（UI / Logging / Config）
- `namespace` 语义

### 20.2 概念的分配

下表说明各概念归属哪一层，用于判断一个新概念是否属于本层。

| 内容 | 位置 |
|---|---|
| Tuple / Lease / Cursor / Event Plane / Delivery Semantics | Interaction Layer |
| Trust Domain | 横切 |
| Identity / Capability / Plugin / Binding / Lifecycle / Discovery | **Composition Core** |

### 20.3 已知限制

| 限制 | 影响 | 缓解 |
|---|---|---|
| Binding 粒度粗 | 复杂交互需多 Channel | Interaction Layer 用 Channel 细分 |
| Discovery 不保证组合 | 需要显式 bind | 设计选择 |
| Bootstrap 硬编码 | 一个必须的根 | 保持最小，可被 Plugin 逐步替换 |
| Trust Scope 与 Discovery 耦合 | 需显式传 scope | 显式优于隐式 |

---

## 21. 宣言

> **Plugins are entities.**
> **Capabilities define possibilities.**
> **Bindings create composition.**
> **Lifecycle defines participation.**
> **Discovery finds what can be composed.**

> **EaPP 决定关系。**
> **Interaction Layer 决定关系建立之后如何互动。**
> **Transport 决定互动如何实现。**

---

## 第 II 部分 Interaction Layer

## 22. Channel

### 22.1 定义

三种取值域：

| 名称 | 取值 |
|---|---|
| `ChannelMode` | `request` \| `event` \| `stream` \| `state` |
| `DeliveryGuarantee` | `at-most-once` \| `at-least-once` |
| `ChannelState` | `OPEN` \| `ACTIVE` \| `DRAINING` \| `CLOSED` |

**`Channel`** —— 在 `ChannelRef`（§13.1）之上增加三个字段：

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `mode` | `ChannelMode` | 是 | 交互模式；创建时显式指定（`CC-3`） |
| `delivery` | `DeliveryGuarantee` | 是 | 投递保证；省略时的推导见 `CC-4` |
| `state` | `ChannelState` | 是 | 生命周期状态 |

### 22.2 生命周期

```
OPEN --connect--> ACTIVE
OPEN --close-->   CLOSED
ACTIVE --drain--> DRAINING
ACTIVE --close--> CLOSED
DRAINING --connect-> ACTIVE      （见 §22.4：Binding 恢复时 Channel 回到服务）
DRAINING --close-> CLOSED
CLOSED --any-->   CLOSED（幂等）
```

### 22.3 不变量

```
CH-1  一个 Channel 对应恰好一个 Binding。
CH-2  Channel 生命周期 MUST NOT 超过 Binding。
CH-3  CLOSED 是终结状态。
CH-4  close() MUST 幂等。
CH-5  mode MUST NOT 在生命周期内改变。
CH-6  delivery MUST NOT 在生命周期内改变。
```

### 22.4 与 Binding 的状态同步

Channel 的生命周期不独立于它的 Binding。Binding 状态由 Composition Core **派生**
（§9.4），Channel 跟随它：

| Binding 状态 | Channel 状态 |
|---|---|
| `ACTIVE` | `OPEN` 或 `ACTIVE` |
| `DORMANT` | `DRAINING` |
| `CLOSED` | `CLOSED` |

```
CC-1  Channel MUST NOT 独立于 Binding 存在。
CC-2  Binding 进入 DORMANT 时，Channel MUST 进入 DRAINING；
      Binding 进入 CLOSED 时，Channel MUST 立即进入 CLOSED；
      Binding 恢复 ACTIVE 时，Channel MUST 回到 ACTIVE。
```

**CC-2 的第三个分句是 §22.2 里 `DRAINING --connect--> ACTIVE` 存在的理由。**
若 DRAINING 不可恢复，则"Binding 恢复时 Channel 回到服务"这条要求无法被满足。

**DORMANT ⇒ DRAINING 而不是 CLOSED**，是为了不丢弃在途消息：停止接收新消息，
等待在途完成。`deactivate` 与 `suspend` 对 Binding 的效果相同（都派生出 DORMANT），
因此对 Channel 的效果也相同。

---

## 23. 交互模式

四种模式已冻结：`request` / `event` / `stream` / `state`。
**`state` 的运行时语义由 State Mode 定义。**

一个 Channel MUST 恰好有一种模式。

### 23.1 模式消息形状

三种消息传递模式各自有一个冻结的信封。它们属于本层，上层 MUST 使用它们而不得自创形状。

**`RequestMessage`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `correlationId` | string | 是 | 关联标识，应答按它配对（`RQ-1`） |
| `operation` | string | 是 | 被请求的操作名 |
| `payload` | 任意值 | 是 | 请求体 |
| `deadline` | number | 否 | 截止时间，Unix 毫秒 |

**`ResponseMessage`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `correlationId` | string | 是 | 与请求相同 |
| `ok` | boolean | 是 | 成功与否 |
| `result` | 任意值 | 否 | `ok` 为真时的结果 |
| `error` | `EappError` | 否 | `ok` 为假时的错误 |

**`EventMessage`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `topic` | string | 是 | 事件主题 |
| `payload` | 任意值 | 是 | 事件体 |
| `headers` | 字符串到任意值的映射 | 否 | 附加头部 |

**`StreamMessage`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `cursor` | `Cursor` | 是 | 该消息在 Channel 内的位置；全局单调递增 |
| `payload` | 任意值 | 是 | 消息体 |

实现 MAY 在信封上附加自己的字段（例如方向判别符、调用方身份），
但 §23.1 已列出的字段 MUST NOT 被改名或改义。

### 23.2 不变量

```
RQ-1  每个 request MUST 有唯一 correlationId。
RQ-2  一个 request MUST 对应 0 或 1 个 response。
RQ-3  response MUST 携带与 request 相同的 correlationId。
RQ-4  deadline 到期后，request MUST 被视为超时。

EV-1  event MUST NOT 期待响应。
EV-2  event 的投递 MAY 为零次。
EV-3  event 的投递 MAY 为多次。

ST-1  消息的 cursor MUST 全局单调递增。
ST-2  消费者 MUST 通过 cursor 恢复。
ST-3  已 ack 的 cursor 之前的消息 MUST NOT 被重新投递。
ST-4  未 ack 的消息 MAY 在重连后重新投递。
```

> **RQ-2 的落点**：`response` 的第二份副本、或对已超时请求的迟到回复，
> MUST 被丢弃，MUST NOT 二次解决同一个调用。
> **RQ-4 的落点**：deadline 已过时，接收方 MUST NOT 开始执行该请求。

---

## 24. 投递语义

```
DL-1  delivery MUST 是 at-most-once 或 at-least-once。
DL-2  exactly-once MUST NOT 出现在 Core。
DL-3  at-most-once MUST NOT ack。
DL-4  at-least-once MUST ack。
DL-5  at-least-once 消费者 MUST 幂等处理。
```

**模式与投递保证的对应**：

| 模式 | 允许的 delivery |
|---|---|
| request | at-most-once, at-least-once |
| event | at-most-once, at-least-once |
| stream | **at-least-once only** |
| state | **at-least-once only** |

```
DL-6  创建 stream / state Channel 时指定 at-most-once MUST 返回 EAPP_DELIVERY_UNSUPPORTED。
```

---

## 25. Lease

**`Lease`** —— 对某个位置的一次认领。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `leaseId` | string | 是 | 认领标识 |
| `cursor` | `Cursor` | 是 | 被认领的位置 |
| `expiresAt` | number | 是 | 到期时间，Unix 毫秒 |

```
ack()         ->  ()
nack()        ->  ()
renew(ttl)    ->  ()
```

```
L-1  leaseId MUST 全局唯一。
L-2  同一 cursor 在任意时刻 MUST NOT 被多个 ACTIVE Lease 持有。
L-3  ack() MUST 幂等。
L-4  nack() MUST 幂等。
L-5  renew() 只对 ACTIVE Lease 有效。
L-6  expiresAt 到期后，cursor MAY 被其他消费者重新领取。
L-7  过期的 Lease MUST NOT 影响新 Lease。
```

---

## 26. Cursor

### 26.1 定义

**`Cursor`** —— 一个不透明字符串，在 Channel 内全局有序。它的字面形式由实现定义，消费者 MUST NOT 解析它。

**`CursorState`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `cursor` | `Cursor` | 是 | 当前位置 |
| `pending` | `Cursor` 列表 | 是 | 已收到但未 ack 的位置 |

### 26.2 锚点

位置参数需要同时表达"字面锚点"与"具体位置"，因此引入 `CursorAnchor`：

| 取值 | 语义 |
|---|---|
| `earliest` | Channel 中仍可服务的最早位置 |
| `latest` | Channel 当前头位置 |
| 一个 `Cursor` 值 | 该具体位置 |

**解析规则（MUST，消除 `'earliest'` 与 `Cursor` 的类型歧义）**：

```
1. 先比较字面量：'earliest' / 'latest'  MUST 被识别为锚点，MUST NOT 当作 Cursor 值。
2. 其余字符串 MUST 被当作 Cursor 处理。
3. 'earliest'  MUST 解析为"Channel 中仍可服务的最早位置"。
4. 'latest'    MUST 解析为 Channel 当前头位置。
5. 锚点 MUST 在订阅创建时**立即**解析（eager），MUST NOT 延迟到首次迭代。
6. 若日志已压缩到无法定位 'earliest'，MUST 返回 EAPP_CURSOR_TOO_OLD。
7. 一个**具体 Cursor** 若已被删除（早于保留起点），MUST 返回 EAPP_CURSOR_TOO_OLD，
   MUST NOT 被静默替换为保留起点。
```

**规则 7 是这条语义里最容易写错、后果也最重的一半。**
压缩不是错误，但**假装没压缩过**是：调用方传入一个已被删除的位置时，
它以为自己从中断处继续，实际读到的却是被截断的历史 ——
**中间的变更永久丢失，而它不会知道**。所以这种情况必须失败，而不是尽力而为。

由此推出保留语义的精确形状：

```
保留起点（floor） = 已被丢弃的最新位置
   位置 > floor  → 可读
   位置 = floor  → 可读（读的是 floor 之后的内容；floor 本身已丢弃）
   位置 < floor  → EAPP_CURSOR_TOO_OLD
   'earliest' / cursor === undefined → 解析为 floor（TR-6「最早已保留位置」）
```

Transport 的 `stateRetention` 能力声明（§46.1）MUST 与实际行为一致：
声明 `unbounded` 就 MUST NOT 丢任何位置，声明 `window` 就 MUST 遵守上面这张表。

### 26.3 不变量

```
CR-1  Cursor MUST be globally ordered within Channel.
CR-2  Cursor MUST be persistable and recoverable.
CR-3  Cursor MUST NOT skip unacked messages implicitly.
CR-4  Resume MUST continue from cursor.
CR-5  If Transport does not support cursor, MUST return EAPP_CURSOR_UNSUPPORTED.
```

### 26.4 推进规则

位置如何推进，由 `ack` 唯一决定：

```
ack(c)   MUST 将 cursor 置为 max(当前 cursor, c)
nack()   MUST NOT 推进 cursor；该项回到可用，并在下一次迭代重新投递
```

**CR-3 禁止的是隐式跳过** —— cursor 随"收到消息"自动前移。
**显式 ack 一个更靠后的位置、因而放弃中间未 ack 的项，MUST 被允许**：
"已确认到此处"就是这个意思，而恢复语义正建立在这上面。

**任何"只推进到第一个未 ack 项之前"的实现 MUST 被视为违反本节。**
它看起来更保守，代价却是让一个掉队的位置永久压住整个消费者的进度 ——
而 §28.3 明确禁止先用"最小未了结位置"替代组游标，理由是同一个。

---

## 27. Subscription

### 27.1 定义

**`SubscriptionMode`**

| 取值 | 语义 |
|---|---|
| `exclusive` | 默认。每个订阅持有独立 cursor，收到全部匹配项 |
| `group` | 同 group 的订阅共享一个 cursor，竞争消费 |

`SubscriptionState` 的取值为 `ACTIVE` \| `SUSPENDED` \| `CLOSED`。

**`SubscriptionOptions`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `mode` | `SubscriptionMode` | 否 | 默认 `exclusive` |
| `group` | string | 否 | `mode` 为 `group` 时 MUST 指定 |
| `cursor` | `CursorAnchor` | 否 | 默认 `latest` |

**`Subscription`** —— 一个消费单元 `T` 的序列。

| 成员 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `id` | string | 是 | 订阅标识 |
| `channel` | string | 是 | 所属 Channel |
| `mode` | `SubscriptionMode` | 是 | 消费模式 |
| `cursor` | `Cursor` | 是 | 当前位置；MUST 非 undefined（`SUB-9`） |
| `state` | `SubscriptionState` | 是 | 订阅状态 |
| `suspend()` | 操作 | 是 | 停止投递 |
| `resume()` | 操作 | 是 | 从当前位置继续 |
| `close()` | 操作 | 是 | 终止序列 |

`T` MUST 是携带 `AckContext` 的消费单元。对 State 模式，`T` 即 State Mode 的 `StateUpdateEvent`。

### 27.2 语义

| 操作 | 语义 |
|---|---|
| `suspend()` | 停止投递；已 yield 未 ack 的项仍然有效 |
| `resume()` | 从当前 cursor 继续；MUST NOT 重投已 ack 的项 |
| `close()` | 终止迭代（挂起的 `next()` resolve 为 `done`）；`close()` 幂等 |

### 27.3 不变量

```
SUB-1  Subscription MUST NOT 独立于 Channel 存在。
SUB-2  Subscription MUST 有独立 cursor（mode === 'exclusive'）。
SUB-3  Subscription MUST NOT 影响同 Channel 的其他 exclusive 订阅。
SUB-4  mode === 'group' 时 group MUST 非空。
SUB-5  suspend() 之后 MUST NOT 继续投递，直到 resume()。
SUB-6  close() MUST 幂等。
SUB-7  close() 之后 MUST NOT 再投递。
SUB-8  close() 之后对已 yield 项调用 ack() MUST 为 no-op（MUST NOT 抛错、MUST NOT 改变 cursor）。
SUB-9  cursor MUST 在 Subscription 创建返回前被解析为非 undefined 值。
```

---

## 28. ConsumerGroup

### 28.1 语义

Subscription 回答"谁在参与"，**ConsumerGroup 回答"谁和谁在竞争"**。

```
同一 Channel 上可以有多个 ConsumerGroup。
组之间：每个组都收到全部消息，各自持有独立 Cursor。
组之内：每条消息只交给一个成员 —— 成员之间竞争。
```

这是"可靠竞争消费"的**命名作用域**。§25 的 Lease 提供"临时所有权"这一机制，
ConsumerGroup 则规定这份所有权**在哪一组消费者之间竞争**。

### 28.2 定义

**`ConsumerGroup`**

| 成员 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `id` | string | 是 | 组标识 |
| `name` | string | 是 | 在同一 Channel 内唯一 |
| `channel` | string | 是 | 所属 Channel |
| `cursor` | `Cursor` | 是 | 组共享位置，MUST 唯一 |
| `memberCount` | number | 是 | 当前成员数 |
| `close()` | 操作 | 是 | 关闭组 |

**`ConsumerGroupOptions`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `name` | string | 是 | 组名 |
| `claimTtlMs` | number | 否 | 一个成员可以持有一次 claim 多久；超时后该位置归还给组。默认 30000 ms。MUST 大于 0 |

成员身份通过既有的 `SubscriptionOptions` 表达，不引入新的订阅类型：

```
subscribe(channel, pattern, { mode: 'group', group: 'workers' })
```

### 28.3 与 Lease / Cursor 的关系

```
一次 claim 就是一次 Lease。
  → §25 的 L-2（同一 cursor 不被两个 ACTIVE Lease 持有）就是 CG-3 的机制保证。
  → 组不需要重新发明排他性。

组 Cursor = 组内已 ack 位置的最大值。
  → 与 §26.4 一致：一个成员 ack 一个更靠后的位置，
    即声明"它之前的位置都已了结"，中间未 ack 的项被显式放弃。
  → 这是一次**显式**跳过，不违反 CR-3（CR-3 禁止的是隐式前移）。
```

**实现 MUST NOT 用"最小未了结位置"替代组 Cursor。** 那会让一个掉队的成员
永久拖住整个组的位置，且与 §26.4 已冻结的语义冲突。

### 28.4 不变量

```
CG-1  ConsumerGroup.name MUST 在同一 Channel 内唯一。
CG-2  一个 ConsumerGroup 的所有成员 MUST 共享恰好一个 Cursor。
CG-3  一条消息在同一时刻 MUST NOT 被同一组的多个成员同时持有。
CG-4  同一 Channel 上的不同 ConsumerGroup MUST NOT 互相影响各自的 Cursor。
CG-5  一个成员离开 MUST NOT 使该组停滞。
CG-6  被 nack 或 claim 超时的位置 MUST 重新对该组可用。
CG-7  ConsumerGroup MUST NOT 独立于其 Channel 存在。
CG-8  mode === 'group' 的 Subscription MUST 指名同一 Channel 上的一个 ConsumerGroup。
```

---

## 29. Ack / Nack / NackContext

**`AckContext`** —— 每个消费单元携带的确认句柄：

```
ack()    ->  ()
nack()   ->  ()
```

| 操作 | 效果 |
|---|---|
| `ack()` | 项被确认，cursor 推进到该项位置（取 max） |
| `nack()` | 项被拒绝，回到可用；cursor **不前移** |

```
AK-1  ack() MUST 幂等。
AK-2  nack() MUST 幂等。
AK-3  ack() 之后 MUST NOT 允许 nack()。
AK-4  nack() 之后 MUST NOT 允许 ack()。
AK-5  对已终结的 AckContext 再次调用 MUST 返回 EAPP_LEASE_CLOSED。
```

---

## 30. Transport

### 30.1 接口

**`TransportMessage`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `cursor` | `Cursor` | 是 | 该消息在 Channel 内的位置 |
| `payload` | 任意值 | 是 | 消息体 |

**`Transport`**

| 成员 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `id` | string | 是 | Transport 标识 |
| `capabilities` | `TransportCapabilities` | 是 | 能力声明 |
| `send(channel, msg)` | 操作，结果为 `Cursor` | 是 | 发送一条消息；Transport 负责分配 cursor |
| `readAfter(channel, cursor, pattern)` | 操作，结果为 `TransportMessage` 列表 | 是 | 返回 cursor 之后、匹配 pattern 的消息，按 cursor 升序 |
| `close()` | 操作 | 是 | 关闭 |

**`Pattern`**

| 取值 | 语义 |
|---|---|
| `{ all: true }` | 匹配全部消息 |
| `{ type: string }` | 匹配给定类型 |

`readAfter` 的 `cursor` 参数 MAY 为"未提供"，含义见 `TR-6`。

**语义约束**：

```
TR-5  readAfter MUST 只返回 cursor **严格大于**参数的消息。
TR-6  cursor === undefined MUST 解释为"从最早已保留位置开始"。
TR-7  readAfter 无匹配时 MUST 返回空数组，MUST NOT 阻塞。
TR-8  send 返回的 cursor MUST 在该 Channel 内严格大于此前所有 cursor。
```

### 30.2 能力声明

**`TransportCapabilities`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `persistent` | boolean | 是 | 是否跨进程存活 |
| `ordering` | `none` \| `per-source` \| `global` | 是 | 顺序保证的范围 |
| `delivery` | 见下 | 是 | 投递能力 |
| `supportsCursor` | boolean | 是 | 是否支持位置 |
| `supportsLease` | boolean | 是 | 是否支持认领 |
| `durabilityBoundary` | `process` \| `machine` \| `cluster` \| `global` | 是 | 持久化边界的可见范围 |

`delivery` 的三个字段：`atMostOnce`、`atLeastOnce`、`replay`，均为 boolean。

### 30.3 能力矩阵

| Transport | persistent | ordering | atLeastOnce | replay | cursor | lease | durabilityBoundary |
|---|---|---|---|---|---|---|---|
| Memory | ❌ | global | ✅ | ❌ | ✅ | ✅ | process |
| Socket | ❌ | per-source | ✅ | ❌ | ✅ | ✅ | machine |
| Redis Streams | ✅ | global | ✅ | ✅ | ✅ | ✅ | cluster |
| NATS JetStream | ✅ | global | ✅ | ✅ | ✅ | ✅ | cluster |
| NATS Core | ❌ | per-source | ❌ | ❌ | ❌ | ❌ | machine |

### 30.4 不支持时的处理

```
TR-1  Transport MUST NOT 定义 Interaction 语义。
TR-2  Transport MUST 声明自己的能力。
TR-3  Transport MUST NOT 伪装支持。
TR-4  Channel MUST NOT 使用超出 Transport 能力的特性。
TR-9  不支持时 MUST 返回 EAPP_UNSUPPORTED；不支持 cursor 时 MUST 返回 EAPP_CURSOR_UNSUPPORTED。
```

---

## 31. 与 Composition Core 的接口

**Composition Core → Interaction Layer**（Binding 状态变化时通知）

```
onBindingCreated(binding)   ->  ChannelRef
onBindingActive(binding)    ->  ()
onBindingDormant(binding)   ->  ()
onBindingClosed(binding)    ->  ()
```

**Interaction Layer → Composition Core**

```
channelRef(id)     ->  ChannelRef
channelState(id)   ->  ChannelState
```

---

## 32. Channel 创建路径

`Channel MUST 由 Binding 派生`是一条原则；原则需要一条可执行的路径才可检查。State Mode 还需要从一个既有的 `binding` 出发构造 Channel。本节给出这条路径。

**`InteractionLayer`**

```
createChannel(request)   ->  Channel
channel(id)              ->  Channel，不存在时为"未找到"
channelRef(id)           ->  ChannelRef
channelState(id)         ->  ChannelState
```

`createChannel` 的 `binding` MUST 是已存在且未被 CLOSED 的 Binding。

**`CreateChannelRequest`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `binding` | string | 是 | `Binding.id`，来自 Composition Core 的 `bind()` |
| `mode` | `ChannelMode` | 是 | MUST 由调用方显式指定（`CC-3`） |
| `delivery` | `DeliveryGuarantee` | 否 | 省略时按 §24 推导 |

**规则**：

```
CC-1  Channel MUST NOT 独立于 Binding 存在。（见 §22.4）
CC-2  Binding 状态变化时 Channel 的跟随规则。（见 §22.4）
CC-3  mode MUST 由调用方显式指定。
CC-4  delivery 省略时：stream / state 推导为 'at-least-once'；其余推导为 'at-most-once'。
CC-5  stream / state 指定 'at-most-once' MUST 返回 EAPP_DELIVERY_UNSUPPORTED。
CC-6  binding 不存在 MUST 返回 EAPP_BINDING_INVALID。
CC-7  binding 已 CLOSED MUST 返回 EAPP_BINDING_CLOSED。
CC-8  Channel 创建后处于 OPEN；connect() 后进入 ACTIVE。
CC-9  一个 Binding MAY 派生多个 Channel，各自 mode 不同。
```

**State Channel 的三段式路径**：

```
① bind(from, to, capability)                     → Binding        （Composition Core §12.2）
② createChannel({ binding, mode: 'state',
                  delivery: 'at-least-once' })   → Channel        （本层 §32）
③ configure(channel, { conflictPolicy: 'cas',
                       owner })                  → StateChannel   （State Mode §44.1）
```

---

## 33. 错误模型

错误对象的形状与其构造规则见 §18。各层的 code 联合按层扩展，MUST NOT 重命名或改义既有码。

**本层错误码与它们的产生条件**：

| 错误码 | 何时返回 |
|---|---|
| `EAPP_CHANNEL_INVALID` | 目标 Channel 不存在，或不是本层创建的 Channel（`CC-1`、`SUB-1`） |
| `EAPP_CHANNEL_CLOSED` | Channel 已是 CLOSED，而该操作要求它未关闭（`CH-3`） |
| `EAPP_CHANNEL_DRAINING` | Channel 处于 DRAINING，而该操作属于新工作（§22.4） |
| `EAPP_MODE_INVALID` | 操作与 `Channel.mode` 不匹配（`RQ-1`、`EV-1`、`ST-1`） |
| `EAPP_DELIVERY_UNSUPPORTED` | 给 stream / state Channel 指定 `at-most-once`（`DL-6`、`CC-5`） |
| `EAPP_CURSOR_INVALID` | 位置参数既不是 `earliest` / `latest`，也不是本 Transport 签发的位置（§26.2） |
| `EAPP_CURSOR_UNSUPPORTED` | Transport 不支持位置（`CR-5`） |
| `EAPP_CURSOR_TOO_OLD` | 请求的位置早于保留起点（§26.2 规则 6、规则 7） |
| `EAPP_SUBSCRIPTION_INVALID` | 订阅构造参数非法：`mode` 不在取值域内，或 `mode` 为 `group` 而 `group` 为空（`SUB-4`） |
| `EAPP_LEASE_EXPIRED` | 操作针对一个已过期的认领（`L-6`） |
| `EAPP_LEASE_CLOSED` | 操作针对一个已终结的 `AckContext`（`AK-5`） |
| `EAPP_LEASE_CONFLICT` | 该位置已被另一个 ACTIVE Lease 持有（`L-2`） |
| `EAPP_TIMEOUT` | 请求的截止时间到达（`RQ-4`、`OP-5`） |
| `EAPP_UNSUPPORTED` | 见 §18 |
| `EAPP_INTERNAL` | 见 §18 |

---

## 34. 合规等级

| 等级 | 要求 | 状态 |
|---|---|---|
| **I1 Channel** | Channel 生命周期 + 四种模式 | MUST |
| **I2 Delivery** | at-most-once / at-least-once | MUST |
| **I3 Lease** | 可靠竞争消费 | SHOULD |
| **I4 Cursor** | 可恢复观察 | SHOULD |
| **I5 Transport Capability** | 能力声明与检查 | MAY |
| **I6 Subscription** | 独立 cursor 的异步订阅 | MUST（I1 的组成部分） |
| **I7 ConsumerGroup** | 命名竞争消费作用域（§28） | SHOULD |

> **I4 的等级与 state 模式的冲突已裁定**：状态模式必须依赖 Cursor 语义，
> 因此**承载 state / stream Channel 的实现 MUST 满足 I4**，
> 即使它在其它模式下只声明 SHOULD。

---

## 第 III 部分 State Mode

## 35. 范围与定位

### 35.1 State Mode 解决什么

Interaction Layer 冻结的四种模式中，前三种都是**消息传递**：

```
request / event / stream  →  一个参与者如何向另一个参与者发送信息？
state                     →  多个参与者如何共享、观察、修改同一份状态？
```

### 35.2 非目标

State Mode **不是**数据库、CRDT 协议、消息队列或缓存。
它是：**一种最小的、可观察的、带版本的状态共享语义。**

### 35.3 分层位置

```
Composition Core（Composition Core）        Who composes with whom
    ↓
Interaction Layer（Interaction Layer）       How composed parties interact
    ├── request / event / stream
    └── state                   ← 本层定义其语义
    ↓
Transport
```

**State Mode 是 Channel 的第四种 mode。它不是新层。**

`'state'` **早已是 ChannelMode 的既有成员**（§22.1）。
本版本 MUST NOT 修改 `ChannelMode`。

---

## 36. 核心本体

```
StateCell        带版本的状态单元
Revision         状态日志的位置（= Interaction Layer Cursor）
StateWatcher     状态观察者（Interaction Layer Subscription 的子类型）
StateUpdate      一次状态变更请求
StateChange      一条已提交的变更记录（日志条目）
```

### 36.1 因果链

```
Channel (mode = 'state', delivery = 'at-least-once')
    │
    ▼
StateCell ──── Revision ──── StateChange（日志）
    │
    └── StateWatcher ──── Cursor
```

### 36.2 Revision 与 Cursor 的关系（核心裁定）

```
Revision = Channel 内状态日志的位置
Cursor   = §26.1：消费者已确认消费到的位置
```

**裁定**：二者是**同一域上的同一类型**，都是 `string`，都在 Channel 内全局有序。
因此：

```
1. 每次写入 MUST 在 Channel 日志尾部追加一条 StateChange，并获得新位置。
2. 该位置即是本次写入的 Revision。
3. 该位置即是可用的 Cursor。
4. REV-1 / REV-2 / REV-4 与 Interaction Layer 的 CR-1 是同一条规律。
5. REV-7 不再是"例外"，而是 CR-1 的推论。
6. REV-6 自动成立：request / event / stream 没有 Revision 这一概念，谈不上混用。
```

**MUST NOT** 把 Revision 实现为 per-cell 的独立计数器 —— 那样它既不是全序，
也无法充当 Cursor，任何"从某位置之后读取变更"的操作都将无从实现。

---

## 37. Revision

**`Revision`** —— 一个不透明标识，在 `(Transport, Channel)` 内唯一且全序。它的字面形式由 Transport 定义。

### 37.1 语义

```
REV-1  Revision MUST be monotonic within a Channel.
REV-2  New revision MUST be greater than the current head.
REV-3  Revision MUST be assigned by the Transport.
REV-4  Revision MUST NOT roll back within a Channel.
REV-5  Revision MUST be opaque to consumers.
REV-6  Revision MUST NOT be used as Cursor in Interaction Layer modes other than state.
REV-7  Revision MAY be used as Cursor in State Mode.
REV-8  Revision MUST NOT be compared across Transports.
```

### 37.2 比较

**Consumer MUST NOT 直接比较 Revision 字符串。** 比较 MUST 由 Transport 提供：

```
compareRevision(a, b)   ->  负数表示 a 在前，0 表示相等，正数表示 a 在后
```

若 `a` 或 `b` 不是本 Transport 实例签发的值，MUST 返回 `EAPP_REVISION_INVALID`（`REV-8`）。

### 37.3 分配

```
nextRevision(channel)   ->  Revision
```

`nextRevision` **预留**一个位置；随后 `writeStateWithRevision` 必须使用它。
`writeStateWithRevision` 收到一个 `<= head` 的 revision 时 MUST 抛 `EAPP_REVISION_INVALID`。

---

## 38. StateCell

**`StateCell`** —— 一个键在某一位置的取值。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `key` | string | 是 | 键 |
| `revision` | `Revision` | 是 | 最后一次写入的日志位置 |
| `value` | 任意值 | 是 | 可序列化；`deleted` 为真时 MUST 为 undefined |
| `deleted` | boolean | 是 | 逻辑删除标记 |
| `updatedAt` | number | 是 | 最后一次写入时间，Unix 毫秒 |
| `updatedBy` | `Identity` | 是 | 最后一次写入者（§6.1） |

### 38.1 不变量

```
SC-1  key MUST NOT 为空。
SC-2  revision MUST 单调递增（在 Channel 内）。
SC-3  deleted = true MUST 保留 revision（MUST NOT 重置计数器）。
SC-4  value MUST 可序列化；该约束只适用于 deleted === false 的 cell。
SC-5  updatedBy MUST 是已存在的 Identity。
```

### 38.2 可见性

```
SC-6  get / list MUST 返回已逻辑删除的 cell（deleted === true），
      MUST NOT 因 deleted 而返回 null。
      只有当 key **从未存在**时，get 才返回 null。
```

**理由**：`DEL-5` 的 no-op 分支要求调用方能够拿出已删除 cell 的 `revision`；
若 `get` 对已删除返回 `null`，该分支永远不可达，`DEL-6` 的复活也无从携带 revision。

---

## 39. StateUpdate 与 CAS

### 39.1 定义

**`StateUpdate`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `key` | string | 是 | 键 |
| `value` | 任意值 | 否 | 新值；"存在性"按属性存在判定 |
| `deleted` | boolean | 否 | 逻辑删除；出现时 MUST 为 true |
| `expectedRevision` | `Revision` 或 `null` | 是 | CAS 的期望位置，取值见下 |
| `actor` | `Identity` | 否 | 省略时回落到 Channel 的 owner |

`expectedRevision` 的两种取值：

```
null       → key MUST NOT 曾经存在
Revision   → key MUST 存在，且其 revision MUST 精确匹配
```

### 39.2 CAS 语义

```
expectedRevision === null
    key 从未存在           → 成功
    key 存在（含已删除）   → EAPP_REVISION_CONFLICT

expectedRevision is Revision
    key 不存在             → EAPP_REVISION_CONFLICT
    revision 不匹配        → EAPP_REVISION_CONFLICT
    revision 匹配          → 成功
```

**`null` 是唯一表示"不存在"的方式。MUST NOT 使用 `''` / `'0'` / `-1`。**
**`null` 表示"从未存在"，MUST NOT 用它复活一个已逻辑删除的 key**（复活须携带旧 revision）。

### 39.3 字段校验

```
SU-1  StateUpdate MUST specify key.
SU-2  StateUpdate MUST have a 'value' property or set deleted = true.
      'value' 的存在性 MUST 按属性存在判定，MUST NOT 用 value !== undefined 判定。
      （因此 { value: undefined } 是合法写入，有明确语义。）
SU-3  MUST NOT 同时携带 'value' 与 deleted = true → EAPP_STATE_VALUE_INVALID。
SU-9  deleted 出现时 MUST 为 true；deleted === false → EAPP_STATE_VALUE_INVALID。
```

### 39.4 原子性

```
SU-7  CAS check + write MUST be atomic in Transport.
SU-8  expectedRevision MUST be Revision | null.
SU-4  CAS 失败 MUST 返回 EAPP_REVISION_CONFLICT。
SU-5  CAS 失败 MUST NOT 修改任何状态。
```

### 39.5 无条件写入

```
SU-6  Core MUST NOT 对外暴露无条件写入。
      Transport MAY 提供 revision 钉定的内部写入原语（writeStateWithRevision），前提是：
        (a) 收到 <= head 的 revision 时 MUST 抛 EAPP_REVISION_INVALID；
        (b) MUST NOT 从 StateChannel 的公开 API 可达，唯一例外是 restore()。
```

---

## 40. 删除

### 40.1 删除是一等原语

```
delete MUST 由 Transport 的一等原语实现，
MUST NOT 被实现为 set({ deleted: true }) 的语法糖。
```

**理由**：若把 `delete()` 实现为 `set({deleted:true})`，Transport 将无法区分"删除"与"创建"，
`EAPP_STATE_KEY_NOT_FOUND` **结构上不可产生**，而 DEL-4 与 §48 要求该码存在。

### 40.2 边界情况

| key 当前状态 | `expectedRevision` | 结果 |
|---|---|---|
| 从未存在 | `null` | `EAPP_STATE_KEY_NOT_FOUND` |
| 从未存在 | `Revision` | `EAPP_REVISION_CONFLICT` |
| 存在，未删除（rev = r） | `null` | `EAPP_REVISION_CONFLICT` |
| 存在，未删除（rev = r） | `r` | 成功；分配新 revision；产生 `deleted` 变更 |
| 存在，未删除 | `r' ≠ r` | `EAPP_REVISION_CONFLICT` |
| 已删除（rev = r） | `null` | `EAPP_REVISION_CONFLICT` |
| 已删除（rev = r） | `r` | **no-op 成功** |
| 已删除 | `r' ≠ r` | `EAPP_REVISION_CONFLICT` |

### 40.3 no-op 语义

```
删除一个"已删除"的 key 且 revision 匹配时：
  MUST NOT 分配新 revision
  MUST NOT 产生 type='deleted' 变更
  MUST NOT 通知 StateWatcher
```

### 40.4 返回值

```
delete 的返回值 MUST 恒等于操作完成后 key 的当前 revision。
  → 成功删除：返回新 revision
  → no-op：   返回旧 revision
```

### 40.5 不变量

```
DEL-1  delete MUST perform CAS.
DEL-2  A successful delete MUST produce a type='deleted' change.
       Exception: a no-op delete (§40.3) MUST NOT produce a change.
DEL-3  StateWatcher MUST receive deleted changes.
DEL-4  delete with expectedRevision = null on a key that has never existed
       MUST return EAPP_STATE_KEY_NOT_FOUND.
DEL-5  delete of an already-deleted key with a matching revision MUST be a no-op success.
DEL-6  delete followed by set MUST increment the revision and clear the deleted flag.
```

---

## 41. StateWatcher

### 41.1 定义

**`StateWatcher`** —— 在 `Subscription` 之上收窄为状态变更。

| 成员 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `kind` | `state` | 是 | 标识 State Mode |
| `mode` | `SubscriptionMode` | 是 | §27.1 的取值；MUST NOT 被覆盖为 `state` |
| `pattern` | `StatePattern` | 是 | 该 watcher 观察的范围 |

**`StateUpdateEvent`** —— 每个变更同时是一个可确认的消费单元（`AckContext`）。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `type` | `set` \| `deleted` | 是 | 变更种类 |
| `key` | string | 是 | 键 |
| `revision` | `Revision` | 是 | 变更位置 |
| `value` | 任意值 | 否 | 当且仅当 `type` 为 `set` |

### 41.2 消费接口

消费方按序列取得变更，逐个确认：

```
循环取得 update：
  应用 update
  成功  → 确认 update（无参数）
  失败  → 拒绝 update（无参数）
```

**MUST NOT** 把确认写成 `确认(watcher, update)` 这种由 watcher 代收的形式。
**MUST NOT** 只提供确认而不提供拒绝 —— 只提供其一的类型不是合法的 `AckContext`。

### 41.3 ack / nack 语义

```
ack()   MUST 将 cursor 置为 max(cursor, 本变更的 revision)
nack()  MUST NOT 推进 cursor；该变更 MUST 在下一次迭代重新投递
```

**MUST NOT 引入 `pending` 结构。** "只推进到第一个未 ack 项之前"与 §26.4
"ack 一个更新的 cursor 意味着放弃中间未 ack 的消息"直接冲突。
CR-3 禁止的是**隐式**跳过；显式 ack 更靠后的位置并放弃中间项是允许的。

### 41.4 初始位置

**`WatchOptions`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `cursor` | `CursorAnchor` | 否 | 默认 `latest` |
| `mode` | `SubscriptionMode` | 否 | 默认 `exclusive` |
| `group` | string | 否 | `mode` 为 `group` 时 MUST 指定 |
| `pollIntervalMs` | number | 否 | 无 `waitForChange` 时的轮询间隔，默认 50，MUST 大于 0 |

```
1. cursor 省略          → 等价于 'latest'
2. 'latest'             → 创建时刻的 head(channel)
3. 'earliest'           → 仍可服务的最早位置
4. Cursor               → 该位置之后
5. 锚点 MUST 在 watch() 返回之前解析完成（eager）
6. 因此 watch() 返回后 watcher.cursor MUST 非 undefined（Interaction Layer SUB-9）
```

把 cursor 留成"尚未解析"、指望"Transport 在首次迭代时提供当前位置"，
会使 `SW-1` 与 `SUB-9` 的要求必然无法满足：
锚点在 `watch()` 返回之前已经可以求值，不存在延迟解析的理由。

### 41.5 变更发现

```
waitForChange(channel, cursor, signal)   ->  ()
```

此操作**可选**：阻塞直到 `cursor` 之后出现变更，或 `signal` 被中止。
Transport 不提供它时，StateWatcher MUST 以 `WatchOptions.pollIntervalMs` 轮询。
**MUST NOT 无等待忙轮询。**

### 41.6 不变量

```
SW-1  StateWatcher MUST implement Interaction Layer Subscription.
SW-2  StateWatcher MUST have kind = 'state'.
SW-3  StateWatcher MUST NOT override Subscription.mode.
SW-4  StateWatcher MUST have an independent cursor when mode === 'exclusive'.
SW-5  StateWatcher MUST NOT affect other StateWatchers.
SW-6  ack() and nack() MUST NOT take parameters.
SW-7  ack() MUST NOT modify any StateCell.
SW-8  StateWatcher MUST receive deleted changes.
SW-9  StateWatcher's default initial position MUST be 'latest'.
SW-10 StateWatcher MUST implement the full Interaction Layer AckContext (ack + nack).
SW-11 close() MUST be idempotent; after close() no further delivery occurs.
SW-12 ack() / nack() invoked after close() MUST be a no-op and MUST NOT throw.
```

---

## 42. StatePattern

**`StatePattern`**

| 取值 | 语义 |
|---|---|
| `{ key: string }` | 精确匹配 |
| `{ prefix: string }` | 前缀匹配 |
| `{ all: true }` | 全部 |

**校验（MUST 逐字段，MUST NOT 只检查属性名）**：

```
合法：{ key: <非空 string> } | { prefix: <string> } | { all: true }
非法（MUST 返回 EAPP_STATE_PATTERN_INVALID）：
  属性数量 ≠ 1
  属性名不在 { key, prefix, all }
  { all: false } / { all: 1 }
  { key: '' }
  同时出现 key 与 prefix
```

---

## 43. Snapshot / Restore

### 43.1 定义

**`StateSnapshot`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `channel` | string | 是 | 快照来源 Channel |
| `pattern` | `StatePattern` | 是 | 本快照的选择范围 |
| `cells` | `StateCell` 列表 | 是 | 范围内的 cell |
| `maxRevision` | `Revision` | 是 | 读取 cells **之前**观察到的 Channel 头位置 |
| `takenAt` | number | 是 | 生成时间，Unix 毫秒 |

### 43.2 一致性（去循环化）

```
snapshot MUST 按此顺序执行：
  ① P := head(channel)                    ← 先取日志头
  ② cells := listState(channel, pattern)，过滤到 revision <= P
  ③ maxRevision := P

MUST NOT 从 cells 归约推导 maxRevision。
```

**理由**：若 `cells` 与 `maxRevision` 来自同一次读取，`cell.revision <= maxRevision`
是**恒真式**，Transport 可以返回任意不一致的 cell 集合而"满足" `SNAP-1`。
把 head 的读取放到 cell 读取**之前**，打开一个真实的竞态窗口，
使该不变量**可被违反、因而可被测试**。

以"空值"作归约种子同样不可用：零匹配时 `maxRevision` 会是一个没有任何 Transport
能比较的非法值，违反 `SNAP-2`。

```
SNAP-1  Every returned cell's revision MUST be <= maxRevision, and maxRevision MUST be
       the channel head observed BEFORE the cell read.
SNAP-2  snapshot MUST include maxRevision.
SNAP-3  snapshot MUST NOT claim linearizability.
```

### 43.3 Restore

```
restore(snapshot, options)   ->  ()
```

`options.mode` 取 `merge` 或 `replace`，默认 `merge`。

| 模式 | 语义 |
|---|---|
| `merge` | 快照内每个 cell 分配**新 revision** 并写入；范围外的 cell 不动 |
| `replace` | 先 `merge`，再把 `snapshot.pattern` 范围内、不在快照中的 cell 全部逻辑删除 |

```
SNAP-4  restore MUST NOT roll back revisions.
SNAP-5  restore MUST assign new revisions to all restored cells.
SNAP-6  restore MUST preserve relative ordering.
SNAP-7  restore MUST be the ONLY public path to an unconditional write (§39.5b).
SNAP-8  restore MUST append a change for every write it performs; watchers MUST observe them.
SNAP-9  restore MUST reject a snapshot whose channel differs from the target:
        EAPP_SNAPSHOT_INVALID.
```

**`restore` 只写不删**，与 API-8"MUST overwrite current state"的两种读法并存；
显式 `mode` 消除该歧义。

### 43.4 Transport 层不再提供 restore

```
MUST NOT 在 StateTransport 上提供 restoreState。
restore MUST 在 StateChannel 层唯一实现，由 nextRevision + writeStateWithRevision
+ deleteStateWithCAS 组合而成。
```

**理由**：若 `StateTransport` 与 `StateChannel` 都提供 restore 入口，
两者的关系未定义，同一份快照可能被写入两次。

---

## 44. StateChannel API

### 44.1 创建

```
① bind(from, to, capability)                          ->  Binding        （Composition Core §12.2）
② createChannel({ binding, mode: 'state',
                  delivery: 'at-least-once' })        ->  Channel        （§32）
③ configure(channel, { conflictPolicy: 'cas',
                       owner })                       ->  StateChannel   （本节）
```

```
configure MUST 校验：
  channel.mode === 'state'                 否则 EAPP_MODE_INVALID
  channel.delivery === 'at-least-once'     否则 EAPP_DELIVERY_UNSUPPORTED
  transport.capabilities.supportsState     否则 EAPP_STATE_UNSUPPORTED
  config.conflictPolicy === 'cas'          否则 EAPP_UNSUPPORTED
  config.owner 是已注册 Identity           否则 EAPP_STATE_ACTOR_REQUIRED
```

### 44.2 接口

**`StateChannel`** —— 在 `Channel` 之上增加状态操作：

```
get(key)                                  ->  StateCell 或 null
list(pattern)                             ->  StateCell 列表
set(update)                               ->  Revision
delete(key, expectedRevision, options)    ->  Revision
watch(pattern, options)                   ->  StateWatcher
snapshot(pattern)                         ->  StateSnapshot
restore(snapshot, options)                ->  ()
```

`delete` 的 `options` 与 `restore` 的 `options` 各自 MAY 省略，省略时的含义见 §43.3 与 §40。

> **`watch` 的结果在返回之前完成解析。** 契约同时要求初始 cursor 是**具体位置**（`SUB-9` / `SW-9`），
> 而解析 `'latest'` 需要读取 Channel 头位置，这是一次读取操作。
> 若返回时 cursor 尚未解析，`SW-1` 与 `SUB-9` 的要求将无法满足。
> 二者不可兼得；本版本选择在返回前完成解析。

**StateChannel 是 Channel 的收窄视图，MUST NOT 是包装类型**（IX-6）。
`id` / `binding` / `delivery` / `state` 直接来自被包装的 Channel。

### 44.3 返回值

| 操作 | 返回 |
|---|---|
| `get` | `StateCell` 或 `null`（仅当 key 从未存在） |
| `list` | `StateCell[]`，按 `key` 字典序稳定排序，含已删除 cell |
| `set` | 新 revision |
| `delete` | 操作后该 key 的当前 revision（§40.4） |
| `watch` | `StateWatcher`（解析在返回之前完成，见 §44.2） |
| `snapshot` | read-consistent 快照 |
| `restore` | `void` |

### 44.4 不变量

```
API-1  get MUST return the current StateCell — including logically-deleted cells —
       or null if the key has never existed.
API-2  list MUST return all matching StateCells, including logically-deleted ones,
       sorted by key.
API-3  set MUST return the new revision.
API-4  delete MUST NOT reset the revision counter; it MUST return the key's current
       revision after the operation.
API-5  watch MUST return an Interaction Layer-compatible Subscription..
API-6  snapshot MUST be read-consistent.
API-7  snapshot MUST include maxRevision.
API-8  restore MUST overwrite the state covered by snapshot.pattern.
API-9  StatePattern MUST be a union type validated per §42.
```

### 44.5 冲突策略（冻结）

**`StateChannelConfig`**

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `conflictPolicy` | `cas` | 是 | Core 只有这一种 |
| `owner` | `Identity` | 是 | 该 Channel 的归属；`actor` 省略时的回落对象 |

```
CF-1  Core MUST only support the CAS conflict policy.
CF-2  A CAS failure MUST return EAPP_REVISION_CONFLICT.
CF-3  Other policies (last-write-wins / merge / crdt / quorum / unconditional)
      MUST be defined in Extension, MUST NOT appear in Core.
CF-4  The policy MUST be fixed when the Channel is configured, MUST NOT change afterwards.
CF-5  StateChannel MUST extend Channel；MUST NOT be a wrapper type.
```

**理由**：CAS 的正确性建立在 Revision 的全序之上（§37）。
一个"最终一致但号称能 CAS"的存储会**静默丢更新**，所以 Core 不给这条口子 ——
没有全序的 Transport 只能在能力声明里写 `supportsStateRevision = false`（TS-4），
于是 `set` / `delete` 直接失败，而不是悄悄退化成后写覆盖。

**`CF-3` 的兑现方式。** `CF-3` 不要求 `StateChannel` 支持 CAS 之外的策略：
`conflictPolicy` 是冻结的字面量 `'cas'`（`CF-1`、`CF-4`），放宽它属于 `4.0.0`（§2.2）。
因此非 CAS 策略**不能经由 `StateChannel` 选中** —— 它由 Extension 提供自己的路径，
`StateChannel` 保持只支持 CAS 这一事实不变。

这一区分是必要的：若不写明，两种读法都能自称合规 —— 一种把策略名塞进能力声明、
却仍以 `conflictPolicy: 'cas'` 配置 Channel（于是那个字段成为假话），
另一种认为 Core 需要放宽该字段。前者正是 `CF-3` 要避免的静默降级。

---

## 45. StateTransport

**`StateChange`** —— 日志中的一条变更记录。

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `channel` | string | 是 | 所属 Channel |
| `revision` | `Revision` | 是 | 日志位置 |
| `key` | string | 是 | 键 |
| `type` | `set` \| `deleted` | 是 | 变更种类 |
| `value` | 任意值 | 否 | 当且仅当 `type` 为 `set` |

**`StateTransport`** —— 在 `Transport`（§30.1）之上增加状态操作：

```
getState(channel, key)                              ->  StateCell 或 null
listState(channel, pattern)                         ->  StateCell 列表
head(channel)                                       ->  Revision

setStateWithCAS(channel, update, actor)             ->  Revision
deleteStateWithCAS(channel, key, expectedRevision, actor)  ->  Revision

readChangesAfter(channel, cursor, pattern)          ->  StateChange 列表

nextRevision(channel)                               ->  Revision
compareRevision(a, b)                               ->  负数 / 0 / 正数
writeStateWithRevision(channel, key, value,
                       deleted, revision, actor)    ->  ()

waitForChange(channel, cursor, signal)              ->  ()     （可选）
```

**语义约束**：

```
TS-9   readChangesAfter MUST 按 revision 严格升序返回。
TS-10  readChangesAfter MUST 只返回 revision **严格大于** cursor 的变更（不含 cursor 本身）。
TS-11  cursor === undefined MUST 解释为"从最早已保留位置开始"。
TS-12  readChangesAfter 无匹配时 MUST 返回空数组，MUST NOT 阻塞。
TS-13  寻址 MUST 按 (channel, key) 二元组；MUST NOT 把二者拼接为单一字符串。
TS-14  head 在 Channel 尚无任何变更时 MUST 返回一个可比较的初始 revision。
TS-15  nextRevision MUST 返回一个严格大于当前 head 的位置。
```

> **TS-13 的理由。** 若把二者拼接为单一字符串，
> `(channel="a", key="b:c")` 与 `(channel="a:b", key="c")` 会命中同一个 cell，造成跨 channel 污染。

`readChangesAfter` 返回**变更流**，而非 `StateCell[]` 后像：后像**无法表达同一 key 的两次变更**，
中间的变更永久丢失，cursor 语义因此不可实现。
返回变更流才能使"独立 cursor + per-update ack + 删除事件可观察"三者同时成立。

---

## 46. Transport 能力

### 46.1 能力声明

**`StateTransportCapabilities`** —— 在 `TransportCapabilities`（§30.2）之上增加：

| 字段 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `supportsState` | boolean | 是 | 是否支持状态操作 |
| `supportsStateRevision` | boolean | 是 | 是否支持可全序比较的位置 |
| `supportsStateWatch` | boolean | 是 | 是否支持观察 |
| `supportsStateSnapshot` | boolean | 是 | 是否支持快照与恢复 |
| `stateConsistency` | `strong` \| `eventual` | 是 | 一致性强度 |
| `stateRetention` | `{ kind: 'unbounded' }` 或 `{ kind: 'window', entries: number }` | 是 | 日志保留策略 |

命名与 Interaction Layer 对齐（`supports*`，非 `provides*`）。

### 46.2 能力闸门（每个标志 MUST 有唯一的运行时后果）

| 标志 | `false` 时的强制行为 |
|---|---|
| `supportsState` | `get`/`list`/`set`/`delete`/`snapshot`/`restore`/`watch` 全部抛 `EAPP_STATE_UNSUPPORTED` |
| `supportsStateRevision` | `set`/`delete`/`restore` 抛 `EAPP_STATE_UNSUPPORTED`（CAS 不可能成立）；`get`/`list` 仍可用 |
| `supportsStateWatch` | `watch()` 以 `EAPP_WATCH_UNSUPPORTED` 失败 —— 在能立即报告的时刻报告（见 §44.2） |
| `supportsStateSnapshot` | `snapshot()` / `restore()` 抛 `EAPP_UNSUPPORTED` |

```
TS-1  Transport MUST declare state capabilities.
TS-2  Each capability flag MUST have exactly one mandated runtime consequence,
      enforced at the earliest possible call, synchronously where the API is synchronous.
TS-3  MUST NOT fake support.
TS-5  A Transport MUST NOT declare stateConsistency = 'strong' beyond its durabilityBoundary.
TS-6  CAS MUST be implemented atomically in Transport.
TS-7  StateTransport MUST extend Transport.
TS-8  Revision comparison MUST be provided by Transport.
```

### 46.3 一致性能力收紧

```
supportsStateRevision === true   ⟺  Revision 在 Channel 内构成全序且单调（REV-1/2/3/4/8 成立）
supportsStateRevision === false  ⟹  MUST NOT 用于 CAS
```

```
TS-4  A Transport whose revision ordering is not total per channel MUST declare
      supportsStateRevision = false, MUST declare stateConsistency = 'eventual',
      and MUST NOT claim CAS support.
```

允许"eventual 的 revision + CAS"共存，等于允许一个会**静默丢更新**的 CAS。
CAS 的正确性建立在全序之上，故不存在该豁免，能力标志相应收紧。

### 46.4 能力矩阵

下表给出若干**自洽的能力组合**。表描述组合形状，不列举实现，也不要求任何传输必须落在某一行。

| Transport | state | revision | watch | snapshot | consistency | durabilityBoundary |
|---|---|---|---|---|---|---|
| Memory | ✅ | ✅ | ✅ | ✅ | strong | process |
| Socket（仅承载消息） | ❌ | ❌ | ❌ | ❌ | — | machine |
| Socket（broker 持有状态） | ✅ | ✅ | ✅ | ✅ | strong | machine |
| Redis | ✅ | ✅ | ✅ | ✅ | strong | cluster |
| NATS KV | ✅ | ✅ | ✅ | ✅ | strong | cluster |
| CRDT | ✅ | ❌ | ✅ | ❌ | eventual | global |

> **Socket 有两行，因为两种都自洽。** 传输介质不决定能力。
> 仅承载消息的 Socket 不提供状态能力，`stateConsistency` 因而无意义（记 `—`）；
> broker 持有状态的 Socket 提供全部状态能力，其 `strong` 恰好覆盖一台机器上的全部进程。

> **CRDT 行的 `revision` 与 `snapshot` 为 ❌**：
> 其 revision 非全序，故 `supportsStateRevision = false`，CAS 不可用，
> 而 `restore` 依赖 `nextRevision`，故 snapshot 亦不可用。CRDT 的冲突合并策略属于 Extension。

---

## 47. 错误模型

**本层错误码与它们的产生条件**：

| 错误码 | 何时返回 |
|---|---|
| `EAPP_STATE_UNSUPPORTED` | Transport 声明 `supportsState = false`，或 `set` / `delete` / `restore` 落在 `supportsStateRevision = false` 上（§46.2） |
| `EAPP_WATCH_UNSUPPORTED` | Transport 声明 `supportsStateWatch = false`（§46.2） |
| `EAPP_STATE_KEY_INVALID` | `key` 为空（`SC-1`） |
| `EAPP_STATE_KEY_NOT_FOUND` | 以 `expectedRevision = null` 删除一个从未存在的 key（`DEL-4`） |
| `EAPP_STATE_VALUE_INVALID` | 同时给出 `value` 与 `deleted = true`（`SU-3`），或 `deleted` 出现而不为真（`SU-9`） |
| `EAPP_STATE_PATTERN_INVALID` | `StatePattern` 不满足 §42 的逐字段校验 |
| `EAPP_STATE_ACTOR_REQUIRED` | `actor` 无法解析，且 Channel 没有 `owner`（§44.1） |
| `EAPP_REVISION_INVALID` | 位置不是本 Transport 签发，或 `writeStateWithRevision` 收到一个 `<= head` 的值（§37.2、§37.3） |
| `EAPP_REVISION_CONFLICT` | CAS 失败：key 的存在性或位置与 `expectedRevision` 不符（`CF-2`） |
| `EAPP_SNAPSHOT_INVALID` | 快照来自另一个 Channel；或 `restore` 的 `mode` 不在取值域内（§43.3） |

**复用的其他两卷既有码**（MUST NOT 重复定义）：
`EAPP_MODE_INVALID`、`EAPP_DELIVERY_UNSUPPORTED`、`EAPP_CURSOR_TOO_OLD`、`EAPP_UNSUPPORTED`、`EAPP_INTERNAL` 的产生条件见 §18 与 §33。

错误对象的形状与其构造规则见 §18。附录 D 是三个分卷的完整登记。

**retryable 赋值规则**：

```
EAPP_REVISION_CONFLICT  → true（CAS 冲突可重试）
EAPP_CURSOR_TOO_OLD     → false（必须重新同步）
EAPP_UNSUPPORTED / EAPP_STATE_UNSUPPORTED / EAPP_WATCH_UNSUPPORTED / EAPP_INTERNAL → false
其余                    → false（默认）
```

---

## 48. 与 Interaction Layer 的关系

| 维度 | Interaction Layer | State Mode |
|---|---|---|
| Channel 模式 | request / event / stream / **state** | 沿用（MUST NOT 修改） |
| 新增本体 | — | StateCell / StateWatcher / StateUpdate / StateChange |
| Revision | 未定义 | = Channel 日志位置 = Cursor |
| 复用 | — | Channel / Subscription / Cursor / AckContext / Transport |
| 冲突策略 | — | CAS（Core only） |
| Transport 关系 | — | `StateTransport` 在 `Transport` 之上扩展 |

### 48.1 层级隔离（冻结）

State Mode 是 Interaction Layer 的**第四种 mode，不是新层**。以下四条界定它与下面两层的关系：

```
IX-1  State Mode MUST NOT modify, remove or retype any existing member of any
      Composition Core or Interaction Layer type.
IX-2  State Mode MUST reuse Interaction Layer Subscription / Cursor / AckContext semantics.
IX-3  State Mode MUST NOT introduce new primitives into Channel.
IX-4  StateTransport MUST extend Interaction Layer Transport.
IX-6  StateChannel MUST be a narrowing view of Channel; narrowing `mode` to the
      literal 'state' MUST NOT be considered a modification under IX-1.
```

**IX-1 是最强的一条**：它禁止的是"改既有成员"，不是"加东西"。
本层新增的四个本体（StateCell / Revision / StateWatcher / StateUpdate）
全部是**新增**，没有一个改动过 Composition Core 或 Interaction Layer 的既有字段。
这也是为什么 `ChannelMode` 早就含有 `'state'` 这件事很重要（§22.1）——
本层从来没有"扩展"过它，只是使用它。

**IX-3** 的实际含义：`get` / `set` / `watch` / `snapshot` 这些是
**StateChannel 视图上的方法**，MUST NOT 出现在裸 `Channel` 上。
一个 Interaction Layer 模式的 Channel 拿到手里，不应该能调 `set`。

**IX-6**：`id` / `binding` / `delivery` / `state` 直接读穿到底层 Channel，
这样 Channel 的生命周期变化（例如 Binding 派生为 DORMANT 时的 DRAINING）
对状态层的持有者依然可见，而不是被一层拷贝遮住。

---

## 49. 边界与非目标

```
不做：查询语言 / 事务 / 索引 / Schema 验证 / 冲突自动合并 /
      分发策略 / 权限 / 无条件写入 / CRDT / 全文检索 / 二级索引
```

| 限制 | 缓解 |
|---|---|
| 无查询语言 | Extension |
| 无多 key 事务 | Extension |
| CAS 可能失败，需重试 | 应用层重试（`retryable = true`） |
| 日志可能被压缩 | `EAPP_CURSOR_TOO_OLD` + 重新快照 |
| Snapshot 非 linearizable | Extension |
| Revision 是 Transport-local | 应用层映射 |

---

## 第 IV 部分 插件开发表面

## 50. 表面

前三部分规定了语义：一个 Plugin 是什么，Binding 如何派生，Channel 如何互动，状态如何共享。
语义相同的两份实现仍可能无法互通，因为**插件作者写代码时面对的是操作的形状**：

```
find 还是 discover？
bind 的第二个参数是 PluginRef 还是它的 id？
请求超时返回什么？
```

只要形状由各自实现决定，两份实现就必须互相适配，而这正是"任何语言都能实现同一个协议"所要避免的成本。

**插件开发表面**是前三部分已经要求过的操作，在名称、参数、结果与错误码上的**统一形状**。

> **表面不是第四层。** 它不定义新的本体，不改变前三部分的任何语义，也不引入新的状态。
> 它只规定这些操作**叫什么、收什么、给什么**。任何一条表面规则与前三部分冲突时，以前三部分为准，
> 且该冲突是表面的缺陷，不是前三部分的例外。

表面的价值是可判定的：**一个只读过本文件的第三方，写出的插件应当能被另一份同样只读过本文件的实现直接组合**，中间不需要任何适配代码。

## 51. 操作集合

表面由**五个操作组**构成。组名是给读者的分类，不是新的本体。

| 操作组 | 操作 | 定义处 |
|---|---|---|
| **发现** | `find`、`watch` | §12.2 |
| **连接** | `bind`、`unbind`、`createChannel` | §12.2、§32 |
| **激活** | `activate`、`deactivate`、`suspend`、`resume` | §12.2 |
| **通信** | `send`、`subscribe`，以及消费单元自带的 `ack` / `nack` | §30.1、§27.1、§29 |
| **调用** | `invoke` | §52 |

**一个操作组 MUST 只含上表列出的操作**，且这些操作 MUST 使用上表与各定义处给出的名称与参数。
实现 MAY 提供额外的操作，但**插件作者完成组合、互动与调用 MAY 不需要它们**（`OP-1`、`OP-2`）。

四个操作组的语义与形状已在前三部分完全给出；本部分只补上第五组，它此前有信封而没有操作名。

## 52. 调用

请求-应答在 §23 中已有完整的信封与规则（`RQ-1`–`RQ-4`），但没有一个**操作**把"发一个请求、等它的应答"这件事命名。
`invoke` 是那个名字。

```
invoke(from, to, capability, request, options)   ->  response
```

| 参数 | 类型 | 必需 | 语义 |
|---|---|---|---|
| `from` | `PluginRef` | 是 | **调用方** |
| `to` | `PluginRef` | 是 | 被调用方 |
| `capability` | `CapabilityRef` | 是 | 被调用的能力 |
| `request` | 任意值 | 是 | 请求体，放入 `RequestMessage.payload` |
| `options.timeoutMs` | number | 否 | 截止时间，从调用开始计；到期即超时 |
| `options.correlationId` | string | 否 | 显式指定关联标识；省略时由实现分配 |

结果是 `ResponseMessage.result`（成功）或一个 `EappError`（失败）。

**`from` 是被调用方的对面。** 这与 `bind(from, to, capability)` 中 `from` 是提供方并不矛盾：
`bind` 描述的是能力的**提供**方向，`invoke` 描述的是请求的**发出**方向。
两个操作的 `to` 都指向被调用方所暴露的能力（`OP-4`）。

```
invoke(from, to, capability)  ⟺  bind(from = to, to = from, capability) 之上的 request
```

**超时 MUST 以 `EAPP_TIMEOUT` 结束。** 截止时间到达时，`invoke` MUST 失败，MUST NOT 继续等待，
MUST NOT 返回一个形态未定义的值（`OP-5`）。迟到的应答 MUST 按 `RQ-2` 被丢弃。

## 53. 合规等级

| 等级 | 要求 | 蕴含自 |
|---|---|---|
| **CS1 Discovery** | `find`、`watch` | C1 |
| **CS2 Connection** | `bind`、`unbind`、`createChannel` | C1、C2 |
| **CS3 Lifecycle** | `activate`、`deactivate`、`suspend`、`resume` | C3 |
| **CS4 Messaging** | `send`、`subscribe`，以及消费单元的 `ack` / `nack` | I1、I2、I6 |
| **CS5 Invocation** | `invoke` | I1、RQ |

声明某一等级的实现 MUST 声明上表"蕴含自"一列中的全部等级；反之，声明后者中的某一等级时
MUST 同时声明对应的表面等级（`OP-9`）。例如，声明 `I6` 的实现 MUST 同时声明 `CS4`。

含 `state` 模式的 Channel 不在此表内：它复用 `send` / `subscribe` / `ack`，语义见第 III 部分。

## 54. 不变量

```
OP-1  表面 MUST 只由本协议规定的操作组成。实现 MUST NOT 要求插件作者使用本协议未定义的
      入口来完成组合、互动或调用。
OP-2  五个操作的参数与结果中的类型 MUST 全部在本协议内定义；
      插件作者 MUST 无需访问实现的内部对象即可完成组合、互动与调用。
OP-3  表面 MUST NOT 引入本协议未定义的语义。表面是前三部分的剖面，不是第四层。
OP-4  bind 的 from MUST 是提供 Capability 的一方；invoke 的 from MUST 是调用方。
      两个操作的 to MUST 指向同一方。
OP-5  invoke MUST 携带关联标识；截止时间到达时 MUST 以 EAPP_TIMEOUT 结束，
      MUST NOT 静默挂起，MUST NOT 返回形态未定义的值。
OP-6  activate / deactivate / suspend / resume 的语义 MUST 与 §10 一致；
      suspend MUST NOT 断开 Binding。
OP-7  同一组合语义的两份实现 MUST 能只经由表面互通：表面 MUST NOT 要求实现特有的握手、
      能力协商或序列化约定。
OP-8  find 的结果 MUST 可直接作为 bind 与 invoke 的输入，
      MUST NOT 需要额外的注册、转换或转写步骤。
OP-9  声明 C1、C2、C3、I1 或 I6 中任一等级的实现 MUST 同时声明由它蕴含的表面等级（§53）。
```

---

## 附录 A：术语表

| 术语 | 定义 |
|---|---|
| Identity | 三层身份：domain + id + instance |
| Capability | 可组合能力声明，含 name + version |
| Plugin | 具有 Identity / Capability / Lifecycle 的可组合实体 |
| Binding | 两个 Plugin 之间的关系，状态派生 |
| OPEN / CLOSED | Binding 的基础属性 |
| ACTIVE / DORMANT | OPEN Binding 的派生状态 |
| ChannelRef | 运行时交互通道引用，含 id + binding |
| Lifecycle | INACTIVE / ACTIVE / SUSPENDED |
| Discovery | 发现可组合实体的操作集合 |
| DiscoveryEvent | added / removed / changed |
| DiscoveryScope | trustLevel / trustDomain |
| Composition | 对 Plugin Graph 的操作 |
| Bootstrap | 唯一允许硬编码的引导运行时 |
| Trust Level | L0 / L1 / L2，分类而非排序 |

---

## 附录 B：不变量全集

本附录是本协议声明的全部不变量的唯一清单。每条不变量的陈述在正文中给出；本清单给出 ID 与归纳的陈述，供机械核对。

### B.1 Composition Core（§4–§21）

首次冻结于协议版本 `3.0.0`。后续新增：`C-7`（`3.3.0`）、`ER-1` / `ER-2`（`3.5.0`）。

```text
ID-1  domain MUST NOT be empty.
ID-2  id MUST NOT be empty.
ID-3  instance MUST be unique within (domain, id).
ID-4  Identity MUST be immutable.
ID-5  Identity MUST NOT be self-issued.
ID-6  Identity MUST NOT carry version semantics.

C-1   Capability.name MUST NOT be empty.
C-2   Capability.version MUST be valid SemVer.
C-3   contract is optional context.
C-4   Capability MAY be exposed by multiple Plugins.
C-5   CapabilityRef MUST include version.
C-6   Capability version participates in Binding identity.
C-7   Constraint matching MUST be exact: equal `kind` AND structurally equal `value`.

P-1   Every Plugin MUST have a unique Identity.
P-2   Plugin.capabilities MAY be empty.
P-3   Plugin Identity MUST NOT change during lifecycle.
P-4   Capability set MAY change via explicit declaration.

B-1   Binding.from and Binding.to MUST be existing Plugins.
B-2   Binding.capability MUST be exposed by Binding.from.
B-3   Binding state MUST be derived.
B-4   CLOSED is terminal.
B-5   Any endpoint INACTIVE/SUSPENDED => Binding DORMANT.
B-6   Only one non-CLOSED Binding per (from, to, capability).
B-7   Binding.capability.plugin MUST equal Binding.from.
B-8   Binding uniqueness check + creation MUST be atomic.
B-9   PENDING Binding MUST NOT be externally observable.

LC-1   activate:   INACTIVE -> ACTIVE.
LC-2   deactivate: any -> INACTIVE.
LC-3   suspend:    ACTIVE -> SUSPENDED.
LC-4   resume:     SUSPENDED -> ACTIVE.
LC-5   SUSPENDED MUST NOT unbind.
LC-6   activate applies only to INACTIVE; resume applies only to SUSPENDED.

D-1   find MUST return only current Trust Scope visible Plugins.
D-2   watch MUST only fire for current Trust Scope.
D-3   Discovery MUST NOT imply composability.
D-4   Discovery MAY cache with invalidation policy.
D-5   Discovery MUST NOT replace Binding.
D-6   DiscoveryEvent.type MUST be added|removed|changed.
D-7   Trust level MUST NOT imply ordered authorization.

O-1   bind MUST create Binding; state is derived.
O-2   bind MUST fail if capability not exposed by from.
O-3   unbind MUST set Binding to CLOSED.
O-4   unbind MUST be idempotent.
O-5   activate MUST be idempotent.
O-6   deactivate MUST set all Bindings to DORMANT.
O-7   suspend MUST set all Bindings to DORMANT.
O-8   resume MUST re-evaluate all Bindings.

CHB-1  Composition Core MUST NOT define Channel interaction semantics.

BR-1  Bootstrap MUST NOT be replaced by nonexistent.
BR-2  Bootstrap MUST NOT depend on Plugins.
BR-3  Bootstrap MUST provide initial Discovery.

ER-1  实现为一个条件返回的错误码 MUST 是规范为该条件规定的那个码。
ER-2  每个在附录 D 中登记的错误码 MUST 在正文中被某一条款规定其产生条件。
```

### B.2 Interaction Layer（§22–§34）

首次冻结于协议版本 `3.1.0`。

```text
CH-1..CH-6       Channel
DL-1..DL-6       Delivery
L-1..L-7         Lease
CR-1..CR-5       Cursor
AK-1..AK-5       Ack / Nack
CG-1..CG-8       ConsumerGroup
SUB-1..SUB-9     Subscription
TR-1..TR-9       Transport
CC-1..CC-9       Composition ↔ Interaction
RQ-1..RQ-4       Request 模式
EV-1..EV-3       Event 模式
ST-1..ST-4       Stream 模式
```

### B.3 State Mode（§35–§49）

首次冻结于协议版本 `3.2.0`。

```text
SC-1   key MUST NOT be empty.
SC-2   revision MUST be monotonic within a Channel.
SC-3   deleted = true MUST preserve revision.
SC-4   value MUST be serializable (only for deleted === false).
SC-5   updatedBy MUST be an existing Identity.
SC-6   get / list MUST include logically-deleted cells.

REV-1  Revision MUST be monotonic within a Channel.
REV-2  New revision MUST be greater than the current head.
REV-3  Revision MUST be assigned by the Transport.
REV-4  Revision MUST NOT roll back within a Channel.
REV-5  Revision MUST be opaque to consumers.
REV-6  Revision MUST NOT be used as Cursor in Interaction Layer modes other than state.
REV-7  Revision MAY be used as Cursor in State Mode.
REV-8  Revision MUST NOT be compared across Transports.

SU-1   StateUpdate MUST specify key.
SU-2   StateUpdate MUST have a 'value' property or set deleted = true.
SU-3   MUST NOT carry both 'value' and deleted = true.
SU-4   CAS failure MUST return EAPP_REVISION_CONFLICT.
SU-5   CAS failure MUST NOT modify state.
SU-6   Core MUST NOT expose an unconditional client-facing write.
SU-7   CAS check + write MUST be atomic in Transport.
SU-8   expectedRevision MUST be Revision | null.
SU-9   deleted, when present, MUST be true.

DEL-1  delete MUST perform CAS.
DEL-2  A successful delete MUST produce a type='deleted' change (no-op excepted).
DEL-3  StateWatcher MUST receive deleted changes.
DEL-4  delete with expectedRevision = null on a never-existing key MUST return
       EAPP_STATE_KEY_NOT_FOUND.
DEL-5  delete of an already-deleted key with matching revision MUST be a no-op success.
DEL-6  delete followed by set MUST increment revision and clear the deleted flag.

SW-1   StateWatcher MUST implement Interaction Layer Subscription.
SW-2   StateWatcher MUST have kind = 'state'.
SW-3   StateWatcher MUST NOT override Subscription.mode.
SW-4   StateWatcher MUST have an independent cursor when mode === 'exclusive'.
SW-5   StateWatcher MUST NOT affect other StateWatchers.
SW-6   ack() and nack() MUST NOT take parameters.
SW-7   ack() MUST NOT modify any StateCell.
SW-8   StateWatcher MUST receive deleted changes.
SW-9   StateWatcher's default initial position MUST be 'latest'.
SW-10  StateWatcher MUST implement the full Interaction Layer AckContext.
SW-11  close() MUST be idempotent; no delivery after close().
SW-12  ack() / nack() after close() MUST be a no-op.

SNAP-1  snapshot MUST be read-consistent against a head read BEFORE the cell read.
SNAP-2  snapshot MUST include maxRevision.
SNAP-3  snapshot MUST NOT claim linearizability.
SNAP-4  restore MUST NOT roll back revisions.
SNAP-5  restore MUST assign new revisions.
SNAP-6  restore MUST preserve relative ordering.
SNAP-7  restore MUST be the only public path to an unconditional write.
SNAP-8  restore MUST append a change for every write.
SNAP-9  restore MUST reject a snapshot from another channel.

CF-1   Core MUST only support CAS.
CF-2   CAS failure MUST return EAPP_REVISION_CONFLICT.
CF-3   Other policies MUST be defined in Extension.
CF-4   Policy MUST be specified at Channel creation (configure()).
CF-5   StateChannel MUST extend Channel, MUST NOT be a wrapper type.

API-1  get MUST return the current cell (including deleted) or null.
API-2  list MUST return matching cells (including deleted), sorted by key.
API-3  set MUST return the new revision.
API-4  delete MUST return the key's current revision after the operation.
API-5  watch MUST return an Interaction Layer-compatible Subscription.
API-6  snapshot MUST be read-consistent.
API-7  snapshot MUST include maxRevision.
API-8  restore MUST overwrite the state covered by snapshot.pattern.
API-9  StatePattern MUST be a union type.

TS-1   Transport MUST declare state capabilities.
TS-2   Each capability flag MUST have exactly one mandated runtime consequence.
TS-3   MUST NOT fake support.
TS-4   Non-total revision ordering MUST declare supportsStateRevision = false.
TS-5   stateConsistency MUST NOT exceed durabilityBoundary.
TS-6   CAS MUST be implemented atomically in Transport.
TS-7   StateTransport MUST extend Transport.
TS-8   Revision comparison MUST be provided by Transport.
TS-9   readChangesAfter MUST return changes in strictly ascending revision order.
TS-10  readChangesAfter MUST return only revisions strictly greater than the cursor.
TS-11  cursor === undefined MUST mean "from the earliest retained position".
TS-12  readChangesAfter MUST NOT block.
TS-13  Addressing MUST use the (channel, key) pair, never string concatenation.
TS-14  head MUST return a comparable initial revision for an empty channel.
TS-15  nextRevision MUST return a position strictly greater than the current head.

IX-1   State Mode MUST NOT modify, remove or retype any existing member of any
       Composition Core or Interaction Layer type.
IX-2   State Mode MUST reuse Interaction Layer Subscription / Cursor / AckContext semantics.
IX-3   State Mode MUST NOT introduce new primitives into Channel.
IX-4   StateTransport MUST extend Interaction Layer Transport.
IX-6   StateChannel MUST be a narrowing view of Channel.

```

### B.4 插件开发表面（§50–§54）

首次冻结于协议版本 `3.4.0`。

```text
OP-1   表面 MUST 只由本协议规定的操作组成。
OP-2   五个操作的参数与结果的类型 MUST 全部在本协议内定义。
OP-3   表面 MUST NOT 引入本协议未定义的语义。
OP-4   bind 的 from MUST 是提供方；invoke 的 from MUST 是调用方。
OP-5   invoke MUST 携带关联标识；截止时间到达 MUST 以 EAPP_TIMEOUT 结束。
OP-6   activate / deactivate / suspend / resume 的语义 MUST 与 Lifecycle 一致。
OP-7   同一组合语义的两份实现 MUST 能只经由表面互通。
OP-8   find 的结果 MUST 可直接作为 bind 与 invoke 的输入。
OP-9   声明 C1、C2、C3、I1 或 I6 中任一等级的实现 MUST 声明对应的表面等级。
```

---

## 附录 C：冻结语义答案

| 问题 | 答案 |
|---|---|
| Plugin 身份组成 | domain + id + instance（不含版本） |
| Capability 与 Plugin 关系 | 多对多 |
| Binding 是否要求 contract | 否 |
| SUSPENDED 是否解除 Binding | 否，只派生 DORMANT |
| Discovery 是否保证组合 | 否 |
| Plugin 是否可被多 Binding | 是 |
| 任一端 deactivate / suspend | Binding 派生为 DORMANT |
| Binding 状态 | 派生，PENDING 不可观察 |
| activate 与 resume | activate: INACTIVE→ACTIVE；resume: SUSPENDED→ACTIVE |
| Plugin.capabilities 是否可空 | 可以 |
| Binding 唯一性 | 非 CLOSED 唯一，原子 check+create |
| Binding.from 与 capability.plugin | MUST 相等 |
| Channel | 只保留 ChannelRef |
| namespace | 从 Core 移除 |
| trustLevel | 分类，不是排序 |

---

## 附录 D：错误码全集

本附录是三个分卷错误码的并集，用于避免同一语义在不同分卷被赋予两个码。
错误对象的形状与其构造规则见 §18。

**一个码的产生条件只在一处规定。** 每个码的「何时返回」写在它的归属分卷的错误模型里：
Composition Core 见 §18，Interaction Layer 见 §33，State Mode 见 §47。
本附录不重复那些条件，只把它们汇总到一处，好让「三个分卷一共定义了哪些码」有一个可核对的答案。

```
ER-2  每个在附录 D 中登记的错误码 MUST 在本文件中被某一条款规定其产生条件。
```

`check:spec` 的第八条规则检查这一条：本表中的每个码 MUST 也在正文的某一处被规定产生条件。

| 错误码 | 分卷 | 产生条件见 |
|---|---|---|
| `EAPP_IDENTITY_INVALID` | Composition Core | §18 |
| `EAPP_IDENTITY_DUPLICATE` | Composition Core | §18 |
| `EAPP_CAPABILITY_NOT_FOUND` | Composition Core | §18 |
| `EAPP_CAPABILITY_NOT_EXPOSED` | Composition Core | §18 |
| `EAPP_PLUGIN_NOT_FOUND` | Composition Core | §18 |
| `EAPP_PLUGIN_INACTIVE` | Composition Core | §18 |
| `EAPP_BINDING_INVALID` | Composition Core | §18 |
| `EAPP_BINDING_DUPLICATE` | Composition Core | §18 |
| `EAPP_BINDING_CLOSED` | Composition Core | §18 |
| `EAPP_LIFECYCLE_INVALID` | Composition Core | §18 |
| `EAPP_DISCOVERY_SCOPE_INVALID` | Composition Core | §18 |
| `EAPP_CHANNEL_INVALID` | Interaction Layer | §33 |
| `EAPP_CHANNEL_CLOSED` | Interaction Layer | §33 |
| `EAPP_CHANNEL_DRAINING` | Interaction Layer | §33 |
| `EAPP_MODE_INVALID` | Interaction Layer | §33 |
| `EAPP_DELIVERY_UNSUPPORTED` | Interaction Layer | §33 |
| `EAPP_CURSOR_INVALID` | Interaction Layer | §33 |
| `EAPP_CURSOR_UNSUPPORTED` | Interaction Layer | §33 |
| `EAPP_CURSOR_TOO_OLD` | Interaction Layer | §33 |
| `EAPP_SUBSCRIPTION_INVALID` | Interaction Layer | §33 |
| `EAPP_LEASE_EXPIRED` | Interaction Layer | §33 |
| `EAPP_LEASE_CLOSED` | Interaction Layer | §33 |
| `EAPP_LEASE_CONFLICT` | Interaction Layer | §33 |
| `EAPP_TIMEOUT` | 插件开发表面 | §33 |
| `EAPP_STATE_UNSUPPORTED` | State Mode | §47 |
| `EAPP_WATCH_UNSUPPORTED` | State Mode | §47 |
| `EAPP_STATE_KEY_INVALID` | State Mode | §47 |
| `EAPP_STATE_KEY_NOT_FOUND` | State Mode | §47 |
| `EAPP_STATE_VALUE_INVALID` | State Mode | §47 |
| `EAPP_STATE_PATTERN_INVALID` | State Mode | §47 |
| `EAPP_STATE_ACTOR_REQUIRED` | State Mode | §47 |
| `EAPP_REVISION_INVALID` | State Mode | §47 |
| `EAPP_REVISION_CONFLICT` | State Mode | §47 |
| `EAPP_SNAPSHOT_INVALID` | State Mode | §47 |
| `EAPP_UNSUPPORTED` | 三个分卷 | §18 |
| `EAPP_INTERNAL` | 三个分卷 | §18 |

### D.1 retryable 的赋值规则

```
EAPP_REVISION_CONFLICT  → true   （CAS 冲突可重试）
其余                    → false
```

`retryable` 为 `true` 时，重试同一操作在语义上是有意义的；为 `false` 时，调用方 MUST 改变输入或重新同步，而不是重试。

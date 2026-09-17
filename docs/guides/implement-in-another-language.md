# 用另一种语言实现 EaPP

> **本页的读者**：以 Go / Rust / Java / Python 等语言实现 EaPP 的实现方。
> 规则本身在 [`docs/spec/eapp.md`](../spec/eapp.md) 里；本页只说清
> 必须逐字遵守的部分、实现方自由决定的部分，以及各语言都容易做错的地方。

前置阅读：[概念：三层心智模型](./concepts.md)。
本页属于非规范性文档，与规范冲突时以规范为准。

---

## 1. 实现对象与合规等级

四部分单向依赖（§1.1）：`Composition Core → Interaction Layer → State Mode → Transport`。
第 IV 部分不是第四层，它是前三部分已经要求过的操作在形状上的**剖面**（§50）。
只实现其中一部分是允许的，代价是声明面变小。

| 部分 | 等级 | 语义 |
|---|---|---|
| 第 I 部分 | `C1` Core | Identity / Capability / Plugin / Binding / Lifecycle / Discovery（§17） |
| 第 I 部分 | `C2` Derived Binding | Binding 状态派生 + OPEN / CLOSED 基础属性（§17） |
| 第 I 部分 | `C3` Lifecycle Closure | activate / suspend / resume / deactivate 语义闭合（§17） |
| 第 I 部分 | `C4`–`C8` | Trust Scope、Discovery Events、Atomic Bind、Constraints、Bootstrap（§17） |
| 第 II 部分 | `I1` Channel · `I2` Delivery · `I6` Subscription | `MUST`（§34） |
| 第 II 部分 | `I3` Lease · `I4` Cursor · `I7` ConsumerGroup | `SHOULD`（§34） |
| 第 II 部分 | `I5` Transport Capability | `MAY`（§34） |
| 第 III 部分 | 无等级前缀 | 覆盖度由不变量计数表达（§3.2） |
| 第 IV 部分 | `CS1`–`CS5` | Discovery / Connection / Lifecycle / Messaging / Invocation（§53） |

两条容易漏掉的约束：实现 MUST 支持 `C1`–`C3`，SHOULD 支持 `C4`–`C6`，MAY 支持 `C7`–`C8`（§17）；
承载 `state` / `stream` Channel 的实现 MUST 满足 `I4`，即使它在其他模式下只声明 `SHOULD`（§34）。
`CS1`–`CS5` 与前面各层有蕴含关系（§53）：声明 `CS2` 的实现 MUST 声明 `C1`、`C2`，
反向地，声明 `C1`、`C2`、`C3`、`I1`、`I6` 中任一等级的实现 MUST 声明由它蕴含的表面等级（`OP-9`）。

---

## 2. 规范性 vs 实现自由

规范规定**行为**，不规定**内部形态**。下列内容规范没有规定：

| 实现自由 | 说明 |
|---|---|
| 语言与运行时 | 规范适用于任何语言、任何运行时（§文件头） |
| 目录布局与包名 | 规范不规定测试框架、语言或目录结构（§3.1） |
| 序列化格式 | JSON / Protobuf / MessagePack / 自定义二进制都可行 |
| 存储布局 | 内存 / SQL / KV / 文件都可行 |
| 进程模型与并发模型 | actor、协程、线程池、独立进程都可行 |
| 测试框架 | 测试由实现方提供，位于实现方的仓库（§3.1） |

与自由相对的是**跨实现契约**：§1.2 规定字段名与操作名是跨实现契约的一部分 ——
实现 MUST 使用规范给出的名字，MUST NOT 改名或改义。操作的结果类型也由规范给出，
`1.2` 的记法不标注异步性：一个操作是否 MUST 在返回之前完成语义效果，由该操作的条款规定。

规范正文里另有若干**非规范性表格**（例如 §30.3 与 §46.4 的能力矩阵）：
它们描述自洽组合的形状，MUST NOT 被读成"某个传输必须落在某一行"。

---

## 3. 各语言都容易做错的地方

### 3.1 Cursor 与 Revision 是不透明值

`Cursor` 的字面形式由实现定义，消费者 MUST NOT 解析它（§26.1）；
`Revision` 同样是不透明标识，其字面形式由 Transport 定义（§37）。
两条不变量直接约束这一点：

```
REV-5  Revision MUST be opaque to consumers.
REV-8  Revision MUST NOT be compared across Transports.
```

因此：把位置解析成整数、时间戳或"层级编号"，会把实现细节冻结成跨实现契约；
把来自另一个 Transport 实例的值拿来比较，MUST 失败而不是排出一个错误顺序。
比较 MUST 由 Transport 提供（§37.2、`TS-8`），`compareRevision(a, b)` 的两个入参
不是本实例签发的值时 MUST 返回 `EAPP_REVISION_INVALID`（§37.2，对应 `REV-8`）。

**类型上也要留出这个自由度。** 若把 `Revision` 声明成 `int64` 或 `Uuid`，
调用方迟早会开始对它做算术或排序，而这些用法在别的实现上不成立。

### 3.2 `find` 的 `version` 是 SemVer range

`Criteria.version` 的类型是 string，语义是 **SemVer range**（§11.1）。
它 MUST NOT 被读成"精确匹配的版本串"：`CapabilityRef` 携带的是具体版本（`C-5`），
而 §11.1 的 `version` 是它的取值范围。

实现上，这意味着需要一段 range 求值逻辑（`^1.2.0`、`>=1.2.0 <2` 之类），
而不是一次字符串相等比较。另一条约束在 `C-2`：

```
C-2  Capability.version MUST be valid SemVer.
```

因此版本在**声明侧** MUST 是合法 SemVer，range 语法则在**查询侧**出现。
把两侧都实现成字符串相等比较，会让"声明 `1.2.0`、查询 `^1.0.0`"这种正确用法查不到东西。

### 3.3 `expectedRevision` 的 `null` 只表示"从未存在"

```
null       → key MUST NOT 曾经存在
Revision   → key MUST 存在，且其 revision MUST 精确匹配
```

`null` 是一个独立取值，MUST NOT 被实现为 `''` / `'0'` / `-1`（§39.2），
也 MUST NOT 被用来复活一个已逻辑删除的 key —— 复活必须携带旧 revision（§39.2）。
CAS 的判定表在 §39.2 与 §40.2 中给出，其中"从未存在"与"存在但 revision 不匹配"
是**不同的失败**：`delete` 对从未存在的 key 且 `expectedRevision = null` 返回
`EAPP_STATE_KEY_NOT_FOUND`（`DEL-4`），其余不匹配返回 `EAPP_REVISION_CONFLICT`（`CF-2`）。
合成一个码，调用方就分不清"调用错误"与"CAS 竞争"，而两者的重试策略相反。
重试策略由 `EAPP_REVISION_CONFLICT` 的 `retryable = true` 表达（§47）：CAS 冲突可以重试，
`EAPP_STATE_KEY_NOT_FOUND` 不可以。

### 3.4 `value` 的存在性按属性存在判定

```
SU-2  StateUpdate MUST have a 'value' property or set deleted = true.
      'value' 的存在性 MUST 按属性存在判定，MUST NOT 用 value !== undefined 判定。
      （因此 { value: undefined } 是合法写入，有明确语义。）
```

这与 `expectedRevision` 的三态是同一类问题：**缺席**与**存在但为空值**是两个不同的事实。
在静态语言里，这要求类型能表达三层状态（例如可选值再包一层可选），
而不是一个可空引用。"没有 value 且没有 `deleted`" MUST 失败（`SU-2`），
"同时带 `value` 与 `deleted: true`" MUST 返回 `EAPP_STATE_VALUE_INVALID`（`SU-3`）。

### 3.5 `suspend` MUST NOT 断开 Binding

```
LC-5  SUSPENDED MUST NOT unbind.
OP-6  activate / deactivate / suspend / resume 的语义 MUST 与 §10 一致；
      suspend MUST NOT 断开 Binding。
```

`suspend` 只把 Plugin 置为 `SUSPENDED`，其所有 Binding 派生为 `DORMANT`（`O-7`、§9.4）；
对应 Channel 进入 `DRAINING` 而不是 `CLOSED`（§22.4），因此恢复时 MUST 回到 `ACTIVE`。
把它实现成"断开连接"或"关闭 Channel"，会让恢复路径丢失在途消息，
也会让 `resume` 无从重新评估 Binding（`O-8`）。
从 `SUSPENDED` 回到 `ACTIVE` MUST 走 `resume`，`activate` 只适用于 `INACTIVE`（`LC-6`）。

### 3.6 不支持的路径 MUST 显式失败

`TR-3` 规定 Transport MUST NOT 伪装支持；`TS-3` 对状态能力给出同样的要求。
能力标志在 `false` 时的强制行为写在 §46.2，其中每个标志恰好对应一个运行时后果（`TS-2`）。
"不支持"在跨实现场景中等价于数据损坏：静默降级会产出一个形式正确、语义错误的结果，
而调用方无从察觉。异常、错误值、返回联合都可以，**错误码必须能被调用方读取**。

---

## 4. 一致性声明必须写什么

§3.2 规定实现声称合规时 MUST 声明五个字段：

| 字段 | 类型 | 语义 |
|---|---|---|
| `eappVersion` | string | 实现所覆盖到的协议版本 |
| `levels` | string[] | 已声明的合规等级 |
| `testSuite` | string | 所用一致性测试套件的标识与版本 |
| `passed` | number | 通过的测试用例数 |
| `total` | number | 测试用例总数 |

三条约束：

1. **`levels` 只允许出现本文件定义过的等级。** 第 I 部分定义 `C1`–`C8`，
   第 II 部分定义 `I1`–`I7`，第 IV 部分定义 `CS1`–`CS5`；
   State Mode 不定义等级前缀（§3.2）。声明一个规范没有定义过的等级不是扩展，是伪造合规。
2. **`eappVersion` 报告的是覆盖到的版本。** 只实现 Composition Core 的实现报告 `3.0.0`，
   覆盖全部分卷的实现报告当前版本；两者都能满足声明要求，而声明的强弱不同（§3.2）。
3. **`passed` / `total` 统计的是不变量覆盖，不是测试条数。** 每个不变量 MUST 至少有一个
   对应的测试用例，不适用的不变量 MUST NOT 被静默省略：要么补测试，
   要么在一致性声明中登记为未覆盖并给出理由（§3.1）。

本仓库不设认证机构：规范不要求任何第三方签署。声明是可验证的承诺，不是许可证。

---

## 5. 如何验证

**本仓库不再自带实现，也不自带跨实现检查工具。** 工作分支上只有规范与文档；
参考实现与跨实现检查工具在
[`reference` 分支](https://github.com/quyansiyuanwang/EaPP/tree/reference)（tag `reference-3.3.0`）。
它们是**另一个实现的经验**，不是规则的来源：与规范冲突时以规范为准。

因此验证有三条可行的路径：

1. **按 §3.1 自建判定。** 规范要求每个不变量至少有一个可执行的判定，且失败可被观察。
   测试放在实现方自己的仓库里，框架与语言由实现方决定。这是规范唯一直接要求的验证形式。
2. **按不变量 ID 组织测试名。** 不变量标识在整个协议范围内唯一且稳定（§1.3）。
   把 ID 放进测试名，覆盖清单就能与附录 B 的清单逐条对照。
   附录 B 是全部不变量的唯一清单，按**首次引入的协议版本**分节。
3. **按能力矩阵自查。** §30.3 与 §46.4 给出自洽的能力组合；
   声明的能力与实际行为不一致时，先改声明，再改实现。

实现方还 SHOULD 保留一份"未覆盖的不变量"清单。§3.1 允许不适用，
但不允许静默 —— 一份写着"哪些没测、为什么没测"的清单，
比一个漂亮的总数更能说明实现的状态。

---

## 相关

- [概念：三层心智模型](./concepts.md) —— 层与层的方向与分工
- [实现一个 Transport](./write-a-transport.md) —— 最下面一层的完整契约
- [`docs/spec/eapp.md`](../spec/eapp.md) —— 唯一规范性正文
- [`Transport`](../reference/transport.md) · [`Cursor`](../reference/cursor.md) ·
  [`Revision`](../reference/revision.md) · [`StateUpdate`](../reference/state-update.md)

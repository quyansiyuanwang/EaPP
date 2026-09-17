# 写一个 Extension

> **非规范性。** 本页不新增规则。它说明**如何用既有的 Core 机制**表达规范中
> 标注为 "Extension" 的那些语义。规范正文 [`docs/spec/eapp.md`](../spec/eapp.md) 是唯一裁决者。

前置阅读：[概念：三层心智模型](./concepts.md) 的第 2 节（三个问题）与第 7 节（什么不属于 Core）。

---

## 1. Extension 是什么

Extension 指的是一组**协议之外**的语义：一个命名、带版本的契约，供两个插件在
Core 之上约定 Core 没有规定的东西。

**本协议不为 Extension 增设任何原语。** 需要的机制 Core 已经有了：

| Extension 需要 | Core 已有的机制 |
|---|---|
| 一个有身份、可版本化的名字 | `Capability` 的 `name` 与 `version`（§7.1） |
| 让对端发现自己支持它 | `Discovery` 的 `find(criteria, scope)`（§11.1） |
| 与对端建立关系 | `Binding` 与 `bind(request)`（§9.1、§12.2） |
| 一个承载操作的通道 | 由 Binding 派生的 `request` 模式 `Channel`（§22.1、§32） |
| 失败时让对端知道缺什么 | `EappError` 的 `EAPP_UNSUPPORTED`（§18、§33） |

所以 Extension 不是一个需要被发明的概念，而是一种**用法**。规范中那些
"属于 Extension"的落点，指的是"这件事不由本协议规定，由另一个契约规定" ——
而那个契约如何被两个插件找到、协商、调用，本协议已经规定了。

---

## 2. 形态

一个 Extension 由三样东西构成。以下为说明性伪代码，记法沿用规范 §1.2。

**① 能力：名字加版本。名字是 Extension 的身份。**

| 字段 | 示例值 | 说明 |
|---|---|---|
| `name` | `com.example.conflict-lww` | 反向域名，全局可辨 |
| `version` | `1.0.0` | SemVer |

这两个字段就是 `Capability` 的全部必需字段（§7.1）。

**② 一份规范文档。** 它说明这个名字对应什么语义、哪些消息、哪些错误码。
它不在本仓库里，由 Extension 的作者维护。

**③ 一组操作。** 以 `request` 模式的 Channel 承载，载荷由 ② 定义。

三段都可以用既有类型写出来，不需要新接口。

---

## 3. 一次完整的协商

```
① 提供方声明能力 —— 这是"我支持它"的唯一表达方式：
     Plugin.capabilities 中列出 { name: 'com.example.conflict-lww',
                                  version: '1.0.0' }        （§8.1）

② 消费方在使用之前先发现对端是否支持它：
     find({ capability: 'com.example.conflict-lww', version: '^1.0.0' }, scope)
       ->  PluginRef 列表                                  （§11.1）

③ 结果为空时不退回 Core 的行为，而是显式失败：
     fail with EAPP_UNSUPPORTED                             （§18）

④ 建立关系，由 Binding 派生 request 模式的 Channel，再按 ② 定义的载荷调用：
     bind({ from: provider, to: consumer, capability })  ->  Binding   （§12.2）
```

`find` 的结果 MUST 可直接作为 `bind` 的输入，不需要额外的注册或转换（`OP-8`）。
`Criteria.version` 是 SemVer range，因此 `'^1.0.0'` 表示"任一兼容版本"（§11.1）。

**`find` MUST 在 `bind` 之前。** 这是使用 Extension 与使用 Core 的重要区别：
Core 的操作在任何实现上都存在，Extension 的操作不保证存在，
因此"先问再用"是正确性要求，而不是礼貌。
对端不暴露该能力时，`bind` MUST 失败：`from` 未暴露目标 Capability 是 `O-2` 的
失败条件，错误码取 `EAPP_CAPABILITY_NOT_EXPOSED`（§12.5、§18）。
先 `find` 的价值在于知道**缺的是哪一个**能力，而不是事后从一次失败里推断。

---

## 4. Extension 不可以做什么

以下几条不是本页的发明，是 Core 已经冻结的约束，列在这里是因为写 Extension 时最容易撞上。

**不得修改 Core 的类型。** `Binding` MUST NOT 声明消息方向、同步 / 异步、投递保证或
序列化格式（§9.9）；`Channel` 能携带的交互属性以 §13.2 为界。`Identity` 只有
`domain` / `id` / `instance` 三个字段，且 MUST NOT 携带版本语义（§6.1、`ID-6`）。
`StateChannelConfig.conflictPolicy` 在 Core 里只有 `'cas'`（§44.5、`CF-1`）；
`IX-1` 禁止 State Mode 修改、删除或改型任何既有成员（§48.1）。
**Extension 增加新的能力，不改变既有能力。**

**不得放宽冻结的取值。** 例如非 CAS 的冲突策略：`CF-3` 要求它"定义在 Extension 中"，
但 `StateChannel` 的 `conflictPolicy` 仍是 `'cas'` —— 非 CAS 策略不能经由那个字段选中，
而要由 Extension 提供自己的路径（§44.5）。
把策略名塞进能力声明、却仍以 `conflictPolicy: 'cas'` 配置 Channel，
会让那个字段成为一句假话。

**不得静默降级。** 不支持的能力必须显式失败（§30.4 `TR-9`），
而不是退回 Core 的语义当作已经满足。跨实现时，静默降级与数据损坏等价。

---

## 5. 规范里标注为 Extension 的落点，分别怎么落

正文中出现 "Extension" 的位置共八处。`grep -n Extension docs/spec/eapp.md`
另在附录 B.3 命中一行，那是 `CF-3` 的复核行，与 §44.5 同一条。

| 出处 | 所指 | 落法 |
|---|---|---|
| §7.5（`C-7`） | 更丰富的 `Constraint` 匹配（范围、偏序、谓词） | 不作为 `Criteria.constraints` 的扩展。Core 的匹配是精确匹配；提供方把更丰富的匹配做成一个能力，消费方先 `find` 再 `bind`，匹配语义由 Extension 自己的文档定义 |
| §7.5（`C-7` 的由来） | "任何比这更聪明的规则都需要一个语义协商机制" | 那个机制是 §11 `Discovery` 与 §12 `Composition`。本协议的协商单位是 `Capability`，Extension 沿用它 |
| §44.5（`CF-3`） | 非 CAS 的冲突策略：last-write-wins / merge / crdt / quorum / unconditional | 由 Extension 提供自己的路径，`StateChannel` 保持 CAS-only。见第 4 节 |
| §44.5（`CF-3` 的兑现方式） | 为什么非 CAS 策略不能经由 `conflictPolicy` 选中 | `conflictPolicy` 是冻结的字面量 `'cas'`（`CF-1`、`CF-4`）；放宽它属于 `4.0.0`（§2.1） |
| §46.4 | CRDT 的冲突合并策略 | 同 `CF-3`。CRDT 形态的存储声明 `supportsStateRevision: false` 与 `stateConsistency: 'eventual'`（§46.3 `TS-4`），其合并策略属于提供该策略的 Extension |
| §49 | 无查询语言 | 查询是一组操作，以 `request` Channel 承载，载荷与错误码由 Extension 定义 |
| §49 | 无多 key 事务 | 同上。事务边界是 Extension 的语义，不是 `StateChannel` 的 |
| §49 | Snapshot 非 linearizable | Core 能回答的是诚实声明：`SNAP-3` 要求快照 MUST NOT 自称 linearizable，`stateConsistency` 按实际能力写（§46.1）。提供 linearizable 读的那套机制属于 Extension |
| §2.1、§2.3（不是落点，是吸收路径） | 把某个 Extension 的语义**吸收**进协议 | 那是一次 `3.x.0` 变更（§2.1），走 §2.3 的流程：提交 Issue / RFC、分类、至少两名独立实现者评审、通过一致性测试套件 |

---

## 6. 为什么 Extension 不需要新的协商原语

一个自然的疑问是：既然 Extension 是"协议之外"的，为什么它的协商要受协议约束？

因为协商本身就发生在协议之内。两个插件要就一件 Core 没规定的事达成共识，
它们仍须先能**发现对方**、**建立关系**、**传递消息** —— 而这三件事是 Core 的。
用别的途径做这三件事，等于在协议之外另开一条只有部分实现支持的通道，
对端无从发现，也就无从协商。

把 Extension 收敛到 `Capability` 上，代价是名字与版本要能被两个实现共同理解；
收益是**"对端是否支持它"这个问题永远有答案**。

---

## 相关

- [概念：三层心智模型](./concepts.md) —— 第 7 节说明什么不属于 Core
- [写一个插件](./write-a-plugin.md) —— capability 与声明的用法
- [`Capability`](../reference/capability.md) · [`Discovery`](../reference/discovery.md) ·
  [`Binding`](../reference/binding.md)
- 规范：[`docs/spec/eapp.md`](../spec/eapp.md) §7.5 `C-7` · §44.5 `CF-3` · §49
- [RFC 0001（已否决）](../../rfcs/0001-extension-mechanism.md) —— 为什么这件事不由新的规范性规则解决

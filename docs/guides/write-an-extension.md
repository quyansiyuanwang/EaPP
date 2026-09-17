# 写一个 Extension

> **非规范性。** 本页不新增规则。它说明**如何用既有的 Core 机制**表达规范里
> 十处"属于 Extension"所指的东西。规范正文是唯一裁决者。

前置阅读：[概念：三层心智模型](./concepts.md) 的 §2 与 §7。

---

## 1. Extension 是什么

Extension 指的是一组**协议之外**的语义：一个命名、带版本的契约，供两个插件在
Core 之上约定 Core 没有规定的东西。

**本协议不为 Extension 增设任何原语。** 需要的机制 Core 已经有了：

| Extension 需要 | Core 已有的机制 |
|---|---|
| 一个有身份、可版本化的名字 | [`Capability`](../reference/capability.md) 的 `{ name, version }`（§5） |
| 让对端发现自己支持它 | [`Discovery`](../reference/discovery.md) 的 `find({ capability, version })`（§8.1） |
| 与对端建立关系 | [`Binding`](../reference/binding.md) 与 `bind()`（§9） |
| 一个承载操作的通道 | 由 Binding 派生的 `request` 模式 [`Channel`](../reference/channel.md)（v3.1 §12） |
| 失败时让对端知道缺什么 | [`EappError`](../spec/v3.0.0-core.md) 的 `EAPP_UNSUPPORTED`（§16） |

所以 Extension 不是一个需要被发明的概念，而是一种**用法**。规范里那十处
"属于 Extension"，指的是"这件事不由本协议规定，由另一个契约规定" ——
而那个契约如何被两个插件找到、协商、调用，本协议已经规定了。

---

## 2. 形态

一个 Extension 由三样东西构成：

```typescript
// ① 能力：名字 + 版本。名字是 Extension 的身份。
const capability: Capability = {
  name: 'com.example.conflict-lww',   // 反向域名，全局可辨
  version: '1.0.0',                   // SemVer
};

// ② 一份规范文档：说明这个名字对应什么语义、哪些消息、哪些错误码。
//    它不在本仓库里，由 Extension 的作者维护。

// ③ 一组操作：以 request 模式的 Channel 承载，载荷由 ② 定义。
```

三段都可以用既有类型写出来，不需要新接口。

---

## 3. 一次完整的协商

```typescript
// 提供方：声明能力。这是"我支持它"的唯一表达方式。
provider.manifest.capabilities.push({ name: 'com.example.conflict-lww', version: '1.0.0' });

// 消费方：在使用之前先发现自己是否被支持。
const matches = await discovery.find({ capability: 'com.example.conflict-lww', version: '^1.0.0' });

// 没有被支持时，显式失败，而不是退回 Core 的行为。
if (matches.length === 0) {
  throw new EappError('EAPP_UNSUPPORTED', 'peer does not expose com.example.conflict-lww@^1.0.0');
}

// 建立关系，由 Binding 派生 request Channel，再按 ② 定义的载荷调用。
const binding = await core.bind({ from: providerIdentity, to: consumerIdentity, capability: matches[0].capability });
```

**`find()` 必须在建立 Binding 之前。** 这是使用 Extension 与使用 Core 的重要区别：
Core 的操作在任何实现上都存在，Extension 的操作不保证存在，
所以"先问再用"不是礼貌，是正确性。用到一个对端没有的能力而不先查，
结果由 `EAPP_UNSUPPORTED` 决定 —— 而那已经太晚了，调用方无从知道缺的是哪一个。

---

## 4. Extension 不可以做什么

以下几条不是本页的发明，是 Core 已经冻结的约束，列在这里是因为写 Extension 时最容易撞上。

**不得修改 Core 的类型。** `Binding` 不得携带 `mode` / `delivery` / `channel` 等交互语义（v3.0 §6.9 / `CH-1`）；
`Identity` 正好三个字段（`ID-6`）；`StateChannelConfig.conflictPolicy` 在 Core 里只有 `'cas'`（v3.2 `CF-1`）。
**Extension 增加新的能力，不改变既有能力。**

**不得放宽冻结的取值。** 例如非 CAS 的冲突策略：`CF-3` 要求它"定义在 Extension 中"，
但 `StateChannel` 的 `conflictPolicy` 仍是 `'cas'` —— 非 CAS 策略不能经由那个字段选中，
而要由 Extension 提供自己的路径（v3.2 §10.5，勘误 E-M）。
把策略名塞进能力声明、却仍以 `conflictPolicy: 'cas'` 配置 Channel，
会让那个字段成为一句假话。

**不得静默降级。** 不支持的能力必须显式失败（v3.1 §10.4 `TR-9`），
而不是退回 Core 的语义当作已经满足。跨实现时，静默降级与数据损坏等价。

---

## 5. 规范里那十处，分别怎么落

| 出处 | 所指 | 落法 |
|---|---|---|
| v3.0 §4.1 | 更丰富的 `Constraint` 匹配（范围、偏序、谓词） | 不作为 `Criteria.constraints` 的扩展。提供方把它做成一个能力，消费方先 `find()` 再 `bind()`；语义由 Extension 自己的文档定义 |
| v3.0 §4.1 | "需要一个语义协商机制" | 那个机制是 §8 `Discovery` + §9 `Composition`。本协议的协商单位是 `Capability`，Extension 沿用它 |
| v3.2 §10.5 `CF-3` | 非 CAS 的冲突策略 | 由 Extension 提供自己的路径，`StateChannel` 保持 CAS-only。见 §4 |
| v3.2 §12.4 | CRDT 的冲突合并策略 | 同上。CRDT 形态的存储声明 `supportsStateRevision: false`（`TS-4`），其合并策略属于提供该策略的 Extension |
| v3.2 §17 | 无查询语言 | 查询是一组操作，以 `request` Channel 承载，载荷由 Extension 定义 |
| v3.2 §17 | 无多 key 事务 | 同上。事务边界是 Extension 的语义，不是 `StateChannel` 的 |
| v3.2 §17 | Snapshot 非 linearizable | 这是一条**能力声明**的诚实性问题，不是 Extension：声明 `stateConsistency` 时如实写 |
| v3.0 §18.1 | "新增 Extension 章节" | 指协议本身可以把某个 Extension 的语义**吸收**进来，那是一次 `3.x.0` 变更，走 [`rfcs/`](../../rfcs/README.md) |

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

- [概念：三层心智模型](./concepts.md) —— §7 说明什么不属于 Core
- [写一个插件](./write-a-plugin.md) —— capability 与 manifest 的用法
- [`Capability`](../reference/capability.md) · [`Discovery`](../reference/discovery.md) ·
  [`Binding`](../reference/binding.md)
- [v3.0.0-core §4 / §8 / §9](../spec/v3.0.0-core.md) · [v3.2.0-state §10.5](../spec/v3.2.0-state.md)
- [RFC 0001（已否决）](../../rfcs/0001-extension-mechanism.md) —— 为什么这件事不由新的规范性规则解决

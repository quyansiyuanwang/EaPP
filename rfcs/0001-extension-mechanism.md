# RFC-0001　Extension 机制的规范化

| | |
|---|---|
| **状态** | Draft |
| **§18.1 归类** | `3.x.0`（新增 Extension 章节，§18.1 明确允许） |
| **协议版本影响** | 次版本：`3.3.0` → `3.4.0` |
| **评审** | 待评审 |
| **作者** | EaPP 维护者 |
| **日期** | 见提交记录 |

---

## 1. 问题

规范有十处把内容指派给 Extension，而 **Extension 从未被定义**。

| 出处 | 原文 |
|---|---|
| v3.0 §4.1 | 更丰富的匹配（范围、偏序、谓词）属于 Extension，MUST NOT 混入 Core |
| v3.0 §4.1 | 任何比这更聪明的规则都需要一个语义协商机制，而那属于 Extension |
| v3.0 §18.1 | `3.x.0`：新增不变量、新增合规等级、新增错误码、**新增 Extension 章节** |
| v3.2 §10.5 | `CF-3  Other policies (last-write-wins / merge / crdt / quorum / unconditional) MUST be defined in Extension` |
| v3.2 §12.4 | CRDT 的冲突合并策略属于 Extension |
| v3.2 §17 | 无查询语言 / 无多 key 事务 / Snapshot 非 linearizable → Extension |

读者按规范实现时会到达"那属于 Extension"，然后无处可去。更严重的是，
**规范自己指出了缺口**：v3.0 §4.1 承认"需要一个语义协商机制"，并把它推给一个未定义的东西。

### 缺口是可以给出反例的

两个都自称合规的实现，会在一处 Extension 上安静地分道扬镳：

```
实现 A：支持 conflictPolicy = 'last-write-wins'，按 Extension 定义实现
实现 B：只实现 Core 的 CAS

A 配置一个 'last-write-wins' 的 Channel，B 收到后：
  ① 静默当作 CAS 处理  →  B 认为合规，A 认为冲突策略被遵守，而它没有
  ② 静默忽略该配置      →  同上，且没有任何一方能发现
  ③ 返回错误            →  这是唯一正确的行为，但规范没有要求它
```

②是默认结局：Core 里没有"这个策略我不认识"的表达方式，因为 Extension 没有身份。
这不是边界情况 —— `CF-3` 把"除 CAS 外的全部策略"都放进了 Extension，
而 §12.4 的能力矩阵里 CRDT 一行正是这种情形。

### 更根本的一处

v3.0 §4.1 说更丰富的 `Constraint` 匹配属于 Extension。若 A 用范围匹配筛选、
B 用精确匹配，`find()` 在 B 上**静默返回空集** —— 与"没有插件匹配"无法区分。
这正是勘误 E-I 在 Core 内修掉的同一类问题（"匹配"含义未定），
只是在 Extension 上它重演一次，且这次连规定都没有。

---

## 2. 提案

新增一节 **§21 Extension**，措辞如下：

```text
X-1  An Extension MUST be identified by an (id, version) pair:
     `id` a namespaced string, `version` a SemVer. The pair MUST be globally unique.
     The `id` MUST be the name under which the Extension's specification is published.

X-2  An Extension MUST be exposed as a Capability (§5). An Extension MUST NOT add
     primitives to Core types, change the semantics of Core operations, or introduce
     new Core error codes.

X-3  An Extension MUST NOT contradict, weaken, or redefine any Core invariant, error
     code, or type. Where an Extension and Core disagree, Core governs.

X-4  Support for an Extension MUST be discoverable before use: the Extension MUST be
     exposed as a Capability whose name is `id` and whose version is `version`, so that
     §8 Discovery and §9 Composition negotiate it with no new machinery.

X-5  Using an Extension that the peer does not expose MUST fail explicitly.
     An implementation MUST NOT fall back to a Core behaviour as if the Extension
     had been honoured.

X-6  An Extension MUST have a normative specification stating its `id`, `version`,
     and semantics. An implementation claiming an Extension MUST cite that document.
```

### 设计要点

**没有新原语。** `X-2` 与 `X-4` 把 Extension 表达为既有的 `Capability`。
这不是回避，而是 §5 与 §8 已经具备的能力：能力有名、有版本、可被筛选、可被绑定。
Extension 需要的语义协商机制，Core 里已经有了 —— 缺的只是"Extension 必须走这条路"的规定。

**`X-5` 是这条提案里唯一有分量的约束。** 它禁止静默降级。这与 TR-9
（不支持的特性必须显式失败）是同一条原则，但方向相反：TR-9 管的是**底层**不具备能力，
`X-5` 管的是**对端**不具备能力。两者都拒绝"给一个安静的错答案"。

**`X-3` 使 Core 保持权威。** Extension 可以加东西，不能改东西。
没有这一条，Extension 就成了"绕过不变量"的后门。

---

## 3. 为什么不维持现状

不采纳时，"属于 Extension" 是一句无处兑现的话，且有两类具体后果：

1. **`CF-3` 不可实现。** 它 MUST 要求除 CAS 外的策略定义在 Extension 中，
   而 Extension 没有身份 —— 于是这条 MUST 既无法被满足，也无法被检查。
2. **反例中的 ①② 是安静的。** 项目已经反复确认：**漏掉任何一条，错误都是安静的。**
   Extension 的缺失恰好落在这一类上。

而 §18.1 已经把"新增 Extension 章节"列为 `3.x.0` 允许的变更 ——
规范预留了这个位置，只是一直空着。

---

## 4. 对既有实现的影响

| 实现 | 会变成不合规吗 | 需要改什么 |
|---|---|---|
| `packages/`（TypeScript 参考实现） | 否 | 未实现任何 Extension，`X-1`…`X-4`、`X-6` 因而无对象。`X-5` 已满足：`state-channel.ts:234` 对任何非 `'cas'` 的 `conflictPolicy` 抛 `EAPP_UNSUPPORTED`，`StateChannelConfig.conflictPolicy` 的类型也只允许 `'cas'` |
| `implementations/go/` | 否 | 同上。Go 实现仅覆盖 Composition Core，不触及 `conflictPolicy` |

**`X-5` 不需要实现改动。** 提案起草时曾怀疑参考实现对未知策略静默按 CAS 处理；
核实后不是 —— 它在类型与运行时两处都拒绝。这条不变量因此**当前就已成立**，
本提案做的是把已有的正确行为写成规范，而不是要求一次修改。

这是提案的常见形态：实现先做对了，规范还没有说它必须做对。
E-I（`Constraint` 匹配）与 E-H（已被删除的 Cursor）都属于这一类。

---

## 5. 一致性

| 不变量 | 规则 | 测试 |
|---|---|---|
| `X-1` | Extension 由 `(id, version)` 标识 | `core.test.ts`，校验非法 id（非命名空间、空版本）被拒绝 |
| `X-2` | Extension 以 Capability 暴露，不新增 Core 原语 | `core.test.ts`，断言 Extension 不引入任何 Core 类型成员 |
| `X-3` | 与 Core 冲突时以 Core 为准 | 结构性。与 `B-8`（唯一性检查与创建必须原子）同类，可能不可外部观察 |
| `X-4` | 支持性必须可被发现 | `core.test.ts`，`find({capability: id, version: range})` 能定位支持方 |
| `X-5` | 对端不支持时显式失败 | `interaction.test.ts`，未知 `conflictPolicy` 抛码而非静默按 CAS 处理 |
| `X-6` | Extension 必须有规范文档 | 不可测。这是一条对**规范作者**的约束，不是对实现的 |

`X-6` 与 `X-3` 属于"不可外部观察"的一类。`conformance/README.md` 已登记了
同类情形（`B-8`），本提案沿用相同的处理方式：说明它为什么不可观察，而不是假装覆盖了。

---

## 6. 被否决的替代方案

**① 在 Core 里直接扩展 `conflictPolicy` 联合。**
否决：§10.5 与 `CF-3` 明确要求这些策略 MUST NOT 出现在 Core 里。
把 `'last-write-wins'` 加进 Core 的联合类型，等于让每个实现都必须理解它 ——
与"Core 最小"这一整个分层前提冲突。

**② 用 `Criteria.constraints` 承载 Extension 的身份。**
否决：`Constraint` 是 `{ kind, value }`，没有版本。Extension 必然需要版本 ——
`X-1` 的核心就是"没有版本的扩展身份无法协商"。用 `constraints` 表达，
两个实现会在同一个 id 的不同版本上彼此以为对方理解自己。

**③ 给 `ConformanceClaim` 增加 `extensions` 字段。**
否决（本提案范围内）：§19.3 的接口是冻结的，增加字段属于 `4.0.0`。
而且不必 —— Extension 的支持已经由 `X-4` 通过 Capability 表达，
声明接口属于协议，Extension 在协议之外。见 §7。

**④ 只写一份非规范指南，不改规范。**
否决：`CF-3` 已经是一条 MUST，它引用了 Extension。指南无法使那条 MUST 可满足。

---

## 7. 未解决的问题

1. **`id` 的命名空间形式未定。** `X-1` 只要求"命名空间字符串"。
   是否强制反向域名、是否允许分层，需要先有真实 Extension 才能判断 ——
   现在定死会产生一条无法验证的格式规则。

2. **不可观察的不变量如何计入合规。** `X-3` 与 `X-6` 无法由外部 harness 检查。
   `conformance/README.md` 目前把这类条目标记为"未覆盖并注明原因"，
   但没有说明它们是否计入 `passed` / `total`。这与 `B-8` 是同一个悬而未决的问题。

3. **Extension 之间的一致性无人裁决。** 本提案规定 Extension 与 Core 的关系，
   没有规定两个 Extension 互相冲突时怎么办。当前答案是"没有机制"，
   而这可能是正确的 —— 但应当写下来。

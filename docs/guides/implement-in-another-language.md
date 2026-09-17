# 用另一种语言实现 EaPP

> 协议的价值在于**能被第二次实现**。本页面向以 Go / Rust / Java / Python
> 等语言实现 EaPP 的开发者，说明哪些部分必须逐字遵守、哪些部分可以自行决定，以及如何验证实现的正确性。

---

## 1. 实现对象

三层是**单向依赖**的，所以可以实现其中一部分：

```
Composition Core   谁和谁组合              ← 先做这个
      ↓
Interaction Layer  组合后如何互动          ← 再做这个
      ↓
State Mode         如何共享状态            ← 最后做这个
```

**只实现 Composition Core 是合法的。** 一个只做组合、不做消息的系统仍然可以宣称
符合 C1–C3。反之不行 —— 没有 Binding 就派生不出 Channel。

---

## 2. 规范性 vs 实现自由

这是最容易出错的地方。界限是：

| 类别 | 是否规范 | 例子 |
|---|---|---|
| **语义** | 规范 | "Binding 状态 MUST 派生，MUST NOT 被直接设置" |
| **不变量** | 规范 | 全部 210 条，逐条编号 |
| **错误码** | 规范 | `EAPP_REVISION_CONFLICT` 必须是这个字符串 |
| **数据形状** | 规范 | `Identity` 正好三个字段 `domain` / `id` / `instance` |
| **语言类型** | **自由** | TS 里是 `interface`，Go 里可以是 `struct`，Rust 里可以是 `struct` + trait |
| **并发模型** | **自由** | actor、goroutine、线程池、协程都可以 |
| **序列化格式** | **自由** | JSON / Protobuf / MessagePack / 自定义二进制 |
| **存储布局** | **自由** | 内存 / SQL / KV / 文件 |

**判据**：如果一条规则改变后，两个实现互相之间会产生**不同结果**，它就是语义，必须规范。
如果只是内部怎么放，就是实现自由。

---

## 3. 五件各语言都容易做错的事

### 3.1 `Revision` 与 `Cursor` 必须**不透明**

`Revision = string`，`Cursor = string`。它们是**同一个域上的同一类型** ——
一次写入在 Channel 状态日志中的位置。

```
MUST      把 revision 当作不透明 token：存储它、传回它、用 transport 比较它
MUST NOT  解析它、拼接它、自己生成它、用 < 直接比较它
MUST NOT  跨 Transport 比较它
```

以整数或时间戳实现较为自然，但**不可采用** ——
一旦消费者开始依赖其内部结构，一个实现细节就被冻结成了跨实现契约。

比较**必须**由 Transport 提供：`compareRevision(a, b) → -1 | 0 | 1`，
并且当任一参数不是本 Transport 实例签发的值时必须拒绝。

### 3.2 Binding 状态是**派生**的，不是存储的

不要把 `state` 字段存进 Binding 然后赋值。它由三件事算出来：

```
CLOSED   ⟸ 已被显式 unbind
ACTIVE   ⟸ 未被 unbind ∧ from 是 ACTIVE ∧ to 是 ACTIVE ∧ from 仍暴露该 Capability
DORMANT  ⟸ 其余情况
```

实现成字段会引入一整类无法调试的状态不同步。**算出来，别存。**

### 3.3 `expectedRevision: null` 不等于"当前不存在"

```
null       key 从未存在过
Revision   key 存在且 revision 精确匹配
```

**已逻辑删除的 key 仍然算"存在"**，所以 `null` 不能复活它 —— 复活必须携带旧 revision。
很多实现会写成 `if (current != null && !current.deleted)`，那正是原始草案的错误。

### 3.4 删除**不是** `set(deleted: true)`

必须是一等原语。原因很具体：Transport 要能区分"删除"与"创建"，
否则下面两条无法同时成立：

```
delete 不存在的 key，expectedRevision = null  → EAPP_STATE_KEY_NOT_FOUND
set    不存在的 key，expectedRevision = null  → 成功
```

把 delete 实现成 set 的语法糖，第一个错误码就永远产生不出来。

### 3.5 `get` 必须**返回**已删除的 cell

```
key 从未存在   → null
key 存在       → 返回 cell，含 deleted: true 或 false
```

如果 `get` 对已删除返回 `null`，那么"删除已删除的 key 是 no-op 成功"这一分支
永远不可达 —— 因为调用方拿不到那个 key 的 revision。

---

## 4. 一致性套件的判定标准

不要只对着规范正文写实现。规范说**规则是什么**，
`tests/conformance/` 说**怎样算做到了**。

```bash
pnpm run check:invariants    # 210 条不变量各自对应哪个测试
```

读这四个文件，它们是各层的验收清单：

| 文件 | 覆盖 |
|---|---|
| `tests/conformance/core.test.ts` | 51 条（v3.0） |
| `tests/conformance/interaction.test.ts` | 75 条（v3.1） |
| `tests/conformance/state.test.ts` | 84 条（v3.2） |
| `tests/conformance/runtime.test.ts` | 端到端场景 |

**测试名包含不变量 ID**，可逐条对照实现情况：

```
CG-6: an expired claim returns to the group on its own
REV-8: revisions are not comparable across transports
SU-7 / TS-6: CAS is atomic under concurrency
```

### 建议的移植顺序

1. 把四份测试**翻译成目标语言**，先不写实现，只让它们编译通过。
2. 实现 `@eapp/core` 的五个本体，让 `core.test.ts` 的 51 条全绿。
3. 实现一个内存 Transport，让 `interaction.test.ts` 的 75 条全绿。
4. 实现 State Mode，让 `state.test.ts` 的 84 条全绿。

这个顺序不是随意的：每层只依赖下层，所以每步都有完整的绿灯可依赖。

---

## 4.1 不用翻译测试：跑语言中立的 harness

上面第 1 步是最贵的一步 —— 把四份 TypeScript 测试翻成另一种语言，翻的过程中
很容易把参考实现的**习惯**当成规范的要求。仓库里有一件更好的东西：

```bash
pnpm run conformance:external
```

它按 [driver 协议](../../conformance/driver.md) 拉起一个**可执行文件**，
用 JSON lines 问它问题，只看它答什么。harness 本身是一个不 import 任何
`@eapp/*` 的 Node 脚本 —— 所以它检查的只有协议的表面行为。

需要的不是翻译测试，而是**实现一个 driver**：stdin 收请求、stdout 回响应、
启动时先说一句 hello。所有操作、数据形状与错误码都在那页里定死了。

```bash
node conformance/harness/run.mjs --driver "<可执行文件>" --cwd <工作目录>
node conformance/harness/run.mjs --list              # 有哪些检查项
node conformance/harness/run.mjs --only B-3          # 只跑一条
```

`hello.layers` 里没写 `core` 的话，Core 的检查会**跳过而不是判失败** ——
没实现的层不该被算成失败。

**覆盖到哪里、哪里没覆盖，都写在 [`conformance/README.md`](../../conformance/README.md) 里**，
逐条列的是 v3.0 的 51 条不变量。该清单不是覆盖率数字：
未覆盖的每一条均注明原因，其中 B-8（唯一性检查与创建必须原子）是一条
**并发**要求，而串行的 stdio driver 结构上无法表达它 —— 该条须在实现语言内自行测试。

参考实现自己也有一个 driver（`conformance/drivers/reference.ts`）。它在那儿是为了
**证明 harness 公平**：只有一套实现被检查时，一条恰好编码了它习惯的检查看起来
就像规范要求。两套独立实现跑同一批检查，这件事才会暴露 —— 它确实暴露了（见那份 README）。

---

## 5. 几个具体陷阱

**`exactOptionalPropertyTypes` 那个坑不是 TypeScript 特有的。**
`StateUpdate` 的 `value` 字段用**属性存在性**判断，不是 `value != null`：

```
{ value: undefined }   是合法写入，语义明确
{}                     非法 —— 必须给 value 或 deleted
```

Go 里用 `*T` 或 `sql.Null` 之类表达；Rust 里用 `Option` 但要注意 `Option<Option<T>>` 的模式。
关键是**三态**：缺席 / 存在且为 undefined / 存在且有值。

**CAS 必须在 Transport 里原子完成。**
不要在 Channel 层"读一次、比一下、再写" —— 那是 TOCTOU。

**无等待的轮询会炸。**
未 ack 的项会被反复重投。参考实现踩过这个坑：堆溢出（OOM）。
节流到 `pollIntervalMs`，或在支持时用 `waitForChange`。

**订阅循环要先注册兴趣再读。**
先读后等会丢失唤醒：写入落在"读"与"等"之间时，通知在无人监听时发出，
随后的等待就会永远阻塞。参考实现踩过这个坑。

---

## 6. 声明合规

任何实现都可以自称实现 EaPP —— **本协议不设认证机构**。
这与"它是一个协议，不是一个产品"是一致的。

但声明应当可验证。本仓库的声明长这样（v3.0 §19.3 的冻结接口）：

```json
{ "eappVersion": "3.2.0",
  "levels": ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "I1", "I2", "I3", "I4", "I5", "I6", "I7"],
  "testSuite": "conformance@3.2.0-r3",
  "passed": 210, "total": 210 }
```

`levels` MUST 只列规范定义过的等级：v3.0 §15 定义 `C1`–`C8`，v3.1 §15 定义 `I1`–`I7`。
v3.2 没有定义独立的等级前缀。规范里不存在的等级 MUST NOT 被声明 ——
本仓库此前误写过 `"S1"`，它在任何一份规范中都不存在，已删除。

`passed` / `total` 统计的是**不变量覆盖**，不是测试条数 ——
因为闸门判定的是覆盖。若实现仅包含 Composition Core，
就声明 `levels: ["C1","C2","C3"]` 并给出那一层的覆盖数字。

**不要声明没做的层。** 见 [`docs/CONFORMANCE.md`](../CONFORMANCE.md) §6 的做法：
本仓库明确列出了自己**没有**实现的东西。

---

## 7. 相关

- [概念：三层心智模型](./concepts.md)
- [实现一个 Transport](./write-a-transport.md)
- [参考](../README.md#参考) —— 每个实体的确切语义
- [规范](../spec/v3.0.0-core.md) —— 唯一裁决者

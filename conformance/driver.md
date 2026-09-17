# Conformance driver 协议

> **非规范性。** 这是**测试接口**，不是协议的一部分。
> EaPP 的规则在 [`docs/spec/`](../docs/spec/)；本文件规定的只是"一个实现要如何被外部检查"。

---

## 为什么有这个

v3.0 §19.3 说实现声称合规时 MUST 声明：

```typescript
interface ConformanceClaim {
  eappVersion: string;
  levels: ('C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8'
         | 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7')[];
  testSuite: string;
  passed: number;
  total: number;
}
```

但仓库里的一致性套件是**用 TypeScript 写的、直接 import 参考实现内部模块的单元测试**。
它对这个声明做不了什么：换一种语言实现 EaPP，那 51 条不变量一条也检查不了。
于是 §19.3 的声明只能靠自称。

这个 driver 协议把"被检查"变成一个**进程中立的接口**：

```
harness（Node，不 import 任何 @eapp/*）
        │  JSON lines over stdin/stdout
        ▼
driver（任何语言）
        │
        ▼
被测实现
```

于是 [用另一种语言实现 EaPP](../docs/guides/implement-in-another-language.md) 不再只是
"照这样写"，而是"照这样写，然后跑这个"。

---

## 传输

一行一个 JSON 对象，UTF-8，`\n` 分隔，双向。标准输入输出，stderr 留给实现自己打日志
（harness 会把它当作诊断信息显示，不解析）。

**启动后实现 MUST 先输出一行 hello：**

```json
{"hello":true,"driver":"eapp-go","layers":["core"],"eappVersion":"3.0.0"}
```

`layers` 是这一份 driver 覆盖的层（`core` / `interaction` / `state`）。
harness 据此决定跑哪些检查 —— **没实现的层不会被误判为失败**。

**请求：**

```json
{"id":1,"op":"identity.create","identity":{"domain":"acme","id":"a","instance":"a-1"}}
```

`id` 由 harness 分配，实现 MUST 在响应里原样回显。**操作自己的参数用各自的键名**
（`identity` / `capability` / `criteria` / `scope` / `from` / `to` / `binding` / `watch` / `seed`），
不与被回显的字段混在一起。

**响应：**

```json
{"id":1,"ok":true,"result":{...}}
{"id":1,"ok":false,"error":{"code":"EAPP_IDENTITY_DUPLICATE","message":"..."}}
```

**事件**（实现主动推，没有 `id`）：

```json
{"event":"discovery","watch":1,"type":"added","plugin":{"domain":"acme","id":"a","instance":"a-1"}}
```

一条请求 MUST 恰好产生一条响应。实现 MAY 在处理过程中推事件。
harness 只按 `id` 配对，所以事件可以插在任意位置。

---

## 数据形状

标识符与字段名与规范逐字一致（v3.0 §16 要求错误码不得改名，同理）。

| 类型 | JSON |
|---|---|
| `Identity` / `PluginRef` | `{"domain":"…","id":"…","instance":"…"}` |
| `CapabilityRef` | `{"name":"…","version":"…"}` |
| `Capability` | `{"name":"…","version":"…","contract"?:{…},"constraints"?:[…]}` |
| `Binding` | `{"id":"…","from":Identity,"to":Identity,"capability":CapabilityRef}` |
| `LifecycleState` | `"INACTIVE"` \| `"ACTIVE"` \| `"SUSPENDED"` |
| `BindingState` | `"ACTIVE"` \| `"DORMANT"` \| `"CLOSED"` |
| `Criteria` | `{"capability"?,"version"?,"constraints"?,"identity"?}` |
| `DiscoveryScope` | `{"trustLevel"?,"trustDomain"?}` |

`Binding.id` 的形状由实现自由决定 —— 它只是 harness 用来引用的句柄。
`Identity` 的 `instance` 省略时由实现铸造（ID-3）。

---

## 操作

### 生命周期与身份

| op | 参数 | 结果 |
|---|---|---|
| `reset` | — | `{}` — 清空一切，回到初始状态 |
| `identity.create` | `identity`（`instance` 可省略） | `Identity` |
| `identity.has` | `identity` | `{"has":bool}` |
| `plugin.register` | `identity`, `capabilities[]` | `Identity`（**铸造后的**权威身份） |
| `plugin.get` | `identity` | `{"identity","capabilities","lifecycle"}` |
| `plugin.list` | — | `[Plugin]` |
| `lifecycle.activate` | `identity` | `{"lifecycle":"ACTIVE"}` |
| `lifecycle.deactivate` | `identity` | `{"lifecycle":"INACTIVE"}` |
| `lifecycle.suspend` | `identity` | `{"lifecycle":"SUSPENDED"}` |
| `lifecycle.resume` | `identity` | `{"lifecycle":"ACTIVE"}` |

> **为什么 `identity.create` 也收一个对象而不是三个平铺字段。**
> 平铺的 `{"op":"identity.create","id":"acme"}` 会和信封自己的关联字段 `id` 撞名 ——
> 一条请求里两个 `id` 含义不同，实现与 harness 都只能靠猜。协议里所有的身份参数
> 一律走 `identity` 对象，没有例外。

### 发现

| op | 参数 | 结果 |
|---|---|---|
| `discovery.find` | `criteria?`, `scope?` | `[Identity]` |
| `discovery.watch` | `criteria?`, `scope?` | `{"watch":int}` |
| `discovery.unwatch` | `watch` | `{}` |

### 组合

| op | 参数 | 结果 |
|---|---|---|
| `composition.bind` | `from`, `to`, `capability` | `Binding` |
| `composition.unbind` | `binding`（id 字符串） | `{}` |
| `composition.binding` | `binding` | `Binding` |
| `composition.bindingState` | `binding` | `{"state":"…"}` |
| `composition.bindings` | — | `[Binding]` |

### 引导

| op | 参数 | 结果 |
|---|---|---|
| `bootstrap.createIdentity` | `seed` | `Identity` |
| `bootstrap.loadFirstPlugin` | `identity` | `Plugin` |
| `bootstrap.initialDiscovery` | — | `{"ok":true}` |

引导的三条不变量（BR-1…BR-3）无法从外部完整观察，
harness 只检查它有初始 Discovery、且未知引用会被明确拒绝 ——
**能检查的部分检查，不能检查的部分明说。**

---

## 错误

`error.code` MUST 是规范定义的码（v3.0 §16），MUST NOT 改名：

```
EAPP_IDENTITY_INVALID      EAPP_IDENTITY_DUPLICATE   EAPP_CAPABILITY_NOT_FOUND
EAPP_CAPABILITY_NOT_EXPOSED EAPP_PLUGIN_NOT_FOUND    EAPP_PLUGIN_INACTIVE
EAPP_BINDING_INVALID       EAPP_BINDING_DUPLICATE    EAPP_BINDING_CLOSED
EAPP_LIFECYCLE_INVALID     EAPP_DISCOVERY_SCOPE_INVALID
EAPP_UNSUPPORTED           EAPP_INTERNAL
```

`message` 是给人看的，harness MUST NOT 解析它 —— 否则各实现会被迫复制参考实现的措辞，
那就成了一个不在规范里的形状要求。

**未实现的操作** MUST 回 `EAPP_UNSUPPORTED`，而不是崩溃或静默成功。
harness 会把这一条当作检查项：它故意发一个不存在的 op。

---

## 怎么跑

```bash
pnpm run conformance:external            # 跑全部随仓库交付的 driver
pnpm run conformance:external -- --driver "go run ./implementations/go/cmd/eapp-driver"
```

harness 不 import 任何 `@eapp/*`，所以它检查的只有这份文档规定的行为。
仓库自带两个 driver：Go 的独立实现，以及 TypeScript 参考实现的适配器 ——
后者存在是为了证明 harness 本身公平：**两套独立实现过同一批检查。**

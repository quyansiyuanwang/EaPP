# 一致性检查（语言中立）

> **非规范性。** 这里是**工具**，不是协议的一部分。

本目录提供**语言中立的规范验证工具**。它按一份固定的测试接口检查一个实现，
自身不引用任何 EaPP 实现 —— 因此"实现了 EaPP"这一声明可以被外部检验，
而不必依赖声明方自己的一致性套件。

```bash
pnpm run conformance:external
```

它做两件事：

1. **`implementations/go/`** —— 用 Go 从规范**独立**实现的 v3.0.0 Composition Core，
   以及一个 driver。写它的人没有被允许读 TypeScript 参考实现。
2. **`harness/`** —— 一个**不 import 任何 `@eapp/*`** 的 Node harness，
   通过 [driver 协议](./driver.md) 对 driver 做黑盒检查。

于是 `docs/guides/implement-in-another-language.md` 不再只是"照这样写"，
而是"照这样写，然后跑这个"。

---

## 目录

```
conformance/
├── driver.md            测试接口的协议（非规范性）
├── README.md            本文件
├── harness/
│   ├── run.mjs          运行器：拉起 driver、跑检查、报告
│   ├── driver.mjs       driver 客户端（只认协议，不认实现）
│   └── checks/core.mjs  v3.0 Composition Core 的黑盒检查
└── drivers/
    └── reference.ts     TypeScript 参考实现的 driver（适配器）
```

`drivers/reference.ts` 的存在是为了**证明 harness 公平**：只有一套实现被检查时，
一条恰好编码了那套实现习惯的检查看起来就像规范要求，别的实现会无辜失败。
两套独立实现跑同一批检查，这件事才会暴露。它确实暴露了 —— 见下面「harness 找到过什么」。

---

## 覆盖了什么，没覆盖什么

检查项共 **33** 条，覆盖 v3.0 §13 的 51 条不变量中的 **40** 条。
**逐条列清楚，比给一个覆盖率数字有用。**

### 已覆盖

| 组 | 不变量 |
|---|---|
| Identity | ID-1、ID-2、ID-3（含"同 id 不同 instance"）、ID-5、ID-6 |
| Capability | C-1、C-2、C-3、C-4、C-6、C-7 |
| Plugin | P-1、P-2、P-3 |
| Binding | B-1、B-2、B-3、B-4、B-5、B-6 |
| Lifecycle | L-1、L-2、L-3、L-4、L-5、L-6 |
| Discovery | D-1（部分）、D-2（部分）、D-3、D-5、D-6 |
| Operations | O-1、O-3、O-4、O-5、O-6、O-7、O-8 |
| Bootstrap | BR-3 |

覆盖 40 条中的一部分是"部分覆盖" —— D-1 / D-2 的 Trust Scope 那一半需要一套信任策略
fixture，driver 协议目前没有暴露它。

### 没有覆盖，以及为什么

| 不变量 | 为什么检查不了 |
|---|---|
| ID-4 Identity MUST be immutable | 不可变性在外部不可观察：改不动的东西和改得动但没人改的东西长得一样。P-3 做了它能做的那一半 |
| C-5 CapabilityRef MUST include version | 每个 `bind` 都带 version，所以"少了会怎样"需要一条协议里不存在的请求形状 |
| P-4 Capability set MAY change via explicit declaration | `plugin.register` 是唯一的声明入口，没有"重新声明"的操作 |
| B-7 `capability.plugin` MUST equal `from` | 这是内部表示的一致性要求。可以让 driver 把 `capability.plugin` 吐出来检查，但那就把一条内部形状变成了跨实现要求 |
| **B-8 uniqueness check + creation MUST be atomic** | 外部 driver 是串行的（stdio 上一条请求一条响应），所以并发 `bind` 根本走不到。参考实现有一个 `go test`/单元测试专门打它（`packages/core`），但**跨实现的检查做不到** —— 要给 driver 协议加一个"并发发起 N 个请求"的形状才行 |
| B-9 PENDING Binding MUST NOT be externally observable | 中间状态按定义观察不到 |
| D-4 Discovery MAY cache | MAY 不是 MUST，缓存与否是实现的自由；参考实现有 `cacheStats()`，但那不是规范形状 |
| 未读的 watch 队列无界增长 | `watch` 的队列是每条 watcher 一个、不设上限的。消费者停止迭代却又不 `close()` 时，事件会一直堆积。规范没有规定丢弃策略，所以**这里也不发明一条** —— 那会让别的实现在一条无从检查的规则下被静默丢事件。关闭是消费者的责任 |
| D-7 Trust level MUST NOT imply ordered authorization | 需要一个会做授权的实现才能看出顺序；本层不做授权 |
| CH-1 Core MUST NOT define Channel semantics | 一个否定性的结构主张，不是运行时可观察的行为 |
| BR-1 / BR-2 | BR-1 要有"一个不存在的根被换掉"的路径，BR-2 要检查依赖关系图。BR-3 能查，另外两条不能 |

**缺口写在这里而不是藏起来，是因为它们比通过的部分更需要被知道。**
B-8 尤其：它是一条并发正确性要求，而外部 harness 在结构上看不到它。

---

## harness 找到过什么

第一次跑就找出三件事 —— 其中两件是关于 harness 自己的。

**① 参考实现的 `Discovery.watch()` 从不产生事件。**

§8.1 把 `watch` 定义成 Discovery 的操作，返回 `AsyncIterable<DiscoveryEvent>`。
实现里有事件队列、有作用域过滤、有类型校验、有测试 —— 而**没有任何东西调用产生事件的那个方法**。
调用方必须已经知道某个插件变了，才能被通知说某个插件变了。

`core.test.ts` 里那条 D-2/D-6 测试之所以通过，是因为它**自己手动调了 `notify()`**。
闸门要求"每条不变量有测试"，测试也真的在，而功能是死的。

已修：注册表变更现在会自动映射成 `added` / `changed`（`packages/core/src/discovery.ts`），
并补了一条**不碰 `notify()`** 的测试。

**② harness 的 `B-6` 检查是错的 —— 它只接受规范允许的两种行为之一。**

§6.8 明说重复 `bind` **MAY return existing Binding 或 fail with `EAPP_BINDING_DUPLICATE`**。
我写检查时钉死了后者，于是参考实现（它返回既有的那个，完全合规）被判失败。

已修：检查现在断言两种结果都满足的那条不变量 —— 该三元组上恰好存在一个非 CLOSED Binding。
**一条钉死某一种合规行为的检查，会把合规的实现判成不合规。**

**③ driver 协议自己有设计缺陷。**

`identity.create` 原本收平铺的 `domain` / `id` / `instance`，而信封自己的关联字段也叫 `id`。
一条请求里两个 `id` 含义不同，harness 把插件的 id 当成了请求 id。
已修：身份参数一律走 `identity` 对象，没有例外。

---

## 加一个实现

1. 按 [`driver.md`](./driver.md) 实现一个可执行文件，stdin/stdout 说 JSON lines。
2. 跑：

```bash
node conformance/harness/run.mjs --driver "<命令>" --cwd <工作目录>
```

`--list` 列出全部检查项，`--only B-3` 只跑一条，`--verbose` 显示通过的每一条。

driver 的 `hello.layers` 里没写 `core` 的话，core 检查会被跳过而不是判失败 ——
**没实现的层不该被算成失败。**

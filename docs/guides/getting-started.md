# 快速上手

> **本页说明如何运行参考实现，并解释 `pnpm run demo` 的每一行输出。**

先读 [概念：三层心智模型](./concepts.md)。演示里的每一行都落在某一层上，
不知道层与层的分工，输出就只是一串日志。

---

## 1. 前置条件

| 依赖 | 版本 | 出处 |
|---|---|---|
| Node.js | `>= 20` | `package.json` 的 `engines.node`；CI 用 22 |
| pnpm | 10 | `.github/workflows/verify.yml`（`pnpm/action-setup@v4`） |
| TypeScript | 仓库自带的 `typescript@^7.0.2`，无需全局安装 | `devDependencies` |
| Go | `>= 1.24` | 第 ⑥ 段要 `go run` [独立实现](../../implementations/go/)；只跑前五段的话不需要 |

不需要构建步骤：一致性套件、示例与 `tsx` 都**直接跑 `packages/*/src` 下的源码**，
别名映射写在 `vitest.config.ts` 与 `tsconfig.json` 的 `paths` 里。
Go 那份也不需要预先编译 —— 第 ⑥ 段用 `go run` 直接拉起 driver。

---

## 2. 安装

```bash
pnpm install
```

CI 使用 `pnpm install --frozen-lockfile`；本地要复现 CI 的行为时用同一条命令。

---

## 3. 验证：`pnpm run verify`

```bash
pnpm run verify
```

它是六段串联（`package.json` 的 `verify` 脚本），**任何一段失败都会中断后面的段**：

| 段 | 命令 | 这一段在验证什么 |
|---|---|---|
| ① 类型 | `pnpm run typecheck` | `tsc -p tsconfig.json --noEmit`。strict + `exactOptionalPropertyTypes`；成功时**没有任何输出** |
| ② 一致性套件 | `pnpm run test` | `vitest run`。按规范分层组织（core / interaction / state / socket / runtime 端到端） |
| ③ 示例 | `pnpm run examples` | [示例](../../examples/README.md)真的跑得起来，且各自的自检全部成立 |
| ④ 冻结闸门 | `pnpm run check:invariants` | v3.0 §19.2 的冻结义务：**每个不变量 MUST 至少有一个对应的测试用例** |
| ⑤ 文档链接闸门 | `pnpm run check:docs` | 相对链接是否都能落到真实文件；只查相对链接，不联网 |
| ⑥ 跨实现一致性 | `pnpm run conformance:external` | 用**不 import 任何 `@eapp/*`** 的 harness，按 [driver 协议](../../conformance/driver.md) 黑盒检查两套独立实现 |

具体条数以命令输出为准 —— 文档里的数字会过期，闸门不会。
写这份文档时是 200 条测试、210 条不变量、462 条链接、33 条跨实现检查 × 2 套实现。

第 ④ 段不是"覆盖率数字"，而是一组集合判定：它从每份规范末尾的
「不变量」小节提取声明的 ID（v3.0 / v3.2 的标题是「不变量（冻结全集）」，
v3.1 的是「不变量（汇总，冻结全集）」—— 工具匹配任何含"不变量"的小节标题），
与对应测试集中**出现的** ID 求差集，
差集非空即失败；它同时拒绝**空测试体**、拒绝**测试文件缺失**，
并检查"在汇总表里列了、正文却从未陈述"的孤立 ID。
所以**在规范里写下一个新不变量，等于同时承诺一个测试。**

第 ④ 段的成功输出形如：

```
v3.0.0-core
  spec      docs/spec/v3.0.0-core.md
  suite     tests/conformance/core.test.ts
  invariant 51/51 covered
  gate      PASS

v3.1.0-interaction
  spec      docs/spec/v3.1.0-interaction.md
  suite     tests/conformance/interaction.test.ts
  invariant 75/75 covered
  gate      PASS

v3.2.0-state
  spec      docs/spec/v3.2.0-state.md
  suite     tests/conformance/state.test.ts
  invariant 84/84 covered
  gate      PASS

FREEZE GATE: PASS
```

第 ⑤ 段扫描 `docs/` 与 `examples/` 两棵树下的全部 Markdown。
放在闸门扫描范围之外的文档，等于链接没人检查的文档。

---

## 4. 演示：`pnpm run demo`

```bash
pnpm run demo
```

它执行 `tsx examples/hello-plugins/index.ts`：三个**互不相识**的插件被注册、发现、连接、
激活、调用，并共享一份带版本的状态。下面用同一份输出逐段讲。

`binding-1`、`ch-1` 这类 id 按创建顺序递增，因此实际输出中的数字可能不同；
判读时看的是形状与语义，不是字面值。
源码里的 `\x1b[1m` 只是把标题加粗，下面引用的是去掉 ANSI 转义后的纯文本。

```
1. Discovery — 发现
─────────────────
  logger     INACTIVE  logging@1.0.0, sessions@1.0.0
  metrics    INACTIVE  metrics@2.1.0
  checkout   INACTIVE  (none)

  find({ capability: 'logging' }) -> logger
  Discovery found the logger, but nothing is composed yet:
  bindings = 0  (D-3: discovery ≠ composability)
```

**这一段来自 v3.0 Composition Core。** `runtime.register()` 把三个
[`Plugin`](../reference/plugin.md) 放进注册表，每个都带着自己的
[`Identity`](../reference/identity.md)（`domain/id/instance`，**不含版本**）与
[`Capability`](../reference/capability.md) 列表。第二行是 `runtime.describe()`：
`lifecycle` 全是 `INACTIVE` —— 注册只让插件**可被发现**，它还没有进入任何组合。

`runtime.discover({ capability: 'logging' })` 走的是
[`Discovery`](../reference/discovery.md)；命中的是 `name === 'logging'` 的插件。
`version` 是 **SemVer range**（§8.1）：写 `'1.0.0'` 就是那一个版本，写 `'^1.0.0'`、
`'>=2'` 或 `'*'` 才是范围；语法不认识的范围会被**明确拒绝**，不会静默不匹配。
最后一行 `bindings = 0` 是 D-3：**发现得到的是"可以被组合"，不是"已经可以调用"。**

```
2. Activation — 激活
──────────────────
  [logger] activated — now part of the active composition
  [metrics] activated — ready to publish samples
  [app] activated — it declares no capabilities of its own
```

**v3.0 Lifecycle。** `runtime.activate()` 先把插件推进到 `ACTIVE`，再调用模块自己的
`activate()` 钩子 —— 三个插件各自打印一行。此刻还没有任何关系；
[`Binding`](../reference/binding.md) 不是被"设置"成某个状态，而是**由两端状态派生**（见下一段）。

```
3. Connect — 连接
───────────────
  binding   binding-1
  channel   ch-1  mode=request  delivery=at-most-once
  binding state = ACTIVE  (derived, never assigned)
```

**这一步跨两层。** `runtime.connect()` 先做 v3.0 的 `bind()`，得到一个
[`Binding`](../reference/binding.md)；
再走 v3.1 的 Channel 创建路径（v3.1 §12）：由这个 Binding **派生**一个
[`Channel`](../reference/channel.md) 并 `connect()` 到 `ACTIVE`。

`delivery=at-most-once` 不是谁写死的：`request` 模式没有显式指定投递保证时，
按 §4.4 推导为 `at-most-once`（[`Delivery`](../reference/delivery.md)）。
`binding state = ACTIVE` 是**派生结果**：两端都 `ACTIVE`、`from` 仍暴露该 Capability、且未被 `unbind`。
没有人能把 Binding "设为" `ACTIVE`。

```
4. Invoke — 调用
──────────────
  reply: {"line":"INFO checkout completed","total":1}
  3 concurrent calls, correlated independently: DEBUG one | DEBUG two | DEBUG three
```

**v3.1 的 request 模式。** `app` 调用（消费方）通过 `runtime.invoke()` 请求 `logger`
（`logging` 能力的提供方）。`invoke()` **不是**直接调函数：它把请求信封
（`type: 'request'`、`correlationId`、`operation`、`caller`、`payload`、`deadline`）
`send` 进 Transport，再由通道上的 dispatcher 读回来交给 handler ——
信封形状沿用 v3.1 §3.1 的冻结定义。

`reply` 是 handler 的返回值，原样回来。第二行是三个 `Promise.all` 并发调用：
它们共享同一条 Channel，靠 **`correlationId` 各自配对**（RQ-1～RQ-3：一个请求至多一个响应，
且必须匹配 correlationId），所以不会被彼此串味。

超时是这一段的隐藏条款：`invoke()` 默认 `5000ms` 后以 `EAPP_TIMEOUT` 拒绝，
并且**放弃**该请求（RQ-4）—— timeout 之后再到的响应会被丢弃，不会二次 resolve。

```
5. Communicate — 通信
───────────────────
  subscribed at cursor ""  (resolved eagerly)
  received: [{"type":"metric","value":12},{"type":"metric","value":47},{"type":"metric","value":91}]
  cursor after acks: "mem-1!0000000000000011"
```

**v3.1 的 event 模式 + Subscription。** 这里新建了第二条 Channel（`mode='event'`），
然后 `runtime.subscribe()` 建了一个 [`Subscription`](../reference/subscription.md)。

订阅时没有给位置，默认锚点是 `'latest'`，而锚点 **MUST 在订阅创建时立即解析**（eager）——
所以打印出来的 [`Cursor`](../reference/cursor.md) 已经是一个具体值，不是 `undefined`。
这里得到 `""` 是因为这条 Channel 刚建好、还没有任何消息；这个空串是"日志起点"的哨兵值，
它排序在所有已分配 cursor 之前。

`for await` 循环里每一轮做两件事：拿到消息、**显式 `await message.ack()`**。
[`AckContext`](../reference/ack-context.md) 存在的原因就是 CR-1：
**收到消息 ≠ 已确认。Cursor MUST NOT 随收到消息自动前移，它只随 ack 前移。**
三个数被 publish 之后，循环 ack 三次，cursor 从 `""` 前进到 `mem-1!0000000000000011` ——
`mem-1!` 是 transport 实例前缀，后面固定 16 位零填充十进制是该 Channel 日志中的位置。

```
6. Shared state — 共享状态
──────────────────────
  set active=0   -> revision mem-1!0000000000000012
  set active=1   -> revision mem-1!0000000000000013
  3 writers with the same token -> 1 won, 2 rejected
  rejection code: EAPP_REVISION_CONFLICT (retryable=true)
  final: 42  — no lost update
  watcher saw [45] at revision "mem-1!0000000000000015"
```

**v3.2 State Mode。** `runtime.stateChannel()` 先在 `mode='state'` 上建 Channel
（该模式只允许 `at-least-once`），再把 Channel 配置成一个
[`StateChannel`](../reference/state-channel.md)。

写入返回的不是值，而是 [`Revision`](../reference/revision.md) ——
**它就是这次写入在 Channel 状态日志中的位置**，因此与 Cursor 是同一域上的同一类型。
这解释了为什么计数器在这里连续：第 5 段的消息与这一段的状态写入**共用同一本日志**。

中间那段是演示的核心：三个写者拿着**同一个** CAS token（`v2`）同时写同一个 key。
CAS 让恰好一个成功，另外两个拿到 `EAPP_REVISION_CONFLICT`（`retryable=true`，
`RETRYABLE_CODES` 里唯一一个默认可重试的码）。这正是"没有全序就不能做 CAS"的原因 ——
允许"最终一致但号称能 CAS"的存储，等于允许**静默丢更新**。

最后两行是 [`StateWatcher`](../reference/state-watcher.md)：它以 `cursor='latest'` 开始观察，
随后一次 CAS 写入落到 revision `mem-1!0000000000000015`，watcher 看到值 `45` 并 ack，
它的 cursor 就停在同一个 revision 上 —— **Revision 可以在 State Mode 里当 Cursor 用**（REV-7），
这不是特例，是 CR-1 的推论。

```
7. Lifecycle — 生命周期
───────────────────
  suspend(logger) -> binding binding-1 = DORMANT
  channel ch-1 = DRAINING
  resume(logger)  -> binding = ACTIVE
```

**v3.0 Lifecycle 与 v3.1 的联动。** `suspend(logger)` 让 logger 离开
Active Composition：Identity 与 Binding 都还在（L-5），但派生出的 Binding 状态变成 `DORMANT`，
而 v3.1 要求 Binding 进入 `DORMANT` 时**由它派生的** Channel 全部 `DRAINING` —— 停止接受新工作、
完成在途工作。演示里打印的是 `request` 模式那条 Channel。
`resume()` 之后两端再次 `ACTIVE`，Channel 回到 `ACTIVE`。

```
done
────
Three independent plugins: discovered, connected, activated, invoked,
and sharing versioned state — each one unaware of the others.
```

`runtime.shutdown()` 关闭所有 Channel、中止 dispatcher、清空未决调用并把 Transport
`close()`。之后**会改变运行时状态的**操作都以 `EAPP_INTERNAL` 失败
（`register` / `discover` / `connect` / `invoke` / `publish` / 生命周期操作）。
纯查询不在此列：`describe()` 仍然返回关闭前的快照，`channel()` 仍然能查到 Channel 对象 ——
它们读的是既有数据，不推进任何东西。

---

## 5. 用一句话对上三层

| 演示段 | 层 |
|---|---|
| 1. Discovery | v3.0 Composition Core |
| 2. Activation | v3.0 Lifecycle |
| 3. Connect | v3.0 `bind()` **+** v3.1 Channel 创建路径 |
| 4. Invoke | v3.1 request 模式（经真实 Channel 与 Transport） |
| 5. Communicate | v3.1 event 模式 + Subscription / Cursor |
| 6. Shared state | v3.2 State Mode（CAS + StateWatcher） |
| 7. Lifecycle | v3.0 Lifecycle **+** v3.1 的派生联动 |

`@eapp/runtime` 将这五个操作封装为一个门面，不构成第四层：
上面每一行都能在 v3.0 / v3.1 / v3.2 中找到出处。

---

## 下一步

- [写一个插件](./write-a-plugin.md) —— 从零写出一个能被发现、连接、激活、调用的插件
- [实现一个 Transport](./write-a-transport.md) —— 使 EaPP 运行于任意消息系统之上
  （含「用另一种语言实现 EaPP」一节）
- [概念：三层心智模型](./concepts.md) —— 回头再看一遍，这次看的是层与层的边界

要查某个实体的确切语义（签名、不变量、错误码、可运行示例），去
[参考索引](../README.md#参考) 或 [规范](../spec/v3.0.0-core.md)；
文档总入口是 [文档索引](../README.md)。

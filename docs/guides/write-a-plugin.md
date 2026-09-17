# 写一个插件

> **本页说明如何编写一个可被发现、连接、激活、调用的插件。**

前置阅读：[概念：三层心智模型](./concepts.md)（至少读完第 4 节）。
本页所有类型与行为都取自参考实现 `packages/runtime/src/{plugin,runtime}.ts`，
示例是真实可跑的代码，不是伪代码。

---

## 1. 插件是什么：一个契约，不是一种形态

v3.0 §5.2 明确：Plugin **MUST NOT** 被要求具有同一种实现形态 ——
它可以是进程内模块、独立进程、worker、远程服务、一台设备。
所以运行时**只**假设下面这个契约，进程内加载只是它的一种实现方式。

`@eapp/runtime` 给出的进程内契约是
[`PluginModule`](../../packages/runtime/src/plugin.ts)：

```typescript
interface PluginManifest {
  identity: PluginRef;          // = Identity，三个字段：domain / id / instance
  capabilities: Capability[];
}

/** handler 在服务请求的当下能拿到的东西。 */
interface InvocationContext {
  readonly caller: PluginRef;
  readonly callee: PluginRef;
  readonly capability: string;
  readonly correlationId: string;
}

type RequestHandler = (payload: unknown, context: InvocationContext) => Promise<unknown>;

interface PluginModule {
  readonly manifest: PluginManifest;
  activate?(): Promise<void> | void;
  deactivate?(): Promise<void> | void;
  suspend?(): Promise<void> | void;
  resume?(): Promise<void> | void;
  readonly handlers?: Readonly<Record<string, RequestHandler>>;
}
```

逐个字段：

| 字段 | 必填 | 语义 |
|---|---|---|
| `manifest.identity` | 是 | 这个插件**是谁**。`domain` / `id` / `instance` 三个字段，**不含版本**（ID-6）。运行时决定最终身份，见 §3 |
| `manifest.capabilities` | 是 | 这个插件可以参与**什么类型**的组合。MAY 为空数组（P-2）。每项的 `name` 非空、`version` 是 SemVer，可选 `contract` 与 `constraints` |
| `activate()` | 否 | 进入 `ACTIVE` 后调用 |
| `deactivate()` | 否 | 离开 `ACTIVE` 时调用；契约要求它**幂等** |
| `suspend()` / `resume()` | 否 | 离开 / 回到 Active Composition 时调用 |
| `handlers` | 否 | **按 capability 名索引**的请求处理器（request 模式）。`handlers['greeting.render']` 服务名为 `greeting.render` 的能力 |

`Capability` 不是接口。它描述"可以参与什么类型的组合"，
不是方法列表、不是 RPC 端点、不是 HTTP 路由。契约里的 `handlers` 键名与
[`Capability`](../reference/capability.md) 的 `name` 对齐，是**本参考实现的约定**，
不是协议强加的形状。

---

## 2. 完整示例：两个互不相识的插件

示例就在仓库里，**可以直接跑**：

```bash
pnpm run example:first
# 等价于 npx tsx examples/my-first-plugin/index.ts
```

它与演示（[`examples/hello-plugins/`](../../examples/hello-plugins/index.ts)）里
logger / app / metrics 三件套**不同**：这里是 `casing`（纯提供方）与 `greeter`
（提供方同时又是消费方）。

完整文件在 [`examples/my-first-plugin/index.ts`](../../examples/my-first-plugin/index.ts)，
除了下面这两段，它还在结尾核对本文的每一条断言，并把 §7 的错误表逐行跑出来。
下面摘的是核心部分。

> 示例用相对路径导入（`../../packages/...`），这个位置是必需的 —— 相对深度就是按
> `examples/<name>/index.ts` 写的。仓库根目录没有链接 `@eapp/*` 的 `node_modules`
> 入口，所以 `tsx` 下只能用相对路径；`@eapp/...` 包名形式只在 `tsc` 与 `vitest` 中
> 经由 `paths` / alias 可解析，`tests/conformance/*.test.ts` 就是这么写的。

```typescript
import { EappError } from '../../packages/core/src/index.js';
import { EappRuntime, type PluginModule } from '../../packages/runtime/src/index.js';

const CASING = { name: 'casing.apply', version: '1.0.0' };
const GREETING = { name: 'greeting.render', version: '1.0.0' };

/** 提供 casing.apply：把任意输入变成大写。一个最小的纯提供方。 */
function casingPlugin(): PluginModule {
  return {
    manifest: {
      identity: { domain: 'acme.text', id: 'casing', instance: 'casing-1' },
      capabilities: [CASING],
    },
    handlers: {
      'casing.apply': async (payload) => String(payload).toUpperCase(),
    },
  };
}

/**
 * 提供 greeting.render，并且**在 handler 内部**去调用 casing.apply ——
 * 它要用到运行时，所以由外部注入一个函数；它自己不知道谁实现了 casing.apply。
 */
function greeterPlugin(applyCasing: (text: string) => Promise<string>): PluginModule {
  let active = false;
  let rendered = 0;

  return {
    manifest: {
      identity: { domain: 'acme.greeting', id: 'greeter', instance: 'greeter-1' },
      capabilities: [{ ...GREETING, contract: { name: 'GreetingPayload', version: '1.0.0' } }],
    },

    activate() {
      active = true;
      console.log('  [greeter] activate()');
    },
    async deactivate() {
      active = false;
      console.log('  [greeter] deactivate()');
    },

    handlers: {
      'greeting.render': async (payload, context) => {
        // context.caller 是本插件不需要知道的东西 —— 调用方是谁由运行时告诉它。
        const { name, upper = false } = (payload ?? {}) as { name?: unknown; upper?: unknown };
        if (typeof name !== 'string' || name.length === 0) {
          // 抛 EappError：code 会原样跨过 Channel 回到调用方（见 §7）。
          throw new EappError('EAPP_GREETING_INVALID_NAME', 'payload.name MUST be a non-empty string');
        }
        let line = `Hello, ${name}!`;
        if (upper === true) line = await applyCasing(line);
        rendered += 1;
        return { line, total: rendered, correlationId: context.correlationId };
      },
    },
  };
}

async function main(): Promise<void> {
  const runtime = EappRuntime.create({ domain: 'eapp.guide' });

  // 先注册提供方，这样 greeter 的 handler 在调用时一定找得到它。
  const casing = runtime.register(casingPlugin());
  const greeter = runtime.register(
    greeterPlugin(async (text) => {
      const upper = await runtime.invoke({
        from: greeter,      // 调用方
        to: casing,         // 能力提供方
        capability: CASING, // 只写 name/version，plugin 由运行时补上
        payload: text,
      });
      return String(upper);
    }),
  );
  const portal = runtime.register({
    manifest: { identity: { domain: 'acme.app', id: 'portal', instance: 'portal-1' }, capabilities: [] },
  });

  // 发现：谁会做 greeting.render？
  const found = await runtime.discover({ capability: 'greeting.render' });
  console.log('发现:', found.map((p) => p.id).join(', '));

  // 连接：从能力提供方（from）到消费方（to）建立一个 request 模式的关系。
  const { binding, channel } = await runtime.connect({
    from: greeter,
    to: portal,
    capability: GREETING,
    mode: 'request',
  });
  console.log('binding =', binding.id, '状态 =', runtime.core.bindingState(binding.id)); // DORMANT
  console.log('channel =', channel.id, channel.mode, channel.delivery, channel.state);

  await runtime.activate(casing);
  await runtime.activate(greeter);
  await runtime.activate(portal);
  console.log('激活后 binding 状态 =', runtime.core.bindingState(binding.id)); // ACTIVE

  // 调用。
  const reply = await runtime.invoke({
    from: portal,
    to: greeter,
    capability: GREETING,
    payload: { name: 'Ada' },
  });
  console.log('reply:', JSON.stringify(reply));

  const upper = await runtime.invoke({
    from: portal,
    to: greeter,
    capability: GREETING,
    payload: { name: 'Grace', upper: true },
  });
  console.log('handler 内部再调用:', JSON.stringify(upper));

  await runtime.shutdown();
}

main().catch((error: unknown) => {
  console.error('failed');
  console.error(error);
  process.exitCode = 1;
});
```

实测输出（`binding-1` / `ch-1` 这类 id 按创建顺序递增，`correlationId` 末尾是时间戳，
所以字面值会变；这里引用的是 `pnpm run example:first` 的真实输出）：

```
发现: greeter
binding = binding-1 状态 = DORMANT
channel = ch-1 request at-most-once ACTIVE
  [greeter] activate()
激活后 binding 状态 = ACTIVE
reply: {"line":"Hello, Ada!","total":1,"correlationId":"invoke-1-…"}
handler 内部再调用: {"line":"HELLO, GRACE!","total":2,"correlationId":"invoke-2-…"}
```

注意三件事：`casing` 从来没有被"通知"过 `greeter` 的存在；`greeter` 也从来不知道
`casing` 的 `domain` 是什么；而 `portal` 完全不知道 `greeting.render` 是**谁**实现的 ——
它只知道有一个 `greeting.render@1.0.0`。

---

## 3. 声明 manifest 与 capability

声明 manifest 时有三条硬约束：

**① Identity 不能自签发。** v3.0 ID-5：`Identity MUST NOT be self-issued`。
插件在 manifest 里给的是一个**载体**（`domain/id/instance`），
运行时用 `IdentityRegistry` 铸出真正的
[`Identity`](../reference/identity.md) 交给注册表：

```typescript
// packages/runtime/src/runtime.ts › register()
const identity = this.#identities.isIssued(module.manifest.identity)
  ? this.#identities.require(module.manifest.identity)
  : this.#identities.create({
      domain: module.manifest.identity.domain,
      id: module.manifest.identity.id,
      instance: module.manifest.identity.instance,
    });
```

所以：

- 插件 **MUST NOT** 自己"造"一个身份然后声称它是自己的。`register()` 返回的才是权威身份，
  用它去做后续的 `connect` / `invoke` / `activate`。
- `register()` **校验**身份，不是**净化**身份。身份的形状恰好是
  `domain` / `id` / `instance` 三个字段，多写一个（比如 `version`）会直接抛
  `EAPP_IDENTITY_INVALID`，而不是被悄悄丢掉。
  早期版本是丢弃字段的 —— 那让 ID-6（身份不含版本）在最关键的一条路径上静默失效：
  写错了不会报错，但预期的身份并未生效。
- 同一 `(domain, id, instance)` 注册两次会被拒绝：`EAPP_IDENTITY_DUPLICATE`（ID-3 / P-1）。

**② Capability 的 SemVer 是真的 SemVer。** `version` 必须是 `major.minor.patch`
（可带 `-prerelease` / `+build`），`name` 必须非空。校验由
`assertValidCapability` 完成，失败码是 `EAPP_CAPABILITY_NOT_FOUND`。
`capabilities` 必须是数组（MAY 为空）；写成一个字符串会直接抛 `EAPP_CAPABILITY_NOT_FOUND`。

**③ 版本是绑定身份的一部分。** `{ name: 'casing.apply', version: '1.0.0' }` 与
`{ name: 'casing.apply', version: '2.0.0' }` 是两个不同的能力（C-5 / C-6）。
升级版本不会"接管"旧关系，而会让旧 [`Binding`](../reference/binding.md) 因为
`from` 不再暴露旧版本而派生为 `DORMANT`。

可选的 `contract` 是**给人和工具看的上下文**（C-3）：它有两个必填字段 `name` 与 `version`，
可以携带 `schema`。Core 不校验 `schema`，也不做代码生成 —— 见 [概念 §7](./concepts.md)。

---

## 4. 请求处理器与 `InvocationContext`

`handlers` 的每个值都是 `RequestHandler`：

```typescript
type RequestHandler = (payload: unknown, context: InvocationContext) => Promise<unknown>;
```

`payload` 是 `unknown`：协议不在这一层定义 schema 校验（那属于 RPC / Extension）。
处理它之前先自己校验，像示例里的 `typeof name !== 'string'`。

`context` 由运行时填好后传进来，四个字段都是**只读**的：

| 字段 | 是什么 | 谁来填 |
|---|---|---|
| `caller` | 发起请求的插件身份 | 由 Binding 的 `to` 端推出 |
| `callee` | 正在服务的插件身份（= Binding 的 `from` 端） | 由 Binding 推出 |
| `capability` | 被调用的能力名 | 即信封里的 `operation` |
| `correlationId` | 本次调用的关联 id | `runtime.invoke()` 生成，逐调用唯一 |

`correlationId` 是 request 模式"一问一答"的配对依据（RQ-1～RQ-3）：
同一个 Channel 上并发的多个请求靠它各自配对，`handler` 可以把它回传给调用方用于追踪。

**一个 handler 里可以再发起调用。** 示例里的 `greeter` 就在自己的 handler 里
`invoke` 了 `casing`。此时 `greeter` 是 `from`（**发起调用的一方**），`casing` 是 `to`
（**能力提供方**）。

> ### `invoke()` 的 `from` / `to` 与 `connect()` 是**反的**
>
> ```
> connect({ from, to })     from = 能力提供方      to = 消费方      ← v3.0 Binding 的方向
> invoke ({ from, to })     from = 调用方（消费方）  to = 能力提供方  ← "我要调用谁"
> publish({ from, to })     from = 能力提供方      to = 消费方      ← 同 connect
> ```
>
> 这不是笔误，是两个不同的概念用了同一对字段名，读起来很容易反过来。
> `connect()` 描述的是**关系**：v3.0 的 `bind()` 把 `from` 定义为能力提供方。
> `invoke()` 描述的是**动作**：谁在发起这次调用。
>
> 运行时内部按 `(from = request.to, to = request.from)` 建立并复用 Binding ——
> 也就是说 `invoke({ from: A, to: B })` 要求 **B** 提供这个能力。
> 写反会以 `EAPP_CAPABILITY_NOT_EXPOSED` 失败，因为那等于要求消费方去提供它。
>
> `examples/my-first-plugin/` 里把这条实测出来了。

---

## 5. 激活钩子

四个钩子对应 v3.0 Lifecycle 的四个操作：

```
INACTIVE  --activate-->   ACTIVE       → activate()
ACTIVE    --suspend-->    SUSPENDED    → suspend()
SUSPENDED --resume-->     ACTIVE       → resume()
任意状态   --deactivate--> INACTIVE     → deactivate()
```

它们由 `EappRuntime` 在推进核心状态**之后**调用：

```typescript
async activate(plugin: PluginRef): Promise<void> {
  this.#assertLive();
  // 只有核心真的发生了状态转移，才调用插件的钩子。
  if (!(await this.#changeLifecycle(plugin, () => this.core.activate(plugin)))) return;
  await this.#modules.get(identityKey(plugin))?.activate?.();
}
```

注意那个守卫。核心状态机的 `activate` 对已 `ACTIVE` 的插件是 no-op（O-5），
而"no-op"在这里意味着**钩子不会被调用**：

- **重复 `runtime.activate(p)` 不会让 `activate()` 被调用两次。** 早期版本会 ——
  那迫使每个插件都去防御一次 O-5 已经排除的重复激活。现在由运行时负责。
- **但钩子仍然应当自己幂等。** `deactivate()` 在契约里被明确要求幂等；
  而且 `INACTIVE → ACTIVE → INACTIVE → ACTIVE` 是合法的正常序列，
  钩子会各被调用一次。真正的"只允许发生一次"初始化要自己加标记，别指望状态机帮忙。

- **`activate()` 不是 `INACTIVE → SUSPENDED` 的通路。** 对 `SUSPENDED` 的插件调
  `activate()` 会让核心抛 `EAPP_LIFECYCLE_INVALID`（L-6）：先用 `resume()`。

钩子在核心状态之后运行，意味着钩子里做的事情**已经**处在 Active Composition 之中；
派生出的 Binding 此刻已经可能因此变成 `ACTIVE`。

---

## 6. 注册 → 发现 → 连接 → 激活 → 调用

五个动作对应五个方法，前四个方法的归属层不同：

| 动作 | 调用 | 层 |
|---|---|---|
| 注册 | `runtime.register(module): PluginRef` | v3.0（注册只产生"可发现性"） |
| 发现 | `runtime.discover(criteria, scope?): Promise<PluginRef[]>` | v3.0 [`Discovery`](../reference/discovery.md) |
| 连接 | `runtime.connect({from, to, capability, mode, delivery?})` | v3.0 `bind()` + v3.1 Channel 创建路径 |
| 激活 | `runtime.activate(ref)` / `suspend` / `resume` / `deactivate` | v3.0 Lifecycle |
| 调用 | `runtime.invoke({from, to, capability, payload?, timeoutMs?})` | v3.1 request 模式 |

**注册的语义是"可被发现"，不是"可以调用"。**
`register()` 之后插件的生命周期是 `INACTIVE`，`runtime.core.listBindings()` 里什么都没有。
发现（D-3）只是必要条件。

`criteria` 的可用字段：`capability`（名字）、`version`（SemVer **range** ——
`'1.0.0'` 精确到那一个版本，`'^1.0.0'` / `'>=2'` / `'*'` 是范围；语法不认识的范围会被
**明确拒绝**，不会静默不匹配）、`constraints`、`identity`（`domain` / `id` / `instance` 的部分匹配）。
`scope` 是 `{ trustLevel?, trustDomain? }`；当前实现只在有对应信任策略时才接受它，
否则抛 `EAPP_DISCOVERY_SCOPE_INVALID` —— 一个无法评估的 scope **不会被静默忽略**。

**连接方向是有含义的：`from` 是能力提供方，`to` 是消费方。**
（`invoke()` 的 `from` / `to` 是**反的** —— 见 §4 的说明框。）
`connect()` 会：

1. 复用 `(from, to, capability)` 上尚未 `CLOSED` 的
   [`Binding`](../reference/binding.md)（没有才新建，遵守 B-6 唯一性）；
2. 由该 Binding **派生**一个 [`Channel`](../reference/channel.md)，模式取自 `mode`；
3. `delivery` 省略时按 §4.4 推导：`stream` / `state` → `at-least-once`，其余 → `at-most-once`。

Binding 的状态是**派生**的，不是设置的：

```
CLOSED      已 unbind
ACTIVE      from 与 to 都是 ACTIVE，且 from 仍然暴露该 Capability
DORMANT     其余情况（尚在关系中，但不能服务）
```

所以"先 bind 后 activate"是完全正常的顺序：`connect()` 之后 Binding 是 `DORMANT`，
两端 `activate` 之后它自己变成 `ACTIVE`。

**`invoke()` 不是本地函数调用。** 它真的把请求信封写进 Transport、再由 Channel 上的
dispatcher 读回来交给 handler —— 这样才真正跑过了三层。它会：

- 必要时建立 `(from=提供方, to=消费方)` 的 Binding 与 `request` 模式的 Channel；
- 生成 `correlationId`，登记未决调用（RQ-1）；
- 带上 `deadline`；超时后以 `EAPP_TIMEOUT` 拒绝并**放弃**该请求（RQ-4），
  迟到的响应会被静默丢弃，不会二次结算。

`timeoutMs` 默认 5000。**它不保证在极端竞态下必然触发**：
如果响应已经在 Transport 里等待被读走，`invoke` 会先结算成功。
要观察超时，让 handler 的耗时明确大于 `timeoutMs`。

### 6.1 provider 在别的进程里

v3.0 §5.2 拒绝要求每个 Plugin 具有相同的实现形态 —— 它可以是进程内模块、
**独立进程**、worker、远程服务。上面所有内容默认了第一种。换第二种时，
两件事必须显式说出来，因为它们原本是隐式的：

```typescript
// 调用方：注册它，但不执行它
const pricing = runtime.registerRemote({
  identity: { domain: 'acme.shop', id: 'pricing', instance: 'pricing-1' },
  capabilities: [{ name: 'pricing.quote', version: '1.0.0' }],
});
await runtime.activate(pricing);
```

```typescript
// 提供方进程：注册它，并且**服务**它
const pricing = runtime.register({
  manifest: { identity: { /* 同上 */ }, capabilities: [PRICING] },
  handlers: { 'pricing.quote': async (payload) => { /* 真的跑在这里 */ } },
});
const caller = runtime.register({ manifest: { identity: CHECKOUT, capabilities: [] } });
await runtime.activate(pricing);
await runtime.activate(caller);
await runtime.serve({ from: pricing, to: caller, capability: PRICING });   // ← 关键
```

**`register` 与 `registerRemote` 的区别是"可寻址"与"本进程执行"。**
一个进程里这两件事重合，所以这个区别一直看不见。分开之后它立刻显形：
调用方的 dispatcher 若替别人的 provider 应答，会抢在真正的回复前面回一个
`EAPP_CAPABILITY_NOT_EXPOSED` —— 从它自己的角度完全正确，对调用方却是一个错的答案。
`runtime.hosts(ref)` 可以问出这个区别。

**`serve()` 只在提供方进程调用，而且每个 Channel 只能有一个。**
两个进程同时服务同一个 Channel 时，两边都会执行 handler，重复的回复被
correlation tracker 当作重复响应丢掉 —— 调用方看到一个正常的回答，而副作用发生了两次。
所以服务者身份由 Transport 仲裁（`ServerRoleProvider`），抢不到的一方
`serve()` 直接失败。

完整可跑的例子见 [`examples/cross-process/`](../../examples/cross-process/index.ts)：
broker 进程 + 两个 worker 进程 + 一个 provider 进程 + 调用方进程。

---

## 7. 错误如何浮现

三层共用一个运行时错误类 `EappError`（`class EappError extends Error`）。
它**定义在 `@eapp/core`**，而 `@eapp/runtime` 会**再导出**它 ——
所以插件作者只需要一个 import：

```typescript
// 两行等价；§2 的示例用第一行（相对路径的说明见 §2）
import { EappError, EappRuntime, type PluginModule } from '../../packages/runtime/src/index.js';
// import { EappError } from '../../packages/core/src/index.js';

class EappError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly retryable: boolean;
}
```

同一个类被三层共用，所以 handler 里 `new` 出来的实例跨过 Channel 之后，
调用方的 `instanceof EappError` 判断与 `error.code` 读取都成立。

handler 抛出的错误会在响应信封里变成一个**码**，调用方看到的就是这个码：

| handler 抛出 | 调用方拿到 |
|---|---|
| `new EappError('EAPP_GREETING_INVALID_NAME', '…')` | 同样的 `code`，`retryable` 按规则（默认 `false`） |
| 任何其它 `Error`（含 `TypeError`） | `EAPP_INTERNAL`，`message` 保留原始文本 |
| 抛出的不是 `Error`（如字符串） | `EAPP_INTERNAL`，`message` 是该值的字符串化 |
| 请求超出 `timeoutMs` | `EAPP_TIMEOUT`（`invoke` 在调用侧抛，`retryable: false`） |
| 目标插件没有该能力的 handler | `EAPP_CAPABILITY_NOT_EXPOSED` |
| 目标没注册 | `EAPP_PLUGIN_NOT_FOUND` |
| 请求到达时 deadline 已过 | `EAPP_TIMEOUT`，且**工作根本不会开始**（RQ-4） |

实测（`pnpm run example:first` 的后半段，示例会自己核对每一条）：

```
错误如何浮现
  payload.name = ""            -> EAPP_GREETING_INVALID_NAME retryable=false
  handler 睡 40ms, timeoutMs 5 -> EAPP_TIMEOUT retryable=false
  invoke 的 from/to 写反       -> EAPP_CAPABILITY_NOT_EXPOSED
  声明了能力但没有 handler     -> EAPP_CAPABILITY_NOT_EXPOSED
  目标插件没注册               -> EAPP_PLUGIN_NOT_FOUND
  同一身份注册两次             -> EAPP_IDENTITY_DUPLICATE
```

要让 `EAPP_TIMEOUT` 真的出现，示例里的 `greeter` 多接受一个可选的 `delayMs`
（§2 的摘录里省略了它）：handler 的耗时必须明确大于 `timeoutMs`，否则只是普通的时序竞态。
示例用的是 handler 睡 40ms、`timeoutMs: 5`。

「声明了能力但没有 handler」和「目标插件没注册」看起来是同一个失败，其实不是：
前者 Binding 建得起来（`from` 确实暴露了该能力），只是服务不了；
后者连 Binding 都建不起来。

两条实践建议：

- **定义自己的错误码时带上前缀。** 码是一个开放集合：`EappError` 的构造器接受任意
  `string`。但 v3.0 / v3.1 / v3.2 已经注册的码 **MUST NOT** 被重命名或改义，
  所以自定义码要能一眼看出不属于协议，例如 `EAPP_GREETING_INVALID_NAME`。
- **`retryable` 不要随便置真。** 只有 `EAPP_REVISION_CONFLICT` 在
  `RETRYABLE_CODES` 里默认重试；把其它码标成可重试，会把"必须由人处理"的错误
  变成重试风暴。

`EappError` 的 `message` 里**总是**包含 `code` 前缀（已登记的偏离 D-4），
所以 `rejects.toThrow('EAPP_...')` 这种规范形状的断言能够成立。
若对已有的 `EappError` 再次包装，`message` 会出现重复前缀 —— 应当读取 `code` 字段，而非解析 `message`。

---

## 8. 插件 MUST NOT 做的事

| 禁止 | 为什么 |
|---|---|
| 自己签发 [`Identity`](../reference/identity.md) | v3.0 ID-5：`Identity MUST NOT be self-issued`。身份由 `IdentityRegistry` 铸造。运行时**校验**传入的身份，多余字段会被拒绝（`EAPP_IDENTITY_INVALID`），不采信自行声明的身份 |
| 把版本塞进 Identity | ID-6：身份形状恰好是 `domain` / `id` / `instance`。版本属于 `Capability.version`，塞进身份会让"升级"变成"换了一个人" |
| 直接依赖另一个插件的模块 | 那就不是组合，是编译期耦合。跨插件只能通过运行时：发现、连接、调用 |
| 假设发现等于可调用 | D-3 / D-5：发现不是组合，也不替代 Binding |
| 把 Binding 状态"设"成某个值 | 它由三件事派生。想让它变成 `ACTIVE`，去让两端 `ACTIVE` 且 `from` 仍暴露该能力 |
| 在 handler 里假设 `payload` 的形状 | `payload` 是 `unknown`；Core 不做 schema 校验 |
| 假设同一条 Channel 只有一个消费者 | 排他性由 [`ConsumerGroup`](../reference/consumer-group.md) + [`Lease`](../reference/lease.md) 表达，不在插件内部发明 —— 用 `runtime.openConsumerGroup()`，见 §9 |
| 依赖 `onEvent` 之类的声明式钩子 | **没有这个字段**，见下 |

**没有 `onEvent` 钩子，这是有意的。** 早期版本声明过一个，
但运行时**从来没有调用点** —— `register()` 只保存模块，`#dispatchLoop()` 只处理
request/response 信封，`publish()` 只做 `transport.send()`。

一个"看起来支持、接受 handler、然后静默丢弃"的扩展点比没有这个扩展点更糟：
它会让插件作者写下一段永远不会执行的代码，并且以为它已经跑通了。
该字段已被**删除**，而不是留在契约里继续骗人。

**事件与流的消费一律走显式的 `runtime.subscribe()`** ——
它返回一个真正的 v3.1 [`Subscription`](../reference/subscription.md)，
带一个由调用方 `ack()` 推进的 [`Cursor`](../reference/cursor.md)：

```typescript
const subscription = await runtime.subscribe(channel.id, { type: 'metric' });
for await (const message of subscription) {
  handle(message.payload);
  await message.ack();   // 只有 ack 会推进 cursor（CR-1）
}
```

---

## 9. 一条 Channel，多个消费者：`ConsumerGroup`

`subscribe()` 回答"**谁在**参与"。如果一个问题变成"**谁和谁在竞争**" ——
一个工作池里有多个成员、每条消息只能被处理一次 ——
那是另一个实体：[`ConsumerGroup`](../reference/consumer-group.md)（v3.1 §8）。

```
组之间   每个组都收到全部消息，各自持有独立 Cursor      （CG-4）
组之内   每条消息只交给一个成员 —— 成员之间竞争         （CG-3）
```

运行时给出的操作面：

```typescript
// 先在 Channel 上开一个组（CG-1：组名在同一 Channel 内唯一）
await runtime.openConsumerGroup(channel.id, { name: 'workers', prefetch: 1 });

// 成员加入（CG-8：必须指名一个已存在的组）
const member = await runtime.joinConsumerGroup(channel.id, 'workers');

for await (const message of member) {
  await work(message.payload);
  await message.ack();     // ack 推进的是**组**的 cursor（CG-1 / CG-2）
}
```

`member.cursor` 是**组**的位置，成员没有自己的 —— 一个组在任何时刻恰好有一个位置。
成员 `nack()` 或**离开**时，它持有的位置立刻归还给组（CG-6 / CG-5），
所以一个成员崩在岗位上不会让整组空转。

三条容易踩的：

- **`openConsumerGroup` 与 `joinConsumerGroup` 是两步，不能合并。** 组必须先在
  Channel 上存在；直接 join 一个不存在的组会以 `EAPP_SUBSCRIPTION_INVALID` 失败。
- **`prefetch` 是唯一对抗垄断的旋钮。** CG-3 保证排他，**不保证公平**：
  最先醒来的成员会把当时可见的工作整批领走（默认上限 16），其余成员只能等它做完。
  单进程里这多半无所谓；一个**跨进程**的工作池必须调小 ——
  [`examples/cross-process/`](../../examples/cross-process/index.ts) 用 `1`，
  于是两个 worker 进程各拿一半。
- **排他性不等于不重复。** 成员崩溃后工作会被重新投递（这就是 `at-least-once`），
  所以同一个 job 可能被执行两次。去重是应用的事（幂等键、去重表），不是协议的事。

**组能有多宽，取决于竞争状态放在哪。** 认领表在进程内内存里时，两个进程会各自以为
持有同一个位置 —— 每条消息被处理两次，而没有任何报错。所以跨进程的组要求 Transport
提供共享的组状态（`sharesGroupState` + `groupStore()`）；不提供时 `openConsumerGroup()`
会**明确失败**（`EAPP_UNSUPPORTED`），而不是静默降级。细节见
[`ConsumerGroup`](../reference/consumer-group.md)。

完整的、可运行的例子有两份：
[`examples/job-queue/`](../../examples/job-queue/index.ts) 走单进程（竞争消费、nack 重投、
成员死在岗位上、三个组共存于一条 Channel），
[`examples/cross-process/`](../../examples/cross-process/index.ts) 走跨进程
（两个 worker 进程加入同一个组，每条订单恰好被一个进程处理）。

---

## 10. 一页速查

```
注册   runtime.register(module)                       → PluginRef      （权威身份）
发现   runtime.discover({ capability: '...' })         → PluginRef[]
连接   runtime.connect({ from, to, capability, mode })   from = 提供方
激活   runtime.activate(ref) / suspend / resume / deactivate
调用   runtime.invoke({ from, to, capability, payload, timeoutMs })
                                                       from = 调用方（与 connect 反）
消费   runtime.subscribe(channelId, pattern, options)  → Subscription
竞争   runtime.openConsumerGroup(channelId, { name })  → ConsumerGroup
       runtime.joinConsumerGroup(channelId, name)      → Subscription（组的位置）

Binding 状态 = 派生     handler 抛 EappError → 调用方看到同一个 code
组 = 谁和谁竞争        成员没有自己的 cursor
```

---

## 相关

- [概念：三层心智模型](./concepts.md) —— 层与层的分工
- [快速上手](./getting-started.md) —— 演示里这五个动作长什么样
- [实现一个 Transport](./write-a-transport.md) —— 换掉消息怎么走
- [`Plugin`](../reference/plugin.md) · [`Identity`](../reference/identity.md) ·
  [`Capability`](../reference/capability.md) · [`Binding`](../reference/binding.md) ·
  [`Lifecycle`](../reference/lifecycle.md) · [`Discovery`](../reference/discovery.md)
- [v3.0.0-core 规范](../spec/v3.0.0-core.md) —— 唯一裁决者

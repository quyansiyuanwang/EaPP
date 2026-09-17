# `CompositionCore`

> 以上一切的操作入口——2 个 Discovery 操作与 6 个组合 / 生命周期原语。

| | |
|---|---|
| **层** | v3.0 Composition Core |
| **规范** | [v3.0.0-core §9](../spec/v3.0.0-core.md) · §12（Bootstrap Runtime） |
| **实现** | [`packages/core/src/composition.ts`](../../packages/core/src/composition.ts) |
| **测试** | [`tests/conformance/core.test.ts`](../../tests/conformance/core.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface CompositionCore {
  // Discovery
  find(criteria: Criteria, scope: DiscoveryScope): Promise<PluginRef[]>;
  watch(criteria: Criteria, scope: DiscoveryScope): AsyncIterable<DiscoveryEvent>;

  // Composition
  bind(request: BindRequest): Promise<Binding>;
  unbind(bindingId: string): Promise<void>;

  // Lifecycle
  activate(plugin: PluginRef): Promise<void>;
  deactivate(plugin: PluginRef): Promise<void>;
  suspend(plugin: PluginRef): Promise<void>;
  resume(plugin: PluginRef): Promise<void>;
}

interface BindRequest {
  from: PluginRef;
  to: PluginRef;
  capability: CapabilityRef;
  contract?: ContractRef;
}

interface CompositionCoreOptions {
  policy?: DiscoveryTrustPolicy;     // 交给内部 Discovery 服务的 Trust 策略（合规等级 C4）
  discovery?: DiscoveryService;      // 复用已有的 Discovery 服务，而不是新建一个
}

class CompositionCoreImpl implements CompositionCore {
  readonly registry: PluginRegistry;
  readonly discovery: DiscoveryService;

  // 派生状态的观察面
  bindingState(bindingId: string): BindingState;
  binding(bindingId: string): Binding | undefined;
  requireBinding(bindingId: string): Binding;
  listBindings(): Binding[];
  onBindingStateChange(listener: (binding: Binding, state: BindingState) => void): () => void;

  dispose(): void;                   // 与 PluginRegistry 解绑
}

function createCompositionCore(
  registry?: PluginRegistry,
  options?: CompositionCoreOptions,
): CompositionCoreImpl;
```

`BindRequest` 的字段：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `from` | `PluginRef` | 是 | 提供方；MUST 已注册，且 MUST 暴露 `capability`（B-1、B-2） |
| `to` | `PluginRef` | 是 | 消费方；MUST 已注册（B-1） |
| `capability` | `CapabilityRef` | 是 | 被组合的能力；`capability.plugin` MUST equal `from`（B-7） |
| `contract` | `ContractRef` | 否 | 可选上下文，原样保存在 Binding 上 |

---

## 语义

### 分组（§9.1）

```
Discovery
├── find
└── watch

Composition          Lifecycle
├── bind             ├── activate
└── unbind           ├── deactivate
                     ├── suspend
                     └── resume
```

Composition Core 定义 **6 个 Composition/Lifecycle control primitives**，外加 **2 个 Discovery operations**。除此之外没有别的原语：§9.3 的 `replace` / `rewire` 是**高阶操作**，不是 Core Primitive，Composition Core 不提供它们，只提供用来组合它们的原语。

按操作对象划分（§9.4）：Composition Control 作用于 Binding / Graph（`bind` / `unbind`），Lifecycle Control 作用于 Plugin Instance（`activate` / `deactivate` / `suspend` / `resume`）。

### bind 的校验顺序

1. `from` 与 `to` 都 MUST 已在 [`PluginRegistry`](./plugin.md) 注册，否则 `EAPP_PLUGIN_NOT_FOUND`（B-1）。
2. `capability` MUST 是合法 [`CapabilityRef`](./capability.md)（名字非空、版本是合法 SemVer）。
3. `capability.plugin` MUST equal `from`，否则 `EAPP_BINDING_INVALID`（B-7）。
4. `from` MUST 精确暴露 `name@version`，否则 `EAPP_CAPABILITY_NOT_EXPOSED`（B-2、O-2）。
5. 唯一性检查与创建在同一同步块内完成，中间没有 `await`：并发 `bind` 不可能创建出第二个同一 `(from, to, capability)` 的非 CLOSED Binding（B-8）。已存在时返回那个 Binding（§6.8）。

创建的 Binding 被冻结，`capability.plugin` 被规范化为 `from` 的身份，`id` 由实现生成。

### 派生状态的读取

`bindingState` 每次都从当前世界重新派生（§6.4），Binding 本身从不存 `state`（B-3）：

- `binding(id)`：未知返回 `undefined`；CLOSED 的也返回对象，供上层据此报 `EAPP_BINDING_CLOSED`。
- `requireBinding(id)`：未知抛 `EAPP_BINDING_INVALID`；CLOSED 抛 `EAPP_BINDING_CLOSED`。
- `onBindingStateChange(listener)`：派生结果发生变化时通知；`unbind` 是例外——CLOSED 一定通知一次。

注册表侧的变更会推动重新派生：`lifecycle` 与 `capabilities` 变更只影响该 Plugin 作为端点的 Binding；端点已不在注册表里时按 `INACTIVE` 处理，其绑定派生为 `DORMANT`。

### 生命周期操作的幂等与合法源

| 操作 | 非法源 | 幂等 |
|---|---|---|
| `activate` | `SUSPENDED`（MUST 用 `resume`）、`INACTIVE` 以外的未知状态 | 对已 `ACTIVE` 的 Plugin 是 no-op（O-5） |
| `deactivate` | 无 | 对已 `INACTIVE` 的 Plugin 是 no-op |
| `suspend` | 任何非 `ACTIVE` | 否——重复 `suspend` 抛 `EAPP_LIFECYCLE_INVALID` |
| `resume` | 任何非 `SUSPENDED` | 否——重复 `resume` 抛 `EAPP_LIFECYCLE_INVALID` |

`deactivate` 与 `suspend` 都只让绑定派生为 `DORMANT`，都不 CLOSE 绑定（§7.4）。状态与转移表见 [`Lifecycle`](./lifecycle.md)，派生规则见 [`Binding`](./binding.md)。

### 边界：Composition Core 不管 Channel

Composition Core 只承认 `ChannelRef` 这种引用形式的存在（§10.1），**MUST NOT 定义 Channel 的交互语义**（CH-1）：`request` / `event` / `stream` / `state`、投递保证、顺序、序列化、`ack`、`lease`、`cursor` 都不属于它（§10.2）。Binding 上也不会出现这些字段（§6.9）。

### Bootstrap Runtime（§12）

§12 定义的是一个**最小契约**，不是 Composition Core 的一部分：

```typescript
interface BootstrapRuntime {
  createIdentity(seed: unknown): Promise<Identity>;
  loadFirstPlugin(ref: PluginRef): Promise<Plugin>;
  provideInitialDiscovery(): Discovery;
}
```

它 MUST 尽可能小，MUST NOT 承担 Composition Core / Interaction / Transport 的职责（§12.2）；根可以先存在、后被替换，但 MUST 先存在（§12.3）。`@eapp/core` **不**实现它；参考实现在 `@eapp/runtime`（`createBootstrapRuntime`），一致性测试在测试文件内自带一个最小契约来验证三个不变量。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `O-1` | `bind` MUST 创建 Binding，状态由派生规则决定 | `core.test.ts` › `'O-1: bind creates a Binding whose state is derived'` |
| `O-2` | `bind` MUST 失败，如果 `from` 未暴露目标 Capability | `core.test.ts` › `'B-1 / B-2 / B-7 / O-2: bind validates both endpoints and the capability'` |
| `O-3` | `unbind` MUST 将 Binding 置为 CLOSED | `core.test.ts` › `'B-4 / O-3 / O-4: CLOSED is terminal and unbind is idempotent'` |
| `O-4` | `unbind` MUST 幂等 | `core.test.ts` › `'B-4 / O-3 / O-4: CLOSED is terminal and unbind is idempotent'` |
| `O-5` | `activate` MUST 幂等 | `core.test.ts` › `'O-5: activate is idempotent'` |
| `O-6` | `deactivate` MUST 使其所有 Binding 派生为 DORMANT | `core.test.ts` › `'O-6 / O-8: deactivate and resume re-derive every binding of the plugin'` |
| `O-7` | `suspend` MUST 使其所有 Binding 派生为 DORMANT | `core.test.ts` › `'L-5 / O-7: SUSPENDED does not unbind'` |
| `O-8` | `resume` MUST 重新评估所有 Binding 的派生状态 | `core.test.ts` › `'O-6 / O-8: deactivate and resume re-derive every binding of the plugin'` |
| `CH-1` | Composition Core MUST NOT 定义 Channel 的交互语义 | `core.test.ts` › `'§6.9 / CH-1: a Binding carries no interaction semantics'` |
| `BR-1` | Bootstrap MUST NOT 被替换为不存在的东西 | `core.test.ts` › `'BR-1: Bootstrap MUST NOT be replaced by something nonexistent'` |
| `BR-2` | Bootstrap MUST NOT 依赖任何 Plugin | `core.test.ts` › `'BR-2: Bootstrap MUST NOT depend on any Plugin'` |
| `BR-3` | Bootstrap MUST 提供至少一个初始 Discovery | `core.test.ts` › `'BR-3: Bootstrap MUST provide at least one initial Discovery'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_PLUGIN_NOT_FOUND` | `bind` 的端点未注册（B-1）；注册表级操作的未知 Identity | `false` |
| `EAPP_CAPABILITY_NOT_EXPOSED` | `bind` 时 `from` 未暴露该 `name@version`（B-2、O-2） | `false` |
| `EAPP_BINDING_INVALID` | `capability.plugin` ≠ `from`（B-7）；或请求了未知 binding id | `false` |
| `EAPP_BINDING_CLOSED` | 对 CLOSED Binding 做要求 OPEN 的访问 | `false` |
| `EAPP_LIFECYCLE_INVALID` | 生命周期操作的非法源状态或 §7.2 之外的转移 | `false` |
| `EAPP_DISCOVERY_SCOPE_INVALID` | `find` / `watch` 的 scope 无法被服务评估 | `false` |
| `EAPP_IDENTITY_DUPLICATE` / `EAPP_IDENTITY_INVALID` / `EAPP_CAPABILITY_NOT_FOUND` | 注册与形状校验，来自 [`Plugin`](./plugin.md) / [`Identity`](./identity.md) / [`Capability`](./capability.md) | `false` |

§16 的 13 个码里有三个在 `@eapp/core` 中没有抛出点，属于**已声明但不可达**：

| 码 | 说明 |
|---|---|
| `EAPP_PLUGIN_INACTIVE` | 规范正文没有任何规则要求它：`bind` 对 INACTIVE 的端点照常成功，只是派生为 DORMANT |
| `EAPP_BINDING_DUPLICATE` | §6.8 允许的另一支。参考实现恒返回已存在的非 CLOSED Binding，因此不抛 |
| `EAPP_UNSUPPORTED` | Composition Core 不用它；`@eapp/runtime` 的 `replaceDiscovery` 等入口使用 |

`retryable` 取 `EappError` 的默认值：只有 `EAPP_REVISION_CONFLICT` 在 `RETRYABLE_CODES` 中，本层的码都不在其中，`@eapp/core` 也没有任何调用点显式传入 `retryable`。

---

## 示例

```typescript
import { expect, test } from 'vitest';
import {
  DiscoveryService,
  IdentityRegistry,
  PluginRegistry,
  createCompositionCore,
  type Plugin,
} from '@eapp/core';
import { createBootstrapRuntime } from '@eapp/runtime';

test('CompositionCore：绑定 → 派生 → 关闭', async () => {
  const identities = new IdentityRegistry();
  const registry = new PluginRegistry();
  const provider: Plugin = {
    identity: identities.create({ domain: 'com.example', id: 'logger' }),
    capabilities: [{ name: 'logging', version: '1.0.0' }],
    lifecycle: 'INACTIVE',
  };
  const consumer: Plugin = {
    identity: identities.create({ domain: 'com.example', id: 'app' }),
    capabilities: [],
    lifecycle: 'INACTIVE',
  };
  registry.register(provider);
  registry.register(consumer);

  const core = createCompositionCore(registry);
  const request = {
    from: provider.identity,
    to: consumer.identity,
    capability: { plugin: provider.identity, name: 'logging', version: '1.0.0' },
  };

  const dormant = await core.bind(request);
  expect(core.bindingState(dormant.id)).toBe('DORMANT'); // 两端 INACTIVE

  await core.activate(provider.identity);
  await core.activate(consumer.identity);
  expect(core.bindingState(dormant.id)).toBe('ACTIVE'); // 重新派生，Binding 本身未变

  expect((await core.bind(request)).id).toBe(dormant.id); // §6.8：不新建第二个非 CLOSED Binding

  await core.unbind(dormant.id);
  expect(core.bindingState(dormant.id)).toBe('CLOSED');
  expect(() => core.requireBinding(dormant.id)).toThrow('EAPP_BINDING_CLOSED');
  await core.unbind(dormant.id); // 幂等
});

test('Bootstrap Runtime：根 MUST 先存在', async () => {
  const boot = createBootstrapRuntime({ domain: 'com.example' });
  const root = await boot.createIdentity('root'); // BR-2：不依赖任何 Plugin
  expect(root.domain).toBe('com.example');

  const discovery = boot.provideInitialDiscovery(); // BR-3
  await expect(discovery.find({}, {})).resolves.toEqual([]);

  await expect(
    boot.loadFirstPlugin({ domain: 'com.example', id: 'ghost', instance: 'ghost-1' }),
  ).rejects.toThrow('EAPP_PLUGIN_NOT_FOUND'); // BR-1：不伪造占位根

  boot.replaceDiscovery(new DiscoveryService(new PluginRegistry())); // §12.3
  expect(() => boot.replaceDiscovery(undefined)).toThrow('EAPP_UNSUPPORTED');
});
```

> 第二段示例导入的是 `@eapp/runtime`：§12 的 Bootstrap 契约由它实现，`@eapp/core` 不提供。

---

## 相关

- [`Binding`](./binding.md) —— 派生状态、绑定身份与唯一性
- [`Lifecycle`](./lifecycle.md) —— 四个生命周期操作的状态语义
- [`Discovery`](./discovery.md) —— `find` / `watch` 的 scope、事件与缓存
- [`Plugin`](./plugin.md) —— 端点注册表与只读视图
- [`Identity`](./identity.md)、[`Capability`](./capability.md) —— 寻址与能力引用的形状
- [v3.0.0-core §9](../spec/v3.0.0-core.md)、[§12 Bootstrap Runtime](../spec/v3.0.0-core.md) —— 规范性正文
- [一致性报告](../CONFORMANCE.md) —— 合规等级 C1–C8 与已登记的偏离

# `Plugin`

> 什么样的东西**可以被组合**——Identity、可选的能力集合，以及参与状态。

| | |
|---|---|
| **层** | v3.0 Composition Core |
| **规范** | [v3.0.0-core §5](../spec/v3.0.0-core.md) |
| **实现** | [`packages/core/src/plugin.ts`](../../packages/core/src/plugin.ts) |
| **测试** | [`tests/conformance/core.test.ts`](../../tests/conformance/core.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface Plugin {
  identity: Identity;
  capabilities: Capability[];      // MAY be empty
  lifecycle: LifecycleState;
}

/** 对 Plugin 的引用就是它的 Identity。 */
type PluginRef = Identity;

interface PluginChangeEvent {
  type: 'registered' | 'lifecycle' | 'capabilities';
  plugin: PluginRef;
}

class PluginRegistry {
  register(plugin: Plugin): void;
  get(identity: Identity): Plugin | undefined;
  require(identity: Identity): Plugin;
  list(): Plugin[];

  setLifecycle(identity: Identity, state: LifecycleState): void;
  declareCapabilities(identity: Identity, capabilities: Capability[]): void;
  setCapabilities(identity: Identity, capabilities: Capability[]): void;   // declareCapabilities 的别名

  findExposing(ref: Omit<CapabilityRef, 'plugin'>, from: Identity): boolean;

  changeRevision(): number;
  onChange(listener: (event: PluginChangeEvent) => void): () => void;
  size(): number;
}
```

`Plugin` 的字段：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `identity` | `Identity` | 是 | 唯一且不可变的身份；`PluginRef` 就是它（P-1、P-3） |
| `capabilities` | `Capability[]` | 是 | 声明暴露的能力集合；MAY 为空数组（P-2） |
| `lifecycle` | `LifecycleState` | 是 | `INACTIVE` / `ACTIVE` / `SUSPENDED` |

`PluginRegistry` 的成员：

| 成员 | 行为 |
|---|---|
| `register(plugin)` | 注册。同一 Identity 再次注册抛 `EAPP_IDENTITY_DUPLICATE`（P-1） |
| `get` / `require` | 取只读视图；`require` 对未知 Identity 抛 `EAPP_PLUGIN_NOT_FOUND` |
| `list` / `size` | 全部视图 / 注册数量 |
| `setLifecycle(identity, state)` | 只接受 §7.2 的转移；同状态（`INACTIVE → INACTIVE`）是合法 no-op |
| `declareCapabilities(identity, list)` | 显式声明能力集合，**整体替换**已暴露集合（P-4） |
| `findExposing(ref, from)` | `from` 是否精确暴露 `name@version`；未知 Plugin 返回 `false` |
| `changeRevision()` | 单调变更计数；每次注册表变更 +1，被 [`Discovery`](./discovery.md) 用作缓存失效戳 |
| `onChange(listener)` | 订阅 `registered` / `lifecycle` / `capabilities`；返回退订函数 |

---

## 语义

Plugin 是「一个具有 Identity、可选地暴露 Capability、并参与 Lifecycle 的可组合实体」（§5.2）。它 MAY 是一个 in-process module、process、worker、remote service、device、runtime、transport、database、AI model、UI component，或者另一个 plugin system——EaPP **不要求**它们具有相同的实现形态，只要求它们都可被这三个字段描述。

- 引用即身份：`PluginRef = Identity`（三字段值对象，不含版本）。没有独立的「插件句柄」类型，因此 [`Binding`](./binding.md) 的端点与 [`CompositionCore`](./composition-core.md) 的寻址参数都是 Identity。见 [`Identity`](./identity.md)。
- **注册表返回的是只读视图**：`identity` 与 `lifecycle` 是 getter，`capabilities` 每次读取返回一份新副本。调用方改不动注册表，因此能力集合的变化 MUST 走显式声明（P-4）。
- 注册时做防御性拷贝：注册之后修改调用方手里的数组不会改变注册表；`capabilities` 为空的 Plugin 是合法的（P-2），它 MAY 先注册、稍后声明能力。
- 身份只在注册那一刻确定：`identity` 在注册表内不可替换（P-3）。要换身份就是另一个 Plugin。
- 生命周期操作走 `setLifecycle`，它只编码 §7.2 的转移表；`activate` / `suspend` / `resume` / `deactivate` 的幂等与「SUSPENDED MUST 用 resume」是操作层面的性质，由 [`CompositionCore`](./composition-core.md) 施加。见 [`Lifecycle`](./lifecycle.md)。
- 能力集合的变化是一种**显式声明**，不是隐式副作用：`declareCapabilities` 整体替换集合，于是撤回一个能力会让依赖它的 Binding 派生为 DORMANT（§6.6）。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `P-1` | 每个 Plugin MUST 有唯一 Identity | `core.test.ts` › `'P-1 / P-3: a Plugin has one immutable Identity'` |
| `P-2` | Plugin 的 `capabilities` MAY be empty | `core.test.ts` › `'P-2: capabilities MAY be empty'` |
| `P-3` | Plugin Identity MUST NOT 在生命周期内改变 | `core.test.ts` › `'P-1 / P-3: a Plugin has one immutable Identity'` |
| `P-4` | Capability 集合 MAY 在生命周期内变化（通过显式声明更新） | `core.test.ts` › `'P-4: the capability set may change by explicit declaration'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_IDENTITY_DUPLICATE` | 该 Identity 已注册（P-1） | `false` |
| `EAPP_CAPABILITY_NOT_FOUND` | `capabilities` 不是数组，或其中某项不是合法 [`Capability`](./capability.md) | `false` |
| `EAPP_LIFECYCLE_INVALID` | `lifecycle` 不是三个状态之一；或 `setLifecycle` 请求了 §7.2 之外的转移 | `false` |
| `EAPP_PLUGIN_NOT_FOUND` | 对未知 Identity 调用 `require` / `setLifecycle` / `declareCapabilities` | `false` |
| `EAPP_INTERNAL` | `register` 的参数不是对象 | `false` |

`retryable` 取 `EappError` 的默认值：只有 `EAPP_REVISION_CONFLICT` 在 `RETRYABLE_CODES` 中，本层的码都不在其中，`@eapp/core` 也没有任何调用点显式传入 `retryable`。

---

## 示例

```typescript
import { expect, test } from 'vitest';
import { IdentityRegistry, PluginRegistry, type Plugin } from '@eapp/core';

test('Plugin：注册、只读视图、显式声明能力', () => {
  const identities = new IdentityRegistry();
  const registry = new PluginRegistry();
  const plugin: Plugin = {
    identity: identities.create({ domain: 'com.example', id: 'logger' }),
    capabilities: [{ name: 'logging', version: '1.0.0' }],
    lifecycle: 'INACTIVE',
  };

  registry.register(plugin);
  expect(() => registry.register(plugin)).toThrow('EAPP_IDENTITY_DUPLICATE'); // P-1

  const seen: string[] = [];
  const off = registry.onChange((event) => seen.push(event.type));
  registry.setLifecycle(plugin.identity, 'ACTIVE');
  registry.declareCapabilities(plugin.identity, []); // P-4：显式声明
  off();

  expect(seen).toEqual(['lifecycle', 'capabilities']);
  expect(registry.require(plugin.identity).lifecycle).toBe('ACTIVE');
  expect(registry.findExposing({ name: 'logging', version: '1.0.0' }, plugin.identity)).toBe(false);

  // 视图是只读的：调用方拿到的是副本，改不动注册表
  const view = registry.require(plugin.identity);
  view.capabilities.push({ name: 'sneaky', version: '1.0.0' });
  expect(registry.require(plugin.identity).capabilities).toEqual([]);
  expect(registry.changeRevision()).toBe(3);
});
```

---

## 相关

- [`Identity`](./identity.md) —— Plugin 的身份与 `PluginRef` 的形状
- [`Capability`](./capability.md) —— `capabilities` 声明的类型与版本语义
- [`Lifecycle`](./lifecycle.md) —— `lifecycle` 字段的取值与转移表
- [`Binding`](./binding.md) —— 端点 MUST 是已注册的 Plugin；能力撤回使绑定派生为 DORMANT
- [`Discovery`](./discovery.md) —— 从注册表读可见性，并以 `changeRevision` 做缓存失效
- [`CompositionCore`](./composition-core.md) —— 组合与生命周期操作的操作面
- [v3.0.0-core §5](../spec/v3.0.0-core.md) —— 规范性正文

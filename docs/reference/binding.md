# `Binding`

> **谁和谁**建立了关系——`(from, to, capability)` 三元组，以及由它派生出的状态。

| | |
|---|---|
| **层** | v3.0 Composition Core |
| **规范** | [v3.0.0-core §6](../spec/v3.0.0-core.md) |
| **实现** | [`packages/core/src/binding.ts`](../../packages/core/src/binding.ts) |
| **测试** | [`tests/conformance/core.test.ts`](../../tests/conformance/core.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
type BindingState = 'ACTIVE' | 'DORMANT' | 'CLOSED';

interface Binding {
  id: string;
  from: PluginRef;              // 提供 Capability 的一方
  to: PluginRef;                // 消费 Capability 的一方
  capability: CapabilityRef;    // 含 version
  contract?: ContractRef;
}

const CLOSED_BINDING_STATE: BindingState = 'CLOSED';

function bindingKey(from: PluginRef, to: PluginRef, capability: CapabilityRef): string;

function deriveBindingState(args: {
  closed: boolean;
  fromLifecycle: LifecycleState;
  toLifecycle: LifecycleState;
  capabilityStillExposed: boolean;
}): BindingState;
```

观察与操作入口在 [`CompositionCore`](./composition-core.md)：`bind` / `unbind` 改关系，`bindingState` / `binding` / `requireBinding` / `listBindings` / `onBindingStateChange` 读派生结果。

字段逐个说明：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | `string` | 是 | 绑定标识，由 `bind` 生成；`unbind` / 查询都以它寻址 |
| `from` | `PluginRef` | 是 | 提供方；MUST 是已注册的 Plugin（B-1） |
| `to` | `PluginRef` | 是 | 消费方；MUST 是已注册的 Plugin（B-1） |
| `capability` | `CapabilityRef` | 是 | 被组合的能力，含版本；`capability.plugin` MUST equal `from`（B-7） |
| `contract` | `ContractRef` | 否 | 可选上下文，与 [`Capability`](./capability.md) 的 `contract` 同形 |

**Binding 没有 `state` 字段**（§6.1）。它的稳定语义状态是派生的，不是存储的（B-3）。

---

## 语义

### 基础属性与稳定状态

```
Binding
   │
┌──┴───────┐
│          │
CLOSED     OPEN
           │
     ┌─────┴─────┐
     │           │
   ACTIVE      DORMANT
```

- `OPEN` / `CLOSED` 是**基础属性**：`OPEN` iff 未被显式 unbind，`CLOSED` iff 已被显式 unbind；`OPEN` 不是稳定语义状态，`CLOSED` 是终结状态（§6.3、B-4）。
- `ACTIVE` / `DORMANT` / `CLOSED` 是三个稳定语义状态（§6.2）。`PENDING` MAY 作为 `bind()` 的内部事务状态存在，但 MUST NOT 对外可观察（B-9）——参考实现根本不会产生它。

### 派生规则（§6.4）

```
CLOSED   iff 已被显式 unbind
ACTIVE   iff OPEN
         and from.lifecycle == ACTIVE
         and to.lifecycle   == ACTIVE
         and from 仍暴露 capability
DORMANT  iff OPEN 且 ACTIVE 的条件不满足
```

`deriveBindingState` 就是这四条规则的直接编码：闭包优先，其次三个 ACTIVE 条件，其余一律 DORMANT。

### 触发源统一（§6.6）

| 触发源 | 结果 |
|---|---|
| `from` 进入 INACTIVE | DORMANT |
| `from` 进入 SUSPENDED | DORMANT |
| `to` 进入 INACTIVE | DORMANT |
| `to` 进入 SUSPENDED | DORMANT |
| `from` 撤回 Capability | DORMANT |
| 上述任一恢复 | ACTIVE |

**`deactivate` 与 `suspend` 对 Binding 的效果相同**：都只让绑定派生为 DORMANT，都不解除绑定。见 [`Lifecycle`](./lifecycle.md)。

### 身份与唯一性

- 绑定身份是 `(from, to, capability)`，能力版本是其中一部分（C-6）。规范化形式为 `fromKey->toKey::pluginKey#name@version`（`bindingKey`）。
- 同一 `(from, to, capability)` 在任意时刻 MUST NOT 存在多个非 CLOSED Binding，且唯一性检查与创建 MUST 原子（§6.8、B-6、B-8）。并发 `bind(A,B,X)` 的其余请求 MUST return existing Binding 或 fail with `EAPP_BINDING_DUPLICATE`——参考实现恒取前一支：返回已存在的 Binding，因此 `EAPP_BINDING_DUPLICATE` 在 Composition Core 中没有抛出点。

### 边界

Binding MUST NOT 声明消息方向、同步 / 异步、投递保证或序列化格式（§6.9）。这些属于 Interaction 层：Composition Core 只承认“有一条关系”，不定义关系上怎么传话（CH-1，见 [`CompositionCore`](./composition-core.md)）。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `B-1` | `from` / `to` MUST 是已存在的 Plugin | `core.test.ts` › `'B-1 / B-2 / B-7 / O-2: bind validates both endpoints and the capability'` |
| `B-2` | `capability` MUST 由 `from` 暴露 | `core.test.ts` › `'B-1 / B-2 / B-7 / O-2: bind validates both endpoints and the capability'` |
| `B-3` | Binding 状态 MUST 是派生的，MUST NOT 被直接设置 | `core.test.ts` › `'B-3: Binding state is derived, never set directly'` |
| `B-4` | CLOSED 是终结状态 | `core.test.ts` › `'B-4 / O-3 / O-4: CLOSED is terminal and unbind is idempotent'` |
| `B-5` | 任一端 INACTIVE 或 SUSPENDED，Binding MUST 派生为 DORMANT | `core.test.ts` › `'B-5: any endpoint INACTIVE or SUSPENDED derives DORMANT'` |
| `B-6` | 同一 `(from, to, capability)` MUST NOT 有多个非 CLOSED Binding | `core.test.ts` › `'B-6 / B-8: at most one non-CLOSED Binding per (from, to, capability), atomically'` |
| `B-7` | `Binding.capability.plugin` MUST equal `Binding.from` | `core.test.ts` › `'B-1 / B-2 / B-7 / O-2: bind validates both endpoints and the capability'` |
| `B-8` | 唯一性检查与创建 MUST 原子 | `core.test.ts` › `'B-6 / B-8: at most one non-CLOSED Binding per (from, to, capability), atomically'` |
| `B-9` | PENDING Binding MUST NOT 对外可观察 | `core.test.ts` › `'B-9: a PENDING Binding is never externally observable'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_PLUGIN_NOT_FOUND` | `from` 或 `to` 未注册（B-1），由 `bind()` 抛出 | `false` |
| `EAPP_CAPABILITY_NOT_EXPOSED` | `from` 未暴露所声明的 `name@version`（B-2） | `false` |
| `EAPP_BINDING_INVALID` | `capability.plugin` ≠ `from`（B-7）；或请求了未知的 binding id | `false` |
| `EAPP_BINDING_CLOSED` | 对 CLOSED Binding 做要求 OPEN 的访问（`requireBinding`） | `false` |
| `EAPP_BINDING_DUPLICATE` | §6.8 允许的另一支：并发 `bind` 中除第一个之外的请求。**参考实现从不抛它**——它总是返回已存在的非 CLOSED Binding，因此这个码在 Composition Core 里没有抛出点 | `false` |

`retryable` 取 `EappError` 的默认值：只有 `EAPP_REVISION_CONFLICT` 在 `RETRYABLE_CODES` 中，本层的码都不在其中，`@eapp/core` 也没有任何调用点显式传入 `retryable`。

---

## 示例

```typescript
import { expect, test } from 'vitest';
import {
  IdentityRegistry,
  PluginRegistry,
  bindingKey,
  capabilityRefKey,
  createCompositionCore,
  deriveBindingState,
  identityKey,
  type CapabilityRef,
} from '@eapp/core';

test('Binding：派生状态与身份键', async () => {
  const identities = new IdentityRegistry();
  const from = identities.create({ domain: 'com.example', id: 'logger' });
  const to = identities.create({ domain: 'com.example', id: 'app' });
  const capability: CapabilityRef = { plugin: from, name: 'logging', version: '1.0.0' };

  expect(bindingKey(from, to, capability)).toBe(
    `${identityKey(from)}->${identityKey(to)}::${capabilityRefKey(capability)}`,
  );

  // §6.4：状态是四个事实的函数
  expect(
    deriveBindingState({
      closed: true,
      fromLifecycle: 'ACTIVE',
      toLifecycle: 'ACTIVE',
      capabilityStillExposed: true,
    }),
  ).toBe('CLOSED');
  expect(
    deriveBindingState({
      closed: false,
      fromLifecycle: 'ACTIVE',
      toLifecycle: 'ACTIVE',
      capabilityStillExposed: true,
    }),
  ).toBe('ACTIVE');
  expect(
    deriveBindingState({
      closed: false,
      fromLifecycle: 'ACTIVE',
      toLifecycle: 'SUSPENDED',
      capabilityStillExposed: true,
    }),
  ).toBe('DORMANT');
  expect(
    deriveBindingState({
      closed: false,
      fromLifecycle: 'ACTIVE',
      toLifecycle: 'ACTIVE',
      capabilityStillExposed: false,
    }),
  ).toBe('DORMANT');

  const registry = new PluginRegistry();
  registry.register({
    identity: from,
    capabilities: [{ name: 'logging', version: '1.0.0' }],
    lifecycle: 'INACTIVE',
  });
  registry.register({ identity: to, capabilities: [], lifecycle: 'INACTIVE' });
  const core = createCompositionCore(registry);

  const binding = await core.bind({ from, to, capability }); // 两端 INACTIVE ⇒ DORMANT
  expect(Object.keys(binding)).not.toContain('state'); // B-3：没有 state 字段
  expect(Object.isFrozen(binding)).toBe(true);
  expect(core.bindingState(binding.id)).toBe('DORMANT');

  await core.unbind(binding.id);
  expect(core.bindingState(binding.id)).toBe('CLOSED'); // CLOSED 终结
});
```

---

## 相关

- [`CompositionCore`](./composition-core.md) —— `bind` / `unbind` 与派生状态的读取入口
- [`Lifecycle`](./lifecycle.md) —— 端点状态如何使绑定派生为 DORMANT
- [`Capability`](./capability.md) —— 三元组的第三项与版本参与绑定的方式
- [`Plugin`](./plugin.md) —— 端点 MUST 是已注册的 Plugin，撤回能力使绑定 DORMANT
- [`Identity`](./identity.md) —— `from` / `to` 的形状与规范化键
- [v3.0.0-core §6](../spec/v3.0.0-core.md) —— 规范性正文

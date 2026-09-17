# `Lifecycle`

> 它**是否参与**当前组合——三个状态、四个操作、一张闭合的转移表。

| | |
|---|---|
| **层** | v3.0 Composition Core |
| **规范** | [v3.0.0-core §7](../spec/v3.0.0-core.md) |
| **实现** | [`packages/core/src/lifecycle.ts`](../../packages/core/src/lifecycle.ts) |
| **测试** | [`tests/conformance/core.test.ts`](../../tests/conformance/core.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
type LifecycleState = 'INACTIVE' | 'ACTIVE' | 'SUSPENDED';

const LIFECYCLE_STATES: readonly LifecycleState[];     // ['INACTIVE', 'ACTIVE', 'SUSPENDED']

function isLifecycleState(value: unknown): value is LifecycleState;
function canTransition(from: LifecycleState, to: LifecycleState): boolean;
function assertTransition(from: LifecycleState, to: LifecycleState): void;   // 非法时抛 EAPP_LIFECYCLE_INVALID
```

四个操作在 [`CompositionCore`](./composition-core.md) 上（`activate` / `deactivate` / `suspend` / `resume`），底层转移由 `PluginRegistry.setLifecycle` 施加。字段本身属于 [`Plugin`](./plugin.md)。

状态（§7.1）：

| 状态 | 含义 |
|---|---|
| `INACTIVE` | 已注册，不参与当前组合 |
| `ACTIVE` | 参与当前组合 |
| `SUSPENDED` | 保留 Identity 与 Binding，但不再参与 Active Composition |

实现 MAY 扩展 `STARTING` / `STOPPING` / `DRAINING` / `FAILED`，但 MUST NOT 破坏 Core 语义。参考实现只实现这三个状态：`isLifecycleState` 对其他取值一律 `false`。

---

## 语义

### 转移表（§7.2）

```
INACTIVE  --activate-->   ACTIVE
ACTIVE    --suspend-->    SUSPENDED
SUSPENDED --resume-->     ACTIVE

ACTIVE    --deactivate--> INACTIVE
SUSPENDED --deactivate--> INACTIVE
INACTIVE  --deactivate--> INACTIVE
```

`canTransition` 就是这张表的直接编码：目标为 `INACTIVE` 一律允许；目标为 `ACTIVE` 时来源 MUST 是 `INACTIVE` 或 `SUSPENDED`；目标为 `SUSPENDED` 时来源 MUST 是 `ACTIVE`。`INACTIVE → SUSPENDED` 不被允许——不存在「直接暂停」。

### 操作语义（§7.3）

| 操作 | 合法源 | 结果 |
|---|---|---|
| `activate` | **INACTIVE only** | ACTIVE |
| `deactivate` | ACTIVE / SUSPENDED / INACTIVE | INACTIVE |
| `suspend` | ACTIVE only | SUSPENDED |
| `resume` | **SUSPENDED only** | ACTIVE |

- `activate` MUST NOT 用于从 SUSPENDED 恢复 Plugin；从 SUSPENDED 恢复 MUST 使用 `resume`（L-6）。
- `activate` 对已 ACTIVE 的 Plugin 是幂等 no-op，`deactivate` 对已 INACTIVE 的 Plugin 同样是 no-op。**幂等性是操作层面的性质，不在转移表里**：转移表不因为「重复调用」而放宽，`ACTIVE → ACTIVE` 与 `SUSPENDED → SUSPENDED` 都不是合法转移。
- `suspend` 与 `resume` 没有幂等的余地：对非 ACTIVE 调用 `suspend`、对非 SUSPENDED 调用 `resume` 一律抛 `EAPP_LIFECYCLE_INVALID`。

### 与 Binding 的关系（§7.4）

- Plugin 进入 `INACTIVE` 或 `SUSPENDED`：其所有 Binding 派生为 `DORMANT`。
- Plugin 恢复 `ACTIVE`：其所有 Binding 重新派生。
- `deactivate` MUST NOT 直接 CLOSE Binding。解绑只能由 `unbind` 做出。

派生规则本身见 [`Binding`](./binding.md)。

### SUSPENDED 的语义边界（§7.5）

Composition Core 对 `SUSPENDED` 的完整定义是：

> Plugin 保留 Identity 与 Binding，但不再参与 Active Composition。

**Composition Core MUST NOT 定义 Channel 的具体暂停、丢弃、缓存、排空或重新投递行为。** 这些属于 Interaction 层；在 Core 里，`SUSPENDED` 只意味着「绑定还在，但不再 `ACTIVE`」。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `L-1` | `activate` MUST 从 INACTIVE 进入 ACTIVE | `core.test.ts` › `'L-1 / L-6: activate applies only to INACTIVE'` |
| `L-2` | `deactivate` MUST 从任意状态进入 INACTIVE | `core.test.ts` › `'L-2: deactivate reaches INACTIVE from any state'` |
| `L-3` | `suspend` 只对 ACTIVE 有效 | `core.test.ts` › `'L-3 / L-4: suspend needs ACTIVE, resume needs SUSPENDED'` |
| `L-4` | `resume` 只对 SUSPENDED 有效 | `core.test.ts` › `'L-3 / L-4: suspend needs ACTIVE, resume needs SUSPENDED'` |
| `L-5` | SUSPENDED MUST NOT 解除 Binding | `core.test.ts` › `'L-5 / O-7: SUSPENDED does not unbind'` |
| `L-6` | `activate` applies only to INACTIVE；`resume` applies only to SUSPENDED | `core.test.ts` › `'L-1 / L-6: activate applies only to INACTIVE'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_LIFECYCLE_INVALID` | 请求了 §7.2 之外的转移（`assertTransition`、`setLifecycle`）；`activate` 用于 SUSPENDED（L-6）；`suspend` 用于非 ACTIVE（L-3）；`resume` 用于非 SUSPENDED（L-4）；注册 Plugin 时 `lifecycle` 不是三个状态之一 | `false` |

`retryable` 取 `EappError` 的默认值：只有 `EAPP_REVISION_CONFLICT` 在 `RETRYABLE_CODES` 中，本层的码都不在其中，`@eapp/core` 也没有任何调用点显式传入 `retryable`。

---

## 示例

```typescript
import { expect, test } from 'vitest';
import {
  IdentityRegistry,
  LIFECYCLE_STATES,
  PluginRegistry,
  assertTransition,
  canTransition,
  createCompositionCore,
  isLifecycleState,
} from '@eapp/core';

test('Lifecycle：转移表与四个操作', async () => {
  // §7.2：转移表闭合
  expect(canTransition('INACTIVE', 'ACTIVE')).toBe(true);
  expect(canTransition('ACTIVE', 'SUSPENDED')).toBe(true);
  expect(canTransition('SUSPENDED', 'ACTIVE')).toBe(true);
  expect(canTransition('INACTIVE', 'SUSPENDED')).toBe(false); // 不存在「直接暂停」
  expect(isLifecycleState('STARTING')).toBe(false); // v3.0 只冻结三个状态
  expect(LIFECYCLE_STATES).toEqual(['INACTIVE', 'ACTIVE', 'SUSPENDED']);
  expect(() => assertTransition('SUSPENDED', 'SUSPENDED')).toThrow('EAPP_LIFECYCLE_INVALID');

  const identities = new IdentityRegistry();
  const registry = new PluginRegistry();
  registry.register({
    identity: identities.create({ domain: 'com.example', id: 'logger' }),
    capabilities: [],
    lifecycle: 'INACTIVE',
  });
  const identity = registry.list()[0]!.identity;
  const core = createCompositionCore(registry);

  await core.activate(identity);
  await core.suspend(identity);
  await expect(core.activate(identity)).rejects.toThrow('EAPP_LIFECYCLE_INVALID'); // L-6
  await core.resume(identity);
  await core.deactivate(identity);
  expect(registry.require(identity).lifecycle).toBe('INACTIVE');
});
```

---

## 相关

- [`Plugin`](./plugin.md) —— `lifecycle` 是 Plugin 的字段，注册表是施加转移的地方
- [`Binding`](./binding.md) —— 端点状态如何派生绑定状态；DORMANT 与解绑的区别
- [`CompositionCore`](./composition-core.md) —— 四个生命周期操作与它们的幂等语义
- [v3.0.0-core §7](../spec/v3.0.0-core.md) —— 规范性正文

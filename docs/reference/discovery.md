# `Discovery`

> 有哪些东西**可以被组合**——带 Trust Scope 的 `find` 与 `watch`。

| | |
|---|---|
| **层** | v3.0 Composition Core |
| **规范** | [v3.0.0-core §8](../spec/v3.0.0-core.md) |
| **实现** | [`packages/core/src/discovery.ts`](../../packages/core/src/discovery.ts) |
| **测试** | [`tests/conformance/core.test.ts`](../../tests/conformance/core.test.ts) |
| **稳定度** | FROZEN |

> **这里曾经有一处未登记的冲突，已经关掉。** §8.1 把 `Criteria.version` 注释为
> `// SemVer range`，而实现一度只做精确匹配 —— 于是 `find({ version: '^1.0.0' })`
> **静默返回空集**，与"确实没有插件匹配"无法区分。
> 实现已按规范补上 range 匹配（[`packages/core/src/semver.ts`](../../packages/core/src/semver.ts)），
> 记录见 [`CHANGELOG.md` §勘误 E-E](../spec/CHANGELOG.md) 与
> [`CONFORMANCE.md` §7](../CONFORMANCE.md)。**现在规范与实现一致，本页不再需要偏离声明。**

---

## 签名

```typescript
type TrustLevel = 'L0' | 'L1' | 'L2';
const TRUST_LEVELS: readonly TrustLevel[];             // ['L0', 'L1', 'L2']
function isTrustLevel(value: unknown): value is TrustLevel;

interface DiscoveryScope {
  trustLevel?: TrustLevel;
  trustDomain?: string;
}

interface Criteria {
  capability?: string;
  version?: string;              // SemVer range（§8.1）
  constraints?: Constraint[];
  identity?: Partial<Identity>;
}

interface DiscoveryEvent {
  type: 'added' | 'removed' | 'changed';
  plugin: PluginRef;
}

interface Discovery {
  find(criteria: Criteria, scope: DiscoveryScope): Promise<PluginRef[]>;
  watch(criteria: Criteria, scope: DiscoveryScope): AsyncIterable<DiscoveryEvent>;
}

interface DiscoveryTrustPolicy {
  trustLevels?: readonly TrustLevel[];     // 本服务能评估的等级
  trustDomains?: readonly string[];        // 本服务能评估的域
  isVisible?: (plugin: PluginRef, scope: DiscoveryScope) => boolean;
}

interface DiscoveryWatch extends AsyncIterable<DiscoveryEvent> { close(): void }

interface DiscoveryCacheStats { hits: number; misses: number; size: number }

function matchesCriteria(plugin: Plugin, criteria: Criteria): boolean;

class DiscoveryService implements Discovery {
  constructor(registry: PluginRegistry, policy?: DiscoveryTrustPolicy);
  find(criteria: Criteria, scope: DiscoveryScope): Promise<PluginRef[]>;
  watch(criteria: Criteria, scope: DiscoveryScope): DiscoveryWatch;
  notify(event: DiscoveryEvent): void;      // 事件注入点
  invalidate(): void;                       // 显式缓存失效
  cacheStats(): DiscoveryCacheStats;
  watcherCount(): number;
  dispose(): void;
}
```

`DiscoveryScope` 的字段：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `trustLevel` | `TrustLevel` | 否 | Trust / Deployment 分类；只接受策略声明过的等级 |
| `trustDomain` | `string` | 否 | 命名域；只接受策略声明过的域 |

`Criteria` 的字段：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `capability` | `string` | 否 | 能力名 |
| `version` | `string` | 否 | SemVer range（§8.1）。裸版本精确匹配；`^` / `~` / `>` `>=` `<` `<=` `=` / `*`、空格连接的合取、`\|\|` 均可。语法不认识的范围由 `isValidRange` **明确拒绝**，而不是静默不匹配（勘误 E-E） |
| `constraints` | `Constraint[]` | 否 | 每项都 MUST 在候选的能力声明里找到 `kind` + `value` 都相等的对应项 |
| `identity` | `Partial<Identity>` | 否 | 逐字段比对 `domain` / `id` / `instance`，未给出的字段不过滤 |

---

## 语义

Discovery 只回答「有哪些 Plugin 存在、可见」，不回答「它们能不能组合」。两个操作是 Composition Core 里仅有的 Discovery operations（§8.1、§9.1），入口在 [`CompositionCore`](./composition-core.md)。

### Trust Scope MUST 可评估

`DiscoveryService` 只接受**自己有策略**的 scope：`trustLevel` MUST 在 `policy.trustLevels` 里，`trustDomain` MUST 在 `policy.trustDomains` 里，且 scope 对象 MUST NOT 携带 `trustLevel` / `trustDomain` 之外的字段。任何不满足的情形一律抛 `EAPP_DISCOVERY_SCOPE_INVALID`，静默忽略会让「只返回 scope 内可见的 Plugin」变成一句空话（D-1、D-2 因此可判定）。`find` 是 `async`，所以它异步拒绝；`watch` 在注册 watcher **之前**同步抛出。

可见性由一个谓词决定：`policy.isVisible(plugin, scope)`。未提供该谓词时，被接受的 scope 内所有 Plugin 都可见；scope 为空对象时，所有 Plugin 都可见。

### Trust Level 是分类，不是等级（§8.2）

`L0` / `L1` / `L2` MUST NOT 被解释为 `L2 > L1 > L0`，也不得自动推导出 `L2 can access L1`。匹配函数里不存在任何数值比较：等级要么被策略声明、要么不被声明（D-7）。授权是上层的事，不在 Composition Core 里。

### 匹配

`matchesCriteria` 先按 `criteria.identity` 过滤（给出的字段 MUST 相等），再看能力：`capability` / `version` / `constraints` 三项都缺席时只按身份过滤；否则候选 Plugin 的**某一个**能力 MUST 同时满足三项条件（能力之间是「或」，条件之间是「与」）。

### 事件与缓存

- `notify(event)` 是事件注入点：只接受 `added` / `removed` / `changed` 三种类型，且 `plugin` MUST 是合法 [`Identity`](./identity.md)（D-6）。事件只会推送给 scope 内可见、且匹配 criteria 的 watcher（D-2）。
- `watch` 返回的对象既是 async iterable，也带 `close()`。`for await ... break` 会在生成器的 `finally` 里注销 watcher，因此中断循环不会泄漏 watcher；`watcherCount()` 暴露存活数量。
- `find` 的结果按 `(criteria, scope)` 缓存，并绑定当时的 `PluginRegistry.changeRevision()`。任何注册表变更（`registered` / `lifecycle` / `capabilities`）与任何 `DiscoveryEvent` 都会使缓存失效；`invalidate()` 可显式失效，`cacheStats()` 暴露 hits / misses / size（D-4）。

### 边界

- D-3：发现**不**保证「发现即可组合」。`find` 返回的是 `PluginRef[]`，不建立任何关系，也不检查能力是否被暴露。
- D-5：Discovery MUST NOT 成为 [`Binding`](./binding.md) 的替代品。要建立关系只能 `bind`。
- `watch` 的返回值是 `DiscoveryWatch`，它是 §8.1 的 `AsyncIterable<DiscoveryEvent>` 的超集（多了 `close()`），所以实现既能 `for await` 消费，也能主动结束。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `D-1` | `find` MUST 返回当前 Trust Scope 内可见的 Plugin | `core.test.ts` › `'D-1 / D-3: find respects the trust scope and never implies composability'` |
| `D-2` | `watch` MUST 只对当前 Trust Scope 内的事件触发 | `core.test.ts` › `'D-2 / D-6: watch only fires for the current scope and uses the frozen event types'` |
| `D-3` | Discovery MUST NOT 保证「发现即可组合」 | `core.test.ts` › `'D-1 / D-3: find respects the trust scope and never implies composability'` |
| `D-4` | Discovery MAY 缓存，但 MUST 有失效策略 | `core.test.ts` › `'D-4: discovery may cache, but only with an invalidation policy'` |
| `D-5` | Discovery MUST NOT 成为 Binding 的替代品 | `core.test.ts` › `'D-5: Discovery is not a substitute for Binding'` |
| `D-6` | `DiscoveryEvent.type` MUST 是 added / removed / changed 之一 | `core.test.ts` › `'D-2 / D-6: watch only fires for the current scope and uses the frozen event types'` |
| `D-7` | Trust level MUST NOT imply ordered authorization | `core.test.ts` › `'D-7: trust levels are categories, not an authorization order'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_DISCOVERY_SCOPE_INVALID` | scope 不是对象；携带 `trustLevel` / `trustDomain` 之外的字段；`trustLevel` 不是 `L0` / `L1` / `L2`；`trustDomain` 不是非空字符串；服务对该等级 / 域没有策略；`notify` 的事件类型不是三种之一，或 `plugin` 不是合法 Identity | `false` |

`retryable` 取 `EappError` 的默认值：只有 `EAPP_REVISION_CONFLICT` 在 `RETRYABLE_CODES` 中，本层的码都不在其中，`@eapp/core` 也没有任何调用点显式传入 `retryable`。

---

## 示例

```typescript
import { expect, test } from 'vitest';
import {
  DiscoveryService,
  IdentityRegistry,
  PluginRegistry,
  TRUST_LEVELS,
  type DiscoveryScope,
  type PluginRef,
} from '@eapp/core';

test('Discovery：Trust Scope、事件与缓存失效', async () => {
  const identities = new IdentityRegistry();
  const registry = new PluginRegistry();
  const logger = {
    identity: identities.create({ domain: 'com.example', id: 'logger' }),
    capabilities: [{ name: 'logging', version: '1.0.0' }],
    lifecycle: 'INACTIVE' as const,
  };
  const secret = {
    identity: identities.create({ domain: 'com.example', id: 'secret' }),
    capabilities: [{ name: 'logging', version: '1.0.0' }],
    lifecycle: 'INACTIVE' as const,
  };
  registry.register(logger);
  registry.register(secret);

  const discovery = new DiscoveryService(registry, {
    trustLevels: TRUST_LEVELS,
    trustDomains: ['com.example'],
    isVisible: (plugin: PluginRef, scope: DiscoveryScope) =>
      scope.trustLevel === undefined || plugin.id !== 'secret',
  });
  const scope: DiscoveryScope = { trustLevel: 'L0', trustDomain: 'com.example' };

  const visible = await discovery.find({ capability: 'logging' }, scope);
  expect(visible.map((ref) => ref.id)).toEqual(['logger']); // D-1：scope 外的 secret 不可见
  expect(discovery.cacheStats().size).toBe(1);

  // 服务没有策略的 scope MUST NOT 被静默忽略；find 异步拒绝，watch 同步抛出
  await expect(discovery.find({}, { trustDomain: 'other.example' })).rejects.toThrow(
    'EAPP_DISCOVERY_SCOPE_INVALID',
  );
  expect(() => discovery.watch({}, { trustLevel: 'L3' } as unknown as DiscoveryScope)).toThrow(
    'EAPP_DISCOVERY_SCOPE_INVALID',
  );

  const watch = discovery.watch({ capability: 'logging' }, scope);
  const pending = watch[Symbol.asyncIterator]().next();
  discovery.notify({ type: 'changed', plugin: logger.identity });
  const first = await pending;
  watch.close();
  expect(first.value?.type).toBe('changed'); // D-2 / D-6

  discovery.notify({ type: 'removed', plugin: logger.identity }); // D-4：事件使缓存失效
  expect(discovery.cacheStats().size).toBe(0);
  expect(() => discovery.notify({ type: 'birth', plugin: logger.identity } as never)).toThrow(
    'EAPP_DISCOVERY_SCOPE_INVALID',
  );
});
```

---

## 相关

- [`CompositionCore`](./composition-core.md) —— `find` / `watch` 的入口
- [`Plugin`](./plugin.md) —— `changeRevision` 是缓存失效戳的来源
- [`Capability`](./capability.md) —— `criteria.capability` / `criteria.version` 匹配的能力面
- [`Binding`](./binding.md) —— Discovery 不能替代的东西（D-5）
- [`Identity`](./identity.md) —— `DiscoveryEvent.plugin` 与 `criteria.identity` 的形状
- [v3.0.0-core §8](../spec/v3.0.0-core.md)、[一致性报告](../CONFORMANCE.md) —— 规范性正文与偏离登记

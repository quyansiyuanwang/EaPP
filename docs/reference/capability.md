# `Capability`

> 它能**做什么**——声明一个 Plugin 能参与什么类型的组合，版本由 Capability 自己承载。

| | |
|---|---|
| **层** | v3.0 Composition Core |
| **规范** | [v3.0.0-core §4](../spec/v3.0.0-core.md) |
| **实现** | [`packages/core/src/capability.ts`](../../packages/core/src/capability.ts) |
| **测试** | [`tests/conformance/core.test.ts`](../../tests/conformance/core.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface Capability {
  name: string;
  version: string;              // SemVer
  contract?: ContractRef;
  constraints?: Constraint[];
}

interface ContractRef {
  name: string;
  version: string;
  schema?: unknown;
}

interface Constraint {
  kind: string;
  value: unknown;
}

interface CapabilityRef {
  plugin: Identity;             // 暴露该 Capability 的一方
  name: string;
  version: string;
}

function isValidSemVer(version: string): boolean;
function assertValidCapability(capability: Capability): void;
function assertValidCapabilityRef(ref: CapabilityRef): void;
function capabilityMatches(capability: Capability, ref: { name: string; version: string }): boolean;

function capabilityRefKey(ref: CapabilityRef): string;     // `${plugin}#${name}@${version}`
```

`Capability` 的字段：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `name` | `string` | 是 | 能力名。MUST NOT 为空（C-1） |
| `version` | `string` | 是 | SemVer。参与引用与绑定身份（C-2、C-6） |
| `contract` | `ContractRef` | 否 | 可选上下文；缺席即不声明约定（C-3） |
| `constraints` | `Constraint[]` | 否 | 可选的约束列表；每项 MUST 有非空 `kind` 与存在的 `value` |

`CapabilityRef` 的字段：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `plugin` | `Identity` | 是 | 暴露方；`capabilityRefKey` 用它的规范化键做前缀 |
| `name` | `string` | 是 | 能力名，MUST 与暴露方声明的一致 |
| `version` | `string` | 是 | 版本，MUST 存在且是合法 SemVer（C-5） |

---

## 语义

Capability 描述的是一个 Plugin 能参与什么类型的组合（§4.2）。它**不等于** method list、RPC endpoint、HTTP route 或函数签名——这些都是某一层的实现形态，不是组合的类型。

多对多（§4.3）：

```
Plugin A ──┬── logging@1.0.0 ──┬── Plugin B
           └── metrics@2.3.1   └── Plugin C
```

- 一个 Plugin MAY 暴露多个 Capability；一个 Capability MAY 被多个 Plugin 暴露（C-4）。参考实现据此只按 `(name, version)` 匹配，不按暴露方去重。
- **版本 MUST 参与引用**（§4.4）：`CapabilityRef` = `plugin + name + version`，规范化键为 `domain/id/instance#name@version`（`capabilityRefKey`）。同一个 Plugin 同时暴露 `logging@1.0.0` 与 `logging@2.0.0` 时，它们是两条不同的引用，因此也是两条不同的 [`Binding`](./binding.md)（C-6）。
- SemVer 是 `major.minor.patch`，可选 `-prerelease` 与 `+build`：`1.2.3`、`1.2.3-rc.1`、`2.0.0-rc.1+build.5` 合法；`1.2`、`1.2.03`、`01.2.3` 不合法。`isValidSemVer` 只回答「是不是合法 SemVer」，不做版本比较；规范正文没有在 Composition Core 内冻结范围语义，参考实现的匹配（`capabilityMatches` / `PluginRegistry.findExposing`）是精确的 `name + version` 相等。
- `contract` 是**可选上下文**（C-3）：它指向「这个能力遵守什么约定」，不参与匹配，也不参与绑定身份。声明了 `contract` 就 MUST 是合法的 `{ name: 非空, version: 合法 SemVer }`。
- `constraints` 的**匹配语义未被规范冻结**（§15 的 C7 是 MAY）：参考实现只做 `kind` 相等且 `value` 结构相等的判定，供 [`Discovery`](./discovery.md) 的 `criteria.constraints` 使用。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `C-1` | `Capability.name` MUST NOT 为空 | `core.test.ts` › `'C-1 / C-2: name MUST NOT be empty and version MUST be valid SemVer'` |
| `C-2` | `Capability.version` MUST 是合法 SemVer | `core.test.ts` › `'C-1 / C-2: name MUST NOT be empty and version MUST be valid SemVer'` |
| `C-3` | `contract` 是可选上下文（缺席合法，在场 MUST 合法） | `core.test.ts` › `'C-3: contract is optional context'` |
| `C-4` | Capability MAY 被多个 Plugin 暴露 | `core.test.ts` › `'C-4 / C-6: a Capability may be exposed by many Plugins, and version is part of identity'` |
| `C-5` | `CapabilityRef` MUST 包含 `version` | `core.test.ts` › `'C-5: CapabilityRef MUST include a version'` |
| `C-6` | Capability version MUST 参与 Binding identity | `core.test.ts` › `'C-4 / C-6: a Capability may be exposed by many Plugins, and version is part of identity'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_CAPABILITY_NOT_FOUND` | `name` 缺失 / 非字符串 / 全空白；`version` 缺失或不是合法 SemVer；`contract` 形状非法；`constraints` 不是数组，或某项缺 `kind` / `value`。`Capability` 与 `CapabilityRef` 的形状错误共用这一个码 | `false` |
| `EAPP_CAPABILITY_NOT_EXPOSED` | 由 `bind()` 抛出（不在本文件的实现里）：`from` 未暴露所声明的 `name@version`。见 [`Binding`](./binding.md) | `false` |

`retryable` 取 `EappError` 的默认值：只有 `EAPP_REVISION_CONFLICT` 在 `RETRYABLE_CODES` 中，本层的码都不在其中，`@eapp/core` 也没有任何调用点显式传入 `retryable`。

---

## 示例

```typescript
import { expect, test } from 'vitest';
import {
  IdentityRegistry,
  PluginRegistry,
  assertValidCapability,
  capabilityRefKey,
  identityKey,
  isValidSemVer,
} from '@eapp/core';

test('Capability：声明、SemVer 与引用键', () => {
  expect(isValidSemVer('2.0.0-rc.1+build.5')).toBe(true);
  expect(isValidSemVer('2.0')).toBe(false); // C-2
  assertValidCapability({ name: 'logging', version: '1.0.0' }); // C-1, C-2
  expect(() => assertValidCapability({ name: '', version: '1.0.0' })).toThrow(
    'EAPP_CAPABILITY_NOT_FOUND',
  );

  const identities = new IdentityRegistry();
  const provider = identities.create({ domain: 'com.example', id: 'logger' });
  const registry = new PluginRegistry();
  registry.register({
    identity: provider,
    capabilities: [
      { name: 'logging', version: '1.0.0' },
      { name: 'logging', version: '2.0.0' },
    ],
    lifecycle: 'INACTIVE',
  });

  // C-6：版本参与引用键，同一个 Plugin 的两个版本是两条不同的引用
  expect(capabilityRefKey({ plugin: provider, name: 'logging', version: '1.0.0' })).toBe(
    `${identityKey(provider)}#logging@1.0.0`,
  );
  expect(registry.findExposing({ name: 'logging', version: '2.0.0' }, provider)).toBe(true);
  expect(registry.findExposing({ name: 'logging', version: '3.0.0' }, provider)).toBe(false);

  // C-3：contract 是可选上下文，缺席不报错
  expect(() =>
    assertValidCapability({
      name: 'logging',
      version: '1.0.0',
      contract: { name: 'log-v1', version: '1.0.0' },
    }),
  ).not.toThrow();
});
```

---

## 相关

- [`Identity`](./identity.md) —— 版本由 Capability 承载，Identity 不承载
- [`Plugin`](./plugin.md) —— `capabilities` 是 Plugin 的声明，`findExposing` 是查询入口
- [`Binding`](./binding.md) —— 绑定三元组的第三项就是 `CapabilityRef`
- [`Discovery`](./discovery.md) —— `criteria.capability` / `criteria.version` 按这一层匹配
- [v3.0.0-core §4](../spec/v3.0.0-core.md)、[§15 合规等级](../spec/v3.0.0-core.md)（C7 Constraints 为 MAY） —— 规范性正文

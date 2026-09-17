# `Identity`

> 这是**谁**——不含版本的运行时身份。

| | |
|---|---|
| **层** | v3.0 Composition Core |
| **规范** | [v3.0.0-core §3](../spec/v3.0.0-core.md) |
| **实现** | [`packages/core/src/identity.ts`](../../packages/core/src/identity.ts) |
| **测试** | [`tests/conformance/core.test.ts`](../../tests/conformance/core.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface Identity {
  domain: string;
  id: string;
  instance: string;
}

function identityKey(identity: Identity): string;          // `${domain}/${id}/${instance}`
function assertValidIdentity(identity: Identity): void;    // 形状非法时抛 EAPP_IDENTITY_INVALID

class IdentityRegistry {
  create(seed: { domain: string; id: string; instance?: string }): Identity;
  has(identity: Identity): boolean;
  get(key: string): Identity | undefined;
  require(identity: Identity): Identity;
  list(): Identity[];
  isIssued(identity: Identity): boolean;
}
```

字段逐个说明：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `domain` | `string` | 是 | 命名域，例如 `"com.example"`。MUST NOT 为空（ID-1） |
| `id` | `string` | 是 | 逻辑身份，例如 `"logger"`。MUST NOT 为空（ID-2） |
| `instance` | `string` | 是 | 运行时实例，例如 `"logger-7f92"`。MUST 在同一个 `(domain, id)` 内唯一（ID-3） |

`IdentityRegistry` 的成员：

| 成员 | 行为 |
|---|---|
| `create(seed)` | 唯一的签发路径（ID-5）。种子的 `instance` 可选：省略时实现给出一个在该 `(domain, id)` 内未被占用的值；显式给出且已占用时抛 `EAPP_IDENTITY_DUPLICATE` |
| `has(identity)` | 该身份是否已签发 |
| `get(key)` | 按规范化键取值，未知返回 `undefined` |
| `require(identity)` | 同上，未知抛 `EAPP_IDENTITY_INVALID` |
| `list()` | 全部已签发的 Identity |
| `isIssued(identity)` | 该对象（引用相等）是否由**本** registry 签发 |

---

## 语义

Identity 回答「这是谁」，不回答「这是哪一版」（§3.2）：

```
Who            ──► Identity
Which revision ──► Capability.version
Which runtime  ──► Identity.instance
```

- Identity 是**值对象**：`domain` / `id` / `instance` 三个字段是它的全部内容。多出的字段不改变语义，而是被拒绝——「MUST NOT 包含版本语义」因此是可判定的（ID-6）。
- 规范化的键是 `domain/id/instance`（`identityKey`）。插件注册表、[`Binding`](./binding.md) 的端点、[`Discovery`](./discovery.md) 的结果都以它作为唯一的标识形式，因此三个字段都是非空字符串是必要的：否则 `undefined` 会被拼进键里。
- Identity **不是自发的**：Plugin MUST NOT 伪造 Identity，`IdentityRegistry` 是整条链上唯一的签发者（ID-5）。伪造的字面量对象存在，但 `has()` 为 `false`、`require()` 抛 `EAPP_IDENTITY_INVALID`、`isIssued()` 为 `false`。
- 签发的身份被 `Object.freeze` 冻结，`get` / `require` / `create` 返回的都指向同一个冻结值（ID-4）。
- 版本语义一律由 [`Capability`](./capability.md) 承载：同一个 Identity MAY 同时暴露 `logging@1.0.0` 与 `logging@2.0.0`，那是两条不同的能力引用，而不是两个身份。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `ID-1` | `domain` MUST NOT 为空（含全空白） | `core.test.ts` › `'ID-1 / ID-2: domain and id MUST NOT be empty'` |
| `ID-2` | `id` MUST NOT 为空（含全空白） | `core.test.ts` › `'ID-1 / ID-2: domain and id MUST NOT be empty'` |
| `ID-3` | `instance` MUST 在同一个 `(domain, id)` 内唯一 | `core.test.ts` › `'ID-3: instance is unique within (domain, id)'` |
| `ID-4` | Identity MUST 在其生命周期内保持不变（签发值被冻结） | `core.test.ts` › `'ID-4 / ID-5: identity is immutable and not self-issued'` |
| `ID-5` | Identity MUST NOT 由 Plugin 自身伪造（只有 registry 签发） | `core.test.ts` › `'ID-4 / ID-5: identity is immutable and not self-issued'` |
| `ID-6` | Identity MUST NOT 包含版本语义（多出字段即拒绝） | `core.test.ts` › `'ID-6: identity MUST NOT carry version semantics'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_IDENTITY_INVALID` | 不是对象；`domain` / `id` / `instance` 缺失、非字符串或全空白；携带三个字段之外的任何字段（ID-6）；`require()` 一个未知身份 | `false` |
| `EAPP_IDENTITY_DUPLICATE` | 显式请求的 `instance` 在 `(domain, id)` 内已被占用（ID-3） | `false` |

`retryable` 取 `EappError` 的默认值：只有 `EAPP_REVISION_CONFLICT` 在 `RETRYABLE_CODES` 中，本层的码都不在其中，`@eapp/core` 也没有任何调用点显式传入 `retryable`。

---

## 示例

```typescript
import { expect, test } from 'vitest';
import { IdentityRegistry, assertValidIdentity, identityKey, type Identity } from '@eapp/core';

test('Identity：签发、规范化键、不可伪造', () => {
  const registry = new IdentityRegistry();
  const logger = registry.create({ domain: 'com.example', id: 'logger' });

  expect(identityKey(logger)).toBe('com.example/logger/logger-1');
  expect(Object.isFrozen(registry.require(logger))).toBe(true); // ID-4
  expect(registry.isIssued(logger)).toBe(true); // ID-5

  const forged: Identity = { domain: 'com.example', id: 'forged', instance: 'forged-1' };
  expect(registry.has(forged)).toBe(false);
  expect(() => registry.require(forged)).toThrow('EAPP_IDENTITY_INVALID');

  expect(() =>
    registry.create({ domain: 'com.example', id: 'logger', instance: logger.instance }),
  ).toThrow('EAPP_IDENTITY_DUPLICATE'); // ID-3

  expect(() => assertValidIdentity({ ...logger, version: '1.0.0' } as unknown as Identity)).toThrow(
    'EAPP_IDENTITY_INVALID',
  ); // ID-6
});
```

---

## 相关

- [`Capability`](./capability.md) —— 版本与契约由它承载，Identity 明确不承载
- [`Plugin`](./plugin.md) —— `PluginRef` 就是 Identity；注册表以 `identityKey` 为键
- [`Binding`](./binding.md) —— `from` / `to` 都是 Identity，绑定身份以规范化键拼接
- [`CompositionCore`](./composition-core.md) —— 所有操作都以 `PluginRef`（即 Identity）寻址
- [v3.0.0-core §3](../spec/v3.0.0-core.md) —— 规范性正文

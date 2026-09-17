# `Lease`

> 这份工作**谁领了**、领到什么时候 —— 可靠竞争消费里的临时所有权。

| | |
|---|---|
| **层** | v3.1 Interaction Layer |
| **规范** | [v3.1.0-interaction §5](../spec/v3.1.0-interaction.md) |
| **实现** | [`packages/interaction/src/lease.ts`](../../packages/interaction/src/lease.ts) |
| **测试** | [`tests/conformance/interaction.test.ts`](../../tests/conformance/interaction.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
type LeaseStatus = 'ACTIVE' | 'ACKED' | 'NACKED' | 'EXPIRED';

interface Lease {
  readonly leaseId: string;
  readonly cursor: Cursor;
  readonly expiresAt: number;      // Unix ms
  ack(): Promise<void>;
  nack(): Promise<void>;
  renew(ttl: number): Promise<void>;
}

interface LeaseManagerOptions {
  now?: () => number;              // 注入时钟，使过期可确定性测试
}

class LeaseManager {
  constructor(options?: LeaseManagerOptions);
  claim(cursor: Cursor, ttl: number): Lease;
  releaseExpired(): void;
  release(cursor: Cursor): void;
  status(cursor: Cursor): LeaseStatus | undefined;
  active(): Lease[];
  get size(): number;
}
```

字段逐个说明：

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `leaseId` | `string` | 是 | 全局唯一（L-1）；每次 `claim()` 重新分配，重新领取拿到的是新 id |
| `cursor` | `Cursor` | 是 | 被领取的位置；租约按 cursor 索引，这就是 L-2 的落点 |
| `expiresAt` | `number` | 是 | 到期时刻（Unix ms）；`renew(ttl)` 把它重设为 `now() + ttl` |
| `ack()` | `Promise<void>` | 是 | 确认；`MUST` 幂等（L-3），且此后 `nack()` 抛错 |
| `nack()` | `Promise<void>` | 是 | 拒绝并归还；`MUST` 幂等（L-4），且此后 `ack()` 抛错 |
| `renew(ttl)` | `Promise<void>` | 是 | 只对 `ACTIVE` 租约有效（L-5） |

`LeaseManager` 侧：

| 成员 | 类型 | 含义 |
|---|---|---|
| `claim(cursor, ttl)` | `(Cursor, number) => Lease` | 先清理过期项，再领取；同一 cursor 已有 `ACTIVE` 租约时抛 `EAPP_LEASE_CONFLICT` |
| `releaseExpired()` | `() => void` | 把 `expiresAt <= now()` 的 `ACTIVE` 置为 `EXPIRED`（L-6 / L-7） |
| `release(cursor)` | `(Cursor) => void` | 显式放弃：`ACTIVE` → `NACKED` |
| `status(cursor)` | `(Cursor) => LeaseStatus \| undefined` | 查询状态；未登记过该 cursor 时返回 `undefined` |
| `active()` | `() => Lease[]` | 先清理过期项，再返回仍 `ACTIVE` 的租约快照 |
| `size` | `number` | 已登记条目总数（含已终结项，不是活跃租约数） |

---

## 语义

租约是"临时所有权"这一机制。§5 只规定机制本身 —— 谁领取了哪个位置、能持有到什么时候；
它**在哪一组消费者之间竞争**由 [ConsumerGroup](./consumer-group.md) 规定（§8.1）。

冲突判定按 cursor，而不是按租约对象。`claim()` 先 `releaseExpired()`，
再检查该 cursor 上是否已有 `ACTIVE` 条目；是则抛 `EAPP_LEASE_CONFLICT`。
`L-2` —— "同一 cursor 在任意时刻 `MUST NOT` 被多个 `ACTIVE` Lease 持有" ——
因此在结构上成立，不需要调用方自律。

终结状态是单调的：

```
ACTIVE ──ack()──► ACKED
   │                
   ├──nack()──► NACKED
   └──过期────► EXPIRED
```

`ACKED` / `NACKED` / `EXPIRED` 都不再回到 `ACTIVE`。`ack()` / `nack()` 在已到达
自身终态时是静默成功（L-3 / L-4），而在到达对侧终态时抛 `EAPP_LEASE_CLOSED` ——
这与 §9 的 AK-3 / AK-4 在 Lease 面上是同一条规则。

重新领取要等过期，或显式归还。到期的位置 `MAY` 被其他消费者重新领取（L-6），
而"重新领取"的判据只认 `expiresAt`：过期条目 `MUST NOT` 影响新租约的可领取性（L-7），
也不会改变其他仍 `ACTIVE` 的条目。`release(cursor)` 是主动路径：不需要等时钟，
直接把该 cursor 归还可领取状态。

时钟是注入的。`LeaseManagerOptions.now` 默认 `Date.now`，测试注入单调递增的假时钟，
使 L-5 / L-6 / L-7 不需要 sleep —— 这也是 `expiresAt` 用绝对毫秒数而非相对时长的原因。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `L-1` | `leaseId` MUST 全局唯一 | `interaction.test.ts` › `'L-1 / L-2: lease ids are unique and one cursor has at most one ACTIVE lease'` |
| `L-2` | 同一 cursor 在任意时刻 MUST NOT 被多个 ACTIVE Lease 持有 | `interaction.test.ts` › `'L-1 / L-2: lease ids are unique and one cursor has at most one ACTIVE lease'` |
| `L-3` | `ack()` MUST 幂等 | `interaction.test.ts` › `'L-3 / L-4: ack and nack are idempotent'` |
| `L-4` | `nack()` MUST 幂等 | `interaction.test.ts` › `'L-3 / L-4: ack and nack are idempotent'` |
| `L-5` | `renew()` 只对 ACTIVE Lease 有效 | `interaction.test.ts` › `'L-5: renew applies only to an ACTIVE lease'` |
| `L-6` | `expiresAt` 到期后，cursor MAY 被其他消费者重新领取 | `interaction.test.ts` › `'L-6 / L-7: expiry frees the cursor and never disturbs live leases'` |
| `L-7` | 过期的 Lease MUST NOT 影响新 Lease | `interaction.test.ts` › `'L-6 / L-7: expiry frees the cursor and never disturbs live leases'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_LEASE_CONFLICT` | `claim(cursor, ttl)` 时该 cursor 已有 `ACTIVE` 租约（L-2） | `false` |
| `EAPP_LEASE_CLOSED` | 在 `NACKED` / `EXPIRED` 租约上 `ack()`，或在 `ACKED` / `EXPIRED` 租约上 `nack()`（AK-3 / AK-4 的 Lease 面） | `false` |
| `EAPP_LEASE_EXPIRED` | `renew(ttl)` 时租约已不是 `ACTIVE`（L-5） | `false` |

`retryable` 取 `EappError` 的默认值（本层的码不在 `RETRYABLE_CODES` 中）。
注意 `ack()` / `nack()` 在**自身**终态下不抛错（L-3 / L-4），只有在**对侧**终态下才抛
`EAPP_LEASE_CLOSED`。

---

## 示例

```typescript
import { LeaseManager } from '@eapp/interaction';
import { expect } from 'vitest';

let now = 1_000;
const leases = new LeaseManager({ now: () => now });

const expiring = leases.claim('c1', 500);
expect(expiring.expiresAt).toBe(1_500);
const live = leases.claim('c2', 100_000);
expect(live.leaseId).not.toBe(expiring.leaseId);                   // L-1

// L-2：同一 cursor 的第二个 ACTIVE 租约是冲突，而不是"覆盖"
expect(() => leases.claim('c1', 500)).toThrow('EAPP_LEASE_CONFLICT');

// L-5：只有 ACTIVE 租约可以续期
await expiring.renew(5_000);
expect(expiring.expiresAt).toBe(6_000);

const nacked = leases.claim('c3', 500);
await nacked.nack();
await expect(nacked.nack()).resolves.toBeUndefined();              // L-4：幂等
await expect(nacked.renew(1_000)).rejects.toThrow('EAPP_LEASE_EXPIRED');

// L-3：ack() 幂等；此后 nack() 被拒绝（AK-3 在 Lease 面上的落点）
const acked = leases.claim('c4', 500);
await acked.ack();
await expect(acked.ack()).resolves.toBeUndefined();
await expect(acked.nack()).rejects.toThrow('EAPP_LEASE_CLOSED');

// L-6 / L-7：时钟越过 expiresAt 后，该 cursor 可以重新领取，且不影响活跃租约
now += 6_000;                                                      // 7_000 > 6_000
leases.releaseExpired();
expect(leases.status('c1')).toBe('EXPIRED');
expect(leases.status('c2')).toBe('ACTIVE');                        // L-7：活跃租约不受影响
const reclaimed = leases.claim('c1', 1_000);                       // L-6
expect(reclaimed.leaseId).not.toBe(expiring.leaseId);

// 显式归还同样释放位置，不必等时钟
const held = leases.claim('c5', 100_000);
leases.release('c5');
expect(leases.status('c5')).toBe('NACKED');
```

---

## 相关

- [`ConsumerGroup`](./consumer-group.md) —— 一次 claim 就是一次 Lease；L-2 是 CG-3 的机制保证
- [`Cursor`](./cursor.md) —— 租约按位置索引，因此游标的排序语义是租约冲突判定的前提
- [`AckContext`](./ack-context.md) —— 消费端的 `ack()` / `nack()` 与租约状态是同一套终结规则
- [`Delivery`](./delivery.md) —— 租约过期后的重新投递属于 `at-least-once` 语义
- [`Channel`](./channel.md) —— 位置所属的通道；`CLOSED` 的 Channel 不再产生新位置

# `Revision`

> 一次写入在 Channel 状态日志中的**位置**。它与 v3.1 的 `Cursor` 是同一域上的同一类型——这不是类比，是裁定。

| | |
|---|---|
| **层** | v3.2 State Mode |
| **规范** | [v3.2.0-state §2.2, §3](../spec/v3.2.0-state.md) |
| **实现** | [`packages/state/src/types.ts`](../../packages/state/src/types.ts) |
| **测试** | [`tests/conformance/state.test.ts`](../../tests/conformance/state.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
type Revision = string;                    // opaque token；在 (Transport, Channel) 内唯一且全序

type ExpectedRevision = Revision | null;   // null = key MUST NOT have ever existed

// 比较 MUST 由 Transport 提供（§3.2）。consumer MUST NOT 直接比较 Revision 字符串。
compareRevision(a: Revision, b: Revision): number;   // <0 = a < b；0 = 相等；>0 = a > b

// 分配与钉定（StateTransport，§3.3 / §5.5）
head(channel: string): Promise<Revision>;
nextRevision(channel: string): Promise<Revision>;
writeStateWithRevision(
  channel: string, key: string, value: unknown,
  deleted: boolean, revision: Revision, actor: Identity,
): Promise<void>;
```

| 成员 | 类型 | 含义 |
|---|---|---|
| `Revision` | `string` | 日志位置。不透明，调用方 MUST NOT 解析其内部形状（REV-5） |
| `ExpectedRevision` | `Revision \| null` | `null` 是"从未存在"的**唯一**表示，MUST NOT 用 `''` / `'0'` / `-1` 代替（§5.2） |
| `compareRevision` | `<0 / 0 / >0` | 由 Transport 提供；任一参数不是本 Transport 实例签发的值 MUST 抛 `EAPP_REVISION_INVALID`（REV-8） |
| `head` | `Promise<Revision>` | Channel 状态日志的当前末尾；空 Channel MUST 返回可比较的初始值（TS-14） |
| `nextRevision` | `Promise<Revision>` | 预留一个严格大于当前 `head` 的位置（TS-15） |
| `writeStateWithRevision` | `Promise<void>` | revision 钉定的内部写入原语；收到 `<= head` 的 revision MUST 抛 `EAPP_REVISION_INVALID` |

---

## 语义

### 1. Revision = 日志位置（核心裁定，§2.2 C-1）

```
Revision = Channel 内状态日志的位置
Cursor   = v3.1 §6.1「消费者已确认消费到的位置」
```

二者是**同一域上的同一类型**：都是 `string`，都在 Channel 内全局有序。因此：

```
① 每次写入 MUST 在 Channel 日志尾部追加一条 StateChange，并获得新位置
② 该位置即是本次写入的 Revision
③ 该位置即是可用的 Cursor
④ REV-1 / REV-2 / REV-4 与 v3.1 的 CR-1 是同一条规律
⑤ REV-7 不再是「例外」，而是 CR-1 的推论
⑥ REV-6 自动成立：request / event / stream 没有 Revision 这一概念，谈不上混用
```

图示：

```
写入 k=1 ──► 日志位置 p1 ──► Revision = p1 ──► 也可直接当 Cursor 用
写入 k=2 ──► 日志位置 p2 ──► Revision = p2 ──► 也可直接当 Cursor 用        (p1 < p2)
                                  │
             watcher 的 cursor 就是某个 pᵢ；从 p1 恢复 = 读 p1 之后的变更流
```

### 2. 为什么 REV-7 是推论而不是例外

v3.1 的 `Cursor` 语义（CR-1）是"消费位置"；v3.2 只是规定**写入所产生的位置**与**消费所记录的位置**
是同一空间里的同一个值。既然写入的位置天然就是消费者要记录的位置，"Revision MAY be used as Cursor
in State Mode"不需要任何额外机制、不需要转换函数、也不需要给 State Mode 开特例——它只是 CR-1 在
State Mode 的实例化。规范 §2.2 因此写成"REV-7 不再是『例外』，而是 CR-1 的推论"。

参考实现中这一点是**零代码**的：`StateWatcher` 的事件把 `change.revision` 直接交给 v3.1 的
`AckFactory`（`state-watcher.ts` 的 `toEvent`），`TransportSubscription` 用 `maxCursor` 推进
`#cursor`；没有任何 state 专属的"位置"概念被引入。

### 3. 为什么 MUST NOT 用 per-cell 计数器

r2 草案把 `Revision` 实现为**每个 cell 自己的计数器**。这条捷径同时打断三件事：

| 后果 | 说明 |
|---|---|
| 不是全序 | 不同 cell 的计数器之间无可比性，而观察者需要的是"日志中下一个未观察事件"这一**单一位置** |
| 不能充当 Cursor | 某个 cell 的计数器不指向日志中的任何位置，"从 p 恢复"因而没有定义 |
| 观察契约不可实现 | `SW-4`（每个 watcher 独立 cursor）与 `SW-9`（初始位置可解析为具体值）都要求一个**跨 cell 的位置域**；per-cell 计数无法提供它 |

这一缺陷在 r2 里表现为 `readStateAfter` 返回 `StateCell[]`（当前值数组）：**同一 key 的两次写入无法
表达**，中间变更永久丢失，cursor 语义因此落空。参考实现以 `readChangesAfter` 返回**变更流**
（`StateChange[]`）取代它，才让"独立 cursor + per-update ack + 删除事件可观察"三者同时成立。

### 4. 比较 MUST 由 Transport 提供

`compareRevision` 是 Transport 的能力，不是调用方的自由。理由：位置的**全序**是 Transport 的属性
（`ordering`、日志是否压缩、token 如何编码），调用方看到的只是不透明字符串。参考实现把 Transport
身份编进 token（形如 `mem-1!0000000000000001`）并固定宽度零填充，使字典序等于数值序；换一个
Transport，token 形状可以完全不同，而协议不受影响。

### 5. 跨 Transport 不可比（REV-8）

两个 Transport 各自签发自己的位置空间，把 A 的 revision 交给 B 比较**没有定义**。MUST 被拒绝，
MUST NOT "尽力排序"——静默错误排序会让 CAS 接受一个它根本不该接受的前提。参考实现的
`compareRevision` 先校验 token 是否由本实例签发，否则抛 `EAPP_REVISION_INVALID`。

唯一的例外是初始哨兵 `''`（`BEGINNING`）：它代表"最早已保留位置之前"，由本 Transport 自己定义，
因此允许参与比较。除此之外，任何外来 token 都被拒绝。

### 6. 分配与钉定

`nextRevision` **预留**一个严格大于当前 `head` 的位置（TS-15）；随后的 `writeStateWithRevision` MUST
使用它，收到 `<= head` 的 revision MUST 抛 `EAPP_REVISION_INVALID`。这条规则是 SNAP-4
（restore MUST NOT 回退 revision）的机制保证：恢复走的是"分配新位置再写入"，而不是"把日志倒回去"。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `REV-1` | Revision MUST be monotonic within a Channel | `state.test.ts` › `'SC-2 / REV-1 / REV-2 / REV-3: revision is monotonic and transport-assigned'` |
| `REV-2` | New revision MUST be greater than the current head | `state.test.ts` › `'SC-2 / REV-1 / REV-2 / REV-3: revision is monotonic and transport-assigned'` |
| `REV-3` | Revision MUST be assigned by the Transport | `state.test.ts` › `'SC-2 / REV-1 / REV-2 / REV-3: revision is monotonic and transport-assigned'` |
| `REV-4` | Revision MUST NOT roll back within a Channel | `state.test.ts` › `'REV-4: revision never rolls back within a transport'` |
| `REV-5` | Revision MUST be opaque to consumers | `state.test.ts` › `'REV-5: revision is opaque to consumers'` |
| `REV-6` | Revision MUST NOT be used as Cursor in v3.1 modes other than state | `state.test.ts` › `'REV-6: a v3.1-mode channel cannot be reinterpreted as state'` |
| `REV-7` | Revision MAY be used as Cursor in State Mode | `state.test.ts` › `'REV-7: revision MAY be used as a cursor in State Mode'` |
| `REV-8` | Revision MUST NOT be compared across Transports | `state.test.ts` › `'REV-8: revisions are not comparable across transports'` |

`REV-1` / `REV-2` / `REV-3` 由同一个场景承载（连续三次 `set`，逐次比较并检查 token 携带了 Transport 身份），
因为它们是同一条规律的三种表述（§2.2 第 4 点）。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_REVISION_INVALID` | `compareRevision` 的任一参数不是本 Transport 实例签发的 revision（REV-8） | `false` |
| `EAPP_REVISION_INVALID` | `writeStateWithRevision` 收到 `<= head` 的 revision（§3.3 / §5.5a） | `false` |
| `EAPP_REVISION_INVALID` | 写入未携带 `expectedRevision`（`undefined`），即 SU-8 的形状要求未满足 | `false` |
| `EAPP_REVISION_INVALID` | `expectedRevision` 是陌生 token，而 key **存在**，因此需要一次比较才能判定前提 | `false` |
| `EAPP_REVISION_CONFLICT` | 前提在语法上成立但事实不成立：key 不存在、revision 不匹配、或 `null` 却已存在（§5.2） | `true` |

第 4 行与第 5 行的关系值得精确对待：**错误的类型取决于 CAS 判定走到了哪一步**。key 不存在时，
实现无须比较即可判定失败，抛出 `EAPP_REVISION_CONFLICT`；key 存在时必须比较，陌生 token 因此在
这一层被拦成 `EAPP_REVISION_INVALID`。这与规范一致——§5.2 把"key 不存在"直接规定为
`EAPP_REVISION_CONFLICT`，而没有为它附加任何 token 合法性前提。

---

## 示例

```typescript
import { expect } from 'vitest';
import type { Identity } from '@eapp/core';
import { InteractionLayerImpl } from '@eapp/interaction';
import { configureStateChannel, type StateUpdateEvent } from '@eapp/state';
import { MemoryTransport } from '@eapp/transport-memory';

const owner: Identity = { domain: 'e2e', id: 'owner', instance: 'owner-1' };
const transport = new MemoryTransport();
const interaction = new InteractionLayerImpl({ transport });
const channel = await interaction.createChannel({
  binding: 'b1',
  mode: 'state',
  delivery: 'at-least-once',
});
await channel.connect();
const ch = configureStateChannel(channel, transport, { conflictPolicy: 'cas', owner });

const r1 = await ch.set({ key: 'k', value: 1, expectedRevision: null });

// REV-7：把 revision 直接当 cursor 用 —— 不需要任何转换
const seen: StateUpdateEvent[] = [];
const watcher = await ch.watch({ key: 'k' }, { cursor: r1 }); // 初始位置 eager 解析为 r1 本身
const task = (async () => {
  for await (const update of watcher) {
    seen.push(update);
    await update.ack();
  }
})().catch(() => undefined);

const r2 = await ch.set({ key: 'k', value: 2, expectedRevision: r1 });
while (seen.length < 1) await new Promise((resolve) => setTimeout(resolve, 10));

expect(seen[0]?.revision).toBe(r2);                                  // 事件携带的就是位置本身
expect(transport.compareRevision(r2, r1)).toBeGreaterThan(0);        // REV-2：严格晚于 r1
await watcher.close();
await task;

// TS-15：nextRevision 预留一个严格大于 head 的位置
const reserved = await transport.nextRevision(ch.id);
expect(transport.compareRevision(reserved, await transport.head(ch.id))).toBeGreaterThan(0);

// REV-8：另一个 Transport 签发的 revision 与本 Transport 不可比
const other = new MemoryTransport();
const foreign = await other.nextRevision('ch-x');
expect(() => transport.compareRevision(r1, foreign)).toThrow('EAPP_REVISION_INVALID');

// §3.3 / SNAP-4：钉定写入 MUST NOT 把日志往回推
await expect(
  transport.writeStateWithRevision(ch.id, 'k', 0, false, r1, owner),
).rejects.toThrow('EAPP_REVISION_INVALID');
```

---

## 相关

- [`StateCell`](./state-cell.md) —— cell 的 `revision` 字段就是本页所说的位置
- [`StateUpdate`](./state-update.md) —— `expectedRevision` 的 CAS 前提与错误优先级
- [`StateWatcher`](./state-watcher.md) —— 为什么 watcher 契约要求位置域跨 cell
- [`StateSnapshot`](./state-snapshot.md) —— `maxRevision` 与"恢复不倒退"的机制
- [`StateTransport`](./state-transport.md) —— `compareRevision` / `nextRevision` / `head` 的能力闸门
- [决议记录 §2.2（C-1）](../spec/v3.2.0-state.md)

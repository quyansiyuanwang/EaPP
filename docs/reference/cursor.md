# `Cursor`

> 恢复到**哪里** —— 消费者**已确认到**的位置，而不是"收到过的最远位置"。

| | |
|---|---|
| **层** | v3.1 Interaction Layer |
| **规范** | [v3.1.0-interaction §6](../spec/v3.1.0-interaction.md) |
| **实现** | [`packages/interaction/src/cursor.ts`](../../packages/interaction/src/cursor.ts) |
| **测试** | [`tests/conformance/interaction.test.ts`](../../tests/conformance/interaction.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
type Cursor = string;                  // 不透明字符串，在 Channel 内全局有序（CR-1）

interface CursorState {
  cursor: Cursor;                      // 已确认到的位置
  pending: Cursor[];                   // 已收到、未 ack
}

type CursorAnchor = 'earliest' | 'latest' | Cursor;

const EARLIEST: 'earliest';
const LATEST: 'latest';

function isAnchorLiteral(value: string): value is 'earliest' | 'latest';
function compareCursor(a: Cursor, b: Cursor): number;
function maxCursor(a: Cursor, b: Cursor): Cursor;
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `Cursor` | `string` | 是 | 位置值；不透明，消费者 `MUST NOT` 解析它 |
| `cursor`（`CursorState`） | `Cursor` | 是 | 已 ack 的位置；§6.1 的中间状态视图 |
| `pending`（`CursorState`） | `Cursor[]` | 是 | 已收到、未 ack 的位置 |
| `CursorAnchor` | 联合 | 是 | 位置参数：可以写锚点字面量，也可以写具体游标 |
| `isAnchorLiteral(value)` | `(string) => boolean` | — | §6.2 规则 1：字面量必须先于具体游标被识别 |
| `compareCursor(a, b)` | `(Cursor, Cursor) => number` | — | 字典序比较；相等返回 `0` |
| `maxCursor(a, b)` | `(Cursor, Cursor) => Cursor` | — | §6.4 的 `max(当前 cursor, c)` |

`CursorState` 是规范 §6.1 定义的状态视图，本实现导出但未在内部路径上使用。

---

## 语义

**游标是"已确认到"的位置，不是"已收到"的位置。** 这两者必须分开：

```
收到一条消息        → 游标不动（CR-3：MUST NOT 隐式前移）
显式 ack 该位置     → 游标 := max(当前游标, 该位置)（§6.4）
显式 ack 更后的位置 → 游标 := 那个更后的位置，中间未 ack 的项被显式放弃（§6.4 / E1-4）
nack 该位置         → 游标不动；该位置回到可用，下一次迭代重新投递（§6.4）
```

E1-4 的裁定把两件事区分得很清楚：CR-3 禁止的是**隐式**跳过 —— 也就是"收到了就自动前移"，
或者"ack 时只推进到第一个未 ack 项之前"。**显式** ack 一个更靠后的位置、因而放弃中间项，
是 §6.4 明确允许的行为：

```
ack(c)   MUST 将 cursor 置为 max(当前 cursor, c)
nack()   MUST NOT 推进 cursor
```

**恢复就是这条规则的另一面。** 游标是普通值，`MUST` 可持久化、可恢复（CR-2）；
恢复 `MUST` 从该游标继续（CR-4）—— 即严格大于该位置的下一条。
一个掉队成员不会拖住位置：组游标同样取"已 ack 位置的最大值"（见 [ConsumerGroup](./consumer-group.md) §8.3）。

```
   c1        c2        c3        c4
   ack ──────┐
             │  cursor = c1
             │
             └── ack(c3) ──► cursor = c3      ← 显式放弃 c2，允许
                 （收到 c2/c3 本身从不推进游标）  ← 隐式前移，禁止
```

**不透明性与排序。** 消费者 `MUST NOT` 解析游标；`Channel` 内全局有序由 CR-1 保证
（每个 Channel 有自己的位置序列，跨 Channel 不可比较）。实现的 `compareCursor()`
用字典序，这要求承载它的 [Transport](./transport.md) 分配**定宽、零填充**的游标 ——
定宽数字串的字典序与数值序一致。`MemoryTransport` 用 `${transportId}!` 前缀加 16 位补齐，
因此 CR-1 成立。

**锚点**（§6.2，六条 MUST）：

| 规则 | 内容 |
|---|---|
| 1 | `'earliest'` / `'latest'` `MUST` 先被识别为锚点，`MUST NOT` 当作具体游标 |
| 2 | 其余字符串 `MUST` 当作具体游标 |
| 3 | `'earliest'` `MUST` 解析为"Channel 中仍可服务的最早位置" |
| 4 | `'latest'` `MUST` 解析为 Channel 当前头位置 |
| 5 | 锚点 `MUST` 在订阅创建时**立即**解析（eager），`MUST NOT` 延迟到首次迭代 |
| 6 | 若日志已压缩到无法定位 `'earliest'`，`MUST` 返回 `EAPP_CURSOR_TOO_OLD` |

规则 1 的存在是因为 `'earliest'` 本身就是一个合法的 `Cursor` 字符串值，没有这条顺序规则
两种情形无法区分；规则 5 的落点是 SUB-9 —— `subscription.cursor` 在创建返回前已是具体值。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `CR-1` | Cursor MUST be globally ordered within Channel | `interaction.test.ts` › `'CR-1: cursors are globally ordered within a channel'` |
| `CR-2` | Cursor MUST be persistable and recoverable | `interaction.test.ts` › `'CR-2 / CR-4 / SUB-9: a cursor is persistable and resumable'` |
| `CR-3` | Cursor MUST NOT skip unacked messages implicitly | `interaction.test.ts` › `'CR-3: receiving never advances the cursor implicitly'` |
| `CR-4` | Resume MUST continue from cursor | `interaction.test.ts` › `'CR-2 / CR-4 / SUB-9: a cursor is persistable and resumable'` |
| `CR-5` | If Transport does not support cursor, MUST return `EAPP_CURSOR_UNSUPPORTED` | `interaction.test.ts` › `'CR-5: a transport without cursor support reports it explicitly'` |

锚点解析规则 1–6 目前**没有**对应的不变量编号，因此不作为不变量行登记；
一致性测试里覆盖它们的是 `interaction.test.ts` ›
`'§6.2: anchor literals are recognised before concrete cursors'`
与 `'CR-2 / CR-4 / SUB-9: a cursor is persistable and resumable'`。

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_CURSOR_UNSUPPORTED` | Transport 声明 `supportsCursor: false` 而 Channel 仍要使用游标（CR-5 / TR-9） | `false` |
| `EAPP_CURSOR_TOO_OLD` | §6.2 规则 6：日志压缩后 `'earliest'` 无法定位。`SubscriptionSource.earliest()` 的契约如此声明，但 `MemoryTransport` 保留无界、永远不抛该码 —— **未覆盖** | `false` |
| `EAPP_CURSOR_INVALID` | §13 声明了该码，实现中没有任何抛出点 —— **未覆盖** | `false` |

---

## 示例

```typescript
import { TransportSubscription, compareCursor } from '@eapp/interaction';
import type { Cursor, SubscriptionSource } from '@eapp/interaction';
import { MemoryTransport } from '@eapp/transport-memory';
import { expect } from 'vitest';

interface Delivered {
  cursor: Cursor;
  payload: unknown;
  ack(): Promise<void>;
  nack(): Promise<void>;
}

const transport = new MemoryTransport();
const first = await transport.send('room', { type: 'job', id: 1 });
const second = await transport.send('room', { type: 'job', id: 2 });
expect(compareCursor(second, first)).toBeGreaterThan(0);   // CR-1

const source: SubscriptionSource<Delivered> = {
  head: () => transport.resolveAnchor('room', 'latest'),
  earliest: () => transport.resolveAnchor('room', 'earliest'),
  readAfter: async (cursor, ack) => {
    const messages = await transport.readAfter('room', cursor, { all: true });
    return messages.map((message) => {
      const context = ack(message.cursor);
      return {
        cursor: message.cursor,
        item: {
          cursor: message.cursor,
          payload: message.payload,
          ack: () => context.ack(),
          nack: () => context.nack(),
        },
      };
    });
  },
  waitForChange: (cursor, signal) => transport.waitForChange('room', cursor, signal),
};

const subscription = await TransportSubscription.create<Delivered>(
  'room',
  { cursor: 'earliest' },        // §6.2 规则 5：锚点在 create() 内立即解析
  source,
);
const iterator = subscription[Symbol.asyncIterator]();

const a = (await iterator.next()).value!;
const b = (await iterator.next()).value!;
expect(a.cursor).toBe(first);

// CR-3：收到（yield）不等于已确认 —— 游标一动不动
expect(subscription.cursor).not.toBe(second);

// §6.4 / E1-4：显式 ack 一个更靠后的位置，中间未 ack 的 first 被显式放弃
await b.ack();
expect(subscription.cursor).toBe(second);

// CR-2：游标是普通值，可以被持久化并在别处恢复
const stored = subscription.exportCursor();
await subscription.close();
const resumed = await TransportSubscription.create<Delivered>('room', { cursor: stored }, source);
expect(resumed.cursor).toBe(stored);
await resumed.close();
```

---

## 相关

- [`Subscription`](./subscription.md) —— 持有游标、并在创建返回前解析锚点（SUB-9）
- [`ConsumerGroup`](./consumer-group.md) —— 组游标 = 组内已 ack 位置的最大值
- [`AckContext`](./ack-context.md) —— 唯一能推进游标的动作
- [`Delivery`](./delivery.md) —— 未 ack 的位置为什么会被重新投递
- [模式消息](./messages.md) —— ST-2 / ST-3 / ST-4：stream 模式下的恢复语义
- [`Transport`](./transport.md) —— 游标由它分配，CR-5 的能力检查也在那里

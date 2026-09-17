# 模式消息

> request / event / stream 各自的**信封** —— 三种消息传递模式的冻结形状。

| | |
|---|---|
| **层** | v3.1 Interaction Layer |
| **规范** | [v3.1.0-interaction §3](../spec/v3.1.0-interaction.md) |
| **实现** | [`packages/interaction/src/messages.ts`](../../packages/interaction/src/messages.ts) |
| **测试** | [`tests/conformance/interaction.test.ts`](../../tests/conformance/interaction.test.ts) |
| **稳定度** | FROZEN |

---

## 签名

```typescript
interface RequestMessage {
  correlationId: string;
  operation: string;
  payload: unknown;
  deadline?: number;             // Unix ms
}

interface ResponseMessage {
  correlationId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown; retryable?: boolean };
}

interface EventMessage {
  topic: string;
  payload: unknown;
  headers?: Record<string, unknown>;
}

interface StreamMessage {
  cursor: Cursor;                // 全局单调递增（§3.1）
  payload: unknown;
}

function newCorrelationId(prefix?: string): string;
function isRequestMessage(value: unknown): value is RequestMessage;
function isResponseMessage(value: unknown): value is ResponseMessage;
function assertRequestMessage(value: unknown): asserts value is RequestMessage;
function assertResponseMessage(value: unknown): asserts value is ResponseMessage;
function isRequestExpired(request: RequestMessage, now?: number): boolean;

class CorrelationTracker {
  begin(correlationId: string): void;
  settle(response: ResponseMessage): boolean;
  abandon(correlationId: string): void;
  has(correlationId: string): boolean;
  get size(): number;
}
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `correlationId` | `string` | 是 | 请求标识；每个 request 唯一（RQ-1），response 必须引用同一个（RQ-3） |
| `operation` | `string` | 是 | 被调用的操作名 |
| `payload` | `unknown` | 是 | 载荷；`request` / `event` / `stream` 都用这个字段名 |
| `deadline` | `number` | 否 | Unix ms；到期后该 request `MUST` 被视为超时（RQ-4）；缺省表示永不过期 |
| `ok` | `boolean` | 是 | response 的成功标志 |
| `result` / `error` | `unknown` / 结构体 | 否 | 二者按 `ok` 取其一；`error.retryable` 与 `EappError.retryable` 同义 |
| `topic` | `string` | 是 | event 的主题；event 信封里**没有** `correlationId` —— 没有可回复的对象（EV-1） |
| `headers` | `Record<string, unknown>` | 否 | event 的附加头 |
| `cursor` | `Cursor` | 是 | stream 消息的位置，全局单调递增（ST-1） |

`newCorrelationId(prefix)` 的默认前缀为 `'req'`，返回值形如 `req-<seq36>-<time36>`。
`CorrelationTracker` 是 RQ-2 / RQ-3 的落地：`begin()` 登记在途请求，
`settle()` 只在 id 仍在途时返回 `true`，`abandon()` 用于丢弃永远不会被答复的请求。

---

## 语义

四种模式已冻结：`request` / `event` / `stream` / `state`；一个
[Channel](./channel.md) `MUST` 恰好有一种模式。其中 `state` 的运行时语义由 v3.2.0 定义，
本层只声明它存在并冻结其信封（见 [`Channel`](./channel.md) 的 E1-2 说明）。

§3.1 的字段 `MUST NOT` 被改名或改义。实现 `MAY` 在信封上附加自己的字段
（例如方向判别符、调用方身份），但不改既有语义。

**request —— 一问一答：**

```
sender ──RequestMessage{correlationId: R}──► receiver
sender ◄─ResponseMessage{correlationId: R}── receiver        （0 或 1 次）
```

- RQ-1：每个 request `MUST` 有唯一 `correlationId`。
- RQ-2：一个 request `MUST` 对应 0 或 1 个 response —— response 的第二份副本、
  或对已超时请求的迟到回复，`MUST` 被丢弃，`MUST NOT` 二次解决同一个调用。
- RQ-3：response `MUST` 携带与 request 相同的 `correlationId`。
- RQ-4：`deadline` 到期后，request `MUST` 被视为超时；
  接收方 `MUST NOT` 开始执行该请求。缺省 `deadline` 表示永不过期。

**event —— 即发即忘：** `MUST NOT` 期待响应（EV-1），投递 `MAY` 为零次（EV-2）或多次（EV-3）。
"零次"的常见来源是订阅锚点：以 `'latest'` 加入的消费者看不到它之前的 event。

**stream —— 有序序列：** 消息的 `cursor` `MUST` 全局单调递增（ST-1）；
消费者 `MUST` 通过 `cursor` 恢复（ST-2）；已 ack 的位置之前 `MUST NOT` 被重新投递（ST-3）；
未 ack 的消息 `MAY` 在重连后重新投递（ST-4）。游标推进的完整规则见 [`Cursor`](./cursor.md)。

---

## 不变量

| ID | 规则 | 测试 |
|---|---|---|
| `RQ-1` | 每个 request MUST 有唯一 correlationId | `interaction.test.ts` › `'RQ-1: every request carries a unique correlationId'` |
| `RQ-2` | 一个 request MUST 对应 0 或 1 个 response | `interaction.test.ts` › `'RQ-2 / RQ-3: a request maps to at most one response, quoting its own id'` |
| `RQ-3` | response MUST 携带与 request 相同的 correlationId | `interaction.test.ts` › `'RQ-2 / RQ-3: a request maps to at most one response, quoting its own id'` |
| `RQ-4` | deadline 到期后，request MUST 被视为超时 | `interaction.test.ts` › `'RQ-4: a request past its deadline is treated as timed out'` |
| `EV-1` | event MUST NOT 期待响应 | `interaction.test.ts` › `'EV-1: an event expects no response'` |
| `EV-2` | event 的投递 MAY 为零次 | `interaction.test.ts` › `'EV-2: an event MAY be delivered zero times'` |
| `EV-3` | event 的投递 MAY 为多次 | `interaction.test.ts` › `'EV-3: an event MAY be delivered multiple times'` |
| `ST-1` | 消息的 cursor MUST 全局单调递增 | `interaction.test.ts` › `'ST-1: message cursors increase globally within a channel'` |
| `ST-2` | 消费者 MUST 通过 cursor 恢复 | `interaction.test.ts` › `'ST-2 / ST-3 / ST-4: resume by cursor, acked never returns, unacked may'` |
| `ST-3` | 已 ack 的 cursor 之前的消息 MUST NOT 被重新投递 | `interaction.test.ts` › `'ST-2 / ST-3 / ST-4: resume by cursor, acked never returns, unacked may'` |
| `ST-4` | 未 ack 的消息 MAY 在重连后重新投递 | `interaction.test.ts` › `'ST-2 / ST-3 / ST-4: resume by cursor, acked never returns, unacked may'` |

---

## 错误

| 码 | 触发条件 | retryable |
|---|---|---|
| `EAPP_TIMEOUT` | `assertRequestMessage()` 收到不是 request 形状的值，或 `correlationId` / `operation` 为空。§13 没有为"格式非法"指定码，实现复用了 `EAPP_TIMEOUT`；语义上更贴近 `EAPP_INTERNAL`，属实现选择 | `false` |
| `EAPP_INTERNAL` | `assertResponseMessage()` 收到不是 response 形状的值；`CorrelationTracker.begin()` 登记一个仍在途的 `correlationId`（RQ-1 的编程错误路径） | `false` |

`retryable` 取 `EappError` 的默认值（本层的码不在 `RETRYABLE_CODES` 中）。

---

## 示例

```typescript
import {
  CorrelationTracker,
  assertRequestMessage,
  isRequestExpired,
  newCorrelationId,
} from '@eapp/interaction';
import { expect } from 'vitest';

// RQ-1：唯一 id，且不需要 UUID 源
const correlationId = newCorrelationId('req');
const request = {
  correlationId,
  operation: 'jobs.run',
  payload: { id: 1 },
  deadline: Date.now() + 1_000,
};
assertRequestMessage(request);
expect(newCorrelationId('req')).not.toBe(correlationId);

// RQ-2 / RQ-3：一个请求最多一个响应，且响应必须引用它自己的 id
const tracker = new CorrelationTracker();
tracker.begin(request.correlationId);
expect(tracker.settle({ correlationId: 'someone-else', ok: true })).toBe(false);   // RQ-3
expect(tracker.has(request.correlationId)).toBe(true);
expect(tracker.settle({ correlationId: request.correlationId, ok: true, result: 1 })).toBe(true);
expect(tracker.settle({ correlationId: request.correlationId, ok: true, result: 2 })).toBe(false); // RQ-2
expect(tracker.size).toBe(0);

// RQ-4：到期即超时；缺省 deadline 永不过期
expect(isRequestExpired({ ...request, deadline: Date.now() - 1 }, Date.now())).toBe(true);
expect(isRequestExpired({ correlationId: 'c', operation: 'op', payload: null }, 1e12)).toBe(false);

// 超时的请求应当被丢弃，而不是留在在途集合里
tracker.begin('stale');
tracker.abandon('stale');
expect(tracker.has('stale')).toBe(false);
expect(() => tracker.begin('c1')).not.toThrow();
```

event 与 stream 的形状（信封本身没有行为，行为由 Channel 的 mode 决定）：

```typescript
import { compareCursor } from '@eapp/interaction';
import type { EventMessage, StreamMessage } from '@eapp/interaction';

const event: EventMessage = { topic: 'log', payload: { line: 'x' } };
// EV-1：信封里没有 correlationId —— 没有可回复的对象
expect('correlationId' in event).toBe(false);

const first: StreamMessage = { cursor: 'mem-1!0000000000000001', payload: { n: 1 } };
const second: StreamMessage = { cursor: 'mem-1!0000000000000002', payload: { n: 2 } };
expect(compareCursor(second.cursor, first.cursor)).toBeGreaterThan(0);   // ST-1
```

---

## 相关

- [`Channel`](./channel.md) —— 一个 Channel 恰好一种模式，模式决定使用哪个信封
- [`Delivery`](./delivery.md) —— event 的"零次或多次"与 stream 的 `at-least-once`
- [`Cursor`](./cursor.md) —— stream 的 `cursor` 字段与 ST-2 / ST-3 / ST-4 的推进规则
- [`Subscription`](./subscription.md) —— 消费端如何按模式消费这些信封
- [`AckContext`](./ack-context.md) —— request / event 之外的消费单元如何确认

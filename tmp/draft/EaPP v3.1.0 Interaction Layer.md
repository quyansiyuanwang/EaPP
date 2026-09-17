# EaPP v3.1.0 Interaction Layer

**Everything as a Plugin — Interaction Semantics**

版本：3.1.0  
状态：Draft  
前置：v3.0.0-core FROZEN  
规范用语：MUST / MUST NOT / SHOULD / SHOULD NOT / MAY（RFC 2119）

> **Composition 决定关系。**
> **Interaction 决定关系建立之后如何互动。**
> **Transport 决定互动如何实现。**

---

## 目录

1. 范围与定位
2. Channel
3. 交互模式
4. 投递语义
5. Lease
6. Cursor
7. Ack / Nack
8. 与 Composition Core 的关系
9. 与 Transport 的关系
10. 不变量
11. 错误模型
12. 参考实现
13. 一致性测试

---

## 1. 范围与定位

### 1.1 本文冻结什么

EaPP Interaction Layer 定义**关系建立之后的运行时交互语义**：

- Channel 是什么
- Channel 的生命周期
- 四种交互模式：request / event / stream / state
- 投递保证
- 可靠消费（lease + ack）
- 可恢复观察（cursor + ack）

### 1.2 本文不冻结什么

- Composition Core（Identity / Capability / Plugin / Binding / Lifecycle / Discovery）
- Transport 实现（Memory / Socket / Redis / NATS）
- 序列化格式
- 加密 / 认证
- Federation
- Schema 验证
- 具体交互操作的语义（业务层）

### 1.3 三层关系

```
┌────────────────────────────────────────┐
│         EaPP Composition Core          │
│   Identity · Capability · Plugin       │
│   Binding  · Lifecycle  · Discovery    │
│                                        │
│   FROZEN at v3.0.0-core                │
└───────────────────┬────────────────────┘
                    │  Binding 建立后派生 ChannelRef
                    ▼
┌────────────────────────────────────────┐
│         EaPP Interaction Layer         │
│                                        │
│   Channel · Mode · Delivery            │
│   Lease   · Cursor · Ack/Nack          │
│                                        │
│   THIS DOCUMENT                        │
└───────────────────┬────────────────────┘
                    │  Channel 由以下实现
                    ▼
┌────────────────────────────────────────┐
│              Transport                 │
│   Memory · Socket · Redis · NATS       │
│   Tuple Space · Message Bus · RPC      │
└────────────────────────────────────────┘
```

**方向单向。下层 MUST NOT 反向定义上层语义。**

---

## 2. Channel

### 2.1 定义

Channel 是 Interaction Layer 的核心实体。它是 Binding 在运行时的具体化。

```typescript
interface Channel {
  id: string;
  binding: string;              // Binding.id（来自 Composition Core）
  mode: ChannelMode;
  delivery: DeliveryGuarantee;
  state: ChannelState;
}

type ChannelMode = 'request' | 'event' | 'stream' | 'state';

type DeliveryGuarantee = 'at-most-once' | 'at-least-once';

type ChannelState =
  | 'OPEN'
  | 'ACTIVE'
  | 'DRAINING'
  | 'CLOSED';
```

### 2.2 ChannelRef（Composition Core 可见部分）

Composition Core 只承认：

```typescript
interface ChannelRef {
  id: string;
  binding: string;
}
```

其余字段属于 Interaction Layer，**MUST NOT** 回渗到 Composition Core。

### 2.3 Channel 与 Binding 的关系

- 一个 Binding MAY 派生 0 个或多个 Channel。
- 一个 Channel MUST 恰好对应一个 Binding。
- Channel 的生命周期 MUST NOT 超过其 Binding。
- Binding 进入 `DORMANT` 时，其所有 Channel MUST 进入 `DRAINING`。
- Binding 进入 `CLOSED` 时，其所有 Channel MUST 进入 `CLOSED`。

### 2.4 Channel 生命周期

```
        create()
           │
           ▼
         OPEN ──────────────► CLOSED
           │                     ▲
        connect()                │
           │                     │
           ▼                     │
        ACTIVE ──────────────────┤
           │                     │
       drain()                   │
           │                     │
           ▼                     │
       DRAINING ─────────────────┘
```

状态语义：

| 状态 | 含义 |
|---|---|
| `OPEN` | 已创建，未连接 |
| `ACTIVE` | 已连接，可交互 |
| `DRAINING` | 停止接收新消息，等待在途完成 |
| `CLOSED` | 终结状态 |

### 2.5 Channel 状态转移

```
OPEN     --connect-->  ACTIVE
OPEN     --close-->    CLOSED
ACTIVE   --drain-->    DRAINING
ACTIVE   --close-->    CLOSED
DRAINING --close-->    CLOSED
CLOSED   --any-->      CLOSED（幂等）
```

### 2.6 Channel 不变量

- **CH-1**：一个 Channel MUST 对应恰好一个 Binding。
- **CH-2**：Channel 生命周期 MUST NOT 超过 Binding。
- **CH-3**：`CLOSED` 是终结状态。
- **CH-4**：`close()` MUST 幂等。
- **CH-5**：`mode` MUST NOT 在生命周期内改变。
- **CH-6**：`delivery` MUST NOT 在生命周期内改变。

---

## 3. 交互模式

Interaction Layer 冻结四种模式：

```
request   — 请求-响应
event     — 发布-订阅
stream    — 有序流
state     — 状态同步
```

### 3.1 Request 模式

**语义**：一个发送方，一个接收方，一个响应。

```typescript
interface RequestMessage {
  correlationId: string;
  operation: string;
  payload: unknown;
  deadline?: number;            // 毫秒
}

interface ResponseMessage {
  correlationId: string;
  ok: boolean;
  result?: unknown;
  error?: EappError;
}
```

**不变量**：

- **RQ-1**：每个 request MUST 有唯一 `correlationId`。
- **RQ-2**：一个 request MUST 对应 0 或 1 个 response。
- **RQ-3**：response MUST 携带与 request 相同的 `correlationId`。
- **RQ-4**：`deadline` 到期后，request MUST 被视为超时。

### 3.2 Event 模式

**语义**：一个发送方，零个或多个接收方，即发即忘。

```typescript
interface EventMessage {
  topic: string;
  payload: unknown;
  headers?: Record<string, unknown>;
}
```

**不变量**：

- **EV-1**：event MUST NOT 期待响应。
- **EV-2**：event 的投递 MAY 为零次。
- **EV-3**：event 的投递 MAY 为多次（at-least-once）。

### 3.3 Stream 模式

**语义**：一个发送方，一个或多个接收方，有序序列。

```typescript
interface StreamMessage {
  cursor: string;               // 全局单调递增
  payload: unknown;
}

interface StreamSubscription extends AsyncIterable<StreamMessage> {
  cursor(): string;
  close(): Promise<void>;
}
```

**不变量**：

- **ST-1**：`cursor` MUST 全局单调递增。
- **ST-2**：消费者 MUST 通过 `cursor` 恢复。
- **ST-3**：已 ack 的 `cursor` 之前的消息 MUST NOT 被重新投递。
- **ST-4**：未 ack 的消息 MAY 在重连后重新投递（at-least-once）。

### 3.4 State 模式

**语义**：一个或多个参与者，共享状态的读写。

```typescript
interface StateMessage {
  key: string;
  value: unknown;
  revision: number;             // 单调递增
  deleted?: boolean;
}
```

**不变量**：

- **SM-1**：`revision` MUST 单调递增。
- **SM-2**：同一 `key` 的并发更新 MUST 通过 revision 冲突检测。
- **SM-3**：`deleted: true` 表示逻辑删除，MUST 保留 revision。

### 3.5 模式与 Channel 的关系

一个 Channel MUST 恰好有一种模式。一个 Binding MAY 派生多个 Channel，各自使用不同模式。

例如：

```
Binding A→B
  ├── Channel-1 (request)
  ├── Channel-2 (event)
  └── Channel-3 (state)
```

**MUST NOT** 在一个 Channel 内混用模式。

---

## 4. 投递语义

### 4.1 两种保证

Interaction Layer **只冻结两种**：

```
at-most-once    最多一次（可能丢失，不会重复）
at-least-once   至少一次（不会丢失，可能重复）
```

**`exactly-once` 不属于 EaPP Interaction Layer。** 它 MAY 由 Extension 提供，但 MUST NOT 作为 Core 语义。

理由：业务副作用的一次性无法仅由消息层保证。重复投递是不可避免的；幂等性由应用负责。

### 4.2 at-most-once

- 消息 MAY 丢失。
- 消息 MUST NOT 重复。
- 消费者 MUST NOT ack。
- 适用：event、监控、非关键通知。

### 4.3 at-least-once

- 消息 MUST NOT 丢失（在 Transport 可达范围内）。
- 消息 MAY 重复。
- 消费者 MUST ack。
- 适用：request、stream、task queue。

### 4.4 投递保证与模式的关系

| 模式 | 允许的 delivery |
|---|---|
| request | at-most-once, at-least-once |
| event | at-most-once, at-least-once |
| stream | at-least-once |
| state | at-least-once |

**Stream MUST 使用 at-least-once**（因为 cursor 恢复语义要求）。

### 4.5 不变量

- **DL-1**：`delivery` MUST 是 `at-most-once` 或 `at-least-once`。
- **DL-2**：`exactly-once` MUST NOT 出现在 Core。
- **DL-3**：at-most-once MUST NOT ack。
- **DL-4**：at-least-once MUST ack。
- **DL-5**：at-least-once 消费者 MUST 幂等处理。

---

## 5. Lease

### 5.1 语义

Lease 是**可靠竞争消费**的机制。它回答：

> 谁领取了这份工作？在什么时间范围内？

Lease 用于 Channel 模式为 `stream` 且需要竞争消费时。

### 5.2 定义

```typescript
interface Lease {
  leaseId: string;
  cursor: string;               // 领取的消息 cursor
  expiresAt: number;            // Unix ms
  ack(): Promise<void>;
  nack(): Promise<void>;
  renew(ttl: number): Promise<void>;
}
```

### 5.3 生命周期

```
        claim()
           │
           ▼
        ACTIVE ──────────────► ACKED
           │  \                  │
           │   \── nack() ──► RELEASED
           │                     
           │      timeout
           ▼
        EXPIRED
```

### 5.4 不变量

- **L-1**：`leaseId` MUST 全局唯一。
- **L-2**：同一 cursor 在任意时刻 MUST NOT 被多个 ACTIVE Lease 持有。
- **L-3**：`ack()` MUST 幂等。
- **L-4**：`nack()` MUST 幂等。
- **L-5**：`renew()` 只对 ACTIVE Lease 有效。
- **L-6**：`expiresAt` 到期后，cursor MAY 被其他消费者重新领取。
- **L-7**：过期的 Lease MUST NOT 影响新 Lease。

### 5.5 Lease 与 Ack 的关系

```
Lease.ack()    → 消息被确认消费，cursor 前移
Lease.nack()   → 消息回到可用，cursor 不前移
Lease.expire() → 消息回到可用，cursor 不前移
```

---

## 6. Cursor

### 6.1 语义

Cursor 表示**消费者已确认消费到的位置**。

```
received ≠ acknowledged
```

Cursor **MUST NOT** 随收到消息自动前移。它只随 `ack` 前移。

### 6.2 定义

```typescript
type Cursor = string;           // 不透明字符串，全局有序

interface CursorState {
  cursor: Cursor;
  pending: Cursor[];            // 已收到未 ack
}
```

### 6.3 不变量

- **CR-1**：Cursor MUST 在 Channel 内全局有序。
- **CR-2**：Cursor MUST 可持久化、可恢复。
- **CR-3**：Cursor MUST NOT 跳过未 ack 的消息。
- **CR-4**：从 cursor 恢复时，MUST 从该位置之后继续。
- **CR-5**：如果 Transport 不支持 cursor，MUST 返回 `EAPP_CURSOR_UNSUPPORTED`。

### 6.4 Cursor 与消息投递

```
消息序列:  E1  E2  E3  E4  E5
             │
          ack(E1)
             │
          cursor = E1

收到 E2, E3
             │
          未 ack
             │
          cursor = E1

ack(E3)
             │
          cursor = E3（跳过 E2 意味着 E2 被放弃）
```

**关键语义**：ack 一个更新的 cursor 意味着放弃中间未 ack 的消息。

---

## 7. Ack / Nack

### 7.1 定义

```typescript
interface AckContext {
  ack(): Promise<void>;
  nack(): Promise<void>;
}
```

### 7.2 语义

| 操作 | 效果 |
|---|---|
| `ack()` | 消息被确认，cursor 前移 |
| `nack()` | 消息被拒绝，回到可用 |

### 7.3 不变量

- **AK-1**：`ack()` MUST 幂等。
- **AK-2**：`nack()` MUST 幂等。
- **AK-3**：`ack()` 后 MUST NOT 允许 `nack()`。
- **AK-4**：`nack()` 后 MUST NOT 允许 `ack()`。
- **AK-5**：对已终结的 AckContext 再次调用 MUST 返回 `EAPP_LEASE_CLOSED`。

---

## 8. 与 Composition Core 的关系

### 8.1 Channel 的诞生

Channel **MUST** 由 Binding 派生。

```
Binding (ACTIVE)
    │
    │ derive
    ▼
ChannelRef (id + binding)
    │
    │ instantiate
    ▼
Channel (mode + delivery + state)
```

### 8.2 Channel 与 Binding 状态同步

| Binding 状态 | Channel 状态 |
|---|---|
| ACTIVE | OPEN 或 ACTIVE |
| DORMANT | DRAINING |
| CLOSED | CLOSED |

**Binding 进入 DORMANT 时，Channel MUST 进入 DRAINING。** 这保证在途消息不被丢弃。

### 8.3 不变量

- **CC-1**：Channel MUST NOT 独立于 Binding 存在。
- **CC-2**：Binding CLOSED 时，Channel MUST 立即进入 CLOSED。
- **CC-3**：Channel 的 mode 和 delivery MUST 由创建者显式指定。

---

## 9. 与 Transport 的关系

### 9.1 Transport 的职责

Transport 提供**消息的物理传递**。它 **MUST NOT** 定义：

- 交互模式
- 投递保证的语义
- Lease 语义
- Cursor 语义

这些是 Interaction Layer 的职责。

### 9.2 Transport 能力声明

```typescript
interface TransportCapabilities {
  // 消息存储
  persistent: boolean;
  // 顺序保证
  ordering: 'none' | 'per-source' | 'global';
  // 投递能力
  delivery: {
    atMostOnce: boolean;
    atLeastOnce: boolean;
    replay: boolean;
  };
  // 语义支持
  supportsCursor: boolean;
  supportsLease: boolean;
}
```

### 9.3 能力矩阵

| Transport | persistent | ordering | atLeastOnce | replay | cursor | lease |
|---|---|---|---|---|---|---|
| Memory | ❌ | global | ✅ | ❌ | ✅ | ✅ |
| Socket | ❌ | per-source | ✅ | ❌ | ✅ | ✅ |
| Redis Streams | ✅ | global | ✅ | ✅ | ✅ | ✅ |
| NATS JetStream | ✅ | global | ✅ | ✅ | ✅ | ✅ |
| NATS Core | ❌ | per-source | ❌ | ❌ | ❌ | ❌ |

### 9.4 Transport 不支持时的处理

如果 Transport 不支持某个语义：

- **MUST** 返回 `EAPP_UNSUPPORTED`。
- **MUST NOT** 伪装支持。

例如：Transport 不支持 cursor，则 `watch(cursor)` MUST 返回 `EAPP_CURSOR_UNSUPPORTED`。

### 9.5 不变量

- **TR-1**：Transport MUST NOT 定义 Interaction 语义。
- **TR-2**：Transport MUST 声明自己的能力。
- **TR-3**：Transport MUST NOT 伪装支持。
- **TR-4**：Channel MUST NOT 使用超出 Transport 能力的特性。

---

## 10. 不变量（汇总）

```text
CH-1   Channel MUST correspond to exactly one Binding.
CH-2   Channel lifecycle MUST NOT exceed Binding lifecycle.
CH-3   CLOSED is terminal.
CH-4   close() MUST be idempotent.
CH-5   mode MUST NOT change during lifecycle.
CH-6   delivery MUST NOT change during lifecycle.

RQ-1   Each request MUST have a unique correlationId.
RQ-2   One request MUST map to 0 or 1 response.
RQ-3   Response MUST carry the same correlationId.
RQ-4   Request MUST time out after deadline.

EV-1   Event MUST NOT expect a response.
EV-2   Event MAY be delivered zero times.
EV-3   Event MAY be delivered multiple times.

ST-1   cursor MUST be globally monotonically increasing.
ST-2   Consumers MUST resume via cursor.
ST-3   Acked messages MUST NOT be re-delivered.
ST-4   Unacked messages MAY be re-delivered.

SM-1   revision MUST be monotonically increasing.
SM-2   Concurrent updates MUST be conflict-detected.
SM-3   deleted MUST preserve revision.

DL-1   delivery MUST be at-most-once or at-least-once.
DL-2   exactly-once MUST NOT appear in Core.
DL-3   at-most-once MUST NOT ack.
DL-4   at-least-once MUST ack.
DL-5   at-least-once consumer MUST be idempotent.

L-1    leaseId MUST be globally unique.
L-2    Same cursor MUST NOT be held by multiple ACTIVE leases.
L-3    ack() MUST be idempotent.
L-4    nack() MUST be idempotent.
L-5    renew() only valid for ACTIVE lease.
L-6    After expiry, cursor MAY be re-claimed.
L-7    Expired lease MUST NOT affect new lease.

CR-1   Cursor MUST be globally ordered within Channel.
CR-2   Cursor MUST be persistable and recoverable.
CR-3   Cursor MUST NOT skip unacked messages implicitly.
CR-4   Resume MUST continue from cursor.
CR-5   If Transport does not support cursor, MUST return EAPP_CURSOR_UNSUPPORTED.

AK-1   ack() MUST be idempotent.
AK-2   nack() MUST be idempotent.
AK-3   ack() then nack() MUST fail.
AK-4   nack() then ack() MUST fail.
AK-5   Terminal AckContext MUST return EAPP_LEASE_CLOSED.

CC-1   Channel MUST NOT exist independently of Binding.
CC-2   Binding CLOSED => Channel MUST immediately CLOSE.
CC-3   Channel mode and delivery MUST be explicit.

TR-1   Transport MUST NOT define Interaction semantics.
TR-2   Transport MUST declare its capabilities.
TR-3   Transport MUST NOT fake support.
TR-4   Channel MUST NOT use unsupported features.
```

---

## 11. 错误模型

```typescript
type EappInteractionErrorCode =
  | 'EAPP_CHANNEL_INVALID'
  | 'EAPP_CHANNEL_CLOSED'
  | 'EAPP_CHANNEL_DRAINING'
  | 'EAPP_MODE_INVALID'
  | 'EAPP_DELIVERY_UNSUPPORTED'
  | 'EAPP_CURSOR_INVALID'
  | 'EAPP_CURSOR_UNSUPPORTED'
  | 'EAPP_LEASE_EXPIRED'
  | 'EAPP_LEASE_CLOSED'
  | 'EAPP_LEASE_CONFLICT'
  | 'EAPP_TIMEOUT'
  | 'EAPP_UNSUPPORTED'
  | 'EAPP_INTERNAL';

interface EappError {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}
```

---

## 12. 参考实现

### 12.1 目录结构

```
eapp/
├── spec/
│   ├── v3.0.0-core.md
│   └── v3.1.0-interaction.md       ← 本文
├── reference/
│   ├── core/                        # Composition Core 参考实现
│   │   ├── identity.ts
│   │   ├── capability.ts
│   │   ├── plugin.ts
│   │   ├── binding.ts
│   │   ├── lifecycle.ts
│   │   └── discovery.ts
│   ├── interaction/                 # Interaction Layer 参考实现
│   │   ├── channel.ts
│   │   ├── modes/
│   │   │   ├── request.ts
│   │   │   ├── event.ts
│   │   │   ├── stream.ts
│   │   │   └── state.ts
│   │   ├── lease.ts
│   │   ├── cursor.ts
│   │   └── ack.ts
│   └── transport/                   # Transport 参考实现
│       ├── memory.ts
│       ├── socket.ts
│       └── redis.ts
├── tests/
│   └── conformance/
│       ├── core.test.ts
│       └── interaction.test.ts
└── examples/
    ├── logger-plugin/
    ├── app-plugin/
    └── job-queue/
```

### 12.2 Channel 实现

```typescript
// reference/interaction/channel.ts
import type { Binding } from '../core/binding';
import type { Transport } from '../transport/interface';
import type {
  ChannelMode,
  DeliveryGuarantee,
  ChannelState,
} from './types';

export class Channel {
  readonly id: string;
  readonly binding: string;
  readonly mode: ChannelMode;
  readonly delivery: DeliveryGuarantee;

  private _state: ChannelState = 'OPEN';
  private transport: Transport;
  private onClose?: () => void;

  constructor(
    id: string,
    binding: string,
    mode: ChannelMode,
    delivery: DeliveryGuarantee,
    transport: Transport,
  ) {
    this.id = id;
    this.binding = binding;
    this.mode = mode;
    this.delivery = delivery;
    this.transport = transport;
    this.validate();
  }

  private validate(): void {
    if (this.mode === 'stream' && this.delivery !== 'at-least-once') {
      throw new EappError(
        'EAPP_DELIVERY_UNSUPPORTED',
        'Stream mode requires at-least-once delivery',
      );
    }
    if (!this.transport.capabilities.supportsCursor && this.mode === 'stream') {
      throw new EappError(
        'EAPP_CURSOR_UNSUPPORTED',
        'Stream mode requires cursor support',
      );
    }
  }

  get state(): ChannelState {
    return this._state;
  }

  async connect(): Promise<void> {
    if (this._state !== 'OPEN') {
      throw new EappError('EAPP_CHANNEL_INVALID', 'connect only from OPEN');
    }
    await this.transport.connect(this.id);
    this._state = 'ACTIVE';
  }

  async drain(): Promise<void> {
    if (this._state !== 'ACTIVE') return;
    this._state = 'DRAINING';
    await this.transport.drain(this.id);
  }

  async close(): Promise<void> {
    if (this._state === 'CLOSED') return;   // 幂等
    if (this._state === 'ACTIVE') {
      await this.drain();
    }
    await this.transport.close(this.id);
    this._state = 'CLOSED';
    this.onClose?.();
  }

  async onBindingClosed(): Promise<void> {
    // CC-2: Binding CLOSED → Channel MUST immediately CLOSE
    await this.close();
  }

  async onBindingDormant(): Promise<void> {
    // 进入 DRAINING，等待在途完成
    if (this._state === 'ACTIVE') {
      await this.drain();
    }
  }
}
```

### 12.3 Request 模式

```typescript
// reference/interaction/modes/request.ts
export class RequestChannel {
  private pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: EappError) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(private channel: Channel) {}

  async request(
    operation: string,
    payload: unknown,
    deadline = 30_000,
  ): Promise<unknown> {
    if (this.channel.state !== 'ACTIVE') {
      throw new EappError('EAPP_CHANNEL_CLOSED', 'Channel not active');
    }

    const correlationId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new EappError('EAPP_TIMEOUT', 'Request timed out'));
      }, deadline);

      this.pending.set(correlationId, { resolve, reject, timer });

      this.channel.send({
        correlationId,
        operation,
        payload,
        deadline,
      }).catch(err => {
        clearTimeout(timer);
        this.pending.delete(correlationId);
        reject(err);
      });
    });
  }

  async onResponse(msg: ResponseMessage): Promise<void> {
    const entry = this.pending.get(msg.correlationId);
    if (!entry) return;                       // 已超时或未知
    clearTimeout(entry.timer);
    this.pending.delete(msg.correlationId);

    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(msg.error ?? new EappError('EAPP_INTERNAL', 'Unknown'));
  }
}
```

### 12.4 Stream + Lease + Cursor

```typescript
// reference/interaction/modes/stream.ts
export class StreamChannel {
  constructor(
    private channel: Channel,
    private cursorStore: CursorStore,
    private leaseStore: LeaseStore,
  ) {}

  async *subscribe(pattern: Pattern): AsyncIterable<StreamMessage> {
    let cursor = await this.cursorStore.load(this.channel.id);

    while (this.channel.state !== 'CLOSED') {
      const messages = await this.channel.transport.readAfter(
        this.channel.id,
        cursor,
        pattern,
      );

      for (const msg of messages) {
        const lease = await this.leaseStore.claim(
          this.channel.id,
          msg.cursor,
          30_000,
        );

        yield {
          cursor: msg.cursor,
          payload: msg.payload,
          lease,
        };
      }

      if (messages.length === 0) {
        await sleep(50);
      }
    }
  }

  async ack(lease: Lease): Promise<void> {
    await lease.ack();
    await this.cursorStore.save(this.channel.id, lease.cursor);
  }

  async nack(lease: Lease): Promise<void> {
    await lease.nack();
  }
}
```

### 12.5 Lease 实现

```typescript
// reference/interaction/lease.ts
export class LeaseStore {
  private leases = new Map<string, LeaseRecord>();

  async claim(
    channelId: string,
    cursor: string,
    ttl: number,
  ): Promise<Lease> {
    const key = `${channelId}:${cursor}`;

    // L-2: 同一 cursor 不能被多个 ACTIVE lease 持有
    const existing = this.leases.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      throw new EappError('EAPP_LEASE_CONFLICT', 'Cursor already claimed');
    }

    const leaseId = crypto.randomUUID();
    const expiresAt = Date.now() + ttl;
    this.leases.set(key, { leaseId, cursor, expiresAt, state: 'ACTIVE' });

    return {
      leaseId,
      cursor,
      expiresAt,

      ack: async () => {
        const rec = this.leases.get(key);
        if (!rec || rec.leaseId !== leaseId) {
          throw new EappError('EAPP_LEASE_CLOSED', 'Lease no longer active');
        }
        if (rec.state === 'ACKED') return;         // L-3 幂等
        rec.state = 'ACKED';
        this.leases.delete(key);
      },

      nack: async () => {
        const rec = this.leases.get(key);
        if (!rec || rec.leaseId !== leaseId) {
          throw new EappError('EAPP_LEASE_CLOSED', 'Lease no longer active');
        }
        if (rec.state === 'NACKED') return;        // L-4 幂等
        rec.state = 'NACKED';
        this.leases.delete(key);
      },

      renew: async (newTtl: number) => {
        const rec = this.leases.get(key);
        if (!rec || rec.leaseId !== leaseId || rec.state !== 'ACTIVE') {
          throw new EappError('EAPP_LEASE_EXPIRED', 'Lease not renewable');
        }
        rec.expiresAt = Date.now() + newTtl;
      },
    };
  }
}
```

### 12.6 Memory Transport

```typescript
// reference/transport/memory.ts
export class MemoryTransport implements Transport {
  readonly capabilities: TransportCapabilities = {
    persistent: false,
    ordering: 'global',
    delivery: { atMostOnce: true, atLeastOnce: true, replay: false },
    supportsCursor: true,
    supportsLease: true,
  };

  private messages: Array<{ channel: string; cursor: string; payload: unknown }> = [];
  private counter = 0;

  async send(channel: string, msg: unknown): Promise<string> {
    const cursor = String(++this.counter).padStart(20, '0');
    this.messages.push({ channel, cursor, payload: msg });
    return cursor;
  }

  async readAfter(
    channel: string,
    cursor: string,
    pattern: Pattern,
  ): Promise<Array<{ cursor: string; payload: unknown }>> {
    return this.messages
      .filter(m => m.channel === channel && m.cursor > cursor)
      .filter(m => matches(m.payload, pattern))
      .map(m => ({ cursor: m.cursor, payload: m.payload }));
  }

  // connect / drain / close 省略
}
```

### 12.7 完整示例：Job Queue

```typescript
// examples/job-queue/producer.ts
const producer = await composition.bind({
  from: workerPlugin.identity,
  to: queuePlugin.identity,
  capability: { name: 'jobs', version: '1.0.0' },
});

const channel = await interaction.createChannel({
  binding: producer.id,
  mode: 'stream',
  delivery: 'at-least-once',
});

await channel.send({
  task: 'resize',
  imageId: 'abc',
});

// examples/job-queue/consumer.ts
const sub = streamChannel.subscribe({ type: 'job' });

for await (const msg of sub) {
  try {
    await processJob(msg.payload);
    await streamChannel.ack(msg.lease);      // cursor 前移
  } catch (err) {
    await streamChannel.nack(msg.lease);     // 回到可用
  }
}
```

---

## 13. 一致性测试

### 13.1 测试结构

```typescript
// tests/conformance/interaction.test.ts
describe('EaPP v3.1.0 Interaction Conformance', () => {

  describe('Channel lifecycle', () => {
    test('CH-1: Channel 必须对应一个 Binding', ...);
    test('CH-3: CLOSED 是终结状态', ...);
    test('CH-4: close() 幂等', ...);
  });

  describe('Request mode', () => {
    test('RQ-1: correlationId 唯一', ...);
    test('RQ-4: deadline 超时', ...);
  });

  describe('Stream mode', () => {
    test('ST-1: cursor 单调递增', ...);
    test('ST-3: ack 后的消息不重新投递', ...);
    test('ST-4: 未 ack 的消息可重新投递', ...);
  });

  describe('Lease', () => {
    test('L-2: 同一 cursor 不能被多 lease 持有', ...);
    test('L-3: ack 幂等', ...);
    test('L-6: lease 超时后 cursor 可重新领取', ...);
    test('L-7: 过期 lease 不影响新 lease', ...);
  });

  describe('Cursor', () => {
    test('CR-3: cursor 不跳过未 ack 的消息', ...);
    test('CR-4: 从 cursor 恢复', ...);
    test('CR-5: 不支持 cursor 时返回标准错误', ...);
  });

  describe('Delivery', () => {
    test('DL-2: exactly-once 不在 Core', ...);
    test('DL-3: at-most-once 不 ack', ...);
    test('DL-4: at-least-once 必须 ack', ...);
  });

  describe('Transport boundaries', () => {
    test('TR-2: Transport 声明能力', ...);
    test('TR-3: Transport 不伪装支持', ...);
    test('TR-4: Channel 不使用超出能力的功能', ...);
  });
});
```

### 13.2 合规等级

| 等级 | 要求 |
|---|---|
| **I1 Channel** | Channel 生命周期 + 四种模式 |
| **I2 Delivery** | at-most-once / at-least-once |
| **I3 Lease** | 可靠竞争消费 |
| **I4 Cursor** | 可恢复观察 |
| **I5 Transport Capability** | 能力声明与检查 |

实现 MUST 支持 I1-I2。SHOULD 支持 I3-I4。MAY 支持 I5。

---

## 14. 冻结声明（草案）

一旦 I1-I4 通过一致性测试：

```
Tag:    v3.1.0-interaction
Date:   TBD
Status: FROZEN
Next:   v3.2.0 transport-capability
```

---

## 附录 A：术语表

| 术语 | 定义 |
|---|---|
| Channel | Binding 的运行时具体化 |
| ChannelRef | Composition Core 可见的 Channel 引用 |
| ChannelMode | request / event / stream / state |
| DeliveryGuarantee | at-most-once / at-least-once |
| Lease | 竞争消费的临时所有权 |
| Cursor | 消费者已确认消费的位置 |
| AckContext | ack / nack 的上下文 |
| TransportCapabilities | Transport 的能力声明 |

## 附录 B：与 v3.0.0-core 的接口

```typescript
interface CompositionToInteraction {
  // Composition Core 输出
  onBindingCreated(binding: Binding): ChannelRef;
  onBindingDormant(binding: Binding): void;
  onBindingClosed(binding: Binding): void;
  onBindingActive(binding: Binding): void;
}

interface InteractionToComposition {
  // Interaction Layer 向 Composition Core 暴露
  channelRef(id: string): ChannelRef;
  channelState(id: string): ChannelState;
}
```

**双向接口 MUST NOT 引入跨层语义。** Composition Core 只发状态变更事件；Interaction Layer 只回报 Channel 引用与状态。

---

**EaPP v3.1.0 Interaction Layer — Draft**

**Composition 决定关系。Interaction 决定互动。Transport 决定机制。**

**下一步：一致性测试通过后，标记 v3.1.0 FROZEN。**
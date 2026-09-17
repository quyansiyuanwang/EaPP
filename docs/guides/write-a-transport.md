# 实现一个 Transport

> **本页规定 Transport 实现的完整契约。满足该契约，EaPP 即可运行于任意消息系统之上。**

前置阅读：[概念：三层心智模型](./concepts.md) 的 **§2 与 §7**。
本页所有类型与行为都取自 `packages/interaction/src/transport.ts`、
`packages/state/src/state-transport.ts` 与参考实现 `packages/transport/memory/`；
所有代码都是真实可跑的，并已在仓库内执行验证。

---

## 0. Transport 在哪一层

```
Composition Core   ──►  谁和谁组合
Interaction Layer  ──►  组合之后，它们如何互动
State Mode         ──►  它们如何共享状态
Transport          ──►  消息物理上怎么走          ← 实现位置
```

Transport 是**最下面一层**，它的职责只有两件事：

```
① 追加消息，并为这次追加分配一个位置（cursor）
② 从某个位置之后读回消息
```

它**不做**的事，与它做的事同样重要。见 §5。

---

## 1. `Transport` 接口

v3.1 §10 冻结的接口（`packages/interaction/src/transport.ts`）：

```typescript
type Cursor = string;          // 不透明，在 Channel 内全局有序
type CursorAnchor = 'earliest' | 'latest' | Cursor;

interface TransportMessage {
  cursor: Cursor;
  payload: unknown;
}

type Pattern = { readonly all: true } | { readonly type: string };

interface TransportCapabilities {
  persistent: boolean;
  ordering: 'none' | 'per-source' | 'global';
  delivery: { atMostOnce: boolean; atLeastOnce: boolean; replay: boolean };
  supportsCursor: boolean;
  supportsLease: boolean;
  durabilityBoundary: 'process' | 'machine' | 'cluster' | 'global';
}

interface Transport {
  readonly id: string;
  readonly capabilities: TransportCapabilities;

  send(channel: string, msg: unknown): Promise<Cursor>;
  readAfter(channel: string, cursor: Cursor | undefined, pattern: Pattern): Promise<TransportMessage[]>;
  close(): Promise<void>;

  resolveAnchor?(channel: string, anchor: CursorAnchor): Promise<Cursor>;
  waitForChange?(channel: string, cursor: Cursor | undefined, signal?: AbortSignal): Promise<void>;
}
```

| 成员 | 必填 | 语义 | 违反时的表现 |
|---|---|---|---|
| `id` | 是 | 这个 transport 实例的标识。参考实现把它嵌进每个 cursor/revision，用于识别"这个值是哪个实例签发的" | —— |
| `capabilities` | 是 | 能力声明。MUST 如实声明（TR-2 / TR-3），检查见 `assertDeclared` |
| `send` | 是 | 追加一条消息，返回它被分配的位置（TR-8：`send` 返回的 cursor MUST 在该 Channel 内严格大于此前所有 cursor） | —— |
| `readAfter` | 是 | 返回 **严格大于** `cursor` 且匹配 `pattern` 的消息，按升序（TR-5） | 破坏恢复语义（CR-2 / CR-4） |
| `readAfter` 的 `undefined` | 是 | MUST 解释为"从最早已保留位置开始"（TR-6） | —— |
| `readAfter` 无匹配 | 是 | MUST 返回空数组，**MUST NOT 阻塞**（TR-7） | 订阅循环与 dispatcher 会挂死 |
| `close` | 是 | 关闭。之后的 `send` / 状态写入 MUST 明确失败，而不是静默丢弃 | 静默丢数据 |
| `resolveAnchor` | 否 | 解析 `'earliest'` / `'latest'` | 省略后订阅方只能用 `''` 当起点；`'latest'` 会退化为空串 |
| `waitForChange` | 否 | 阻塞到 `cursor` 之后有新东西。**这是优化，不是语义** | 省略后订阅循环按 `pollIntervalMs`（默认 50ms）轮询 |

`pattern` 的两种形状是**闭合**的：`{ all: true }` 或 `{ type: string }`，
`type` 与实际负载的 `payload.type` 比较。校验由 `validatePattern` 完成，
两种以外抛 `EAPP_CHANNEL_INVALID`。

**`Cursor` 是不透明的。** 消费者 MUST NOT 解析它。实现方只需保证"同一条 Channel 内可比较、
且严格递增"，形状由实现方决定 —— 但 §4 的约束使可选的形状只剩很窄的一类。

---

## 2. `StateTransport`：同一层，多一组职责

v3.2 §11 没有引入新层，而是**扩展** Transport（TS-7）：

```typescript
interface StateTransport extends Transport {
  readonly capabilities: StateTransportCapabilities;

  getState(channel: string, key: string): Promise<StateCell | null>;
  listState(channel: string, pattern: StatePattern): Promise<StateCell[]>;
  head(channel: string): Promise<Revision>;

  setStateWithCAS(channel: string, update: StateUpdate, actor: Identity): Promise<Revision>;
  deleteStateWithCAS(
    channel: string, key: string, expectedRevision: ExpectedRevision, actor: Identity,
  ): Promise<Revision>;

  readChangesAfter(
    channel: string, cursor: Cursor | undefined, pattern: StatePattern,
  ): Promise<StateChange[]>;

  nextRevision(channel: string): Promise<Revision>;
  compareRevision(a: Revision, b: Revision): number;
  writeStateWithRevision(
    channel: string, key: string, value: unknown, deleted: boolean, revision: Revision, actor: Identity,
  ): Promise<void>;
}
```

三个容易做错的形状决策，规范都点名了：

**① `readChangesAfter` 返回的是"变更流"，不是 `StateCell[]`。**
一个 post-image 数组表达不了"同一个 key 被写了两次"，中间那次变更会永久消失，
观察位置也就失去意义（TS-9 / TS-10）。

**② 寻址是 `(channel, key)` 二元组，不是拼起来的字符串**（TS-13）。
用 `` `${channel}:${key}` `` 当 map key，会让 `(channel="a", key="b:c")` 与
`(channel="a:b", key="c")` 命中同一个 cell，造成跨 Channel 污染。

**③ `head` 在空 Channel 上 MUST 返回一个可比较的初始 revision**（TS-14）。
不要抛异常，也不要泄露 `undefined`：返回一个排序在所有已分配位置之前的哨兵
（参考实现用空串 `''`）。`compareRevision` 必须接受它。

另外三条来自 v3.2 的硬约束：

```
TS-6   CAS MUST 在 Transport 内原子完成。
       set/delete 的"比较"和"写入"之间 MUST NOT 出现 await —— 否则两个并发写者能同时通过检查。
TS-8   Revision 的比较 MUST 由 Transport 提供；使用者 MUST NOT 直接比较 Revision 字符串。
REV-8  拿别的 Transport 实例签发的 Revision 来比较 MUST 抛 EAPP_REVISION_INVALID，
       而不是静默按字典序排出一个错误结果。
```

`nextRevision` + `writeStateWithRevision` 是给 `restore` 用的**内部钉住写入**（§5.5 / SNAP-7）：
先预留一个严格大于 head 的位置，再用它写入；`writeStateWithRevision` 收到 `<= head` 的位置
MUST 抛 `EAPP_REVISION_INVALID`，因此 restore **永远不会把日志往回拨**。

---

## 3. 如实声明 `TransportCapabilities`

能力声明是规范里最容易被"善意地撒谎"的地方，所以它被设计成**一处声明、处处可查**：

```typescript
function assertDeclared(transport: Transport): void {
  const c: Partial<TransportCapabilities> | undefined = transport.capabilities;
  if (!c || typeof c.persistent !== 'boolean' || typeof c.ordering !== 'string') {
    throw new EappError('EAPP_UNSUPPORTED', `transport ${transport.id} does not declare capabilities`);
  }
}

function assertCapability(transport: Transport, feature: 'cursor' | 'lease'): void {
  if (feature === 'cursor' && !transport.capabilities.supportsCursor) {
    throw new EappError('EAPP_CURSOR_UNSUPPORTED', `transport ${transport.id} has no cursor support`);
  }
  if (feature === 'lease' && !transport.capabilities.supportsLease) {
    throw new EappError('EAPP_UNSUPPORTED', `transport ${transport.id} has no lease support`);
  }
}
```

规则是两句：

```
TR-2  Transport MUST 声明自己的能力。
TR-3  Transport MUST NOT 伪装支持。
```

**"不支持"必须是显式失败，而不是静默降级**（TR-4 / TR-9）。
一个号称 `supportsCursor: true` 却记不住位置的实现，比一个诚实地报 `false` 的实现危险得多：
后者会被闸门在调用点拦住，前者会在生产环境里静默重投或丢消息。

> 注意两套闸门的执行方式**不一样**：
>
> - v3.2 的四个 `supportsState*` 标志由 `assertStateCapability` 在最早的调用点强制。
> - v3.1 的 `assertDeclared` **也被自动执行**：`InteractionLayerImpl` 的构造函数调用
>   `assertCapabilitiesCoherent`，后者先调 `assertDeclared`，
>   再拒绝两种自相矛盾的组合（`supportsCursor` + `ordering:'none'`，
>   以及 `persistent:false` + `durabilityBoundary:'cluster'|'global'`）。
>   所以只要用运行时建过一层，声明就已经被查过。
> - 只有 `assertCapability(transport, 'cursor' | 'lease')` 是**导出供调用方使用**的，
>   参考实现内部没有自动调用点。自己不调它，"这个 Transport 支不支持 cursor" 就没人问过。
>
> 见 §10.2 的检查清单。

`StateTransportCapabilities` 在之上再加六个字段，每个 flag **恰好**对应一个强制后果（TS-2），
闸门在最早的调用点执行：

| 标志 | `false` 时的强制行为 | 闸门位置 |
|---|---|---|
| `supportsState` | `get` / `list` / `set` / `delete` / `snapshot` / `restore` / `watch` 全部抛 `EAPP_STATE_UNSUPPORTED` | `assertStateCapability` |
| `supportsStateRevision` | `set` / `delete` / `restore` 抛 `EAPP_STATE_UNSUPPORTED`（CAS 不可能成立）；**`get` / `list` 仍可用** | `assertStateCapability(…, 'revision')` |
| `supportsStateWatch` | `watch()` 抛 `EAPP_WATCH_UNSUPPORTED`（在 API 同步的地方**同步**抛） | `createStateWatcher` 入口 |
| `supportsStateSnapshot` | `snapshot()` / `restore()` 抛 `EAPP_UNSUPPORTED` | `assertStateCapability(…, 'snapshot')` |
| `stateConsistency` | `'strong'` MUST NOT 超出 `durabilityBoundary`（TS-5） | 见 §7 |
| `stateRetention` | `{kind:'unbounded'}` 或 `{kind:'window', entries:n}`；声明窗口就得在超出时抛 `EAPP_CURSOR_TOO_OLD` | `resolveAnchor('earliest')` |

实测（用一个只声明 `supportsStateRevision: false` 的 transport）：

```
get on an empty channel -> null
set with supportsStateRevision=false -> EAPP_STATE_UNSUPPORTED
```

注意第一行：**读仍然可以工作。** 这正是"能力闸门"该有的样子 —— 关掉的是不可能正确实现的操作，
不是整个能力。

---

## 4. Cursor 契约

### 4.1 契约本身

```
CR-1  Cursor MUST be globally ordered within Channel.
CR-2  Cursor MUST be persistable and recoverable.
CR-3  Cursor MUST NOT skip unacked messages implicitly.
CR-4  Resume MUST continue from cursor.
CR-5  If Transport does not support cursor, MUST return EAPP_CURSOR_UNSUPPORTED.
```

它对 Transport 实现的要求是：

- **在一条 Channel 内，cursor 必须构成全序**，且 `send` 每次分配的值严格大于此前所有值（TR-8）。
- **cursor 是一个可以直接比较的字符串。** 规范没有规定形状，但**比较由字符串完成** ——
  参考实现的 `compareCursor` 就是一次 `<` 比较：

```typescript
export function compareCursor(a: Cursor, b: Cursor): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
```

- **cursor 必须可持久化**（CR-2）：把它存进数据库、进程重启后拿出来继续读，必须仍然有效。
  这就要求它编码的是**日志位置**，不是"内存里的下标"。
- **ack 语义不属于 Transport 的职责**（CR-3）：cursor 只随显式 ack 前移，这条规则由 v3.1 的订阅实现保证。
  Transport 的职责是：`readAfter(channel, cursor, …)` 如实返回"严格大于 cursor"的东西，
  并且**永远不要**因为"投递过了"就自己推进任何东西。

### 4.2 参考实现怎么做到"字典序 = 数值序"

内存 Transport 用**固定宽度、零填充十进制**：

```typescript
const WIDTH = 16;

#allocate(): Revision {
  this.#seq += 1;
  return `${this.id}!${String(this.#seq).padStart(WIDTH, '0')}`;
}
```

这不是装饰。对**等宽的数字串**，字典序与数值序恰好一致，因此
`compareCursor` 可以退化成一次字符串比较。实测：

```
cursors: ["check-1!00000000000000000001","check-1!00000000000000000002","check-1!00000000000000000003"]
strictly increasing lexicographically: true
```

前缀 `${this.id}!` 承担第二件事：让 `compareRevision` 能识别"这个值是谁签发的"，
从而对**外来 revision** 抛 `EAPP_REVISION_INVALID`（REV-8），而不是排出一个错误顺序。

### 4.3 会坏掉的写法：`'1'`, `'2'`, `'10'`

如果直接分配不填充的十进制字符串，字典序就**不再等于**数值序。把
`['1','2','9','10']` 交给 `compareCursor` 排序：

```
bare decimal sorted by compareCursor: ["1","10","2","9"]
```

`'10'` 被排到了 `'2'` 前面。任何一次 `compareCursor` / `maxCursor` 都会得到错误结论，
而错误方式是**静默的**：订阅的 ack 只会把 cursor 停在更早的位置，表现为"消息反复重投"或
"位置停滞"，不会报错。

若无法保证等宽，正确做法是更换编码形状，而非依赖谨慎比较 —— 例如
`epoch` + 零填充序号、或 (timestamp, 零填充序号) 拼接。**只要保证：同样长度的字符串，
字典序与数值序一致。**

### 4.4 锚点解析

```
1. 先比较字面量：'earliest' / 'latest' MUST 被识别为锚点，MUST NOT 当作 Cursor 值。
2. 其余字符串 MUST 被当作 Cursor 处理。
3. 'earliest' MUST 解析为"Channel 中仍可服务的最早位置"。
4. 'latest'   MUST 解析为 Channel 当前头位置。
5. 锚点 MUST 在订阅创建时立即解析（eager）。
6. 若日志已压缩到无法定位 'earliest'，MUST 返回 EAPP_CURSOR_TOO_OLD。
```

内存实现的注释解释了这个顺序为什么必须在类型层面被明确：

```typescript
// v3.1 §6.2 rule 1: the literals MUST be recognised BEFORE a string is treated as a
// concrete cursor. Without that ordering rule `'earliest'` would itself be a valid
// `Cursor` and the two cases would be indistinguishable.
```

实践上：`'earliest'` 返回 `''`（保留日志的起点），`'latest'` 返回该 Channel 上
"最新出现过的东西"的位置 —— 注意它**同时**要考虑消息与状态写入。
参考实现为此把 anchor 与 state head 分开维护，因为 `head()` 只回答"状态日志推进到哪"，
而 anchor 回答"这条 Channel 上最新的东西在哪"。只跟踪状态 revision 会让流订阅者拿到一个状态位置。

### 4.5 `waitForChange` 是优化

它是可选的。订阅循环先**注册兴趣**、再读取；没有 `waitForChange` 就退化为
按 `pollIntervalMs`（默认 50ms）轮询。两条要注意：

- 它 MUST 在 `signal` 被 abort 时尽快返回，否则订阅 `close()` 会卡住。
- 它 MUST NOT 被用作正确性依赖："醒来"只是提示，醒来之后仍然要重新 `readAfter`。

---

## 5. Transport MUST NOT 定义 Interaction 语义

```
TR-1  Transport MUST NOT 定义 Interaction 语义。
```

这意味着一份"能通过"的实现**不能**出现下列任何行为 —— 它们各自都属于上面的层：

| 不属于 Transport | 属于谁 |
|---|---|
| "这是 request 模式，所以要等响应" | v3.1 Interaction Layer（模式与信封） |
| "这条消息至少投递一次" | [`Delivery`](../reference/delivery.md) 语义，由订阅/Lease 实现 |
| "这条消息只能交给一个消费者" | [`ConsumerGroup`](../reference/consumer-group.md) + [`Lease`](../reference/lease.md) |
| "cursor 在收到时就前进" | [`Cursor`](../reference/cursor.md) 的 CR-3：只随 ack 前移 |
| "这个写入是 CAS 的，所以我要合并冲突" | v3.2 [`StateChannel`](../reference/state-channel.md)/CAS；Transport 只负责**原子地**执行比较与写入 |
| "这是 State Mode，我要在这里做快照" | State Mode 的 `snapshot` / `restore`；Transport 只提供 `head` 与钉住写入 |

**Transport 只搬字节、分配位置。**
把上层语义下沉到传输层，会把它们埋进整条链路中最难替换、也最难测试的位置。

---

## 6. 完整示例：一个可运行的 Transport

示例就在仓库里，**可以直接跑**：

```bash
pnpm run example:transport
# 等价于 npx tsx examples/array-transport/index.ts
```

完整文件在 [`examples/array-transport/index.ts`](../../examples/array-transport/index.ts)：
每条 Channel 一个数组，固定宽度零填充 cursor，同时实现 `Transport` 与 `StateTransport`，
结尾自检 12 条结论。下面摘的是实现部分，并标出四处**容易写错的地方**。

（示例内的导入用相对路径，与 `examples/hello-plugins/` 的做法一致 ——
仓库根目录没有链接 `@eapp/*` 的 `node_modules` 入口，`@eapp/...` 形式的包名只在
`tsc`（经由 `tsconfig.json` 的 `paths`）与 `vitest`（经由 `vitest.config.ts` 的 alias）下可解析。）

```typescript
import { EappError, type Identity } from '../../packages/core/src/index.js';
import {
  TransportSubscription,
  compareCursor,
  type Cursor,
  type CursorAnchor,
  type Pattern,
  type TransportMessage,
} from '../../packages/interaction/src/index.js';
import {
  configureStateChannel,
  type ExpectedRevision,
  type Revision,
  type StateCell,
  type StateChange,
  type StatePattern,
  type StateTransport,
  type StateTransportCapabilities,
  type StateUpdate,
} from '../../packages/state/src/index.js';

/** 固定宽度：等宽数字串的字典序等于数值序。 */
const WIDTH = 20;

export class ArrayTransport implements StateTransport {
  readonly id: string;
  readonly capabilities: StateTransportCapabilities;

  readonly #log = new Map<string, Array<{ cursor: Cursor; message: unknown }>>();
  readonly #cells = new Map<string, Map<string, StateCell>>();
  readonly #changes = new Map<string, StateChange[]>();
  readonly #heads = new Map<string, Revision>();
  /** channel → 当前最新位置，消息与状态写入共用。 */
  readonly #anchors = new Map<string, Cursor>();
  readonly #waiters = new Map<string, Set<() => void>>();
  #seq = 0;
  #closed = false;

  constructor(id = 'array-1', options: { withCas?: boolean } = {}) {
    this.id = id;
    this.capabilities = {
      persistent: false,
      ordering: 'global',
      delivery: { atMostOnce: true, atLeastOnce: true, replay: false },
      supportsCursor: true,
      supportsLease: false,
      durabilityBoundary: 'process',
      supportsState: true,
      supportsStateRevision: options.withCas ?? true,
      supportsStateWatch: true,
      supportsStateSnapshot: true,
      stateConsistency: 'strong',
      stateRetention: { kind: 'unbounded' },
    };
  }

  /** 唯一的分配点：消息与状态写入共用同一本日志，因此位置天然全序。 */
  #allocate(): string {
    this.#seq += 1;
    return `${this.id}!${String(this.#seq).padStart(WIDTH, '0')}`;
  }

  #notify(channel: string): void {
    const pending = [...(this.#waiters.get(channel) ?? [])];
    this.#waiters.get(channel)?.clear();
    for (const resolve of pending) resolve();
  }

  /** 提交一次状态变更：推进 head 与 anchor，唤醒等待者。 */
  #commit(channel: string, change: StateChange): void {
    const log = this.#changes.get(channel) ?? [];
    log.push(change);
    this.#changes.set(channel, log);
    this.#heads.set(channel, change.revision);
    this.#anchors.set(channel, change.revision);
    this.#notify(channel);
  }

  // ------------------------------------------------------------------ 两道闸门
  //
  // 这两道闸门是上面那份"能跑但不够对"的版本缺的东西。它们都不是仪式：
  // 少了第一道，"已关闭"和"还开着"从调用方看完全一样（TR-4 禁止的静默降级）；
  // 少了第二道，一个外来的位置会被当成自己的位置，静默读到错的地方。

  #assertOpen(): void {
    if (this.#closed) {
      throw new EappError('EAPP_UNSUPPORTED', `transport ${this.id} is closed`);
    }
  }

  #requireOwn(value: Cursor | Revision | undefined, label: string): void {
    if (value === undefined || value === '') return;
    if (typeof value !== 'string' || !value.startsWith(`${this.id}!`)) {
      throw new EappError(
        'EAPP_CURSOR_INVALID',
        `${label} '${String(value)}' was not issued by transport ${this.id}`,
      );
    }
  }

  // ------------------------------------------------------------------ Transport

  async send(channel: string, msg: unknown): Promise<Cursor> {
    this.#assertOpen();
    const cursor = this.#allocate();
    const log = this.#log.get(channel) ?? [];
    log.push({ cursor, message: msg });
    this.#log.set(channel, log);
    this.#anchors.set(channel, cursor);
    this.#notify(channel);
    return cursor;
  }

  async readAfter(
    channel: string,
    cursor: Cursor | undefined,
    pattern: Pattern,
  ): Promise<TransportMessage[]> {
    this.#requireOwn(cursor, 'cursor');
    const from = cursor ?? '';                       // TR-6
    return (this.#log.get(channel) ?? [])
      .filter((entry) => compareCursor(entry.cursor, from) > 0)         // TR-5
      .filter((entry) => 'all' in pattern ||
        (entry.message as { type?: string })?.type === pattern.type)
      .map((entry) => ({ cursor: entry.cursor, payload: entry.message }));
  }                                                   // TR-7：无匹配就是空数组，不阻塞

  /**
   * `close()` 之后的写入 MUST 明确失败，而不是静默成功。
   * 一个空实现的 `close()` 会让"已关闭"和"还开着"从调用方看完全一样 ——
   * 这正是 TR-4 要禁掉的静默降级。而且它必须**唤醒等待者**，
   * 否则阻塞在 `waitForChange` 里的订阅循环会永远醒不过来。
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const channel of this.#waiters.keys()) this.#notify(channel);
  }

  async resolveAnchor(channel: string, anchor: CursorAnchor): Promise<Cursor> {
    if (anchor === 'earliest') return '';            // 保留日志的起点
    if (anchor === 'latest') return this.#anchors.get(channel) ?? '';
    this.#requireOwn(anchor, 'cursor');              // 规则 2：其余字符串当 cursor
    return anchor;
  }

  /**
   * 真的阻塞，直到该 Channel 上有新东西。这是**优化**，不是正确性依赖（§4.5）：
   * 没有它，`Subscription` 会退化成按 `pollIntervalMs` 轮询 —— 慢，但仍然正确。
   */
  waitForChange(channel: string, _cursor: Cursor | undefined, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const waiters = this.#waiters.get(channel) ?? new Set<() => void>();
      this.#waiters.set(channel, waiters);

      const finish = (): void => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };

      waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  // ------------------------------------------------------------- StateTransport

  async getState(channel: string, key: string): Promise<StateCell | null> {
    return this.#cells.get(channel)?.get(key) ?? null;
  }

  async listState(channel: string, pattern: StatePattern): Promise<StateCell[]> {
    return [...(this.#cells.get(channel)?.values() ?? [])].filter((cell) =>
      'all' in pattern ? true
        : 'key' in pattern ? cell.key === pattern.key
        : cell.key.startsWith(pattern.prefix),
    );
  }

  async head(channel: string): Promise<Revision> {
    return this.#heads.get(channel) ?? '';           // TS-14：可比较的初始位置
  }

  /** TS-6：比较与写入之间没有 await，因此不会交错。 */
  async setStateWithCAS(channel: string, update: StateUpdate, actor: Identity): Promise<Revision> {
    this.#assertOpen();
    const cells = this.#cells.get(channel) ?? new Map<string, StateCell>();
    this.#cells.set(channel, cells);
    const current = cells.get(update.key);

    if (update.expectedRevision === null) {
      if (current) throw new EappError('EAPP_REVISION_CONFLICT', `'${update.key}' already exists`);
    } else if (!current || compareCursor(current.revision, update.expectedRevision) !== 0) {
      throw new EappError('EAPP_REVISION_CONFLICT', `'${update.key}' has moved on`);
    }

    const revision = this.#allocate();
    const deleted = update.deleted === true;
    cells.set(update.key, {
      key: update.key,
      revision,
      value: deleted ? undefined : update.value,
      deleted,
      updatedAt: Date.now(),
      updatedBy: actor,
    });
    this.#commit(channel, {
      channel, revision, key: update.key, type: deleted ? 'deleted' : 'set',
      ...(deleted ? {} : { value: update.value }),
    });
    return revision;
  }

  async deleteStateWithCAS(
    channel: string, key: string, expectedRevision: ExpectedRevision, actor: Identity,
  ): Promise<Revision> {
    this.#assertOpen();
    const cells = this.#cells.get(channel);
    const current = cells?.get(key);

    // 这里是 §6.2 边界表里最容易写错的一格。**两种"key 不存在"是不同的失败**：
    //
    //   从未存在 + expectedRevision === null   →  EAPP_STATE_KEY_NOT_FOUND（DEL-4）
    //   从未存在 + expectedRevision === Revision →  EAPP_REVISION_CONFLICT
    //
    // 第二种是调用方来晚了（CAS 冲突，可重试），第一种是企图删除一个
    // 从来没存在过的东西"（调用错误，不可重试）。合成一个码，调用方就再也分不清
    // 这两种情况 —— 而它们的重试策略正好相反。
    if (!current) {
      if (expectedRevision === null) {
        throw new EappError('EAPP_STATE_KEY_NOT_FOUND', `'${key}' has never existed`);
      }
      throw new EappError('EAPP_REVISION_CONFLICT', `'${key}' does not exist`);
    }
    if (expectedRevision === null) {
      throw new EappError('EAPP_REVISION_CONFLICT', `'${key}' already exists`);
    }
    if (compareCursor(current.revision, expectedRevision) !== 0) {
      throw new EappError('EAPP_REVISION_CONFLICT', `'${key}' has moved on`);
    }

    if (current.deleted) return current.revision;     // 删除已删除的 key：no-op，不分配位置（DEL-5）
    const revision = this.#allocate();
    cells!.set(key, {
      key, revision, value: undefined, deleted: true,
      updatedAt: Date.now(), updatedBy: actor,
    });
    this.#commit(channel, { channel, revision, key, type: 'deleted' });
    return revision;
  }

  /**
   * TS-9 / TS-10：返回的是**变更流**（每次写入一条），不是 post-image 数组。
   * post-image 表达不了"同一个 key 写了两次"，中间那次就永久丢了，
   * 观察位置也就没有意义。
   */
  async readChangesAfter(
    channel: string, cursor: Cursor | undefined, pattern: StatePattern,
  ): Promise<StateChange[]> {
    this.#requireOwn(cursor, 'cursor');
    const from = cursor ?? '';                        // TS-11
    return (this.#changes.get(channel) ?? [])
      .filter((change) => compareCursor(change.revision, from) > 0)     // TS-9 / TS-10
      .filter((change) =>
        'all' in pattern ? true
          : 'key' in pattern ? change.key === pattern.key
          : change.key.startsWith(pattern.prefix),
      );                                              // TS-12：不阻塞
  }

  async nextRevision(_channel: string): Promise<Revision> {
    return this.#allocate();
  }

  /** TS-8 / REV-8：比较由 Transport 提供，外来 revision 明确失败。 */
  compareRevision(a: Revision, b: Revision): number {
    for (const value of [a, b]) {
      if (value !== '' && !value.startsWith(`${this.id}!`)) {
        throw new EappError('EAPP_REVISION_INVALID', `'${value}' was not issued by ${this.id}`);
      }
    }
    return compareCursor(a, b);
  }

  /** §5.5 的钉住写入：只允许前进，不允许把日志往回拨。 */
  async writeStateWithRevision(
    channel: string, key: string, value: unknown, deleted: boolean,
    revision: Revision, actor: Identity,
  ): Promise<void> {
    this.#assertOpen();
    this.#requireOwn(revision, 'revision');
    if (this.compareRevision(revision, await this.head(channel)) <= 0) {
      throw new EappError('EAPP_REVISION_INVALID', `'${revision}' does not advance head`);
    }
    const cells = this.#cells.get(channel) ?? new Map<string, StateCell>();
    this.#cells.set(channel, cells);
    cells.set(key, {
      key, revision, value: deleted ? undefined : value, deleted,
      updatedAt: Date.now(), updatedBy: actor,
    });
    this.#commit(channel, {
      channel, revision, key, type: deleted ? 'deleted' : 'set',
      ...(deleted ? {} : { value }),
    });
  }
}
```

### 6.1 两条接线方式

**① 交给运行时。** `EappRuntime.create()` 接受 `transport` 选项；
缺省时它自己 new 一个内存 Transport：

```typescript
import { MemoryTransport } from '../../packages/transport/memory/src/index.js';

const runtime = EappRuntime.create({
  domain: 'eapp.guide',
  transport: new MemoryTransport('mem-1'),
});
```

> **类型提醒（这条曾经是错的，现在是对的）。** `EappRuntimeOptions.transport` 声明的是
> `StateTransport` 接口，不是 `MemoryTransport` 类。早期版本声明成了具体类，
> 于是把自己的实现传进去会被 `tsc` 拒绝
> （`Type 'MyTransport' is missing the following properties from type 'MemoryTransport'`）——
> 那等于让 Transport 边界在类型上失效。现在传任何 `StateTransport` 都可以。
>
> 示例的第二部分就是这么做的：同一个 `ArrayTransport` 交给运行时，
> `invoke` / `publish` / `subscribe` / `stateChannel` 全部照跑，
> 上面三层不需要知道消息存在数组里。

**② 直接把下层组件接起来。** 这是运行时内部使用的同一组调用，任何实现都可以这样用：

```typescript
import { TransportSubscription } from '../../packages/interaction/src/index.js';
import { configureStateChannel } from '../../packages/state/src/index.js';

// ArrayTransport 就是本节上面那段代码里的类（在同一个文件里，无需再导入）

const transport = new ArrayTransport('array-1');

// 状态：由一条 mode='state' 的 Channel 配置而来
const state = configureStateChannel(
  { id: 'ch-1', binding: 'binding-1', mode: 'state', delivery: 'at-least-once', state: 'ACTIVE' },
  transport,
  { conflictPolicy: 'cas', owner: { domain: 'eapp.guide', id: 'owner', instance: 'owner-1' } },
);

// 消息：构造 SubscriptionSource，其读取指向该 transport
const subscription = await TransportSubscription.create('orders', {}, {
  head: async () => (await transport.resolveAnchor('orders', 'latest')) ?? '',
  earliest: async () => '',
  readAfter: async (cursor, ack) =>
    (await transport.readAfter('orders', cursor, { all: true })).map((message) => {
      const context = ack(message.cursor);           // AckContext 把 ack 绑到位置
      return {
        cursor: message.cursor,
        item: { payload: message.payload, ack: () => context.ack(), nack: () => context.nack() },
      };
    }),
  waitForChange: (cursor, signal) => transport.waitForChange('orders', cursor, signal),
});
```

`pnpm run example:transport` 的第一部分就是这个接法，真实输出：

```
  set stock=1 → array-1!00000000000000000001
  set stock=2 → array-1!00000000000000000002
  拿着旧 token 再写 → EAPP_REVISION_CONFLICT  retryable=true
  最终值 = 2 —— 没有丢更新
  watcher 看到 [3]，它的 cursor = array-1!00000000000000000003
  —— 与 revision 同一个值：在这一层 Revision 和 Cursor 同域（REV-7）
  订阅收到 [10,11]，cursor = array-1!00000000000000000005
  —— 前缀是 array-1，与上面三次状态写入同一本日志（位置连续）
```

（id 与位置按创建顺序递增，字面值会变。）

三处值得注意：

- 拿着同一个 CAS token 的第二次写入被拒绝（`EAPP_REVISION_CONFLICT`，`retryable=true`），
  而 watcher 的 `cursor` **就是**那次写入的 revision —— 因为 Revision 与 Cursor
  在这一层是同一域上的同一类型。
- 状态写入落在位置 `…03`，消息落在 `…04`、`…05`。**没有跳号，也没有两本日志**：
  这就是"Revision 是写入在 Channel 日志中的位置"的字面含义。
- 全部位置都带 `array-1!` 前缀 —— 那是 Transport 的签名，也是
  `compareRevision` 能拒绝外来值（REV-8）的依据。

想自己复现"并发写者"那一幕，用 `Promise.all` 就够了 —— 同一个 token 必然只有一个赢家：

```typescript
const attempts = await Promise.allSettled([
  state.set({ key: 'stock', value: 42, expectedRevision: v2 }),
  state.set({ key: 'stock', value: 43, expectedRevision: v2 }),
  state.set({ key: 'stock', value: 44, expectedRevision: v2 }),
]);
console.log(attempts.filter((a) => a.status === 'fulfilled').length, 'won');
console.log(attempts.filter((a) => a.status === 'rejected').length, 'rejected');
```

---

## 7. `durabilityBoundary` 与一致性

```typescript
stateConsistency: 'strong' | 'eventual';
durabilityBoundary: 'process' | 'machine' | 'cluster' | 'global';
```

`durabilityBoundary` 回答的是：**一条持久化的消息，在最坏情况下能被哪些范围看到。**
`stateConsistency` 回答的是：状态读写是不是全序可判定的。

规则是一条不等式：

```
TS-5  A Transport MUST NOT declare stateConsistency = 'strong'
      beyond its durabilityBoundary.
```

**这条规则的必要性。** 若把 `stateConsistency` 声明成 `'strong'`，
上层就有权假设"所有参与者看到同一份状态、写入有全序"，并据此做 CAS。
而一个 `durabilityBoundary: 'process'` 的实现只保证"本进程内的可见性" ——
两个进程各有一份内存状态，各自都能通过 CAS 检查，于是**同一个写入会被执行两次**，
更新就静默丢了。所以边界是 `'process'` 时，最弱的诚实声明就是"只在进程内强一致"，
跨进程必须按 `'eventual'` 处理。

参考实现是 `process` + `strong`，这个组合是自洽的：它的强一致**恰好**只覆盖一个进程。
一个有本地缓存、跨节点只做最终同步的实现必须是 `cluster` + `eventual`，
并且**因此**不能做 CAS（见下一节）。

---

## 8. 跨进程实现

上面每一节都还在一个进程里。跨过去之后有几件事会变，而且是**静默地**变 ——
这是本仓库里第二个 Transport（`@eapp/transport-socket`）存在的原因。

```bash
pnpm run example:cross-process
```

它拉起三个真进程（`examples/cross-process/`）：一个 broker 进程持有日志，
两个 worker 进程各自跑一个完整运行时。四条设计结论：

**① 位置必须由一方独占分配。** 两个进程各自发号，得到的不是 cursor，是巧合：
两边都会发出"位置 5"，而 `readAfter` 会因此返回无意义的结果。
broker 独占分配，其余进程问它要位置。这也是客户端必须**采用** broker 的 id 的原因 ——
cursor 带着它作前缀，`compareRevision` 才可能在近端同步完成。

**② Channel 的 id 必须靠推导，不能靠计数。** Channel 的 id 就是消息存放的 key，
所以共享一本日志的两个进程必须算出同一个字符串。计数器做不到：每个进程的第一个
Channel 都会叫 `ch-1`，于是它们各自读着自己那本日志，还都以为在用同一个名字。
`EappRuntime` 因此接受一个 `channelId` 回调，它的入参里有 Binding ——
`from` / `to` / capability 是唯一被所有参与者共享的东西，而"Channel 由 Binding 派生"
本来就是这个意思。

**③ 原子性只能在数据所在的地方完成。** 跨进程的 CAS 不可能靠"两边各读一次再比一下"：
那是 TOCTOU，而且跨越网络之后窗口大得多。broker 持有状态，检查与写入之间没有 `await`，
所以 `setStateWithCAS` 仍然是原子的。示例里两个 worker 同时 read-modify-write 同一个
key，拿 `EAPP_REVISION_CONFLICT` 的一方重读再写 —— 计数器最终与期望值一致，没有丢更新。

**④ 所有权状态必须和它保护的数据待在一起。** 这是最容易漏掉的一条。
`ConsumerGroup` 的认领表原本是进程内内存，于是两个进程会各自以为持有同一个位置，
同一条消息被处理两次，**而没有任何报错** —— 因为消息已经跨过去了，而"谁持有它"
没有。§8.3 说"一次 claim 就是一次 Lease"，Lease 要有意义就必须和消息处在同一个
所有权域里。

所以 Transport 可以额外地提供共享的组状态：

```typescript
// 可选的 Transport 扩展，不属于冻结的 v3.1 §10 接口
readonly sharesGroupState: true;
groupStore(context: {
  channel: string; name: string; claimTtlMs: number; initialCursor: Cursor;
}): GroupStore;
```

Interaction Layer 在存在时使用它。**不提供的时候它不会退回到本地认领表** ——
那正是静默降级的形状：`durabilityBoundary` 比进程宽、却又没有共享组状态时，
`openConsumerGroup()` 直接抛 `EAPP_UNSUPPORTED`。

这条规则值得记成一句话：**每个"谁拥有什么"的判断，都必须只有一个做判断的地方，
而那个地方必须在数据的同一侧。** 位置分配、Channel 命名、原子性、认领表 ——
四个都是这个形状，漏掉任何一个，错误都是安静的。

**⑤ 同一个形状还有第五处：谁应答。** request 模式假设恰好一个进程服务一个 Channel。
两个进程都跑 dispatcher 时，两边都会执行 handler；重复的那条回复被 correlation
tracker 当作重复响应丢掉，于是**调用方看到一个完全正常的回答，而副作用发生了两次**。

所以还有第二组可选成员：

```typescript
readonly sharesServerRole: true;
claimServerRole(channel: string): Promise<boolean>;   // 已被别人持有则 false
releaseServerRole(channel: string): Promise<void>;
```

角色由**连接**持有 —— 服务方进程消失时自动归还，不需要任何人注意到。
抢不到的一方由 `runtime.serve()` 报错，而不是悄悄少服务一半请求。

---

## 9. 修订顺序不是全序时：`supportsStateRevision: false`

这是全页最容易踩、后果最严重的一条：

```
TS-4  A Transport whose revision ordering is not total per channel MUST declare
      supportsStateRevision = false, MUST declare stateConsistency = 'eventual',
      and MUST NOT claim CAS support.

supportsStateRevision === true  ⟺  Revision 在 Channel 内构成全序且单调（REV-1/2/3/4/8 成立）
supportsStateRevision === false ⟹  MUST NOT 用于 CAS
```

规范明确取消了"最终一致 + CAS"的豁免（v3.2 §12.3）：

> r2 给 CRDT 加了 `⚠️` 豁免，允许"eventual 的 revision + CAS"共存 ——
> 那等于允许一个会**静默丢更新**的 CAS。

所以一个 CRDT 形态的存储必须这样声明：

```typescript
supportsState: true,
supportsStateRevision: false,   // ← 非全序
stateConsistency: 'eventual',
supportsStateSnapshot: false,   // ← restore 依赖 nextRevision，所以快照也不可用
```

后果是**被强制**的，而且是好事：

- `set` / `delete` / `restore` 抛 `EAPP_STATE_UNSUPPORTED` —— 明确失败，不是静默丢更新；
- `get` / `list` / `watch` 仍然可用 —— 只读的最终一致视图是合法的。

`supportsStateSnapshot: false` 不是可选项：`restore` 的实现路径经过
`nextRevision` 与 `writeStateWithRevision`，而它们在非全序实现上无法给出正确语义
（能力矩阵里 CRDT 行的 `revision` 与 `snapshot` 都是 ❌）。

---

## 10. 合规性检查清单

### 9.1 先跑仓库自带的两道闸门

```bash
pnpm run typecheck        # 实现必须满足 Transport / StateTransport 接口
pnpm run test             # 一致性套件（参考实现的不变量覆盖）
pnpm run check:invariants # 冻结闸门：每条不变量至少对应一个测试（判定对象为参考实现）
```

### 9.2 针对本实现逐项验证

下面每一条都对应一个真实的失败模式。把它们写成 `vitest` 用例，
断言 `cursor` 与 `revision` 的**可比较性**，不要断言字面值 —— 位置会变，性质不会。

**位置与顺序**

- [ ] 连续 `send` 两个值，第二个 `compareCursor(a, b) < 0` 成立；连续几百次仍然成立。
- [ ] cursor 的形状**不是** `'1'`, `'2'`, `'10'` 这种形状：把 1..12 的 cursor 排序，
     结果必须是数值序（§4.3 的反例）。
- [ ] `readAfter(ch, undefined, {all:true})` 返回从最早已保留位置开始的全部消息（TR-6）。
- [ ] `readAfter(ch, c, {all:true})` 严格排除 `c` 本身（TR-5）。
- [ ] 没有新消息时 `readAfter` **立刻**返回 `[]`，不阻塞（TR-7）。用一个已知超时的
      `Promise.race` 断言它。
- [ ] `pattern` 过滤正确：`{type:'a'}` 不返回 `{type:'b'}`，且两种之外的形状抛 `EAPP_CHANNEL_INVALID`。

**锚点**

- [ ] `resolveAnchor(ch, 'earliest')` 在空 Channel 上也有返回值，不抛异常。
- [ ] `resolveAnchor(ch, 'latest')` 在**只有消息**（没有状态写入）的 Channel 上返回
      最后一条消息的位置 —— 只跟踪状态 revision 的实现会在这里给出错误答案。
- [ ] 未实现 `resolveAnchor` 时，订阅仍然可以用 `''` 起步（退化为从头读）。

**状态与 CAS**

- [ ] `head(ch)` 在空 Channel 上返回可比较的初始值，且 `compareRevision(head, 任何已分配值) < 0`（TS-14）。
- [ ] `set` 用 `expectedRevision: null` 只能创建**从未存在**的 key：逻辑删除过的 key
      仍然算存在，不能被 `null` 复活（那会绕过 CAS）。
- [ ] 两个并发 `set` 拿同一个 token：恰好一个成功，另一个 `EAPP_REVISION_CONFLICT`（TS-6）。
- [ ] `compareRevision` 对**另一个实例**签发的 revision 抛 `EAPP_REVISION_INVALID`（REV-8）。
- [ ] `readChangesAfter` 返回的是**变更流**：同一个 key 连写两次，两次都在（TS-9/TS-10）。
- [ ] `delete` 一个从未存在的 key 抛 `EAPP_STATE_KEY_NOT_FOUND`；删除已删除的 key 是 no-op，
      **不分配**新位置（DEL-4 / DEL-5）。
- [ ] `writeStateWithRevision` 收到 `<= head` 的位置抛 `EAPP_REVISION_INVALID`。

**能力声明**

- [ ] 声明 `supportsCursor: false` 时，需要 cursor 的路径明确失败（CR-5）。
      `assertCapability(transport, 'cursor')` 会抛 `EAPP_CURSOR_UNSUPPORTED`、
      `assertCapability(transport, 'lease')` 会抛 `EAPP_UNSUPPORTED`；
      这两个检查是**导出给调用方使用的**，参考实现内部没有自动调用点 ——
      须在实现自身的调用路径上主动调用，否则 `supportsCursor: false` 只是一句没人读的声明。
- [ ] `assertDeclared(transport)` 在本实现上通过（`persistent` 是 boolean、`ordering` 是 string）。
- [ ] 声明 `supportsStateRevision: false` 时，`set`/`delete` 抛 `EAPP_STATE_UNSUPPORTED`，
      而 `get`/`list` **仍然工作**（TS-2）。这一条由 `assertStateCapability` 自动执行。
- [ ] 声明 `supportsStateWatch: false` 时，`watch()` 抛 `EAPP_WATCH_UNSUPPORTED`。
- [ ] `stateConsistency` 没有超出 `durabilityBoundary`（TS-5）。
- [ ] `close()` 之后的写入明确失败，而不是静默成功。

### 9.3 把仓库的一致性套件当作规范用

一致性套件是**对参考实现**的不变量覆盖（209 条不变量 = 51 + 74 + 84，见
[一致性报告](../CONFORMANCE.md)）。`tests/conformance/*.test.ts` 里**大多数**测试的名字
带着它检验的不变量 ID —— 覆盖清单是逐条对照的依据。
但并非每条测试都带 ID：有些测的是规范的形状（例如 `§2.2: ChannelRef carries only id and binding`），
它们的价值同样成立，只是不对应某一条编号。移植这些用例时：

- 保持 ID 与断言的**性质**，不要复制参考实现的位置字面量。D-20 明确要求：
  冲突用例 MUST 用 `nextRevision()` 索取一个必然不匹配的 revision，
  `compareRevision` 用例 MUST 使用 Transport 真实产出的 revision ——
  否则等于把内存实现的格式冻结成跨 Transport 契约，任何非内存实现都无法通过。
- Revision 对消费者是 opaque 的（REV-5）：断言"顺序关系"，不要断言字符串形状。
- 用 `pnpm run check:invariants` 的输出核对：若某个不变量无法覆盖，
  则说明能力声明有误 —— 应关闭对应的能力标志，而非修改测试。

---

## 相关

- [概念：三层心智模型](./concepts.md) —— 特别是 §2（层与层的方向）与 §7（什么不属于 Core）
- [写一个插件](./write-a-plugin.md) —— 上层所见的接口
- [快速上手](./getting-started.md) —— 参考 Transport 的实际输出
- [用另一种语言实现 EaPP](./implement-in-another-language.md) —— 以其他语言实现本层与上层
- [`Transport`](../reference/transport.md) · [`Cursor`](../reference/cursor.md) ·
  [`Channel`](../reference/channel.md) · [`Delivery`](../reference/delivery.md) ·
  [`Lease`](../reference/lease.md) · [`ConsumerGroup`](../reference/consumer-group.md) ·
  [`Revision`](../reference/revision.md) · [`StateCell`](../reference/state-cell.md) ·
  [`StateUpdate`](../reference/state-update.md) · [`StateWatcher`](../reference/state-watcher.md)
- [v3.1.0-interaction §10](../spec/v3.1.0-interaction.md) · [v3.2.0-state §11–§12](../spec/v3.2.0-state.md)
- [一致性报告](../CONFORMANCE.md) —— 声明了什么、没声明什么

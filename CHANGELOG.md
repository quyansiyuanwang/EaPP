# 变更记录

本文件记录**实现与文档**的变更。规范正文的修订（勘误、新增不变量、跨层映射）记在
[`docs/spec/CHANGELOG.md`](docs/spec/CHANGELOG.md)。

格式遵循 [Keep a Changelog](https://keepachangelog.com/)；版本号遵循 [SemVer](https://semver.org/)。

---

## 未发布

### 规范

| 部分 | 变更 |
|---|---|
| v3.0.0-core | 新增 **C-7**：`Constraint` 的匹配语义定义为精确匹配（勘误 E-I）。§19.3 的 `ConformanceClaim` 接口修正为可表达 v3.1 / v3.2 的版本与等级（E-J） |
| v3.1.0-interaction | 恢复 §2.4 的 Channel↔Binding 状态同步表（E-A）；补全 §2.2 的 `DRAINING → ACTIVE`（E-B）；新增 §6.4 推进规则，收拢此前只存在于勘误表中的 MUST（E-H 相关） |
| v3.2.0-state | 补入 §5.4 `SU-4`、§10.5 冲突策略、§15.1 层级隔离（E-G） |

`E1-10` 更名为 `TR-9`。该标识符形状类似勘误编号，使其落在不变量汇总声明的
`TR-1..TR-8` 区间之外，因而从未被冻结闸门统计，也从未被测试覆盖。

### 新增

- `@eapp/transport-socket` —— 跨进程 Transport：broker 进程持有日志，其余进程通过 TCP
  取得 `SocketTransport`。`durabilityBoundary` 声明为 `'machine'`。
- `implementations/go/` —— Composition Core 的独立实现，仅依赖标准库，
  由未参考 TypeScript 实现的开发者依规范正文编写。
- `conformance/` —— 语言中立的 driver 协议与黑盒一致性 harness。
  harness 不引用任何 `@eapp/*`，因此可用于任意实现。
- `examples/cross-process/` —— 五个进程的端到端示例：broker、两个 worker、
  一个 provider、一个调用方。
- `examples/` 增至五个，各自在结尾校验结论，并接入 `pnpm run verify`。
- `tools/check-docs.mjs` 增加正文语域检查（`docs/STYLE.md` §5）。

### 修复

- **`Discovery.watch()` 从不产生事件。** 事件队列、作用域过滤与类型校验均已实现，
  但唯一的事件生产者从未被调用。现已由注册表变更驱动。
- **`shutdown()` 在 handler 运行中崩溃进程。** 迟到的响应被写入已关闭的 transport，
  异常从分离的循环中逃逸为未处理的 rejection。
- **`EappRuntime` 无 ConsumerGroup 入口。** 指南要求插件作者以 ConsumerGroup 表达排他性，
  而门面未提供该操作。
- **`runtime.invoke()` 的 `from` / `to` 方向在指南中写反。** `connect` 的 `from` 是提供方，
  `invoke` 的 `from` 是调用方。
- **跨进程竞争消费静默失效。** 认领表位于进程内内存，两个进程会各自认为自己持有同一位置。
  现由可注入的 `GroupStore` 承载，broker 版本共享之。
- **跨进程请求分发不可达。** 调用方的 dispatcher 会替不属于自己的 provider 应答
  `EAPP_CAPABILITY_NOT_EXPOSED`，与真正的响应竞争。现区分「可寻址」与「本进程执行」。
- **`Criteria.version` 按精确值匹配。** §8.1 声明其为 SemVer range，
  `find({version: '^1.0.0'})` 此前静默返回空集。
- **`EappRuntimeOptions.transport` 声明为具体类。** 自定义 Transport 无法在不强转的情况下传入。

### 一致性

```
v3.0.0-core          51 / 51 不变量
v3.1.0-interaction   75 / 75 不变量
v3.2.0-state         84 / 84 不变量
                     ─────────────
                     210 / 210
```

冻结闸门 PASS。跨实现一致性：33 项检查 × 2 份独立实现，全部通过。
声明与覆盖范围见 [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md)。

---

## [3.2.0-r3] — FROZEN

标签 `v3.2.0`。首次将三份规范、参考实现与一致性套件对齐到同一状态。

### 规范

- **v3.0.0-core** —— 冻结。
- **v3.1.0-interaction** —— 冻结。定义 Channel / Subscription / ConsumerGroup /
  Delivery / Lease / Cursor / Transport，并补齐四种交互模式的消息信封。
- **v3.2.0-state** —— 冻结。定义 StateCell / Revision / StateUpdate / StateWatcher /
  CAS 冲突策略 / Snapshot。

修订的完整记录见 [`docs/spec/CHANGELOG.md`](docs/spec/CHANGELOG.md)，
每条裁定的依据见 [`docs/analysis/DECISIONS-v3.2.0-r3.md`](docs/analysis/DECISIONS-v3.2.0-r3.md)。

### 新增

- `@eapp/core` —— Identity / Capability / Plugin / Binding / Lifecycle / Discovery / CompositionCore
- `@eapp/interaction` —— Channel / Subscription / ConsumerGroup / Delivery / Lease / Cursor /
  AckContext / Transport / 模式消息
- `@eapp/state` —— StateCell / Revision / StateUpdate / StateWatcher / StateChannel / StateTransport
- `@eapp/transport-memory` —— 参考 Transport，同时实现 v3.1 与 v3.2 接口
- `@eapp/runtime` —— Bootstrap 与五个操作的门面
- `tools/check-invariants.mjs` —— 冻结闸门（v3.0 §19.2）
- `examples/hello-plugins` —— 端到端示例

### 修复

实现过程中由测试发现的缺陷：

- **订阅循环先读后等** —— 写入落在「读」与「等」之间时丢失唤醒，观察者永久挂起。
- **重投递时关闭消费者持有的 ack 上下文** —— 消费者的 `ack()` 成为静默 no-op，位置永不前进。
- **无界忙轮询** —— 未 ack 的项被反复重投，导致堆溢出。现按 `pollIntervalMs` 节流。
- **并发 `invoke` 未去重** —— 同一 Binding 派生出多个 Channel，除一个外全部超时。
- **`resolveAnchor('latest')` 只跟踪状态位置** —— 流订阅者取得的是状态位置而非消息位置。
- **Binding 进入 DORMANT 时 Channel 保持 ACTIVE** —— 违反 v3.1 §2.4。

### 一致性

```
v3.0.0-core          51 / 51 不变量
v3.1.0-interaction   74 / 74 不变量
v3.2.0-state         84 / 84 不变量
```

### 已登记的偏离

四项，修正的对象是规范自身的矛盾，正文已同步。见 [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) §5。

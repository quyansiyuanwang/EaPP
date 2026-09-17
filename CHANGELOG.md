# 变更记录

本文件记录**实现与文档**的变更。
规范正文的修订（勘误、新不变量、跨层映射）记在 [`docs/spec/CHANGELOG.md`](docs/spec/CHANGELOG.md)。

格式遵循 [Keep a Changelog](https://keepachangelog.com/)；版本号遵循 [SemVer](https://semver.org/)。

---

## [3.2.0-r3] — FROZEN

标签 `v3.2.0`。首次把三份规范、参考实现与一致性套件对齐到同一状态。

### 规范

- **v3.0.0-core** —— 未作任何修改（逐字副本）。
- **v3.1.0-interaction** —— 由草案冻结；9 条勘误 + 新增 `Subscription` /
  `ConsumerGroup` / 模式消息信封。
- **v3.2.0-state** —— r2 → r3；关闭 40 条内部缺陷与 12 处跨文档冲突。

详见 [`docs/spec/CHANGELOG.md`](docs/spec/CHANGELOG.md) 与
[`DECISIONS-v3.2.0-r3.md`](docs/spec/DECISIONS-v3.2.0-r3.md)。

### 新增

- `@eapp/core` —— Identity / Capability / Plugin / Binding / Lifecycle / Discovery / CompositionCore
- `@eapp/interaction` —— Channel / Subscription / ConsumerGroup / Delivery / Lease / Cursor /
  AckContext / Transport / 模式消息
- `@eapp/state` —— StateCell / Revision / StateUpdate / StateWatcher / StateChannel /
  StateTransport
- `@eapp/transport-memory` —— 参考 Transport，同时实现 v3.1 与 v3.2 接口
- `@eapp/runtime` —— Bootstrap 与五个动作的门面
- `tools/check-invariants.mjs` —— 冻结闸门（v3.0 §19.2）
- `examples/hello-plugins` —— 端到端演示

### 修复（实现过程中由测试发现的真实缺陷）

- **订阅循环先读后等** —— 写入落在"读"与"等"之间时丢失唤醒，观察者永久挂起。
  现在先注册兴趣再读取。
- **重投递时关闭消费者持有的 ack 上下文** —— 消费者的 `ack()` 变成静默 no-op，位置永不前进。
  现在按 revision 复用上下文。
- **无界忙轮询** —— 未 ack 的项被无限重投，堆溢出崩溃。现在按 `pollIntervalMs` 节流。
- **并发 `invoke` 未去重** —— 同一 Binding 派生出多个 Channel，除一个外全部挂到超时。
  现在按 `(binding, mode)` 去重，dispatcher 按 channel 索引。
- **`resolveAnchor('latest')` 只跟踪状态 revision** —— 流订阅者拿到的是状态位置而非消息位置。
- **Binding 进入 DORMANT 时 Channel 保持 ACTIVE** —— 违反 v3.1 §8.2，运行中的 Channel 不会 DRAINING。

### 一致性

```
v3.0.0-core          50 / 50 不变量
v3.1.0-interaction   74 / 74 不变量
v3.2.0-state         84 / 84 不变量
```

冻结闸门 PASS；无空测试体。声明见 [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md)。

### 已登记的偏离

4 条，全部修正了规范草案自身，规范正文已同步。
见 [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) §5。

---

## 更早

`3.2.0-r2` 与之前只有设计文档，位于 `9b78d40` 提交中的草案目录，没有可运行实现。
它们**不是**本仓库的发布版本，只作为溯源保留。

- `git show "9b78d40:tmp/draft/EaPP v3.0.0 Composition Core.md"`（草案原文）
- `git show "9b78d40:tmp/draft/EaPP v3.1.0 Interaction Layer.md"`（草案原文）
- `git show "9b78d40:tmp/draft/EaPP v3.2.0 State Mode — Freeze Candidate r2.md"`（草案原文）

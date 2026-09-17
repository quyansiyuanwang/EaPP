# StateChannel

它是 State Mode 的操作面——`mode` 为 `'state'` 的收窄视图。

| | |
|---|---|
| **层** | State Mode |
| **规范** | `§44`、`§32`、`§48.1` |
| **不变量** | `API-1…API-9`、`CF-1…CF-5` |
| **稳定度** | FROZEN |

## 语义

`StateChannel` 在 [`Channel`](./channel.md) 之上增加状态操作：`get`、`list`、`set`、`delete`、`watch`、`snapshot`、`restore`（`§44.2`）。

它是 Channel 的**收窄视图**，MUST NOT 是包装类型（`IX-6`、`CF-5`）：`id` / `binding` / `delivery` / `state` 直接来自被收窄的 Channel，因此 Binding 派生为 DORMANT 时的 `DRAINING` 对状态层的持有者依然可见（`§48.1`）。

创建是三段式路径（`§44.1`）：`bind()` 得到 [`Binding`](./binding.md)，`createChannel({ binding, mode: 'state', delivery: 'at-least-once' })` 得到 Channel，`configure(channel, { conflictPolicy: 'cas', owner })` 得到 StateChannel。`configure` MUST 逐项校验，`mode` 不是 `'state'`、`delivery` 不是 `at-least-once`、Transport 不支持状态、`conflictPolicy` 不是 `'cas'`、`owner` 不是已注册身份时各自返回对应的错误码（`§44.1`）。

冲突策略只有 CAS（`CF-1`），失败 MUST 返回 `EAPP_REVISION_CONFLICT`（`CF-2`），其余策略 MUST 在 Extension 中定义（`CF-3`），且策略在配置时固定、之后 MUST NOT 改变（`CF-4`）。

返回值是确定的：`get` 返回 cell 或 null（仅当键从未存在）、`list` 按键字典序稳定排序并含已删除 cell、`set` 返回新 revision、`delete` 返回操作后该键的当前 revision、`watch` 在返回前完成解析（`§44.3`、`API-1…API-5`）。

`restore` MUST 覆盖 `snapshot.pattern` 覆盖的状态（`API-8`），其语义见 [`StateSnapshot`](./state-snapshot.md)。

## 常见误用

- "把 StateChannel 实现为包装类型"：`CF-5` 规定 StateChannel MUST extend Channel，MUST NOT be a wrapper type；`§48.1` 说明否则 Channel 的生命周期变化会被一层拷贝遮住。
- "选择 CAS 之外的冲突策略"：`CF-1` 规定 Core MUST only support the CAS conflict policy，`CF-3` 规定其余策略 MUST 在 Extension 中定义。
- "配置之后更换冲突策略"：`CF-4` 规定策略 MUST 在 Channel 配置时固定，之后 MUST NOT 改变。
- "在裸 Channel 上调用 `set` 或 `watch`"：`IX-3` 规定 State Mode MUST NOT 向 Channel 引入新原语，这些是 StateChannel 视图上的方法（`§48.1`）。

## 相关

- [`Channel`](./channel.md) —— 被收窄的视图基底（`IX-6`、`CF-5`）
- [`StateUpdate`](./state-update.md) —— `set` / `delete` 的请求与 CAS 语义（`§39`）
- [`StateWatcher`](./state-watcher.md) —— `watch()` 返回的观察者（`API-5`）
- [`StateSnapshot`](./state-snapshot.md) —— `snapshot` / `restore` 的形状（`§43`）
- [`StateTransport`](./state-transport.md) —— 承载状态操作的 Transport（`TS-7`）
- [规范 §44](../spec/eapp.md) —— StateChannel 的创建、接口与不变量

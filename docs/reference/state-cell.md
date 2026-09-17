# StateCell

它是共享状态的最小单元——一个键在某一位置的取值。

| | |
|---|---|
| **层** | State Mode |
| **规范** | `§38` |
| **不变量** | `SC-1…SC-6` |
| **稳定度** | FROZEN |

## 语义

`StateCell` 是一个键在某一位置的取值，由键、[`Revision`](./revision.md)、值、逻辑删除标记、写入时间与写入者构成（`§38`）。`updatedBy` MUST 是已存在的 [`Identity`](./identity.md)（`SC-5`）。

键 MUST 非空（`SC-1`）。revision 在 Channel 内单调递增（`SC-2`）；逻辑删除 MUST 保留 revision，MUST NOT 重置计数器（`SC-3`），因此删除不回收位置，[`StateUpdate`](./state-update.md) 的 CAS 仍能看见它。

值的可序列化约束只适用于未删除的 cell（`SC-4`）；`deleted` 为真时 `value` MUST 为 undefined（`§38`）。

可见性被冻结在 `SC-6`：`get` / `list` MUST 返回已逻辑删除的 cell（`deleted === true`），MUST NOT 因 `deleted` 而返回 null；只有当 key 从未存在时 `get` 才返回 null。理由是删除的 no-op 分支与复活都需要调用方拿出已删除 cell 的 revision（`§38.2`、`DEL-5`、`DEL-6`）。

## 常见误用

- "让 `get`/`list` 跳过或屏蔽已逻辑删除的 cell"：`SC-6` 规定二者 MUST 返回已逻辑删除的 cell，MUST NOT 因 `deleted` 返回 null。
- "把已删除读成 null，再用 null 表示不存在"：只有 key 从未存在时 `get` 才返回 null（`SC-6`），`§38.2` 说明否则删除的 no-op 分支不可达。
- "把 `updatedBy` 当作任意字符串"：`SC-5` 规定它 MUST 是已存在的 Identity。
- "用逻辑删除重置 revision 计数器"：`SC-3` 规定 `deleted = true` MUST 保留 revision。

## 相关

- [`Revision`](./revision.md) —— cell 上承载的位置（`SC-2`）
- [`StateUpdate`](./state-update.md) —— 写入 cell 的请求形状（`§39`）
- [`StateChannel`](./state-channel.md) —— `get` / `list` 的落点（`API-1`、`API-2`）
- [`StateWatcher`](./state-watcher.md) —— 删除变更同样被观察（`DEL-3`）
- [规范 §38](../spec/eapp.md) —— StateCell 的字段、可见性与不变量

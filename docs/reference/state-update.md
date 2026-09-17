# StateUpdate

它是"写哪个键、写什么、以哪个版本为前提"的一次变更请求。

| | |
|---|---|
| **层** | State Mode |
| **规范** | `§39`、`§40` |
| **不变量** | `SU-1…SU-9`、`DEL-1…DEL-6` |
| **稳定度** | FROZEN |

## 语义

`StateUpdate` 由键、值、逻辑删除标记、`expectedRevision` 与可选的 `actor` 构成（`§39.1`）。

字段校验是确定的：MUST 指定 `key`（`SU-1`）；MUST 有 `value` 属性或 `deleted = true`（`SU-2`）；`value` 的存在性 MUST 按属性存在判定，MUST NOT 用 `value !== undefined` 判定，因此 `{ value: undefined }` 是合法写入（`SU-2`）；MUST NOT 同时携带 `value` 与 `deleted = true`（`SU-3`）；`deleted` 出现时 MUST 为 true（`SU-9`）。

CAS 的前提只有两种取值（`SU-8`）：`null` 表示 key MUST NOT 曾经存在，`Revision` 表示 key MUST 存在且其 revision 精确匹配（`§39.1`）。比较与写入 MUST 在 Transport 内原子完成（`SU-7`）；失败 MUST 返回 `EAPP_REVISION_CONFLICT`（`SU-4`）且 MUST NOT 修改任何状态（`SU-5`）。

Core MUST NOT 对外暴露无条件写入（`SU-6`）；钉定 revision 的内部原语 MUST NOT 从公开 API 可达，唯一例外是 `restore()`（`SU-6`、`SNAP-7`）。

删除是一等原语，MUST 由 Transport 实现，MUST NOT 被实现为 `set({ deleted: true })` 的语法糖（`§40.1`）。删除同样执行 CAS（`DEL-1`），成功时产生 `type='deleted'` 的变更（`DEL-2`）。删除一个已删除且 revision 匹配的 key 是 no-op 成功（`DEL-5`）：MUST NOT 分配新 revision、MUST NOT 产生变更、MUST NOT 通知 [`StateWatcher`](./state-watcher.md)（`§40.3`）。

## 常见误用

- "用 `''` / `'0'` / `-1` 表示不存在"：`§39.2` 规定 `null` 是唯一表示"不存在"的方式，MUST NOT 使用其余形式。
- "用 `expectedRevision: null` 复活一个已逻辑删除的键"：`§39.2` 规定 `null` 表示从未存在，复活须携带旧 revision。
- "把 `delete` 实现为 `set({ deleted: true })` 的语法糖"：`§40.1` 明确禁止，理由是那样 `EAPP_STATE_KEY_NOT_FOUND` 结构上不可产生。
- "用 `value !== undefined` 判定存在的属性"：`SU-2` 规定存在性 MUST 按属性存在判定。

## 相关

- [`StateChannel`](./state-channel.md) —— `set` / `delete` 的落点与返回值（`API-3`、`API-4`）
- [`Revision`](./revision.md) —— `expectedRevision` 的类型（`SU-8`）
- [`StateCell`](./state-cell.md) —— 被写入的单元与删除后的可见性（`SC-3`、`SC-6`）
- [`StateWatcher`](./state-watcher.md) —— 删除变更必须被观察（`DEL-3`）
- [`StateSnapshot`](./state-snapshot.md) —— 无钉定写入的唯一公开路径（`SNAP-7`）
- [规范 §39](../spec/eapp.md) 与 [规范 §40](../spec/eapp.md) —— CAS 与删除语义

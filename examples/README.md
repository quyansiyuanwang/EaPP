# 示例

五个可运行的示例。它们**不是**讲解用的伪代码：每个文件都自己核对结论，
断言失败就以非 0 退出，所以它们同时是文档的测试。

```bash
pnpm run examples           # 五个全跑（pnpm run verify 会跑这一步）
pnpm run demo               # 只跑 hello-plugins
pnpm run example:first      # 只跑 my-first-plugin
pnpm run example:queue      # 只跑 job-queue
pnpm run example:transport  # 只跑 array-transport
pnpm run example:cross-process  # 只跑 cross-process（会拉起 3 个子进程）
```

| 示例 | 在哪里被引用 | 覆盖什么 |
|---|---|---|
| [`hello-plugins/`](./hello-plugins/index.ts) | [快速上手](../docs/guides/getting-started.md) §4 | 三层全貌：发现 → 连接 → 激活 → 调用 → 事件订阅 → 共享状态 → 生命周期联动 |
| [`my-first-plugin/`](./my-first-plugin/index.ts) | [写一个插件](../docs/guides/write-a-plugin.md) §2 | request 模式一条线走到底：身份从哪来、能力版本算不算身份、错误码怎么浮现 |
| [`job-queue/`](./job-queue/index.ts) | [写一个插件](../docs/guides/write-a-plugin.md) §8.1 | Interaction Layer 难的那一半：竞争消费、nack 重投、成员离开、多组共存、DRAINING |
| [`array-transport/`](./array-transport/index.ts) | [实现一个 Transport](../docs/guides/write-a-transport.md) §6 | 替换最下面一层：Transport 契约、位置分配、CAS 的原子性、把自定义 Transport 交给运行时 |
| [`cross-process/`](./cross-process/index.ts) | [实现一个 Transport](../docs/guides/write-a-transport.md) §7.1 | 真的跨进程：broker 进程 + 两个 worker 进程共享一本日志、跨进程 CAS、以及**跨不过去的那一半** |

## 为什么示例要自检

一个只打印日志的示例坏掉时是**静默**的：版本变了、字段改名了、默认值改了，
它照跑不误，只是输出悄悄不一样了 —— 而文档里引用的那段输出就成了假的。

所以每个示例结尾都有一组断言，核对的是**看不见的东西**：返回值、派生状态、错误码。
`console.log` 出来的那部分肉眼可见，断言的是那些看不见的部分。

```
check('两端 ACTIVE 后 Binding 派生为 ACTIVE', runtime.core.bindingState(binding.id) === 'ACTIVE');
```

## 示例的写法

- **相对路径导入。** 仓库根没有链接 `@eapp/*` 的 `node_modules` 入口，所以 `tsx` 下
  用 `../../packages/runtime/src/index.js`。`@eapp/...` 形式只在 `tsc` 与 `vitest` 中
  经 `paths` / alias 可解析。
- **不假装规范里没有的能力。** [CONFORMANCE](../docs/CONFORMANCE.md) §6 列为未实现的
  东西（跨进程 Transport、CRDT、Trust Domain 授权），示例里也不会出现。
- **插件之间零 import。** 这是整个项目的主张，示例必须自己遵守：
  没有一个插件 import 另一个插件，它们之间只有运行时。
- **说清楚不确定的地方。** `job-queue/` 明确写出 CG-3 不保证公平分配 ——
  示例不是宣传材料。

# EaPP

**Everything as a Plugin Protocol** — 万物皆插件协议

> **EaPP 是一套三层插件协议**：Composition Core 定义谁和谁组合，Interaction Layer 定义组合后如何互动，
> State Mode 定义如何共享状态。三层单向依赖，每层可独立替换。
> 任何语言、任何运行时、任何传输，只要实现这些语义，就能互通。
>
> **EaPP 的交付物是规范性文本。** 它规定语义，不规定实现。本仓库中的代码是规范的两份独立
> 实现，用于验证规范本身是否足以写出实现；合规性是实现的行为属性，与是否使用本仓库的代码无关。

---

## 1. 协议规定的操作面

实现方按规范实现下列五个操作，插件作者的全部组合工作由此完成：

| 操作 | 语义 | 规范出处 |
|---|---|---|
| 发现 | 按能力、版本、约束检索可组合的插件 | v3.0 §8 |
| 连接 | 在两个插件之间建立 Binding，并由该 Binding 派生 Channel | v3.0 §9 · v3.1 §12 |
| 激活 | 将插件置入或移出 Active Composition | v3.0 §7 |
| 通信 | 在 Channel 上以 request / event / stream / state 四种模式交互 | v3.1 §3 |
| 调用 | 请求-应答，携带关联标识与截止时间 | v3.1 §3 · §9 |

插件之间的依赖仅经由上述操作。协议不要求插件具有统一的实现形态：进程内模块、
独立进程、worker、远程服务、设备，均为合法的 Plugin（v3.0 §5.2）。

参考实现将这五个操作封装为 [`@eapp/runtime`](packages/runtime/src/runtime.ts)。
该包不定义语义，其每个操作均可追溯到 v3.0 / v3.1 / v3.2 中的条款。

---

## 2. 三层

```
Composition Core   (v3.0)   谁和谁组合          Identity · Capability · Plugin · Binding · Lifecycle · Discovery
        │  单向依赖
        ▼
Interaction Layer  (v3.1)   组合后如何互动      Channel · Subscription · ConsumerGroup · Delivery · Lease · Cursor
        │
        ▼
State Mode         (v3.2)   如何共享状态        StateCell · Revision · StateUpdate · StateWatcher · CAS
        │
        ▼
Transport                   消息如何传输         Memory（进程内） · Socket（跨进程）
```

层的文件名是**冻结标识符**，不是协议版本。协议版本是 `eappVersion` 报告的那个号，
当前为 `3.3.0`；各层独立冻结，冻结文本一经发布不兼容变更须进入 4.0（v3.0 §18）。

---

## 3. 实现状态

| 层 | 规范 | TypeScript 参考实现 | Go 独立实现 |
|---|---|---|---|
| v3.0.0-core | FROZEN | 完整 | 完整 |
| v3.1.0-interaction | FROZEN | 完整 | 未实现 |
| v3.2.0-state | FROZEN | 完整 | 未实现 |

```
不变量           210 / 210         冻结闸门 PASS
一致性测试        200 passed
跨实现一致性      33 项检查 × 2 份实现
示例             5 个，均自检
```

---

## 4. 文档

按阅读目的索引：

| 目的 | 文档 |
|---|---|
| 理解协议结构 | [概念：三层心智模型](docs/guides/concepts.md) |
| 运行参考实现 | [快速上手](docs/guides/getting-started.md) |
| 编写插件 | [编写插件](docs/guides/write-a-plugin.md) |
| 实现 Transport | [实现 Transport](docs/guides/write-a-transport.md) |
| 以其他语言实现协议 | [跨语言实现](docs/guides/implement-in-another-language.md) |
| 验证一个实现 | [一致性 harness](conformance/README.md) |
| 查阅实体语义 | [参考索引](docs/README.md#参考) |
| 阅读规范性文本 | [规范](docs/spec/v3.0.0-core.md) |
| 查阅合规范围 | [一致性报告](docs/CONFORMANCE.md) |

`docs/spec/` 为规范性文本，是唯一裁决者。参考页与指南均为其解释，
与规范冲突时以规范为准。

---

## 5. 如何验证一个实现

三道闸门，分别对应三个不同的问题。

**规范声明的不变量是否都有测试。** v3.0 §19.2 要求每条不变量至少对应一个测试用例。

```bash
pnpm run check:invariants
```

该命令从各规范的「不变量（冻结全集）」小节提取标识符，与一致性测试中出现的标识符
求集合差；差集非空、存在空测试体、或存在仅在汇总表中列出而正文未陈述的标识符，均判定失败。

**文档的交叉引用是否有效。**

```bash
pnpm run check:docs
```

**实现的行为是否符合协议。** 前两道闸门检查本仓库内部；第三道将实现视为黑盒：

```bash
pnpm run conformance:external
```

该命令按 [driver 协议](conformance/driver.md) 启动一个可执行文件，仅依据其 JSON 响应判定。
harness 不引用任何 `@eapp/*`，因此其检查对象是协议的表面行为，而非参考实现的内部结构。
仓库内两份互相独立的实现均运行同一批检查，用于验证 harness 本身的判定标准。

---

## 6. 仓库结构

```
docs/
├── spec/          规范性：冻结的协议文本
├── reference/     非规范性：实体参考，每实体一页
├── guides/        非规范性：教程与操作指南
├── analysis/      非规范性：设计评审记录
└── CONFORMANCE.md 一致性声明与已登记的偏离

packages/                     TypeScript 参考实现
├── core/                       v3.0 Composition Core
├── interaction/                v3.1 Interaction Layer
├── state/                      v3.2 State Mode
├── transport/memory/           进程内 Transport
├── transport/socket/           跨进程 Transport
└── runtime/                    五个操作的门面

implementations/go/           独立的 Composition Core 实现
conformance/                  语言中立的 driver 协议与 harness
rfcs/                         改变语义的规范变更提案
tests/conformance/            与 docs/spec 对应的不变量测试
tools/                        冻结闸门与文档链接闸门
examples/                     5 个可运行示例，各自包含断言
```

---

## 7. 开发

```bash
pnpm install
pnpm run verify
```

`pnpm run verify` 依次执行 `package.json` 中列出的各段：类型检查、一致性套件、示例、
冻结闸门、文档闸门、副本闸门、跨实现一致性。任一段失败即中断后续段。

```bash
pnpm run typecheck              tsc --noEmit，strict + exactOptionalPropertyTypes
pnpm test                       vitest，直接运行源码
pnpm run examples               5 个示例，各自校验结论
pnpm run check:invariants       冻结闸门
pnpm run check:docs             文档链接闸门
pnpm run conformance:external   跨实现一致性
```

工具链：Node ≥ 20 · pnpm 10 · TypeScript 7 · vitest 5 · Go 1.24+（供第六段使用）。

---

## 8. 参与

参见[贡献指南](CONTRIBUTING.md)与[治理](GOVERNANCE.md)。

规范是本项目的主要交付物，实现为其证据。修改一处语义的成本高于修改多处实现，
因此规范变更所受约束严于代码变更。

---

## 9. 许可

[MIT](LICENSE)

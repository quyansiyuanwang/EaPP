# EaPP 的 Go 实现

**这是规范的第二份证据，不是移植。**

它从 [`docs/spec/`](../../docs/spec/) 的正文写出来，作者被明确禁止阅读
[`packages/`](../../packages/)（TypeScript 参考实现）与
[`tests/conformance/`](../../tests/conformance/)。

那条约束是这份实现存在的全部理由。两份实现如果可以互相参考，就会在同一个地方
一起犯错，然后双双自称合规 —— 而"合规"的判定标准恰恰是它们要共同满足的那个东西。

## 覆盖范围

| 层 | 状态 |
|---|---|
| Composition Core（v3.0） | 完整 |
| Interaction Layer（v3.1） | 完整 |
| State Mode（v3.2） | **未实现** |

未实现的层**不在声明内**。driver 的 hello 行通过 `layers` 说明自己覆盖到哪一层，
黑盒 harness 据此决定跑哪些检查 —— 没实现的层不会被判为失败，因为它没有被声明。

## 只依赖标准库

`go.mod` 里没有依赖，也不会有。协议的价值在于任何语言都能实现它；
一份需要引入第三方库才能跑通的参考实现，说明协议本身依赖了库。

## 怎么跑

```bash
go build ./...
go vet ./...
gofmt -l .        # 应当没有任何输出
go test ./...

# 作为黑盒被检查（在仓库根目录）
node conformance/harness/run.mjs --driver "go run ./cmd/eapp-driver" --cwd implementations/go
node conformance/harness/run.mjs --list     # harness 一共问哪些问题
```

`go test` 里的测试**不是**这一节所说的证据 —— 它们与实现出自同一支笔，读的是同一份
规范，抓不住共同的误读。证据在 harness 那一侧：它不引用任何 `@eapp/*`，
两套独立实现回答同一批问题。

## 结构

| 文件 | 内容 |
|---|---|
| `eapp/core.go` `registry.go` `identity.go` `capability.go` `plugin.go` `lifecycle.go` `binding.go` `discovery.go` `bootstrap.go` `semver.go` | Composition Core（v3.0） |
| `eapp/channel.go` `cursor.go` `delivery.go` `modes.go` `transport.go` | Interaction 的实体与传输边界（v3.1 §2 / §3 / §4 / §6 / §10） |
| `eapp/subscription.go` `lease.go` `group.go` | 消费：订阅、租约、竞争消费作用域（v3.1 §5 / §7 / §8 / §9） |
| `eapp/interaction.go` | 把上述各部分接成一层，并接回 Composition Core（§11 / §12） |
| `eapp/errors.go` | 三层的错误码联合与统一的错误类型（v3.0 §16） |
| `cmd/eapp-driver/` | driver：把这一层暴露给黑盒 harness（协议见 [`conformance/driver.md`](../../conformance/driver.md)） |

这份组织方式与 TypeScript 参考实现**不同**，是刻意的。需要一致的是 driver 协议暴露的
可观察行为，不是内部的文件划分。

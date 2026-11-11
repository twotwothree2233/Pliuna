# Monty 一次性计算

内置能力 ID 为 builtin:monty:v1。
当前运行时版本为 @pydantic/monty 1.3.0。
输入和约束直接定义在[contract.ts](../../src/runtime/monty/contract.ts)。

## 使用方式

参数包含 code 和 inputs。
inputs 的每个键作为代码中的同名变量。
代码将最终输出赋给 result。

```json
{"code":"result = sum(values)","inputs":{"values":[2,3,5]}}
```

references 不会隐式绑定变量或读取资源。
需要的正文先通过 read 取得，再显式提供。
一次调用创建一个执行会话并退役 worker。

## 当前能力边界

支持受限 Python 数值、文本和结构化数据计算。
不提供完整 CPython 或任意第三方库。
不提供宿主文件、网络、额外回调和持久会话。

运行时自身的时钟和随机能力保留。
真实 sleep 被拒绝。
输出保存成功只说明执行与交付状态。
数学结论仍需按任务需求核查。

## 运行限制

| 项目 | 当前限制 |
| --- | --- |
| 源码与显式输入 | 1 MiB |
| 分配器内存 | 128 MiB |
| 计算时间 / 外部截止时间 | 120 秒 / 180 秒 |
| 打印输出 | 1 MiB |
| 最终结果 | 256 MiB |
| 递归 / 挂起次数 | 1000 / 1000 |
| 应用活动计算 | 4 |

内存值约束解释器分配器，不覆盖整个进程 RSS。
超过限制会记录明确失败并清理执行。
取消先撤销提交，再等待进程树确认退出。

## 返回值

wire_value 保留大整数、非有限值和容器类型。
bytes 以托管资源引用表示。
大结果可保存为不可变 JSON 资源。
不支持的编码会明确失败，不使用 repr 替代。

## 平台与分发

资产由应用安装包和目标目录定位。
执行不回退到系统 Python、Node 或 shell。
目前只有 darwin-arm64 通过 runtimeVerified 门槛。
其他目标保留候选包与平台验证路径。

目标来源为[native-targets.json](../../src/shared/native-targets.json)。
诊断开关可以关闭入口，但不能绕过平台检查。
相关测试：[生命周期](../../tests/unit/monty-lifecycle.test.ts)、[调用](../../tests/unit/monty-calls.test.ts)、[返回编码](../../tests/unit/monty-native.test.ts)。

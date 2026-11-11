# 当前上下文管理

当前压缩器输出纯文本工作摘要。
宿主将文本和来源边界保存为 InstalledSummary v2。
实现位于[context.ts](../../src/runtime/model/context.ts)。

## 请求由什么组成

主模型使用当前角色提示词、有效摘要和真实消息历史。
新用户请求包含 request 及必要的材料导航。
历史工具调用与原结果按完整交互装载。

当前主角色正文直接来自[agent-v0.1.txt](../../src/runtime/model/prompts/agent-v0.1.txt)。
摘要指令来自[summary-v0.1.txt](../../src/runtime/model/prompts/summary-v0.1.txt)。
文档不再保存另一份角色正文。

## 容量判断

容量参数为模型配置的 context_tokens。
无观测时，以序列化 UTF-8 字节数加 256 估算。
相同请求前缀可复用提供方 usage 观测。
估算与服务实测在请求记录中分别表示。

当前压缩触发线为容量的 90%。
用户也可通过 context.compact 显式整理。
提供方返回上下文超限时进入恢复路径。
计算入口见[capacity.ts](../../src/runtime/model/capacity.ts)。

## 压缩步骤

1. 固定当前消息和覆盖序号。
2. 在同一上下文后追加摘要指令。
3. 使用指定压缩模型，或当前主模型的租约。
4. 接受非空文本，拒绝工具调用。
5. 复查执行有效性和压缩后的容量。
6. 原子安装宿主生成的摘要元数据。

替换压缩模型需通过 compaction 角色测试。
跨配置处理历史还需要明确确认。
当前主路径不要求模型输出结构化摘要 JSON。

## 压缩后保留

保留角色提示词、摘要、最新用户输入和最近两次完整交互。
一次完整交互包含模型响应及其全部工具结果。
孤立工具结果和不完整批次不会拼成活调用。

覆盖序号、保留交互 ID、模型版本和时间由宿主记录。
原始业务记录继续保存。
当前轮读取的契约正文与游标按原消息保留。
历史内容不会自动重新派发。

## 失败与诊断

空摘要、工具调用或来源失效会拒绝安装。
容量恢复没有缩减进展时结束恢复。
旧摘要和已保存业务内容继续保留。

context.status 只读取当前摘要。
输入诊断记录阶段、组成体积和配置参数。
摘要内容本身不产生审批许可。

相关测试：[当前压缩](../../tests/unit/context-management.test.ts)、[按需摘要](../../tests/unit/demand-read-summary.test.ts)、[提供方超限恢复](../../tests/unit/provider-context-recovery.test.ts)、[来源连续性](../../tests/unit/summary-source-continuity.test.ts)。

# 当前模型服务与调度

渠道管理连接，模型管理角色与运行参数。
当前实现使用显式 OpenAI-compatible Chat Completions profile。

## 渠道与模型

渠道保存名称、服务地址、凭据及兼容 profile。
模型关联渠道，保存 wire_model_id、容量和可选限制。
同一渠道的多个模型复用连接信息。

保存配置本身不发起任务推理。
发现、连接测试和角色测试各自显式触发。
修改连接会使相关验证资格失效。

## 角色测试

| 角色 | 当前测试 |
| --- | --- |
| main | 流式响应、一次合成 list 调用及后续文本响应 |
| approval | 无工具的严格 JSON 决策格式 |
| compaction | 无工具的非空文本摘要 |

测试使用合成材料，不执行真实业务工具。
每次测试都有操作 ID、状态和取消入口。
真实业务还要继续遵守权限和容量检查。

## 参数与容量

context_tokens 为必填的输入容量配置。
max_output_tokens 可选，按兼容 profile 映射。
主模型、摘要和审批共用模型适配与请求记账。

可选 limits 包括请求超时、响应体积和 Run 配额。
限制由[Schema](../../src/shared/contracts/core.schema.json)和[RunBudget](../../src/runtime/model/agent.ts)共同处理。
严格 token 上限与未知输出预算存在冲突时会拒绝请求。
费用无可靠来源时标记 unknown。

## 公共目录

服务发现与公开目录查询分别处理。
公开目录只对已知官方地址和精确模型 ID 给出候选。
自定义代理不能直接继承同名模型容量。

元数据保留来源、时间及用户覆盖。
缓存失效或目录不可用不会改写已保存配置。
刷新需要显式入口，不发送任务材料和服务密钥。
实现见[model-directory.ts](../../src/main/model-directory.ts)。

## 连接保存

当前主进程使用 plain-file 后端。
参数在 settings.json，明文 API Key 在 auth.json。
可选仅在内存保存。
文件写入使用私有权限、锁和冲突检查。

settings v4 分开保存渠道和模型。
旧设置版本读取时在内存转换。
重启恢复配置不会自动联网或续跑。

## 占用与网络调度

Run 使用的角色配置持有租约。
连接测试、发现和独立审批也各自占用配置。
占用期间阻止对应模型或渠道的冲突修改。

网络调度上限为应用 4、渠道 2。
等待队列最多 100 项，并按任务轮转。
等人工审批不占网络名额，但可继续占用配置。
失败不会自动换模型、渠道或凭据。

## 请求用量与来源

每次请求有独立 request_id 和派发阶段。
提供方 usage、估算及未知项分别呈现。
分页记录绑定固定 through_sequence。
只看一页时不会把本页数值当作整轮总计。

相关实现：[service](../../src/runtime/model/service.ts)、[adapter](../../src/runtime/model/adapter.ts)、[accounting](../../src/runtime/model/accounting.ts)、[RequestUsage](../../src/renderer/src/RequestUsage.tsx)。
相关测试：[渠道](../../tests/unit/model-channels.test.ts)、[请求用量](../../tests/unit/request-accounting.test.ts)、[容量](../../tests/unit/capacity-plan.test.ts)。

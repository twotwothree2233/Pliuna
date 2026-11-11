# 宿主、模型与插件接入

所有接入都经过当前宿主接口和对象检查。
协议分层见[协议入口](../protocol-v0.1.md)。

## 宿主桥接

[预加载层](../../src/preload/index.ts)只暴露固定 request 桥接。
Renderer 没有 Node 集成和任意 IPC 通道。
[主进程](../../src/main/index.ts)检查窗口、frame 和请求大小。
文件选择、安装来源及保存目标由主进程取得。

## 模型配置

渠道持有地址、凭据和兼容 profile。
渠道内模型持有模型标识、容量及角色参数。
连接和模型通过显式配置请求保存。

当前兼容 profile 为：

- chat-max-tokens：发送 max_tokens。
- chat-max-completion-tokens：发送 max_completion_tokens。

主模型要求通过工具与流式响应测试。
审批模型按其 JSON 决策格式测试。
压缩模型按文本摘要角色测试。
具体实现见[ModelService](../../src/runtime/model/service.ts)。

模型请求使用 OpenAI-compatible Chat Completions SSE。
元数据发现和模型调用是独立的显式操作。
提供方错误、usage 和输入诊断分别登记。

## 配置落盘

主进程当前接入[FileModelStore](../../src/main/file-model-store.ts)。
settings.json 保存参数，auth.json 保存明文凭据。
可选择仅在内存使用连接。
读取旧设置版本时在内存转换，不直接改写旧文件。

修改模型、渠道或协议身份会影响验证资格。
连接与角色被占用时，相关配置保持锁定。
压缩改用另一服务需明确确认历史外发。

## 插件接口

插件 manifest、初始化与工具描述由当前 Schema 校验。
导入后形成私有固定包副本。
启用还检查信任、依赖计划和访问级别。

插件可通过以下回调族请求宿主能力：

| 回调族 | 用途 |
| --- | --- |
| host.describe | 查询宿主能力与约束 |
| objects.list / objects.read | 任务对象查询 |
| resources.read_bytes | 有界读取资源字节 |
| surface.stage | 暂存界面提案 |
| actions.submit / actions.get | 提交及查询动作 |
| tools.call / tools.get / tools.cancel | 调用及查询子能力 |
| execution.wait | 当前调用的等待状态 |
| materials.derive | 登记派生材料来源 |

每项回调仍检查实例、包身份、任务和调用状态。
上传回调另由[uploads](../../src/runtime/plugins/uploads.ts)处理。
完整生命周期见[插件接入](../harness/plugin-integration.md)。

## 参考实现与测试

- [PDF 插件 manifest](../../reference-plugins/pdf-text/manifest.json)。
- [双向 RPC](../../src/runtime/plugins/rpc.ts)及[RPC 测试](../../tests/unit/plugin-rpc.test.ts)。
- [模型协议测试](../../tests/unit/model-adapter.test.ts)及[渠道测试](../../tests/unit/model-channels.test.ts)。
- [配置文件测试](../../tests/unit/file-model-store.test.ts)。

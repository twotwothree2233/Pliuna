# 当前协议与请求边界

当前核心 Schema 标识仍使用 contracts/0.1。
插件 manifest 和握手版本均为字符串 `0.1`。
本文件描述当前代码中的请求路由。

## Renderer 到宿主

页面只通过 `window.trellis.request` 请求宿主。
预加载层暴露固定桥接对象和平台标识。
传输通道名为 `trellis:request`。

```json ipc_request
{"type":"task.create","title":"阅读材料"}
```

响应统一采用下列结构：

```json
{"ok":true,"data":{"example":"业务返回值"}}
```

```json
{"ok":false,"error":{"code":"VERSION_CONFLICT","message":"对象版本已变化"}}
```

主进程检查发送窗口、主 frame 和消息体积。
内部导入、插件安装及导出保存接口不向页面直接开放。
错误中的未知结果应按原操作 ID 查询。

## 请求族与校验归属

| 请求族 | 校验与分发位置 |
| --- | --- |
| 任务、界面、材料、队列、维护 | Schema 的 `ipc_request` 与 RuntimeStore |
| 模型与审批模式 | `host_model_request` 与 ModelService |
| 插件配置 | `host_plugin_request` 与插件控制层 |
| 导出与宿主查询 | `HostRequest`、主进程及 RuntimeStore 的逐字段校验 |

宿主扩展请求由[types.ts](../src/shared/types.ts)定义。
并非所有 HostRequest 都在 `ipc_request` 联合中。
主进程实现见[index.ts](../src/main/index.ts)。

## 内部模型请求

模型工具参数先由[解码层](../src/runtime/model/tool-input.ts)转换。
转换结果再按 `model_request` 校验。

```json model_request
{"type":"list","input":{"kind":"resource","limit":20}}
```

模型可见的 write/call 使用 `input_json` 字符串。
宿主只解码一次，再校验真实 JSON 值。
参数说明见[四工具契约](contracts/objects-tools.md)。

## 插件双向协议

插件通过标准输入输出传输 JSON-RPC 2.0。
每条消息为一行 UTF-8 JSON，以换行结束。
日志应使用标准错误输出。

宿主先发起 `initialize`。
握手绑定插件 ID、包版本身份、实例和访问级别。
插件返回版本、插件 ID 和能力列表。
返回能力必须与宿主解析的列表一致。

宿主调用入口为 `tools.execute`。
取消使用 `tools.cancel`，状态变化可发通知。
插件回调仍经过宿主的任务范围与动作检查。
完整接口见[插件接入](harness/plugin-integration.md)。

## 修订与同步

可变对象通过明确的 revision 检查并发修改。
草稿另有 state_revision。
界面历史、作答和资源采用不可变身份。

`sync.subscribe` 使用 runtime_epoch 与 sequence。
旧 epoch、超出缓冲或序号不匹配时回到完整快照。
宿主读取页面的 Snapshot 是分页摘要。
完整记录通过对象读取接口继续查询。

## 当前契约文件

- [Schema](../src/shared/contracts/core.schema.json)与[校验器](../src/shared/validation.ts)。
- [宿主类型](../src/shared/types.ts)与[runtime 分发](../src/runtime/store.ts)。
- [对象及工具](contracts/objects-tools.md)、[执行与存储](contracts/execution-storage.md)。
- [模型与插件接入](contracts/integration.md)、[校验说明](contracts/validation.md)。

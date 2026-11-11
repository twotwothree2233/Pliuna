# 对象与四工具

主模型对外只使用 list、read、write、call。
工具定义见[tools.ts](../../src/runtime/model/tools.ts)。
模型参数与内部执行请求由[解码层](../../src/runtime/model/tool-input.ts)连接。

## 对象类别

| 类别 | 代表对象 | 当前特征 |
| --- | --- | --- |
| 任务与执行 | task、run、call、action、approval | 查询状态和原操作结果 |
| 内容与状态 | surface、view、view_history、task_data | 区分当前状态和不可变历史 |
| 材料与记录 | resource、answer、message、event | 按任务归属读取 |
| 能力与指南 | object_type、capability、plugin、summary | 发现能力和读取契约 |

普通模型查询限定当前任务。
插件的全局访问需独立信任及启用确认。
对象存在、归属和修订仍在每次读取时检查。

## list

必填参数为 `kind`。
可提供 limit、cursor 和有限过滤条件。
默认返回 50 项，最多 200 项。

```json
{"kind":"object_type","limit":20}
```

object_type 列表返回可读取的契约入口。
能力调用前可查询 capability 并读取其指南。
列表游标按宿主给出的值续用。

## read

模型参数为 kind、id 及可选 selection。
纯文本资源默认读取正文。
契约对象默认返回指南。

```json
{"kind":"resource","id":"resource-id","selection":{"lines":[1,20]}}
```

- `lines`、`pages`、`find` 三者互斥。
- 行和页范围包含起止端点。
- find 是字面搜索。
- max_chars 默认 4000，最多 32000。
- guide、schema、example 视图用于契约读取。
- export_check 视图用于界面及历史的导出检查。

有下一页时，结果附带 next_cursor 和 next_call。
续读只需相同 kind/id 与返回的 cursor。
内容版本变化后应重新读取。
正文与元数据的边界见[工具与资源](../harness/tools-resources.md)。

## write

模型传入 operation 与 input_json。
input_json 必须是操作输入对象的 JSON 文本。
该对象中的 `type` 不能覆盖 operation。

```json
{"operation":"resource.create","input_json":"{\"display_name\":\"说明\",\"content\":{\"type\":\"text\",\"text\":\"正文\"}}"}
```

| 当前操作 | 用途 |
| --- | --- |
| surface.update | 新建、替换、移除 View 和设置布局 |
| task_data.create | 创建固定 Schema 的数据对象 |
| task_data.replace | 替换对象当前值并检查 revision |
| task_data.remove | 删除对象并检查引用及审批 |
| resource.create | 创建新的不可变资源 |

数据的 value 保持真实 JSON 类型。
对象或数组值不应再次序列化成字符串。
新建 Schema 在对象创建后保持固定。

## call

模型传入 capability、input_json 和可选 references。
能力参数解码一次后交给能力专用校验器。
references 提供对象导航，不会隐式加载正文。

```json
{"capability":"builtin:monty:v1","input_json":"{\"code\":\"result = sum(values)\",\"inputs\":{\"values\":[2,3,5]}}"}
```

能力指南声明输入、结果、限制和副作用。
插件能力还需满足当前启用及依赖关系。
Monty 的变量绑定见[计算说明](../harness/code-execution.md)。

## 结果与失败

结果分别记录 execution 与 delivery。
execution 包含 success、partial、failure 和 unknown 等状态。
delivery 表示结果是否交付给调用方。
操作成功与结果交付需要分别判断。

写入后可按 action/call ID 查询原结果。
读取错误不会自动扩大权限或跟随全部引用。
未知结果也不会自动重放原操作。

相关测试：[工具参数](../../tests/unit/tool-input.test.ts)、[工具契约](../../tests/unit/tool-schema.test.ts)、[契约交付](../../tests/unit/contract-delivery.test.ts)。

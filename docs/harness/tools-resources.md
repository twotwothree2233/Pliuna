# 工具、资源与正文读取

模型使用固定四工具，能力说明通过对象查询发现。
外部参数与内部请求的区别见[四工具契约](../contracts/objects-tools.md)。

## 对象与正文

列表返回对象导航和有界元数据。
资源正文按明确的读取请求返回。
references 提供关联，不隐式展开全部正文。

同任务资源为不可变内容。
任务数据则有固定 Schema 和可变 revision。
直接引用任务数据时需要准确修订号。
引用资源时使用不可变资源 ID。

## 正文分页

read 的默认正文长度为 4000 个 Unicode 字符。
最大 32000 字符，响应体积最多 256 KiB。
可按行、工具页索引或字面搜索定位。

返回值带实际范围、content_version 和 next_cursor。
续读绑定原选择与内容版本。
版本变化时重新读取，避免拼接不同内容。
当前范围读完与全文读完分别表示。

宿主 ContentReader 还可按 UTF-8 字节区间读取。
界面仅展示当前片段，并明确提取和页索引状态。
实现见[ContentReader](../../src/renderer/src/ContentReader.tsx)。

## 资源创建与派生

resource.create 创建新内容，不替换已有资源。
小内容可内联，大结果保存为新资源后返回引用。
运行中的原始输入与工具派生结果分别登记。

派生记录绑定输入资源、能力、参数和输出资源。
页码和结构定位保留工具报告的验证级别。
工具报告来源与宿主确认的事实分别表示。

## 任务数据引用

task_data 引用同任务资源或准确版本的任务数据。
读取不递归跟随全部关联。
删除前检查所有进入引用，包括旧版本和自引用。
先显式解除引用，再申请删除。

## 操作结果

结果分别表示执行和交付状态。
截断预览会给出进一步读取入口。
原 action、call、event 和消息可继续查询。

读取检查仍包括任务归属、执行状态和对象版本。
等待审批或宿主界面确认时，模型工具派发受阻。
宿主查询与用户控制入口保持独立。

相关实现：[queries](../../src/runtime/queries.ts)、[resource-reader](../../src/runtime/plugins/resource-reader.ts)、[read-cursor](../../src/runtime/model/read-cursor.ts)。
相关测试：[正文读取](../../tests/unit/content-read.test.ts)、[引用](../../tests/unit/data-references.test.ts)、[工具诊断](../../tests/unit/tool-input.test.ts)。

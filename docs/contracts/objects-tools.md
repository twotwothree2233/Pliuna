# 对象与四工具契约

状态：行为已确认，以下 wire 编码为推荐实现草案。结构见 [schema](schemas/core.schema.json)，数值见[开发默认值](development-defaults.json)。

## 对象目录

| kind | list/read | 模型 write |
| --- | --- | --- |
| task、message、event、answer | 当前任务内获准内容；宿主秘密排除 | 无；专用宿主入口产生 |
| surface、view | 当前版本与获准历史 | 仅 surface.update；View 是内部操作目标 |
| task_data | 当前值、固定 schema、版本和引用 | 创建、整体替换、移除 |
| resource | 元数据、已有表示和有界内容 | 仅创建有界文本/JSON；不可覆盖或直接物理删除 |
| object_type、plugin、capability | 发现及按启用状态读取 | 无；不提供安装、启用或注册权 |
| run、call、action、approval | 公开状态、结果与必要原因 | 无；不直接修改运行状态或批准 |
| summary | 生成摘要及来源，只读展示 | 无；由上下文模块安装 |

身份与当前任务来自可信执行上下文，不由四工具的参数自报。全局插件查询其他任务使用专门 RPC，模型四工具不因此获得跨任务权限。ID 是不透明宿主字符串；示例前缀用于阅读，不是权限凭证。

## 引用与局部 schema

业务内容与 `references` 分离。引用项由局部唯一 `name` 和 `target` 组成；业务字段中的同名字符串仅供作者关联，宿主只解释引用表。`target` 包含 kind、id，可变对象引用必须携带 expected_revision；不可变资源引用精确版本 ID。普通内容即使形似 ID 也不形成引用。

读取 target 未提供 expected_revision 表示查询当前对象，不等于保存了一条允许自动跟随的业务引用。保存时必须校验任务范围、目标存在性、类型及版本。当前业务引用阻止目标移除，包括过期版本引用；历史快照只保护其复制值和资源，不阻止源对象移除。允许业务引用循环，不递归展开或复制。

局部 schema 只支持基础 JSON 类型、properties/required/additionalProperties:false、items、enum、长度及数值范围、description。禁止 `$ref`、组合/条件、pattern、自定义代码和远程引用。程序额外检查关键字适用类型、min/max 关系、required 是否存在、枚举值符合类型及嵌套配额。固定字段对象应声明 additionalProperties:false。该子集不限制宿主协议本身使用完整 2020-12。

创建任务数据时 value 必须符合局部 schema；替换只提交 value/references，不允许更换 schema。结构变更新建对象，不暗中迁移。

## 四入口

- `list`：kind、可选 filters、limit、cursor。过滤仅已定义元数据，默认按创建时间及 ID 稳定排序；游标绑定主体、范围及筛选条件，不能换筛选继续使用。不持长期快照，并发变化允许遗漏/重复；每页重新鉴权。返回 items、next_cursor、consistency="live"。
- `read`：target，可选行范围或 cursor，二者不能同时提供。行号从 1 开始，范围含首尾；start 不得大于 end。游标绑定对象、版本、表示、主体和具体位置，超长单行可分段，不要求调用方计算字节或 UTF-16 偏移。返回 revision、实际范围、truncated、next_cursor 和已有表示。变更后返回 READ_VERSION_CHANGED，不返回新版本尾段；从最新内容重读且计入预算。
- `write`：按 type 区分 Surface、任务数据与资源创建。普通写单对象，Surface 内多个 View 操作同事务。校验、授权、暂存和最终提交由宿主完成，模型等待终态；登记后 UI 可显示 Action。不允许任意 JSON Patch。
- `call`：capability、arguments、references；一次一个能力。参数另按该能力 schema 验证；无脱离来源执行的后台选项。唯一 Call 先持久化再调度，默认许可不创建空授权 Action，额外审批才关联 Action。

`tool_result.data` 是对应对象/能力的多态载荷，核心 schema 不假装能校验所有动态领域值。实现时由对象类型/能力注册表进行二级验证；状态、错误、引用独立于正文截断。失败也可以 delivery=delivered，表示失败报告可读而不是执行成功。模型工具不返回 waiting 作为最终结果。

## 界面生成闭环

1. read 当前 Surface，取得版本和允许挂载位置。
2. write surface.update，传 view.create 的局部 client_ref、slot_id 及内联 bundle，见[请求](examples/02-model_request.json)。client_ref 仅在这次变更集中定位，不是客户端操作 ID。
3. 宿主验证引用和 bundle，必要审批后再次检查版本；把内容保存为不可变产物。
4. 一个数据库事务提交 Surface/View/历史、资源引用和 Action 成功；返回[正式 View ID 映射](examples/03-tool_result.json)。映射的正式 ID 由宿主生成。
5. 用户输入按专用 draft.save 保存；answer.submit 读取匹配版本的已保存草稿，在同事务生成答案和事件，之后才可能启动新 Run。
6. 旧版本提交返回[冲突结果](examples/06-tool_result.json)，旧界面不变；不修补原 Action 或继承旧批准。

大 bundle 通过资源引用进入相同内部结构和校验；不要求模型将所有界面都先转成 ZIP。小文本和 JSON 资源创建有内联上限，大二进制由文件导入、工具产物或插件上传进入，不通过模型 Base64 搬运。

## 新提交与未知结果

每次有效新提交独立生成宿主 ID；相同内容不复用结果。错误修正后显式提交仍是新操作。终态不能复活，已发布 stage 草稿不可再发布，版本检查不属于业务去重。

无 ID 的失联请求通过近期操作列表按时间、来源、目标、类型和状态定位；只有实际连接关联能确认时才自动对应。不能仅因参数相同认领旧结果，找不到不证明未执行。不自动重发未知请求；用户再次执行需知道可能重复产生效果。

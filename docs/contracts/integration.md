# 宿主、插件与模型接入

状态：方向已确认，以下方法/字段为推荐实现草案。本文不承诺完整 SDK 或真实服务兼容性。

## 宿主 IPC

renderer 通过受控 preload 调用窄接口，主进程转发已绑定身份的请求到 runtime；不允许任意 IPC 方法、路径或 SQL。核心字段见 [ipc_request schema](schemas/core.schema.json)。

| 方法组 | 方法及职责 |
| --- | --- |
| 任务 | task.create / snapshot / submit / stop / resume / delete |
| 执行 | run.cancel、approval.decide、cleanup.retry |
| 输入 | draft.save 保存允许字段；answer.submit 提交匹配版本的已保存草稿 |
| 观察 | sync.subscribe；operation.list 查询近期操作，不执行 |

任务 submit 记录所选模型配置，等待启动期间变化需确认。管理级接口只对可信宿主 UI 开放，不因模型可见同名对象就暴露。删除、恢复、丢弃输入等本人确认不能用普通审批接口绕过。

同步位置为 runtime_epoch + 每任务递增 sequence，不与业务事件序号混用。订阅先登记缓冲接收点，再取得该点一致快照并衔接之后变化；实现可在同一 runtime 调度临界区完成，不在读取/订阅之间留缺口。

增量为对象 upsert/remove/invalidate，非通用 JSON Patch。Surface 只更新变化的 View/布局版本；大内容 invalidate 后读取。每个已订阅任务仅保留 1000 条或 8 MiB 内存增量，任一先到淘汰；无订阅者可释放。不建持久事件总线。缺口补取失败或 epoch 变化重新获取快照，不重放请求。

后台异常可在 5 分钟内最多自动重启 3 次，仅做维护、旧执行失效及收尾，之后恢复读取和新操作入口。连续失败转手动重试。renderer 的未保存输入留内存，重连先核对版本，不自动覆盖。

## 插件包与 RPC

manifest_version/protocol_version 精确为 0.1；未知字段拒绝，扩展仅 extensions。包内相对 entry 禁止根目录逃逸和符号链接；backend 是外部命令、参数及包内入口声明，不执行安装脚本。内容包没有 backend，不启动进程。静态声明 task/global，握手不能扩权。能力描述 schema 的 effect 不构成 OS 隔离承诺。

| 方法 | 请求内容 | 返回/行为 |
| --- | --- | --- |
| host.describe | protocol_version | 能力、profile、配额版本、schema 摘要；不支持明确拒绝 |
| objects.list/read | task_id 及对应查询字段 | 范围内结果；真实级别来自连接 |
| tools.call | task_id、capability、arguments、references | 宿主 Call ID，状态查询/通知；嵌套链由宿主管理 |
| tools.cancel | call_id | 请求取消的受理结果，不等于已结束 |
| actions.submit | task_id、mutation 或调用意图 | 新 Action ID；默认或审批后执行 |
| actions.get | action_id | 持久化事实，无重执行 |
| surface.stage | task_id、surface 变更 | 不可变 draft_id、检查报告、到期信息 |
| surface.commit | draft_id | 经 actions.submit 表达修改，批准只绑定该草稿 |
| upload.begin/chunk/finish/abort | 上传声明、偏移及块或 upload_id | 暂存身份，不自动发布；见[存储](execution-storage.md) |
| shutdown | reason | 关闭请求，超宽限由宿主终止直接管理进程 |

双方工具调用和反向查询均为双向 NDJSON JSON-RPC 2.0，stdout 只放协议。无 id 通知只用于状态变化，不接收需要确认的修改。请求 ID 只关联通信，不去重。具体方法 params 需继续由表中类型组合成单独 schema，不把通用 rpc_request 的 object params 当作业务校验。

JSON-RPC error 用于结构/参数格式/未知方法；已登记操作的授权拒绝、冲突和执行失败放业务结果。可定位的非法 JSON 报解析错误；超长、非法 UTF-8、不可恢复 stdout 污染关闭连接并清理，已派发事实保留，不自动重放。持续错误次数需有界实现配置。

## 模型配置字段与映射

| 字段组 | 推荐字段/规则 |
| --- | --- |
| 渠道 | id、revision、base_url、credential_ref、compatibility_profile、共享参数；不保存密钥明文 |
| 模型 | id、revision、channel_id、wire_model_id、context_tokens、max_output_tokens、各角色验证结果 |
| 元数据依据 | 每字段 source、fetched_at、manual_override；目录更新不自动改有效值 |
| 能力 | supported/unsupported/unknown；未声明记 unknown，主模型流式/tool 实测 |
| 价格 | 独立估算信息及来源时间，不回写历史或绕配置锁 |

Chat Completions 为首版 adapter。兼容 profile 显式映射 max_tokens/max_completion_tokens 等字段，只有已定义参数可配置；不开放任意 extra_body 覆盖模型、工具和限额，不根据模型名字猜。无法确定时局部手动选择或报告不支持，不自动换服务。

服务接口优先，models.dev 只按明确 provider + wire ID 匹配；不做名称相似匹配或 canonical 替换。context/output 必须有效正数，缺失不是 0；自定义代理不能自动继承同名模型的服务能力。凭据只发配置服务，不发目录。测试选中配置使用有界合成材料，不用真实任务数据。

流式按服务 tool_call ID/index 组装参数，完整响应后才能派发，残缺不猜补。正常文本、工具调用和停止原因必须明确解码；partial stream 失败按既有中断规则，无输出暂时错误才预算内有限重试。请求取消不证明提供方没有计费。

审批和摘要不要求提供方原生 JSON Schema；有经过测试的结构化模式时使用，否则严格要求 JSON 并本地校验。不提取文字中的 JSON、不修复非法 JSON。审批无效转人工，摘要最多一次纠正，沿用原预算与取消。

## 提示词与预算

宿主模板随版本管理，运行记录绑定版本；首版无提示词编辑器，插件不能替换宿主规则。候选模板为[主 agent](prompts/agent-v0.1.md)、[审批](prompts/approval-v0.1.md)、[摘要](prompts/summary-v0.1.md)，结构校验不证明语义质量。

优先匹配 tokenizer，否则标注估算并留余量，usage 可校准。输入估算包括规则、工具、历史、图片及材料，不能把未知视觉成本记 0；无法给出有界估计时拒绝发送该输入并解释。模型容量必须实际已知，估算不用于猜容量。

默认保留最近 4 个完整交互组，当前请求和未完成调用不丢失；调用与结果完整成组。按需加载、确定性缩减后仍超预算才同步压缩。输出预留 min(8192, 已配置输出上限)，初始余量为上下文 10%，不可靠估算可提高。近期完整组可纳入摘要，最小必要上下文本身过大则停止，不能无限整理。

插件保留说明取当前主 workflow，以及待压缩历史中实际读取/调用且当前仍启用能力；按 workflow、最近调用、最近读取优先，同级稳定 ID 排序，在长度预算内加入，不额外模型判断相关性。保留说明长度和摘要输出长度仍需作为模板实现参数测定，不能无界。

Run 固定限额版本，主推理/压缩/审批/实际重试共享 40 次请求、200 次工具、200000 累计输入输出 token、60 分钟墙钟。请求前预留预计输入与最大输出，返回按 usage 或明确估算结算；已发请求失败不直接归零。同次调用不因经过多层模块重复计数。独立执行也必须固定其适用限额，不能借无 Run 无界执行。

默认无货币额度；价格或 usage 缺失显示未知/估算。用户要求严格货币上限但无法可靠核算时阻止或要求明确改预算，不静默忽略，账单仍以服务商结算为准。正常限额修改只影响新执行；磁盘不足和紧急取消可立即生效。

## Monty 输出

wire_value 用独立 type 封装；普通 JSON 保真，特殊值 bigint/nonfinite/bytes/tuple/set/frozenset/map 保留类型，含特殊元素的 list 递归封装。bytes 外存受管理资源。普通用户字典整体处于 json 或 map 中，不能被误当标签。循环/不支持值拒绝交付，保留执行事实，不 repr 替代、不重跑。

不承诺确定性，不缓存同输入结果；宿主不新增时间/随机/等待回调，必要信息显式输入。Monty 自身时钟、熵及 sleep 的真实能力需实测公布，不能声称已禁用不可控能力；源码、内存、打印及执行配额另行实测，不照搬普通插件 timeout。

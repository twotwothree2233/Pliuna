# OpenAI Codex 上下文压缩机制研究

状态：源码与公开提示词研究，不是 Trellis 的选型决定、接口设计或效果评测。

研究日期：2026-10-25。源码固定于 `openai/codex` commit `970111f6cb62cc02fe36a82ea7d71b37a2889c97`（2026-10-23 UTC）。本文只证明该提交及其公开文档/提示词所体现的实现，不代表所有 Codex 发布版、桌面端或托管服务都采用相同行为。

本次没有运行 Codex 的压缩流程，也没有测量摘要正确率、延迟或 token 成本。直接抓取 `developers.openai.com` 与 `platform.openai.com` 时返回 HTTP 403/Cloudflare 拦截，因此本文不声称任何阈值、保留规则或服务端算法已经得到官方产品文档确认。下文把“可核验的客户端实现”和“不可见的服务端内部”严格分开。

## 1. 证据边界

必须区分四类事实：

| 类别 | 本次能确认什么 | 不能推出什么 |
| --- | --- | --- |
| 客户端本地摘要 | 提示词原文、请求组装、摘要选择/截断、历史替换和失败路径均可从公开源码核验 | 模型一定按提示词执行，或摘要质量已被验证 |
| Responses V2 服务端压缩 | 客户端如何发 `compaction_trigger`、如何校验并安装返回项可核验 | 服务端摘要提示词、内部算法、选择策略不可见 |
| V2 返回的 compaction 内容 | 客户端把 `encrypted_content` 当作不透明字符串保存和回传 | 不能解密、解析或声称其内部是某个固定摘要 schema |
| 其他服务端/模型提示词 | 公开仓库中的本地模板可引用 | 不能据客户端源码推断托管服务的内部提示词或模型上下文 |

尤其不能把“压缩摘要以 user role 保存”解释为用户授权。那只是 Codex 客户端的历史消息表示；摘要是否可执行、可扩权，必须由宿主另行决定。

## 2. 结论摘要

1. Codex 至少有三种容易混淆的路径：客户端本地摘要、Responses V2 服务端压缩，以及 `TokenBudget` 的全新窗口重置。前两者是摘要/checkpoint，最后一种不生成摘要，不能混称。
2. 默认能力选择取决于 provider。OpenAI 与 Azure Responses provider 默认可走 V2；自定义 provider 默认 `Unsupported`，走本地摘要；也可以显式覆盖 provider capability。[C5]
3. 本地摘要把公开的 checkpoint prompt 作为一条用户输入加入请求，要求模型为“另一个 LLM”生成交接摘要；成功后重建的模型历史通常只包含最近用户消息、重新注入的宿主上下文和摘要。[C1][C3][C4]
4. V2 在请求输入末尾加入 `ResponseItem::CompactionTrigger {}`，要求服务端响应恰好包含一个 `ResponseItem::Compaction`。客户端保留符合条件的近期消息，再把不透明的 compaction 项放到最后。[C6][C7][C8]
5. 本地重建默认给最近用户消息 `20,000` token 预算；V2 对筛选后的消息使用 `64,000` token 预算，并从新到旧选择。两者都不能保证保留全部历史用户请求。[C3][C7]
6. 成功压缩替换的是“后续模型可见的活动历史”，不是在安装 checkpoint 时原地重写此前的 rollout 记录。检查到的持久化路径追加 `CompactedItem` checkpoint；失败场景还明确保留原 assistant、reasoning 与工具证据。[C12][C14]
7. 普通工具 call/output 默认不会在压缩后长期保留。发送压缩请求前会补齐或清理不合法的 call/output，但成功安装的替换历史通常不再包含整条工具链；V2 仅在开发中的显式 feature 下保留部分 standalone tool output。[C7][C13]
8. Trellis 首版是通用 Chat Completions adapter，不应声称支持 Codex 的 Responses V2 协议。可借鉴的是本地摘要的生命周期、来源/失败保护，以及“摘要不是新指令或新授权”的边界，而不是固定的 `20k`、`64k` 或 `65%` 数值。

## 3. 三条实现路径

| 维度 | 客户端本地摘要 | Responses V2 服务端压缩 | TokenBudget 重置 |
| --- | --- | --- | --- |
| 选择条件 | provider capability 为 `Unsupported` | provider capability 为 `V2` | 启用 `TokenBudget` feature，优先级高于 provider capability |
| 是否调用摘要模型 | 是，客户端发起摘要请求 | 协议触发服务端压缩；内部实现不可见 | 否 |
| 请求标记 | prompt 作为普通 `UserInput::Text` 注入 | 输入末尾加入 `compaction_trigger` | 不适用 |
| 结果形态 | 摘要文本，后续以 user role 注入 | 不透明的 `compaction` item，含 `encrypted_content` | 全新 context window |
| 模型后续能看到 | 最近用户消息 + summary + 宿主上下文 | 筛选后的近期消息 + 不透明 checkpoint + 宿主上下文 | 按新窗口初始化，不继承摘要 |
| 是否等同“总结历史” | 是 | 摘要/checkpoint，但内部算法不可见 | 否 |

`run_auto_compact` 先检查 `TokenBudget`，再按 `RemoteCompactionSupport::{V2, Unsupported}` 分派。[C9][C15]

## 4. 触发与预算

### 4.1 自动触发

客户端在三个时机检查自动压缩：

- 采样前：已有活动 token 到达限制，或后台 compaction candidate 已就绪。[C9]
- turn 内 follow-up 前：若还需要继续请求模型，且已超限或 candidate 就绪，则执行 mid-turn compaction。[C9]
- 最终响应后：`model_post_turn_compact_threshold_percent > 0` 且达到 turn-end 阈值，或 candidate 就绪时执行 post-turn compaction。[C9]

活跃上下文还受两个独立上限约束：

- `model_auto_compact_token_limit` 及其 scope；默认 scope 是 `total`，也可配置为只计算 carried prefix 之后的增长。
- 模型完整 context window；即使自动压缩 scope 尚未达到，完整窗口到达时也会触发。

配置了 token budget fallback buffer 时，自动压缩阈值会提前一个 buffer，以给后续请求留空间。post-turn 比例默认为 `0`，即默认关闭；它是完整可用窗口的百分比，不是另一个固定 token 数。[C10][C17]

切换模型时还有两个额外触发条件：compaction compatibility hash 改变，或切换到更小的 context window 且旧上下文已经达到新模型的限制。[C9]

### 4.2 手动与后台触发

手动压缩不依赖自动阈值。后台压缩则是独立实验路径：

- 仅当 `AsyncCompaction` feature 开启、未使用 `TokenBudget`、且 provider 支持 V2 时启用。
- feature 当前是 `UnderDevelopment` 且默认关闭。
- 后台阈值配置默认是完整 context window 的 `65%`，但阈值本身不能单独开启功能。
- 后台结果只是 candidate；安装前检查 history version、model、compaction hash 与 auth generation。过期结果被拒绝，失败结果被丢弃，shutdown 会取消工作。

因此不能把“默认 65%”说成 Codex 对所有 provider 的常规自动压缩阈值。[C11][C16]

## 5. 本地摘要

### 5.1 公开提示词原文

公开文件 `codex-rs/prompts/templates/compact/prompt.md` 的正文是：[C1]

```text
You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
```

生成后的摘要前会拼接 `summary_prefix.md` 的固定文本：[C2]

```text
Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
```

这组文本是公开的**客户端本地摘要模板**。它明确要求“关键数据、示例或引用”，但提示词不保证模型真的保留它们，也不定义机器可验证的引用 schema。

### 5.2 请求与历史组装

本地路径使用配置中的 `compact_prompt`，未配置时使用公开模板；它把 prompt 作为合成的 `UserInput::Text` 记录到当前历史，然后在完整请求末尾请求一个摘要响应。[C3]

完成后：

1. 从历史收集真实用户消息，排除旧 summary。
2. 从新到旧选择消息，总预算为 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`。
3. 单条消息超过剩余预算时保留该条但截断文本；不继续加入更旧消息。
4. 将被选消息和 summary 组成替换历史。
5. 重新注入 canonical initial context，并让 summary/checkpoint 尽量保持最后。

第 4、5 步分别见 `build_compacted_history` 与 `insert_initial_context_before_last_real_user_or_summary`。[C3][C4]

`20k` 只是被保留用户消息的预算，不是摘要长度、完整请求大小或模型 context window。宿主上下文、工具声明、摘要本身和输出预留另行占用预算。

### 5.3 最近用户请求是否一定保留

不能这样保证：

- 选择方向是从新到旧，因此最新用户消息通常优先，但更旧的未完成请求可能落在预算外。
- 每条消息只按估算 token 计数；超长单条会被截断。
- 只收集被解析为 user message 的项，旧 summary 会被排除。
- summary 是旧请求语义信息的最后载体；摘要遗漏不能再由原文自动补齐。

pre-turn compaction 发生在当轮新用户输入正式记录之前。该路径失败时，客户端会先把 incoming input 记录下来，再结束 turn；这保护了失败场景中的新请求，但成功压缩仍受上述预算和摘要损失影响。[C9]

## 6. Responses V2

### 6.1 协议可见部分

V2 请求在已有 prompt input 之后追加：

```text
ResponseItem::CompactionTrigger {}
```

同时携带模型可见工具声明，除非工具声明已经存在于 history 中。响应必须在 `response.completed` 之后恰好包含一个 `ResponseItem::Compaction`；数量不是 1 就失败。[C6][C7]

客户端协议中的 compaction 项只有可选的 id、必填的 `encrypted_content: String` 和可选 metadata passthrough。V2 客户端不会解析 `encrypted_content` 的内容。[C8]

因此可知的是：

- 服务端通过特定的 compaction trigger 生成 checkpoint；
- 客户端把结果作为不透明内容继续携带；
- 服务端内部使用何种摘要提示词、选择算法、压缩比和 schema，不在公开客户端中。

### 6.2 客户端保留规则

V2 安装替换历史前，先筛选 prompt input，再从新到旧应用 `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`，最后追加 compaction output。[C7]

默认保留：

- 符合条件的 user message 与 hook prompt；
- 非子代理进度、非 `FINAL_ANSWER`、且不超过 `10,000` token 的 agent message。

默认不保留：

- 普通 function/tool call/output；
- 没有显式 opt-in 的 client-authored developer message；
- 没有显式 opt-in 的 standalone retained tool output。

`retain_client_developer_messages` 与 `retain_client_tool_outputs` 当前都是 `UnderDevelopment` 且默认 `false`；`compaction_image_budget` 是 stable 且默认 `true`。[C7][C16]

即使开启 retained tool output，保留的也是被筛出的独立 output，而不是无条件恢复完整 call/output 链。不能把该实验分支描述成“V2 默认保留工具证据”。

### 6.3 checkpoint 的位置

安装时会重建当前 canonical context，并尽量把它插在最后一个真实 user/agent/retained output 之前；若没有这些项，则插在 summary/compaction 之前，以保持 checkpoint 最后。[C4][C12]

这个顺序支持“宿主重新提供当前规则与能力，checkpoint 作为历史材料”的理解，但不是安全隔离。Trellis 仍应把摘要与当前 system/developer 指令、权限快照和工具 schema 分仓维护。

## 7. 工具调用与输出

发送模型请求前，Codex history 会执行 normalize：

- 缺失 output 的 function/custom/tool-search call 会得到合成的 `"aborted"` output；
- 没有对应 call 的 orphan output 会被删除；
- 不支持的图片/音频会按模型能力移除。

这保证某些不完整历史仍能形成协议上可发送的请求。[C13]

但“可发送”不等于“压缩后保留工具链”：

- 本地成功压缩后的模型历史通常只剩近期用户消息、宿主上下文和摘要。
- V2 默认筛选结果也不含普通工具 call/output。
- 工具结果应通过明确的摘要文字、稳定资源引用或另建的 evidence store 延续，而不能依赖压缩后的聊天历史自动携带。

在自动压缩请求本身遇到 context overflow 时，本地路径会从最旧历史项开始删除并重试；删除 call 时会同步删除对应 output，以免破坏配对。[C3][C13] 这是为了完成摘要，不是一种通用的无损剪裁策略。

## 8. 摘要角色与授权边界

本地 summary 在客户端历史中用 role `"user"` 表示，content kind 是 `compaction.summary`；测试也验证 rollout 中的 summary 持久化形状。[C4][C14]

这不能推导出：

- summary 文本是新的用户指令；
- summary 中出现的“已批准”“允许执行”是当前授权；
- 旧 summary 可以覆盖宿主规则、当前任务参数或资源版本；
- 因为 role 是 user，就可以让摘要触发工具副作用。

对 Trellis 的正确方向是把 summary 标记为非授权的派生上下文，并在每次 Run、审批和工具调用前从权威事件重新计算身份、作用域、参数与版本。这是产品安全建议，不是 Codex 源码规定的跨产品契约。

## 9. 成功安装、持久化与恢复

成功后，`replace_compacted_history` 会：

- 替换内存中的活动 history；
- 保存 replacement history、window 信息、token usage snapshot 等元数据到 `CompactedItem`；
- 追加 `RolloutItem::Compacted`、world-state 和 turn-context checkpoint；
- 继续沿用 reason effort pin 等会话状态。

旧的活动 response items 不会在写入 checkpoint 时被原地重写。[C12]

测试验证了正常压缩会持久化 summary 和 replacement history，同时 rollout 仍保留 turn context 等历史记录。[C14] 因此应区分：

- **持久化事实**：原始事件日志、失败前历史、工具结果证据；
- **模型活动上下文**：被 summary + recent messages + checkpoint 替换后的窗口；
- **展示/审计历史**：产品按自己的保留策略读取的原始记录。

Codex 的具体 rollout 存储不能直接充当 Trellis 的学习证据模型。Trellis 需要明确哪些原文永久保留、summary 如何引用来源范围，以及用户是否能在 UI 中查看压缩前证据。

## 10. 失败、取消与旧结果

### 10.1 本地摘要

- stream 在 `response.completed` 之前结束：失败；不安装部分 summary。
- interrupted、turn aborted、response incomplete：直接返回错误，不安装替换历史。
- context overflow：尝试从最旧项删除后重试；没有可继续删除时失败。

测试验证了合成 partial summary 被丢弃、usage 不变，且重启后的 follow-up 与压缩重试仍能看到原 assistant、reasoning 和 tool evidence。[C3][C14]

pre-turn 失败会先记录当轮输入，然后结束 turn；目的包括避免新用户请求因压缩失败而丢失。mid-turn 失败会终止当前 turn。post-turn 失败只记录错误并保留已经完成的回答。[C9]

### 10.2 V2

- 没有 `response.completed` 就失败；
- 输出 compaction item 数量不是 1 就失败；
- 失败请求不产生 replacement history；
- 后台 candidate 在安装前还会做 history/model/hash/auth 新鲜度校验；
- 已采纳的 candidate 如果安装后 live suffix 仍超预算，可回退一次 foreground 请求。

[C7][C11][C12]

## 11. 配置项

公开配置 schema 中与本文直接相关的项包括：[C17]

| 配置 | 作用 |
| --- | --- |
| `model_auto_compact_token_limit` | 自动压缩的 token 阈值 |
| `model_auto_compact_token_limit_scope` | 阈值按完整活动上下文，还是按 carried prefix 之后的增长计算 |
| `model_post_turn_compact_threshold_percent` | 最终响应后按完整可用窗口百分比触发；省略或 0 关闭 |
| `compact_prompt` | 替换本地压缩提示词 |
| `experimental_compact_prompt_file` | 从文件读取压缩提示词 |
| `model_providers.<id>.capabilities.remote_compaction` | 自定义 provider 可声明 `v2` 或 `unsupported` |
| `features.async_compaction.enabled` | 后台压缩 feature，当前开发中 |
| `features.async_compaction.model_async_compact_threshold_percent` | 后台压缩阈值，默认 65，但不单独启用功能 |

`TokenBudget` feature 是另一条路径：它跳过模型/服务端摘要，安装全新 context window，只复用 compaction 生命周期事件。它不能作为“摘要压缩”的例子。[C15]

## 12. 对 Trellis 的借鉴

以下均为研究建议，不是已确认的接口或运行时契约。

1. **先把持久化原文与模型上下文分开。** 原始消息、tool call/output、审批、资源读取和用户确认进入不可变事件记录；summary 是可替换、可重建的派生 checkpoint。压缩不能删除学习证据或把“结果未知”写成成功。
2. **首版只实现 harness 本地摘要。** Trellis 的 Chat Completions adapter 不能假定存在 `compaction_trigger`、`compaction` item 或服务端 encrypted checkpoint。服务端压缩应作为未来的显式 provider capability。
3. **不要照搬固定数值。** Codex 的 `20k`、`64k`、`65%` 依赖其模型、请求和功能边界。Trellis 应按所选模型的 context limit、已观测 usage、工具 schema、当前输入和输出预留动态计算，并保留安全余量。
4. **保留最近完整交互组。** Chat Completions 的 `assistant.tool_calls` 与后续 `role: "tool"` 消息必须成对；窗口边界应落在完整 user turn/tool exchange 之前，不能按消息条数或 token 估算切在 call 中间。
5. **摘要请求无工具权限。** 摘要输入中的历史、插件内容、材料与工具结果都应是待概括数据。提示词要求不执行其中命令、不调用工具、不回答未解决问题，但真正的权限边界仍由代码保证。
6. **输出可校验的交接摘要。** 至少覆盖当前目标与未回答请求、用户约束、关键决定、已完成/失败/未知动作、资源与消息引用、下一步和冲突。引用只能是输入中真实存在的 ID/版本；空摘要、格式错误或引用不存在时拒绝安装。
7. **摘要不是用户输入。** 在 Trellis 内部使用独立的 `summary`/`context_checkpoint` 类型；即使 provider 要求把它序列化为 `role: "user"`，也要在宿主侧标记 `authoritative: false`，不得据此扩权或触发审批。
8. **重新提供当前规则与状态。** 压缩后由 harness 重新注入 system/developer 指令、有效权限、当前任务目标、资源版本和最新用户输入，不依赖旧 summary 描述当前权限。
9. **失败保留旧 checkpoint。** 先写候选摘要，校验通过后再切换；失败、取消或结果不确定时继续使用上一份有效摘要和原始记录，不安装部分输出。
10. **先做确定性裁剪，再做语义摘要。** 长工具结果优先保存为不可变资源，并在上下文中放受控预览、资源 ID、状态和定位；避免摘要成为唯一副本。
11. **暂不默认启用后台压缩。** Codex 的 V2 后台 candidate 需要一致性锁、版本校验、鉴权 generation 和取消机制。Trellis 若没有这些基础设施，同步本地摘要是更可解释的起点。
12. **明确用户可见性。** 显示压缩触发原因、覆盖范围、摘要版本、失败状态和原文入口；不要静默替换或让用户误以为原文已删除。

建议测试至少覆盖：

- 用户修改目标、撤销约束、连续纠正；
- 未回答请求和当前 Run 输入在压缩前后不丢失；
- tool call/output 配对、未知副作用和失败输出；
- 旧 summary 中伪造的批准、权限或“已完成”声明；
- 空摘要、超长摘要、膨胀摘要和引用不存在；
- 连续多轮压缩、摘要失败、取消、重启恢复；
- 不同 context limit、输出预留和格式化 CLI 估算误差；
- 原文记录可定位、可审计，摘要来源范围可解释。

## 13. 未核验项

- 官方 OpenAI 文档本次未能成功抓取；本文没有用产品文档补强或修正客户端源码结论。
- 未检查托管服务端实现、模型部署版本或 V2 `encrypted_content` 的内部结构。
- 未运行 Codex 或 Trellis 的压缩端到端流程，不能给出摘要准确率、压缩率、成本或延迟数字。
- 公开源码固定于一个提交；其他版本可能有不同阈值、feature stage、provider capability 或持久化策略。
- “摘要以 user role 保存”不等于 OpenAI 官方定义其为用户授权；本文的用户授权边界是面向 Trellis 的安全设计建议。

## 14. 固定源码与提示词来源

所有链接固定在 commit `970111f6cb62cc02fe36a82ea7d71b37a2889c97`。

- [C1] 本地压缩提示词原文：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/prompts/templates/compact/prompt.md#L1-L9>
- [C2] 本地 summary prefix：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/prompts/templates/compact/summary_prefix.md#L1>
- [C3] 本地压缩入口、请求、重试、摘要生成与历史预算：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/compact.rs#L117-L441>  
  本地替换历史见同文件 `L697-L814`。
- [C4] 用户消息收集、summary 边界和 canonical context 注入：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/compact.rs#L590-L695>
- [C5] provider capability 默认与覆盖：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/model-provider/src/capabilities.rs#L33-L54>  
  协议枚举：<https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/model-provider-info/src/capabilities.rs#L20-L27>
- [C6] V2 请求末尾的 compaction trigger：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/compact_remote_v2_attempt.rs#L167-L185>
- [C7] V2 输出校验、64k 保留预算、消息筛选和截断：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/compact_remote_v2.rs#L480-L703>  
  输出完成要求见同文件 `L390-L478`。
- [C8] `ResponseItem::Compaction`、`CompactionTrigger` 与 encrypted content 的协议表示：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/protocol/src/models.rs#L1295-L1321>
- [C9] 压缩触发、phase、provider 分派与 pre-turn 失败保护：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/turn.rs#L201-L241>  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/turn.rs#L672-L842>  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/turn.rs#L1394-L1424>  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/turn.rs#L1557-L1634>
- [C10] 活动窗口、自动压缩 scope、fallback buffer 与 turn-end 阈值：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/context_window.rs#L58-L117>
- [C11] 后台 compaction 的启用条件、candidate 新鲜度与 shutdown：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/async_compaction.rs#L40-L210>
- [C12] 替换活动 history 并持久化 checkpoint：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/mod.rs#L4334-L4517>
- [C13] 工具 call/output normalize 与配对删除：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/context_manager/history.rs#L600-L617>  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/context_manager/history.rs#L685-L694>  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/context_manager/normalize.rs#L21-L241>
- [C14] 失败保留历史、rollout checkpoint 与 summary role 测试：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/tests/suite/compact.rs#L700-L787>  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/tests/suite/compact.rs#L1295-L1401>
- [C15] `TokenBudget` 是无摘要的全新窗口：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/compact_token_budget.rs#L16-L68>
- [C16] feature stage/default、后台压缩阈值和 retained-source feature：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/features/src/lib.rs#L2143-L2171>  
  默认 65 阈值：<https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/config/mod.rs#L228>
- [C17] 配置 schema 与默认 scope：  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/config.schema.json#L8152-L8191>  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/config.schema.json#L7308-L7310>  
  <https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/protocol/src/config_types.rs#L42-L55>

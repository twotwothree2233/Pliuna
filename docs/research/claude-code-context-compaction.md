# Claude Code 上下文压缩：公开机制与提示词研究

研究日期：2026-10-25。本文依据 Anthropic 当前公开的 Claude Code 与 Claude Platform 文档，记录产品可观察行为和明确公开的配置方式。它不是对 Claude Code 内部实现、隐藏系统提示词或模型推理过程的还原，也不替代 Trellis 已确认的产品规范。

## 1. 结论摘要

1. Claude Code 的上下文管理是分层的，不是单一的“到阈值就总结”：会话接近上限时先清理较早的工具输出，必要时再总结对话；`/compact` 可随时手动触发，并可附带保留重点。[S1][S10]
2. 自动压缩在模型上下文和配置窗口附近触发，当前可用 `/autocompact`、`autoCompactWindow` 或 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 调整；不能把某个模型当前的阈值当成所有模型、所有版本的固定值。[S6]
3. 压缩摘要不会自动成为全部事实的唯一副本。Claude Code 持续把消息、工具调用和结果写入 JSONL transcript；恢复已压缩会话时，加载的是最后一次压缩摘要、未总结消息及其后消息，被最后一次压缩总结的历史不会重新装入活动上下文。[S4][S8]
4. 持久指令应放在项目根 `CLAUDE.md`、非路径限定规则或 auto memory 中，因为它们在压缩后从磁盘重新注入；只出现在早期对话里的详细指令可能丢失。[S2][S3]
5. “Compact Instructions”是公开支持的 `CLAUDE.md` 章节名，`/compact` 的焦点说明也是公开接口。但 Anthropic 没有公开 Claude Code 实际发送给模型的完整总结提示词、固定摘要 schema 或内部选择算法。[S1][S7]
6. Hooks 可以观察和介入压缩生命周期：`PreCompact` 能按 `manual`/`auto` 匹配、读取手动 `/compact` 的 `custom_instructions`，并可阻断；`PostCompact` 可通过 `compact_summary` 读取结果；`SessionStart`/`InstructionsLoaded` 可在压缩后重载上下文。[S5]
7. 单个超大文件或工具结果反复把刚压缩的上下文填满时，Claude Code 会报告 thrashing 并停止重试，避免持续浪费 API 调用；恢复手段包括分段读取、带焦点压缩、转到子代理或 `/clear`。[S9]
8. Claude Code 产品压缩与 Claude Platform API 的 Compaction、Context editing 是不同接口层。Claude Code 文档没有声明 `/compact` 等同某个 API 参数；不能把 API 的阈值压缩、后台压缩或工具结果清除功能反推成 Claude Code 的实现细节。[S11][S12]

## 2. 范围与证据边界

本文区分三类陈述：

- **公开产品行为**：官方文档明确写出的命令、事件、输入输出和重载结果。
- **研究推论**：据此提出、但文档没有确认的实现解释；本文会明确标注“推论”。
- **未公开**：内部提示词、完整摘要结构、精确阈值、工具输出选择算法和模型内部决策。

来源快照为 2026-10-25 抓取的官方页面。Claude Code 文档包含多个按版本门控的行为，文中保留文档直接给出的版本号；未给出引入版本的机制，不推测其历史可用性。

## 3. `/compact` 与自动压缩

### 3.1 手动与自动路径

`/compact [instructions]` 的公开语义是“总结到目前为止的对话以释放上下文”，可选参数用于指定总结重点。`/clear` 则是开始空上下文的新会话，不是压缩。[S2]

自动压缩接近上下文上限时运行。文档给出的默认值会因模型和配置而异：例如原生 1M 窗口的若干模型当前约在 967K token 触发；设置 `/autocompact` 可把窗口改为 100K 至 1M 之间的值。这些是文档时点的产品参数，不应固化成通用常数。[S6]

公开的执行顺序是：

1. 清理较早的工具输出；
2. 如果仍需释放空间，总结对话；
3. 保留用户请求和关键代码片段，但早期详细指令可能丢失。[S1][S10]

文档没有公开第 1 步选择哪些工具结果、清理多少、是否按工具类型区别处理。能确认的只是先后顺序和最终目标。

### 3.2 压缩请求与缓存

生成摘要时，Claude Code 发送一个独立请求，重复会话的系统提示词、工具和待总结历史，并在末尾加入总结指令。若前缀缓存仍有效，摘要请求可读取缓存；`/compact` 后对话前缀改变，下一轮需为新摘要重建对话缓存。[S7]

这解释了为什么压缩既有总结成本、又有缓存重建成本。适当做法是在任务自然断点压缩，而不是等到长任务中途自动触发；缓存冷热会显著改变 `/compact` 的实际成本。[S7]

### 3.3 压缩后保留与重载

| 内容 | 压缩后的公开行为 |
| --- | --- |
| 系统提示词、输出风格 | 继续生效 |
| 项目根 `CLAUDE.md`、无 `paths:` 的规则 | 从磁盘重新注入 |
| Auto memory | 从磁盘重新注入 |
| Skill 描述 | 从当前 skills 重建；文档标注需 v2.1.304+ |
| Git 状态 | 若会话开始时载入，则重新读取当前仓库状态 |
| Plan mode 中的计划 | 从磁盘重新注入 |
| 带 `paths:` 的规则、子目录 `CLAUDE.md` | 之后按需重载 |
| 已读/已改文件 | 最多重新读取最近修改的 5 个；单文件超过 5,000 token 时只保留路径引用 |
| 已调用 skill 正文 | 重新注入，但每个 skill 最多 5,000 token、总计最多 25,000 token，超量时先丢最旧的 |
| 后台命令、后台子代理 | 继续运行，并提示 Claude 不要重复启动 |
| 之前由 hooks 注入的上下文 | 与其他对话历史一起被总结 |
| 匹配 `compact` source 的 `SessionStart` hooks | 压缩后重新运行，输出加入压缩后的上下文 |

依据：[S4]。路径限定规则和嵌套 `CLAUDE.md` 在触发文件被访问时进入消息历史，因此也会被后续总结；若某条规则必须跨压缩保留，应移到项目根 `CLAUDE.md` 或去掉 `paths:` 限定。[S4][S3]

## 4. 公开提示词接口与可验证模板

### 4.1 `/compact` 焦点

官方公开的调用形式是：

```text
/compact focus on the API changes
/compact keep only the plan and the diff
```

它们分别用于指定总结重点和排除不再需要的大输出。[S1][S9] 这是用户可见的“附加指令”，不是完整内部总结提示词。

### 4.2 `CLAUDE.md` 中的 Compact Instructions

官方明确建议在项目根 `CLAUDE.md` 中加入名为 “Compact Instructions” 的章节，并可给出以下示例原文：

```markdown
# Compact instructions

When you are using compact, please focus on test output and code changes
```

来源：[S7]。这是可验证的公开示例，但只是内容建议，不是完整系统提示词，也没有承诺模型会逐字执行或形成固定结构。

### 4.3 什么没有公开

本次查阅的官方资料没有公开：

- Claude Code 完整的压缩系统提示词；
- 摘要必须包含的字段、顺序与压缩比例；
- 工具输出清理的具体算法、阈值和不可清理例外；
- 自动与手动压缩在内部提示上的全部差异；
- 压缩模型与主模型是否总是同一个，以及模型选择规则。

因此，网络上以“Claude Code 内部压缩提示词”为名、无一手出处的提取或泄露内容不应作为事实来源。本文不采信此类材料。

## 5. Hooks：可观察、可阻断，但不是摘要编辑器

当前 hooks 文档公开了以下压缩相关事件：[S5]

| 事件 | 可用信息 | 能力与限制 |
| --- | --- | --- |
| `PreCompact` | `trigger: manual/auto`；手动时有 `custom_instructions`，自动时为 `null` | 可用退出码 2 或 `decision: "block"` 阻止压缩。若是在上下文超限错误后的恢复性压缩，阻断会让原请求失败 |
| `PostCompact` | `trigger`、`compact_summary` | 可在压缩完成后记录摘要或更新外部状态；无 decision control，不能改写压缩结果 |
| `SessionStart` | 压缩后以 `source: "compact"` 触发 | 可返回 `additionalContext`；文档说明可用它重注入压缩后上下文 |
| `InstructionsLoaded` | `load_reason` 可为 `compact` | 用于观察指令文件在压缩后重载；不能修改加载内容 |

`PreCompact` 适合自己的自定义指令并不等于能替换总结提示词：它拿到的是触发器与用户传入的焦点，公开控制力主要是允许或阻断。摘要后处理应使用 `PostCompact` 记录，若要在下一轮补充上下文，应从 `SessionStart(source=compact)` 等公开注入通道实现。

Hooks 的通用输入还包含 `transcript_path`，但文档警告 transcript 异步写入，触发时可能落后于内存中的当前轮，因此不能依赖它读取“此刻刚发生”的完整消息。需要当前轮最终回复时应使用对应事件提供的专用字段。[S5]

当前 hooks reference 没有为 `PreCompact`/`PostCompact` 标出引入版本。实现时应对照目标 Claude Code 版本的 changelog 和实际 hook schema，不能假定旧版本支持。

## 6. 原记录、恢复与分支

### 6.1 存储的是完整 transcript，不只是摘要

Claude Code 将每条消息、工具调用和工具结果写入 `~/.claude/projects/<project>/<session-id>.jsonl`。这些记录是明文；工具读到的内容或命令输出中的凭据也会进入 transcript。[S4][S8]

压缩改变的是装入活动上下文的历史，不代表原始 transcript 被删成摘要。恢复会话时，Claude Code 从最后一次 `Conversation compacted` 行继续：加载最后一次摘要、该次压缩未覆盖的消息，以及其后的消息；被该次压缩总结掉的消息不会再次加载。[S4]

JSONL 每行格式是 Claude Code 内部格式，官方明确说明会随版本变化。需要稳定集成时应使用 `/export`、`-p --output-format` 或 SDK，而不是把 JSONL 当作公共协议。[S4]

### 6.2 恢复、分支与清理

- `--continue` / `--resume` 在相同 session ID 下继续并追加消息。
- `--fork-session` / `/branch` 复制当前历史到新 session ID，原会话保持不变。
- `/clear` 开始新会话，旧会话仍可经 `/resume` 找回。
- 默认按 `cleanupPeriodDays` 清理，默认 30 天、最小 1 天；`claude purge` 可提前删除项目状态。

依据：[S4][S8]。

### 6.3 工具输出清理不是 transcript 清除

“先清理旧工具输出”作用于活动上下文，不等同于删除磁盘记录。大工具输出还可被溢出保存到会话的 `tool-results/` 目录；transcript 仍记录该会话的完整消息、调用和结果。[S8][S1]

这是一种有价值的分离：**记录层保存可追溯原物，上下文层保存当前推理所需视图。** 但没有公开证据表明所有被清理的工具输出都能按原样、无成本地重新装入上下文，因此不能承诺“可随时恢复所有工具结果”。

## 7. Thrashing 与失败恢复

当自动压缩成功，但某个文件或工具输出立即多次把上下文重新填满时，Claude Code 会显示 `Autocompact is thrashing: the context refilled to the limit...` 并停止重试，避免浪费 API 调用。[S9]

官方恢复步骤是：

1. 让 Claude 按行范围或函数分段读取超大文件；
2. 运行带焦点的 `/compact`，例如 `/compact keep only the plan and the diff`；
3. 把大文件研究交给子代理，让大读取留在独立上下文；
4. 不再需要旧对话时运行 `/clear`。

依据：[S9]。这说明“压缩失败”至少有两类：总结请求本身失败，以及总结后立即再次超限的 thrashing。实现上下文管理时应有连续重试上限和可诊断的终止状态。

## 8. 与 Anthropic API 压缩、Context Editing 的边界

Claude Platform 官方文档索引把 Compaction 与 Context editing 单列为 API 平台能力，并进一步列出 threshold compaction、background compaction、on-demand compaction、keep recent turns 等 Compaction 页面。[S11]

Claude Code 的文档描述的是一个 agent harness 中的 `/compact`、自动压缩、CLAUDE.md 重载和 hooks 生命周期。[S1][S4][S5] 本次查阅的 Claude Code 文档没有说 `/compact` 调用 Platform API 的某个 Compaction 或 Context editing 参数，也没有把二者定义为同一实现。

因此应保持以下区分：

- **Claude Code `/compact`**：产品命令和 harness 行为，可直接涉及本地 transcript、指令文件、hooks 与恢复语义。
- **Claude Platform API Compaction**：请求级的模型上下文管理能力，具体参数和生命周期由 Platform API 文档定义。
- **Claude Platform Context editing**：另一项 API 上下文管理能力；不能仅凭“也会清除工具结果”就把它视为 Claude Code 内部实现。[S12]

本报告只从官方索引确认 Platform 功能存在并与其页面分离。Platform 页面在当前网络环境被区域门禁拦截，故本文不展开其参数细节，也不以二手摘要补齐。

## 9. 对学习 Harness 的可借鉴建议

以下是研究建议，不是 Trellis 的既定规范，也不改变现有的授权、事实记录和用户意图确认规则。

### 9.1 摘要不是事实、证据或授权的替代品

- 把原始学习证据、用户提交、资源版本、审批记录和授权决定保存在权威存储；摘要只是面向当前 Run 的派生视图。
- 摘要可以丢失原物中的精确措辞和出处，因此不能作为“用户已经批准”“事实已核实”或“成绩已掌握”的证明。
- 恢复时应明确记录本次 Run 使用了哪个摘要版本、覆盖了哪些原始事件、哪些内容未装入活动上下文。
- 删除或压缩摘要不能触发删除原始记录；永久删除仍走独立的用户确认和权限路径。

这与 Claude Code 将完整 transcript 与活动上下文分开的做法相似，但相似性不构成直接复用其实现的依据。

### 9.2 普通 Chat Completions adapter 的边界实验

普通 Chat Completions 通常没有 Claude Code 的原生 hooks、transcript 恢复语义，也没有 Claude Platform 的 Compaction/Context editing 请求参数。adapter 若需要长会话，可把下列能力放在 harness 侧，作为可替换策略而非模型能力假设：

| 可借鉴能力 | 建议 |
| --- | --- |
| 预算观测 | 在每次请求前计算系统、指令、消息、工具结果和输出预留的 token 预算 |
| 工具结果分层 | 先对旧工具输出做确定性裁剪；原始结果仍保存在工具结果或资源存储中 |
| 摘要输入 | 显式记录摘要范围、保留目标和“不得从摘要获得权限”的约束 |
| 摘要输出 | 使用版本化结构，并保留来源事件 ID；解析失败时不覆盖原历史 |
| 非破坏性压缩 | 生成新的活动上下文视图，不删除 transcript 或学习证据 |
| 重试保护 | 若压缩后立即再次超预算，限制连续重试并报告原因 |
| 可恢复性 | 支持回看原记录、从某条事件重新开始，以及保留/删除摘要的明确选择 |
| 权限隔离 | 摘要、工具输出和模型文本都只是内容，不能改变硬性授权或用户确认状态 |

如果 adapter 提供手动“压缩”入口，建议像 `/compact` 一样允许用户给出保留焦点；如果提供自动压缩，应显示触发原因、压缩范围、结果和失败状态。这些是互操作与可解释性建议，不是对 Trellis 的最终接口决定。

## 10. 未公开项与后续验证

尚未由一手资料确认：

- Claude Code 的完整压缩系统提示词和摘要模板；
- 摘要的固定字段、目标长度、舍弃优先级和模型选择；
- 工具输出清理的精确算法、阈值及会话恢复时的重取规则；
- `/compact` 与 Platform API Compaction/Context editing 是否存在任何未公开复用关系；
- `PreCompact`/`PostCompact` 的引入版本，以及不同 Claude Code 版本之间的 schema 兼容范围。

若要继续验证，应针对固定 Claude Code 版本读取 changelog 和本地 hooks schema，并以可公开引用的官方页面复核，而不是运行或引用外部提取源码。

## 来源

抓取日期均为 2026-10-25；链接指向官方 Markdown 页面，页面内容可能随版本更新。

- [S1] Anthropic, Claude Code Docs, “How Claude Code works”: https://code.claude.com/docs/en/how-claude-code-works.md
- [S2] Anthropic, Claude Code Docs, “Commands”: https://code.claude.com/docs/en/commands.md
- [S3] Anthropic, Claude Code Docs, “How Claude remembers your project”: https://code.claude.com/docs/en/memory.md
- [S4] Anthropic, Claude Code Docs, “Explore the context window”: https://code.claude.com/docs/en/context-window.md
- [S5] Anthropic, Claude Code Docs, “Hooks reference”: https://code.claude.com/docs/en/hooks.md
- [S6] Anthropic, Claude Code Docs, “Model configuration”: https://code.claude.com/docs/en/model-config.md
- [S7] Anthropic, Claude Code Docs, “How Claude Code uses prompt caching”: https://code.claude.com/docs/en/prompt-caching.md
- [S8] Anthropic, Claude Code Docs, “Manage sessions”: https://code.claude.com/docs/en/sessions.md 与 “Explore the .claude directory”: https://code.claude.com/docs/en/claude-directory.md
- [S9] Anthropic, Claude Code Docs, “Troubleshooting”: https://code.claude.com/docs/en/troubleshooting.md
- [S10] Anthropic, Claude Code Docs, “Reduce token usage”: https://code.claude.com/docs/en/costs.md
- [S11] Anthropic, Claude Platform Docs index, Compaction pages: https://platform.claude.com/docs/llms.txt
- [S12] Anthropic, Claude Platform Docs index, Context editing: https://platform.claude.com/docs/en/build-with-claude/context-editing

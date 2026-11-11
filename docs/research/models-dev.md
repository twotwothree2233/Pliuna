# models.dev 模型目录调研

状态：研究，不是选型批准、接口承诺或能力验收。抓取日期：2026-10-25（Asia/Shanghai；HTTP 探针主要在 10:44-10:53 UTC）。官方源码固定到 `anomalyco/models.dev@c76f4f5d5380d603789cbd169c21c80bcac1f7fc`，`dev` 分支。线上快照与源码 commit 分开记录。

本次只做有界只读网络探测：没有安装依赖、执行仓库代码、使用 API Key、请求任何模型端点或发送任务材料。报告中的 **事实**、**推断**、**建议**、**缺口** 分开标注。

## 1. 结论

**事实：models.dev 是一个社区维护、MIT 许可的模型规格与价格目录，不是模型厂商的可用性或能力证明。** 官网和 README 都称其为 community-contributed database；公开数据由 TOML 文件生成，目录同时用于 opencode。[S1][S2][S3]

**事实：公开 API 无需认证即可读取，当前 `/api.json` 快照为 232 个 provider、8,929 个 provider/model 行，解压后 5,937,248 字节。** Provider ID、provider 内 model key 和行内 `id` 构成目录主键；另有可选的 `canonical_model_id` 用于关联上游 lab 模型。[O1][S2][S4]

**事实：目录没有通用 `streaming` 能力字段。** v2 源码只有表示“流式事件里是否返回 usage”的 `stream_usage`，它不能被解释为支持流式响应；公开 v1 API 也不发布该字段。[S5]

**推断：它适合作为“自动发现已成功、但服务接口缺失元数据（包括可匹配的容量）”时的候选补充，不适合作为自动发现、授权检查或真实能力测试的替代。** 同一 canonical 模型在不同渠道的价格、上下文、模态和能力可以明显不同；目录自身也说明 relay 的字段可能来自上游或人工整理。[S9][S10]

**建议：Trellis 采用以下边界。**

1. 先查询用户当前渠道的模型列表和元数据；服务实际返回优先。
2. 只对已确认的 preset/provider 身份做 `(provider ID, wire model ID)` 精确匹配。
3. `canonical_model_id` 只用于归属和候选分组，不继承另一个 provider 的参数。
4. 精确 serving 行可以补齐其提供且非零的容量等参数；缺失、`0`、未知或冲突的值不猜，只有仍缺时才要求用户手动补齐。
5. 最终通过针对所选渠道和所选模型的短小合成请求验证流式、工具调用及角色必需格式。
6. 目录刷新只更新参考缓存和待确认变更，不自动改写已保存或占用中的配置。

## 2. 官方归属、版本与线上边界

**事实：官网页面链接的仓库是 `github.com/sst/models.dev`，该地址在探测时返回 HTTP 301，重定向到 `github.com/anomalyco/models.dev`。** GitHub 仓库元数据也报告最终仓库名为 `anomalyco/models.dev`，默认分支 `dev`，非归档、非 fork，许可证为 MIT。[S1][S3][O4]

**事实：固定 commit 的最近提交时间为 2026-10-25T10:26:03Z，提交说明为 `chore(sync): update Kilo model catalog (#11455)`。** 至少从当日的小时级提交和同步工作流看，目录仍在活跃维护。[O4][S11]

**事实：线上 `/api.json` 没有 build commit、generation timestamp 或 schema version 字段。** 因此只能确定“在 2026-10-25 10:46:25Z 读到这份响应”，不能证明该响应由上面固定的源码 commit 精确构建。**推断：两者时间接近且字段能对应，但不应把线上答案视为固定 commit 的可复现构建物。**

**事实：README 中“Specialized model types are omitted by default”在当前源码里具体指默认过滤 `decision`，不是过滤 `image`、`video`、`embedding` 等全部专用类型。** 过滤源码把缺省 `type` 当作 `chat`，默认只排除 `decision`；所以线上默认快照仍能包含 image/video/embedding 等行。[S2][S8][O1]

**事实：本次线上默认 `/api.json` 没有 `decision` 行，但有 image、video、embedding、speech、transcription、reranking、realtime 和极少数显式 chat。** 因而不能因为 `type` 缺失就断定不是聊天模型；但 `type=image` 也不可仅凭目录中出现该模型就把它视为 Chat Completions 主模型候选，只有当实际服务接口和请求协议明确对应图像端点时，才应把它纳入相应 lane。[O1][S8]

**事实：仓库根目录是 MIT License；本报告据此将该目录记录为 MIT 许可的模型目录。** [S3]

## 3. 公开端点、HTTP 与缓存

### 3.1 端点

| 端点 | 用途 | 本次观察 |
| --- | --- | --- |
| `https://models.dev/api.json` | provider 及其 serving 行、价格、能力、API 元数据 | GET 200；232 providers / 8,929 rows；解压 5,937,248 字节 |
| `https://models.dev/models.json` | provider-agnostic lab 模型元数据 | GET 200；606 个 canonical 行；解压 505,653 字节 |
| `https://models.dev/catalog.json` | provider 数据与 lab 数据合在一个响应 | HEAD 200；本次未完整下载，故不报告体积口径 |
| `https://models.dev/model-schema.json` | 由 `$defs.Model` 枚举列出 8,929 个 provider/model ID | GET 200；381,778 字节；不是完整字段 JSON Schema |
| `https://models.dev/logos/{provider}.svg` | provider logo | README 说明存在；本次未取 |

`/model-schema.json` 的 `$defs.Model` 只有字符串枚举，不是对每个模型字段的类型约束。它可以用于 ID allowlist/拼写检查，不能代替 v1 `schema.ts` 或 v2 `schema-v2.ts`。[S2][S4][S5][O3]

### 3.2 认证与响应头

**事实：`/api.json` 和 `/models.json` 在不带 Cookie、Authorization 或 API Key 的情况下返回 200。** 响应含 `access-control-allow-origin: *`，因此可以视为公开只读数据端点，不是按账号授权的模型列表。[O1][O2]

`/api.json` 原样观察到的关键头：

```text
HTTP/2 200
date: Sun, 25 Oct 2026 10:46:25 GMT
content-type: application/json
content-encoding: gzip
cf-cache-status: HIT
access-control-allow-origin: *
cache-control: public, max-age=0, must-revalidate
etag: W/"7eb7e12967d8f6b65d0ac3d1c7aa4403"
```

**事实：解压后 5,937,248 字节，SHA-256 为 `7eb7e12967d8f6b65d0ac3d1c7aa44037a7ddef8a62aaa194b41b3cfafa31889`；本次弱 ETag 的摘要部分与该内容哈希一致。** 这是本次快照的内容标识，不应推断服务承诺 ETag 永远等于 SHA-256。[O1]

**事实：使用 `If-None-Match` 重验证时返回 304。** `Cache-Control: public, max-age=0, must-revalidate` 意味着缓存值不能当作新鲜数据直接使用，必须至少进行一次条件重验证；不适合把旧目录静默当成最新。未观察到 `Last-Modified` 或 `stale-if-error`。[O1]

**事实：`/models.json` 使用相同的 `max-age=0, must-revalidate` 与 ETag 模式，解压后 505,653 字节、606 个 canonical 行。** `/model-schema.json` 的缓存策略不同，为 `public, max-age=3600`、`content-length: 381778`。[O2][O3]

**缺口：本次用 `curl --compressed` 统计的是解压后逻辑大小，没有保留 gzip 线缆字节数；HEAD 对 `model-schema.json` 返回 500，但 GET 正常 200，说明该端点的 HEAD 不能用作可用性探针。**

## 4. 主键、canonical 与真实匹配风险

### 4.1 JSON 形状

**事实：`/api.json` 顶层是 provider ID 到 provider 对象的映射；provider 的 `models` 又是 wire model ID 到模型对象的映射。** 本次 232 个 provider 的 key 均等于 provider 行内 `id`；8,929 个 model key 均等于行内 `id`。[O1][S4]

```json
{
  "<provider-id>": {
    "id": "<provider-id>",
    "models": {
      "<provider-wire-model-id>": {
        "id": "<provider-wire-model-id>",
        "canonical_model_id": "<lab>/<model>"
      }
    }
  }
}
```

模型文件名（去掉 `.toml`）就是 provider 内 model ID，这是官方作者规则；文件名中的 `/` 用子目录表达。[S2][S9]

### 4.2 `canonical_model_id` 的真实语义

**事实：`canonical_model_id` 只在 provider 文件通过 `base_model` 关联 lab 文件时生成。** 它用于把一个 provider-specific ID 归属到上游 lab，不表示该 provider 的调用 ID、价格、限额或能力。[S2][S7][S9]

本次快照：

- 8,929 行中 7,610 行有 `canonical_model_id`，1,319 行没有。
- 7,610 行中有 5,648 行的 provider wire ID 与 canonical 字符串不同；直接拿 canonical 去调用 provider 是错误匹配。
- 有 622 个不同 canonical ID，479 个 canonical ID 对应多个 serving 行，最大一组覆盖 89 个不同 provider。
- 有 1,170 个模型 ID 字符串跨 provider 重复，最多一个字符串出现在 32 个 provider 中。
- 有 53 个 API 中的 canonical ID 在当前 `/models.json` 中没有直接 key；因此也不能假设 canonical 一定能在 lab 目录中解析。[O1][O2]

例如 `alibaba/qwen3.6-27b` 在 `ofox`、`inferx`、`synthetic`、`siliconflow` 等渠道有 30 个 serving 行；本次统计中 context/output、价格、模态、reasoning、structured output 均有差异。[O1]

同一 provider 内也存在 alias，例如 `deepseek-flash` 的 canonical 是 `deepseek/deepseek-v4.1-flash-1017`。本次有 42 个同 provider prefix 的 alias 行。它们代表 provider 的 wire ID 与上游模型归属不同，而不是两个完全等价的免费配置。[O1]

### 4.3 匹配规则建议

**建议：主键必须是精确的 `(models.dev provider ID, provider wire model ID)` 二元组，并保持大小写。** 不按显示名、去掉斜杠、lowercase、去掉日期后缀、最长前缀或 token 相似度自动合并。官方规则明确指出 relay 的模型 ID 与 lab ID 可不同，canonical 用于“不让消费者猜名字”。[S2][S9]

**建议：`canonical_model_id` 可以用于去重展示和搜索分组，但只能从同一精确 serving 行继承该渠道的配置参数。** 没有同渠道 serving 行时，可以把 canonical lab 信息作为“未验证参考”，不能静默作为该代理的 context、tool、structured-output、modal 或 price 真相。

**建议：自定义代理不按相似名称自动匹配。** 自定义服务通常只返回部署名、别名或私有 fine-tune ID；若没有明确 provider preset 和精确 ID，目录只可展示“可能对应”的候选，必须由用户确认，之后才写入来源和覆盖记录。

## 5. 字段、类型与可选性

以下以线上 v1 `/api.json` 的 schema 和本次响应为准；v2 的 TOML 作者格式另有更丰富字段，二者不能混用。[S2][S4][S5]

### 5.1 Provider

| 字段 | API schema | 本次覆盖 | 解释 |
| --- | --- | ---: | --- |
| `id` | 必填 string | 232/232 | 目录 provider key |
| `name` | 必填 string | 232/232 | 显示名，不是认证身份 |
| `env` | 必填 string[] | 232/232 | 环境变量名，不是 key 值或实际认证方式 |
| `npm` | 必填 string | 232/232 | AI SDK 包名/协议线索，不代表可以动态安装执行 |
| `doc` | 必填 string | 232/232 | provider 文档入口，不保证逐行引用当前价格 |
| `api` | 可选 string | 207/232 | base URL 线索；缺失 25 个，不能自动补默认端点 |
| `models` | 必填 object | 232/232 | 该 provider 的 serving 行 |

`env` 可能列出一个或多个变量名，但目录没有说明 header 格式、签名、OAuth、区域或账户权限。**因此认证方式必须来自用户配置和第一方服务文档，不能从 `npm` 或 `env` 推断。**

### 5.2 Model

| 字段 | API schema/取值 | 本次覆盖 | 解读 |
| --- | --- | ---: | --- |
| `id` | 必填 string | 8,929 | provider-specific wire ID |
| `name` | 必填 string | 8,929 | 显示名，不用于匹配 |
| `description` | 必填 string | 8,929 | 自由文本 |
| `type` | 可选 enum | 453 | 缺失按 `chat`；`decision` 默认不返回 |
| `attachment` | 必填 boolean | 8,929 | 从“有非文本输入模态”派生，不是独立文件权限 |
| `reasoning` | 必填 boolean | 8,929 | 声称支持 reasoning |
| `reasoning_options` | 条件可选 array | 6,795 | `reasoning=true` 必须有；含 toggle/effort/budget |
| `tool_call` | 必填 boolean | 8,929 | 声称支持 tool calling，未证明所选代理可用 |
| `structured_output` | 可选 boolean | 6,801 | 缺失表示未知，不是 `false` |
| `temperature` | 可选 boolean | 8,601 | 缺失表示未知 |
| `knowledge` | 可选日期 | 5,223 | 知识截止时间 |
| `release_date` | 必填日期 | 8,929 | 首次公开发布 |
| `last_updated` | 必填日期 | 8,929 | 模型更新时间，不是目录抓取时间 |
| `modalities.input/output` | 必填 arrays | 8,929 | 值为 `text/image/audio/video/pdf` |
| `open_weights` | 必填 boolean | 8,929 | 权重是否公开 |
| `limit` | 必填 object | 8,929 | `context`、`output` 必填，`input` 可选 |
| `cost` | 可选 object | 8,534 | 缺失表示没有可发布的 v1 token 价格，不是免费 |
| `status` | 可选 enum | 978 | `alpha/beta/deprecated` |
| `canonical_model_id` | 可选 string | 7,610 | 上游 lab 归属 |
| `interleaved` | 可选 bool/object | 1,328 | reasoning 字段线索 |
| `provider` | 可选 object | 783 | 可覆盖 `npm/api/shape`，schema 还允许 body/headers |
| `experimental` | 可选 object | 110 | 模式、价格或请求体实验数据 |

**事实：`reasoning_options` 只有在 `reasoning=true` 时出现；本次 6,795 个 reasoning 行全部满足，false 行没有该项。** 选项类型包括 `toggle`、`effort` 和 `budget_tokens`。[S4][O1]

**事实：本次 `type` 分布为：缺失 8,476；显式 `chat` 8、`image` 180、`embedding` 82、`video` 69、`speech` 43、`transcription` 38、`reranking` 17、`realtime` 16。** 源码中缺失 `type` 默认 `chat`，默认 API 过滤又明确只排除 `decision`，所以“缺 type 即排除”是错误的。[S8][O1]

**事实：`limit.context` 与 `limit.output` 在每个 v1 行中都存在，但各有 155/258 行为 `0`；`limit.input` 只有 1,699 行存在。** 许多零值行是 image/video/audio/embedding，schema 允许 0，同步说明也把 zero-limit 称作 placeholder。**推断：对文本角色应把 `0` 当作“未知或不适用”，不能当作可发送零 token 的真实容量。**[S4][S9][S10]

**事实：`attachment` 与“输入模态中存在非 text”在本次 8,929 行完全一致。** 因此它表示附件输入模态，不表示文件上传权限、大小上限或代理是否真正转发附件。[S2][O1]

**事实：公开 API 没有 `streaming` 字段。** v2 作者 schema 中的 `stream_usage` 只控制流式事件是否包含 usage，且没有出现在 v1 `/api.json`；不能用它判断支持或拒绝流式请求。[S5][O1]

**事实：`provider` 子对象在本次实际只出现 `npm`、`api`、`shape`；schema 还允许 `body` 和 `headers`。** 这些内容可能是请求改写线索，但不是值得信任的可执行配置。**建议：不自动执行目录中的 URL、包名、body 或 headers；不按 `env` 自动读取凭据；绝不把凭据发往 models.dev。**[S4][S9]

## 6. 价格、单位与阶梯

**事实：API 公开的 `cost.input` 与 `cost.output` 是 USD / 百万文本 token。** 缓存读写、reasoning 和音频 token 价格也是按百万 token 表示的数值；公开 API schema 没有价格单位字段。[S2][S4][S6][S9]

**事实：v2 文件能表达更丰富的计量单位与条件。** `unit` 可取 `token/character/image/megapixel/second/minute`；`overrides` 可按 context、service tier、region、日期、分辨率等条件覆盖；`multipliers` 再乘价格。[S5][S9]

**事实：v1 `/api.json` 会丢掉不能表达为文本 token 价格和 context tier 的信息。** 转换源码明确只发布 per-token text cost，媒体-only、per-character、per-second/image 等留在 v2；service tier、region、时间与 multipliers 也不进入 v1。因此不能把 `/api.json` 当作完整账单模型。[S6]

本次 `/api.json`：

- 8,534 行有 `cost`，395 行没有。**缺失不是 0 元。**
- 566 行所有数值价格均为 `0`；它可能代表免费、订阅计划、内部价格或未定价，API 本身没有给原因。**建议：`0` 只显示为目录原值，不自动判为免费可用。**
- 795 个模型、863 个 tier 条目含 `cost.tiers`；本次所有 tier 的 `tier.type` 都是 `context`。
- 另有 613 行含 `context_over_200k`。该字段在 schema 中存在，但没有出现在 README 的 v1 API 字段说明里；本次不把它当作唯一或完整的阶梯规则。

**事实：v1 context tier 的 `tier.size` 在生成 v2 时被解释为 `context > size`。** 因而对一条阶梯不能仅凭 `size` 断言是 `>=` 还是 `>`；当前官方转换源码给的是严格大于。[S7]

**建议：Trellis 只用目录价格做带来源和时间的估算。** 在实际请求 usage 已知前不把估价写成账单；媒体、订阅、service tier、区域和长上下文条件未完整覆盖时明确显示“无法估算”，不改预算和历史记录。

## 7. 更新、维护与验证机制

**事实：目录采用小时级 provider-specific 同步。** GitHub Actions 使用 `cron: "17 * * * *"`；每个 provider 单独运行 `bun models:sync`、`bun validate`，有变化时创建/更新独立 PR。同步模块按字段写入，保留其不拥有的手工字段。[S10][S11]

**事实：自动同步并不等于所有字段来自 provider 第一方 API。** 有的 sync module 把 provider API 当权威来源；有的只同步价格或 availability，保留 output limit、reasoning controls 等人工字段；另有 provider 因 API 不足而只创建 missing-model issue。[S10]

**事实：人工/自动合并路径遵守 schema 和 v1 兼容门禁。** PR 必须通过 `bun validate`，并要求保护已发布的 v1；同步通过 `bun validate` 后才建 PR。README 与 contributor 规则还规定，v1 内的数据修正应明确注明来源、在 PR 中列出并由 maintainer 审批。[S2][S9][S11][S12]

**事实：一手来源说明不是 API 字段。** 作者规则建议在 TOML 顶部注释记录来源、在 PR 正文引用 pricing/docs/API；但这些注释不会出现在 `/api.json`。API 也没有逐行 `source_url`、`verified_at`、`confidence` 或 `commit`。[S9][O1]

**事实：`last_updated` 是模型更新时间，不是目录记录抓取时间。** README 对它的定义是“most recent update date”，作者规则也把它与 release date 并列。唯一可信的新鲜度证据是本次 HTTP `Date`、ETag、内容哈希和本地 `fetched_at`。[S2][S9][O1]

**推断：维护活跃，适合做参考目录；但 moderation 是社区/自动化流程，不能替代独立抽样核验。**

## 8. 对 Trellis 方案的适配

### 8.1 数据优先级

建议固定如下优先级，低层不得覆盖高层：

1. 当前渠道实际模型列表及显式元数据。
2. 用户手动补充/覆盖。
3. 同 provider、同 wire ID 的 models.dev serving 行。
4. 仅作展示的 canonical/lab 参考信息。

“实际模型列表”若只返回 ID，不能把它解释为完整能力；只表示模型存在。服务实际响应缺少 context/output 等容量时，可由同 provider、同 wire ID 的精确 serving 行补齐正数容量；流式、工具调用和角色必需格式仍按目录提示与真实测试处理，目录也未提供的残项才需用户手动补充。

### 8.2 自动发现与精确匹配

1. 用用户配置的渠道和凭据查询该服务自己的模型列表；凭据不得发往 models.dev。
2. 只有 preset 明确对应一个 models.dev provider ID 时，才把 discovery ID 送到该 provider 的 `models` map 做精确查找。
3. 若 provider 未识别、base URL 是自定义代理、返回 ID 为部署名/别名，则不自动匹配，只显示需确认的候选。
4. 不对跨 provider 同名行做“随便选一个”的填补；不采用 fuzzy name、日期前缀或 canonical 字符串直接调用。
5. 记录匹配证据：`source=models.dev`、provider ID、wire ID、payload SHA-256、ETag、抓取时间和目录行 `last_updated`。

### 8.3 字段合并

| 字段 | 自动发现有值 | 自动发现缺失 |
| --- | --- | --- |
| context/input/output | 使用服务值 | 使用精确 serving 行中的正数；仍缺才手动 |
| modalities | 使用服务值 | 可由 serving 行提示，但视觉/PDF 需真实测试 |
| tool_call | 使用服务值 | 目录 true 仅作候选；主模型最终须测试 |
| structured_output | 使用服务值 | 目录缺失当未知；角色需要时测试或手动 |
| reasoning/options | 使用服务值 | 目录选项作候选，不阻塞非 reasoning 角色 |
| cost | 使用服务值/账单字段 | 目录值仅用于估算，可缺失 |
| streaming | 没有目录字段 | 必须真实流式合成测试 |

尤其不能把：

- `structured_output` 缺失当成 `false`。
- `limit.context=0` 当成真实零上下文。
- `cost` 缺失当成免费。
- `tool_call=true` 当成当前代理已验证。
- `canonical_model_id` 当成 provider 的 wire ID 或参数继承点。
- `stream_usage` 当成 `streaming`。

### 8.4 关键缺失与手动补充

建议先以服务显式值和精确 serving 行的可用值补齐；目录也未提供、为零或与现有值冲突时，才把下列项目作为用户补充或验证项，而不是猜值：

- 主推理：服务显式值或精确 serving 行中的正数 context/output；仍缺再手动。实际流式、工具调用和输入模态仍须验证。
- 工具调用：当前 wire ID 的真实结构化 tool call 返回，而不是普通文本中看起来像命令。
- 压缩/审批：角色需要的响应格式和容量。
- 视觉/PDF 角色：实际附件输入能力和大小约束；`attachment=true` 不足以证明成功。
- structured output：角色依赖时，在目标渠道发起最小 schema 请求验证。

补齐前保留已发现的字段，仅要求用户填写精确 serving 行也未能提供的缺失/冲突项；不启用相应角色。

### 8.5 目录缓存与配置锁

**建议：缓存原始响应和规范化索引，但不要用刷新结果直接改配置。**

- 保存 `etag`、HTTP `Date`、`fetched_at`、解压后 SHA-256、provider/model 索引。
- 每次刷新带 `If-None-Match`；200 才替换快照，304 只更新检查时间。
- `max-age=0` 不提供后台可直接依赖的新鲜窗口；定期刷新失败时，继续使用最后成功快照并显式标旧。
- 按用途可请求 `type=chat` 缩小载荷，但保留“默认只排 decision”的官方语义；不要期望过滤结果能证明某模型是 chat-only。
- 对新发现差异只生成待审 diff。被 Run 占用的模型/渠道不应用变更；已有手动覆盖优先。
- 目录暂时不可用不阻断已验证的现有配置；不要把过期价格或参数伪装成实时数据。

## 9. 剩余缺口

- 线上 API 没有部署 commit/build 时间，无法证明它与固定源码 commit 是同一构建。
- 没有通用 streaming 字段；必须实际测试。
- 没有逐记录来源、置信度或验证时间；无法从 API 追溯具体声明到模型厂商页面。
- `limit` 的 `0` 没有统一机器可读语义；只能按角色上下文视为不可用/未知，不能断言数据损坏。
- v1 API 丢失媒体单位、多种条件价格、service tier、region、multiplier 和部分 cache 细节；不能作为完整计价器。
- `provider.api`、`npm`、`provider.body/headers` 是目录数据，不是可直接信任的执行配置。
- 本次没有下载完整 `/catalog.json`，没有验证其与 v1 `/api.json` 的字段差异。
- 本次没有调用任何真实模型 API，因此没有独立验证工具、流式、structured output、视觉或上下文极限。

## 来源

动态 API 的数值来自本次快照，不把未来同 URL 内容当作固定证据；固定源码均指向本次读取的 commit。

- [S1 官网](https://models.dev/)
- [S2 README（API、字段、来源说明）](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/README.md#L13-L300)
- [S3 MIT LICENSE](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/LICENSE)
- [S4 v1 API schema](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/packages/core/src/schema.ts#L250-L400)
- [S5 v2 作者 schema（capabilities、limits、API、cost）](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/packages/core/src/schema-v2.ts#L262-L712)
- [S6 v2 到 v1 的转换（字段与价格丢失边界）](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/packages/core/src/translate.ts#L140-L345)
- [S7 canonical/base model 与 context tier 生成](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/packages/core/src/generate-v2.ts#L270-L580)
- [S8 默认类型过滤](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/packages/core/src/filter.ts#L47-L51)
- [S9 作者与来源验证规则](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/AGENTS.md#L1-L357)
- [S10 同步机制与 provider 权威性差异](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/sync.md#L3-L360)
- [S11 小时级同步工作流](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/.github/workflows/sync-models.yml#L1-L125)
- [S12 PR 校验工作流](https://github.com/anomalyco/models.dev/blob/c76f4f5d5380d603789cbd169c21c80bcac1f7fc/.github/workflows/validate.yml#L1-L33)
- [O1 `/api.json` 动态快照](https://models.dev/api.json)（2026-10-25T10:46:25Z）
- [O2 `/models.json` 动态快照](https://models.dev/models.json)（2026-10-25T10:50:51Z）
- [O3 `/model-schema.json` 动态快照](https://models.dev/model-schema.json)（2026-10-25T10:50:57Z）
- [O4 GitHub 仓库元数据](https://api.github.com/repos/anomalyco/models.dev)（2026-10-25 探测）

## 交叉核验所用的本地缓存

这些路径是本次探测留下的可复核原始材料；`/tmp` 可能在重启后消失。

- `/tmp/trellis-models-dev.json`：主代理保存的 `/api.json` 解压快照，5,937,248 字节，SHA-256 `7eb7e12967d8f6b65d0ac3d1c7aa44037a7ddef8a62aaa194b41b3cfafa31889`
- `/tmp/trellis-models-dev.headers`：主代理保存的 API 响应头
- `/tmp/models_dev_api_full.json`：本调研独立保存的同内容 API 快照，哈希相同
- `/tmp/models_dev_api_full.headers`：本调研保存的 API 响应头
- `/tmp/modelsdev_models.json`：`/models.json`，505,653 字节，SHA-256 `3411c8c5207ba05bd26c6920e0c75f3a28f2d9dc4acc9bac51b43fe724d36f66`
- `/tmp/modelsdev_schema_probe.txt`：`/model-schema.json`，381,778 字节，SHA-256 `4df6b94e4d7573b8f79e90e4f8fe5681eb5ad90b2aae2168ef13aee61041c19e`
- `/tmp/models_dev_tree.json`：固定 commit 的 Git tree（12,552 entries）
- `/tmp/modelsdev_README.md`、`/tmp/modelsdev_LICENSE`
- `/tmp/modelsdev_schema.ts`、`/tmp/modelsdev_schema_v2.ts`
- `/tmp/modelsdev_translate.ts`、`/tmp/modelsdev_generate_v2.ts`、`/tmp/modelsdev_filter.ts`
- `/tmp/modelsdev_AGENTS.md`、`/tmp/modelsdev_sync.md`
- `/tmp/modelsdev_sync_models.yml`、`/tmp/modelsdev_validate.yml`
- `/tmp/models_dev_repo.json`、`/tmp/models_dev_commit.json`

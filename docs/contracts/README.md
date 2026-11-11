# 当前运行契约

契约以当前源码和测试样例为唯一机器来源。
本目录保留解释、调用边界与检查入口。

## 机器来源

| 内容 | 当前文件 |
| --- | --- |
| JSON Schema 2020-12 | [core.schema.json](../../src/shared/contracts/core.schema.json) |
| SQLite 初始结构 | [001-core.sql](../../src/shared/contracts/001-core.sql) |
| 开发默认值 | [development-defaults.json](../../src/shared/contracts/development-defaults.json) |
| 生成的 TypeScript 类型 | [contracts.generated.ts](../../src/shared/contracts.generated.ts) |
| 宿主扩展接口 | [types.ts](../../src/shared/types.ts) |
| 模型工具的服务端参数 | [tools.ts](../../src/runtime/model/tools.ts) |
| 动态对象与操作指南 | [operation-contracts.ts](../../src/runtime/model/operation-contracts.ts) |
| 主模型、审批、摘要提示词 | [prompts](../../src/runtime/model/prompts/) |
| Schema 正反例 | [manifest.json](../../tests/fixtures/contracts/manifest.json) |

## 专题

- [对象与四工具](objects-tools.md)：参数形态、分页和结果。
- [managed-v1](managed-v1.md)：界面、状态迁移与导出分类。
- [执行与存储](execution-storage.md)：状态、修订和提交边界。
- [接入契约](integration.md)：宿主、模型与插件接口。
- [校验方式](validation.md)：当前契约和文档检查。

## 版本与校验层

核心 Schema 与插件协议目前使用 `0.1`。
数据库 schema_version 为 `1`。
默认值文件版本为 `dev-0.2`。
持久化工作摘要采用 InstalledSummary 的 `version: 2`。

Schema 校验后，宿主仍检查对象、来源和当前版本。
界面还经过 HTML/CSS、引用和表单语义检查。
插件能力另有输入输出 Schema 与权限检查。
这些检查均发生在实际执行入口。

`$defs.summary` 仍存在于核心 Schema。
当前上下文压缩安装使用[InstalledSummary](../../src/runtime/model/context.ts)。
模型输出为纯文本摘要，持久化元数据由宿主生成。

## 维护方式

修改 Schema 后运行 `pnpm generate`。
修改契约时同步调整当前测试样例和行为测试。
在对应专题补充接口含义及兼容边界。
文档不再复制 Schema、SQL 或角色提示词。

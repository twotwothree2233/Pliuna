# 核心实现契约草案

状态：七轮批量访谈的行为与开发默认值已确认；字段编码、SQL 和模板是据此起草的推荐实现，不是已运行的 harness。版本：0.1，2026-10-26。

## 制品与职责

| 制品 | 用途 |
| --- | --- |
| [对象与四工具](objects-tools.md) | 操作目录、引用、返回与端到端示例 |
| [受管理界面](managed-v1.md) | bundle、行为、样式及预览/导出规则 |
| [执行与持久化](execution-storage.md) | 状态转换、竞态、事务、上传和恢复 |
| [接入与模型](integration.md) | IPC、插件方法、模型映射与提示词 |
| [开发默认值](development-defaults.json) | 已确认数值的唯一机器可读清单，尚未性能验收 |
| [核心 schema](schemas/core.schema.json) | JSON Schema 2020-12；通过 `$defs` 验证各契约 |
| [示例清单](examples/manifest.json) | 正例、结构拒绝例；不冒充行为测试 |
| [初始 SQL](sql/001-core.sql) | 核心链路结构草案，只在临时数据库验证 |
| [校验脚本](verify.py) | 文档链接、schema 示例、SQL 基础约束检查 |
| [校验记录](validation.md) | 本次实测范围及没有测试的部分 |

现有专题继续记录完整产品行为，本目录集中可实现的编码。协议 v0.1 中早期方法和字段例子仍是概念草案；与本目录字段不同处，联调使用这里的统一编码，不混用两套消息。若行为出现冲突，先修正文档，不以编码草案覆盖用户决定。

## 覆盖边界

核心 schema 包含四工具、managed-v1、局部数据 schema、manifest、能力描述、审批结果、摘要、IPC 子集、上传开始/分块及 Monty 返回值。动态能力输入、跨引用校验、DOM/CSS、生命周期与授权不能仅靠 JSON Schema 判断。

初始 SQL 覆盖任务、执行、动作、审批、界面、答案、资源和恢复保护；模型配置 UI、完整插件依赖目录及平台凭据实现不在该迁移草案中。插件方法目录和模型配置字段表已定义，尚未全部转成独立 schema。不能将本目录称为完整可发布 SDK。

自定义 JavaScript profile 的公共边界沿用任务界面专题，具体容器及桥接配置仍需实验。能力未验证时拒绝启用；存在静态表示不等于脚本执行已支持。Monty native ABI、真实清理、类型回传、浏览器负面测试、文件系统崩溃测试和跨平台安装均待实现。

## 检查方式

在安装了 `jsonschema` 的 Python 环境运行 `python3 docs/contracts/verify.py`；未安装时脚本明确失败，不跳过 schema 验证。该验证器只服务文档制品，不改变生产 TypeScript/Ajv 技术栈。SQLite 使用 Python 标准库在内存数据库执行草案，不修改用户数据库。

工程候选为 pnpm workspace、electron-vite、electron-builder、better-sqlite3、json-schema-to-typescript；精确版本在创建工程、验证 Electron 原生兼容性后锁定。本次不创建业务工程或宣称依赖兼容已通过。

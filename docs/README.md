# Trellis 项目文档

更新：2026-11-11。本文档按当前工作区代码整理。

Trellis 是本地任务工作空间。
任务保存请求、回复、界面、材料与执行记录。
模型和插件通过宿主接口操作这些对象。

## 阅读入口

| 目标 | 文档 |
| --- | --- |
| 理解当前功能 | [范围与使用路径](harness/scope.md) |
| 查进程和模块边界 | [架构](harness/architecture.md) |
| 安装、构建和本地检查 | [开发指南](development-readiness.md) |
| 查 IPC、模型和插件协议 | [协议入口](protocol-v0.1.md) |
| 查运行契约和样例 | [契约索引](contracts/README.md) |
| 修改界面与主题 | [前端规范](design/frontend-design.md) |
| 统一对象名称 | [领域术语](harness/architecture.md#领域术语) |

## 当前实现

- Electron 主进程管理窗口、文件对话框和模型配置文件。
- 独立 runtime 写入任务数据库并协调执行。
- 请求队列绑定模型选择与材料导入结果。
- 主模型通过 list、read、write、call 四工具工作。
- 工作摘要、正文分页、请求用量和来源记录可查询。
- managed-v1 界面支持声明式交互和版本化替换。
- 插件支持固定包导入、信任、依赖计划和任务启用。
- 材料导入、PDF 文本提取和静态 HTML 导出已接入。
- 存储提供恢复点、只读检查和分阶段清理。
- 两套桌面打包流程均拦截本地代理元数据。

## 专题导航

- [运行与排队](harness/runtime.md)、[上下文管理](harness/context-management.md)。
- [工具与资源](harness/tools-resources.md)、[输入与材料](harness/input-processing.md)。
- [任务界面](harness/surface.md)、[静态导出](harness/export.md)。
- [模型服务](harness/model-services.md)、[安全与审批](harness/security-approval.md)。
- [插件接入](harness/plugin-integration.md)、[Monty 计算](harness/code-execution.md)。
- [存储与恢复](harness/storage-recovery.md)、[测试与交付](harness/testing-delivery.md)。

## 唯一契约来源

| 内容 | 当前文件 |
| --- | --- |
| Schema | [core.schema.json](../src/shared/contracts/core.schema.json) |
| 数据库结构 | [001-core.sql](../src/shared/contracts/001-core.sql) |
| 集中默认值 | [development-defaults.json](../src/shared/contracts/development-defaults.json) |
| 生成类型 | [contracts.generated.ts](../src/shared/contracts.generated.ts) |
| 宿主扩展请求 | [types.ts](../src/shared/types.ts) |
| 实际模型工具参数 | [tools.ts](../src/runtime/model/tools.ts) |
| 角色提示词 | [prompts](../src/runtime/model/prompts/) |
| 契约正反例 | [测试样例](../tests/fixtures/contracts/manifest.json) |

文档解释当前行为，机器契约直接引用这些文件。
文档目录不再维护 Schema、SQL 和提示词副本。
平台支持边界见[交付说明](harness/testing-delivery.md)。

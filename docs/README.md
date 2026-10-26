# Trellis Harness 文档

更新：2026-10-26。当前交付为设计文档与 Monty 冒烟原型，尚无 harness 实现；已补齐核心契约草案，文档验收条目不代表运行时测试已通过。

## 从哪里开始

- 理解产品：先读[范围与需求](harness/scope.md)和[架构与技术栈](harness/architecture.md)。
- 准备开发：查看[开发契约缺口](development-readiness.md)，区分已确认行为、尚缺制品和后续启用门槛。
- 实现具体模块：按下方专题进入；协议字段与示例集中在[协议草案](protocol-v0.1.md)，可使用其主题导航。
- 查设计依据：阅读专题引用的研究和决策笔记，不将历史候选方案当作当前规范。
- 准备界面实现：先读[前端设计参考](design/frontend-design.md)，确认六套主题、token 与组件状态；它是视觉参考，不承担运行时行为。

## 文档职责与状态

| 文档 | 职责 | 不承担的职责 |
| --- | --- | --- |
| 本入口 | 导航、状态和基线摘要 | 不逐轮复制访谈结论 |
| 前端设计参考 | 六套主题、颜色/字体 token 与组件视觉基线 | 不承担正式前端实现、运行时行为或验收 |
| harness 专题 | 当前行为规则、约束与模块说明 | 不宣称尚未完成的实现或验收 |
| 协议 v0.1 | 跨模块契约、字段草案与消息示例 | 未 schema 化的示例不等于完整 SDK |
| 开发契约缺口 | 汇总待补制品、归属及启用门槛 | 不批准未决方案或缩减首版范围 |
| 测试与实施计划 | 验收场景及推荐交付阶段 | 场景清单不等于测试结果 |
| 研究报告 | 来源、研究时点与技术证据 | 不自动覆盖已确认规则 |
| .agents/notes | 取舍理由、历史与替代关系 | 被替代提案不是并行有效的规范 |
| CONTEXT.md | 领域术语 | 不重复实现规范 |

状态按以下含义阅读：**已确认**是用户认可但不一定已实现；**推荐实现**仍需评审与验证；**待决**不得偷偷补成默认产品行为。

专题记录当前规则，协议表达对应的跨模块约束；若存在不一致，应显式修正文档，不能任选其一实现。协议章节编号和已有锚点保持稳定，方便追溯；最新决定已同步的内容不靠章节先后来推断效力。核心机器可读 schema、SQL 和模板已有[契约草案](contracts/README.md)，尚未覆盖完整 SDK 或实现。

## 已确认基线

- 只开发单用户本地 harness 和最小测试夹具，不开发真实学科插件、插件市场或教学流程引擎。
- Electron + TypeScript、React + Vite、独立 Node.js runtime、SQLite、应用私有资源存储和系统凭据；JSON Schema 2020-12 + Ajv，类型由 schema 生成；Vitest + Playwright。
- 单主 agent，模型入口只有 list/read/write/call；任务持有界面与数据，插件提供能力和领域流程，不因来源获得内容所有权。
- 普通界面采用 managed-v1 的 HTML/CSS 与受限声明式行为；任意脚本不能进入共享 DOM，独立脚本区域未通过验证不得启用。
- 插件是用户信任的本地代码，task/global 控制的是宿主接口范围，不是 OS 沙箱。Monty 仅为一次性内置计算工具，无网络和宿主文件访问。
- 手动审批与独立模型辅助审批并存；具体动作批准不产生长期许可。重启恢复数据、不续跑旧执行；未知结果不自动重放。
- 所有业务新提交独立登记，不按参数、内容或客户端标识去重；查询原 ID 不执行。版本校验、事务和旧许可失效仍有效。
- 在线任务界面为主，可导出自包含静态 HTML；导出不运行自定义脚本或补生成内容。
- 界面视觉基线采用 Layout A 三栏与六套主题；默认浅色石墨、深色暮色，其余四套可选。原型仅作视觉参考，正式前端尚未实现。

以上仅为导航摘要，完整限制以对应专题为准。

## 设计参考

- [前端设计参考](design/frontend-design.md)：六套主题、token 与组件视觉基线，是正式实现时的对照入口。
- [设计 Token 与组件规范](design/assets/design-tokens.html)：22 个颜色 token 六列对照、字体/几何、组件契约与六套主题样本。
- [六风格对照](design/assets/style-gallery.html)：六套视觉方向的筛选稿。
- [交互原型 v3](design/assets/prototype-v3.html)：主题切换与关键流程的交互参考，不作为实现基线。

这些文件是视觉参考，不是生产前端代码；运行时行为以[任务界面](harness/surface.md)为准。HTML 资产均为自包含文件，直接用浏览器打开。

## 阅读顺序

1. [范围与需求](harness/scope.md)：交付什么、不交付什么、用户路径与验收。
2. [架构与技术栈](harness/architecture.md)：进程、模块接口、平台适配与存储。
3. [Agent 运行时](harness/runtime.md)：单主 agent、流程说明、上下文、取消与恢复。
4. [工具与资源](harness/tools-resources.md)：最小工具集、显式输入输出与资源生命周期。
5. [任务界面](harness/surface.md)：统一 DOM、受控呈现与隔离脚本。
6. [安全与审批](harness/security-approval.md)：硬限制、手动审批与独立模型审批。
7. [插件接入](harness/plugin-integration.md)：静态注册、分层访问、可信本地进程与双向 JSON-RPC。
8. [协议 v0.1](protocol-v0.1.md)：插件、消息、提交和事件的跨模块契约草案。
9. [代码执行选型](harness/code-execution.md)：Monty 原生后端、tool 职责与正式启用门槛。
10. [存储与恢复](harness/storage-recovery.md)：草稿、不可变答案/资源、历史只读、重启与永久删除。
11. [测试与实施计划](harness/testing-delivery.md)：测试夹具、分阶段交付与验证门槛。
12. [上下文管理](harness/context-management.md)：分层缩减、同步压缩、插件保留说明、失败与用户控制。
13. [独立材料导出](harness/export.md)：静态单文件、内容分类、快照预览、完整性及受控保存。
14. [输入与材料解析](harness/input-processing.md)：导入入口、批次失败、能力选择、派生结果与受控预览。
15. [模型服务与调度](harness/model-services.md)：自动发现、测试启用、占用锁、目录更新及跨任务限流。

[领域术语](../CONTEXT.md)用于统一语言，不承担实现规范职责。

模型目录研究：[models.dev 接口、字段与匹配边界](research/models-dev.md)。已核查公开数据与固定提交源码；研究不代表渠道能力验收或 adapter 已实现，精确匹配与字段来源规则已确认，adapter仍待实现。

## 实现与验证状态

- Monty 已选原生后端并完成 8 项快速检查；生产配额、生命周期、权限及 Electron 分发仍有[启用门槛](harness/code-execution.md)。
- [models.dev 调研](research/models-dev.md)已完成公开数据和固定提交源码核查；接入字段映射已有草案，真实渠道能力尚未验证。
- [上下文压缩研究](research/context-compaction.md)已完成；摘要 schema、候选模板及开发预算已有草案，效果仍待实测。
- [开发契约缺口](development-readiness.md)集中记录剩余制品；[测试计划](harness/testing-delivery.md)保留完整验收场景。

七轮批量对齐已完成并获准落盘；Action 状态、恢复旧数据本人确认及开发默认值已确认。完整制品及验证边界见[核心实现契约](contracts/README.md)，剩余工程工作见[开发就绪与剩余验证](development-readiness.md)。

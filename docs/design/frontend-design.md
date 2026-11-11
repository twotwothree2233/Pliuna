# 当前前端设计与交互规范

当前 UI 实现以 React 组件和 style.css 为准。
本文件记录现有布局、主题与交互。

## 工作区

左栏为任务，中栏为内容，右栏为 Agent。
[WorkspaceLayout](../../src/renderer/src/WorkspaceLayout.tsx)管理侧栏和分隔线。
几何约束定义在[workspace-layout.ts](../../src/renderer/src/workspace-layout.ts)。

| 项目 | 当前值 |
| --- | --- |
| 默认左栏 / 右栏 | 220px / 300px |
| 左栏 / 中栏 / 右栏最小宽度 | 180px / 360px / 280px |
| 分隔线 | 6px |
| 默认窗口 | 1320 × 860 |
| 最小窗口 | 390 × 600 |

侧栏可以关闭，并从内容边缘重新打开。
空间不足时先收起右栏，再收起左栏。
窄窗口使用抽屉，输入节点和草稿继续保留。
分隔线支持拖动、双击恢复和键盘调整。

## 内容与执行分工

中栏通过 TaskReply 读取最近保存的回复。
最新指令折叠展示，长消息按对象正文续读。
近期事件窗口不承担完整消息历史。

Agent 栏展示当前阶段、最近工具动态和待处理项。
审批、材料、压缩与停止操作按需打开详情。
最近动态来自真实记录，最多显示三项。
完成文案描述本次执行的结果。

## 设置与快捷键

设置覆盖工作区，返回时保留当前任务。
分类为外观、模型、审批、插件、存储和关于。
当前实现见[ApplicationSettings](../../src/renderer/src/ApplicationSettings.tsx)。

- 新建任务使用平台主修饰键加 N。
- 设置使用平台主修饰键加逗号。
- macOS 使用 Command，其余平台使用 Ctrl。
- 弹层处理 Escape、焦点约束与背景隔离。

## 当前主题 Token

主题使用根节点 data-theme 属性。
默认跟随系统，浅色为 graphite，深色为 dusk。
手动主题记入 pliuna-theme 本地偏好。

下表取自当前[style.css](../../src/renderer/src/style.css)。
完整语义 Token 也直接在该文件维护。

| 主题 | --bg | --fg | --accent | --radius |
| --- | --- | --- | --- | --- |
| graphite / 石墨 | #ffffff | #23262a | #35617d | 9px |
| paper / 暖纸 | #fbf8f0 | #33302a | #a1502c | 5px |
| midnight / 深夜 | #171a1e | #e4e8ec | #7fb0f0 | 10px |
| dusk / 暮色 | #23282a | #dfe5e2 | #9ec7b2 | 11px |
| moss / 苔原 | #f7f9f3 | #2c362e | #4c7150 | 14px |
| blueprint / 蓝图 | #ffffff | #101214 | #1f3cff | 0px |

组件使用背景、前景、分隔线、选中态和强调色语义变量。
深色主题声明 color-scheme: dark。
暖纸使用衬线阅读字体，蓝图保留直角与等宽细节。

## 文字大小

文字档位为 90%、100%、110%、125%、140%。
偏好保存在 pliuna-text-size，默认 100%。
主题、栏宽和导出描述保持各自独立。

[文字缩放](../../src/renderer/src/text-size.ts)使用 --text-scale。
受管理 View 的绝对字号也经过显示层转换。
存储中的 bundle 和原始导出样式保持原值。

## 状态与可访问性

按钮和输入提供禁用、焦点与错误状态。
拖动分隔线和快捷键使用真实平台判断。
异步操作保留状态反馈、取消和重新查询入口。
未知结果通过原记录查询，不由 UI 自动重发。

相关测试：[工作区](../../tests/electron/workspace-layout.spec.ts)、[设置](../../tests/electron/application-settings.spec.ts)、[文字大小](../../tests/electron/text-size.spec.ts)、[Agent](../../tests/electron/agent-conversation.spec.ts)。

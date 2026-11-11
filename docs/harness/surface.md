# 任务界面与内容历史

Surface 保存 View 集合及布局。
View 保存当前 bundle、输入状态和修订。
managed-v1 的细节见[界面契约](../contracts/managed-v1.md)。

## 当前能力

- View 新建、替换和删除。
- 受约束的布局分组与权重。
- 声明式输入、文本、可见性、切换和提交。
- 原始草稿与已提交作答分离。
- 不可变界面历史和来源快照。
- 分页展示与历史内容查询。

正式 runtime 默认开放替换入口。
诊断开关可关闭替换、删除和布局更新。
入口仍检查审批、宿主确认和版本关系。

## 显示与隔离

Renderer 将每个 View 放进独立 Shadow DOM。
宿主先解析和检查 HTML、CSS、表单及引用。
完整 HTML 文档会转换成可嵌入呈现片段。
脚本、导航和外部加载入口被拒绝。

当前内容页另展示最近保存的任务回复。
回复和最新指令通过稳定消息 ID 分页读取。
近期执行事件与完整消息正文分开查询。

## 输入保存

草稿写入绑定 view_revision 与 state_revision。
数字控件保留未完成的文本输入。
提交时检查完整格式并保存规范值。
答案同时绑定准确的界面历史版本。

客户端输入保存、表单提交和界面替换互相协调。
切换设置、调宽栏位和窄屏抽屉保留输入节点。
未知保存结果需要重新查询版本。

## 替换与确认

preserve 要求状态兼容版本一致。
reset 提供新初始值，并要求宿主明确确认。
删除 View 也检查准确的 state_revision。

同 Run 的自动编辑资格由宿主检查。
其他修改或布局操作按单动作审批。
提交前再检查版本、来源和确认有效期。
整个操作批次在数据库事务中完成。

## 历史与证据

历史保存 bundle、草稿和声明的来源快照。
来源可包含准确任务数据版本和直接资源。
宿主不递归扩展任意关联。
快照表示当时可见资料，不代替内容真实性判断。

相关实现：[surface-transition](../../src/runtime/surface-transition.ts)、[evidence](../../src/runtime/evidence.ts)、[view-resources](../../src/runtime/view-resources.ts)。
相关测试：[界面替换](../../tests/unit/view-replacement.test.ts)、[布局](../../tests/electron/workspace-layout.spec.ts)、[连续阅读](../../tests/electron/task-reading.spec.ts)。

# managed-v1 界面契约

当前只启用 managed-v1 渲染 profile。
结构以核心 Schema 的 bundle 定义为准。
实现入口为[managed.ts](../../src/runtime/managed.ts)。

## Bundle

Bundle 必须包含以下字段：

| 字段 | 含义 |
| --- | --- |
| profile | 当前为 managed-v1 |
| html、css | 界面描述 |
| state | Schema、初始值及 compatibility_version |
| forms | 明确的表单及字段集合 |
| behaviors | 宿主支持的声明式行为 |
| references | 同任务资源及对象引用 |
| export | 带来源与类别的静态导出片段 |

输入可以是内联 bundle，也可以引用同任务 JSON 资源。
资源中的描述仍受相同容量和语义校验。
提交前会再次核对资源身份和版本绑定。

## 渲染边界

每个 View 在独立 Shadow DOM 中呈现。
HTML、SVG、MathML 和 CSS 保留浏览器呈现能力。
宿主解析结构并拒绝主动执行与外部加载入口。

- 禁止脚本、事件处理器和嵌入浏览上下文。
- 禁止外部样式、资源请求和原生表单导航。
- 图片只使用已声明且验证过的同任务 PNG/JPEG。
- 本地片段引用及 ID 会按 View 作用域改写。
- 原生 top-layer 控件和正 tabindex 被拒绝。
- 结构深度和元素总数受集中默认值限制。

实现采用主动行为阻断和 View 隔离。
文档不维护旧版标签、CSS 属性或选择器白名单。

## 声明式行为

当前行为为 input、text、visible、toggle、class_toggle、submit。
行为引用固定 JSON Pointer 和确定的元素 ID。
宿主检查元素、Schema、控件类型和表单关系。

草稿允许保留数字输入的原始字符串。
提交时再解析完整数字并按字段 Schema 校验。
答案保存 raw 与规范值，以及准确的历史版本。

## 界面变更

surface.update 支持四种子操作：

- view.create。
- view.replace。
- view.remove。
- layout.set。

请求绑定 surface revision 和相关 View revision。
替换可选择 preserve 或 reset 状态迁移。
preserve 检查兼容版本和 state_revision。
reset 会要求明确的宿主确认，即使草稿为空。

已有对象的变更按动作资格进入审批。
宿主另行检查未保存输入和版本变化。
整批变更在事务中提交，并保存不可变历史。

## 导出与个人内容

片段类别包括 learning、answer、feedback、mixed_personal、unclassified。
个人内容需要 personal_binding。
绑定指向已保存的 answer_id 及原 view_history_id。
未保存草稿不能充当该绑定。

片段可选择元素或独立的静态 HTML/CSS。
宿主检查片段重叠、引用和个人快照关系。
导出流程见[静态导出](../harness/export.md)。

相关测试：[界面基础](../../tests/unit/managed.test.ts)、[替换](../../tests/unit/view-replacement.test.ts)、[历史 top-layer](../../tests/unit/view-top-layer-history.test.ts)、[证据](../../tests/unit/evidence.test.ts)。

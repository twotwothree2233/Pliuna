# 当前插件接入

插件以固定目录包导入，再独立处理信任与启用。
配置状态保存在 plugin-control.sqlite。

## Manifest 与包

manifest_version 和 protocol_version 均为 `0.1`。
贡献项可为 workflow、skill、tool、presentation、resource、evaluation。
包声明 task 或 global 访问级别。

后端可使用明确 command/args，或应用自带 app-node。
app-node 使用打包应用的 Node 运行环境。
后端入口和贡献文件必须位于固定包内。

包扫描拒绝不安全路径、链接和越界结构。
当前限制为 256 文件、128 目录、12 层深度。
单文件最多 4 MiB，总体最多 16 MiB。
实现见[package.ts](../../src/runtime/plugins/package.ts)。

## 导入到启用

1. 主进程取得用户选择的来源目录。
2. 宿主校验并安装私有固定副本。
3. 有本地后端的包由本人确认信任。
4. plan 解析依赖、已启用状态和能力要求。
5. enable 绑定计划 fingerprint 并复查状态。
6. 用户按任务选择主 workflow。

导入、信任、启用和启动进程分别记录。
全局级包需要独立的跨任务确认。
只加载内容不会自动授予执行权限。

## 运行与双向 RPC

宿主按实例启动插件进程并执行 initialize。
握手绑定包身份、实例、任务和能力列表。
消息使用换行分隔的 UTF-8 JSON-RPC 2.0。

工具执行通过 tools.execute 派发。
插件可查询对象、读取字节、提交动作和调用子能力。
回调方法及 Schema 见[接入契约](../contracts/integration.md)。

宿主校验当前实例、原调用和有效任务范围。
嵌套调用有深度、队列、超时和取消约束。
原调用结果通过 tools.get 查询，不自动重放。

## 变更、上传与来源

插件变更走动作注册和审批流程。
界面先暂存，再由宿主发布。
分块上传按 offset、长度和拥有者检查。
派生记录绑定原资源、工具调用及输出结果。

停用、撤权、任务停止或重启会废止旧执行资格。
清理仍在进行时，实例不能重新用于新工作。
进程退出前的迟到结果不获得提交许可。

## PDF 参考插件

[PDF 插件](../../reference-plugins/pdf-text/manifest.json)使用 app-node 后端。
能力要求一个同任务 PDF resource_id。
输出是新文本资源和工具报告的页索引。
它不提供 OCR、网页加载或 PDF 脚本执行。

PDF 默认限制见[集中配置](../../src/shared/contracts/development-defaults.json)。
输入最多 16 MiB、200 页，文本最多 8 MiB。
应用最多两个提取、同任务最多一个。

相关测试：[插件包](../../tests/unit/plugin-packages.test.ts)、[调用](../../tests/unit/plugin-calls.test.ts)、[RPC](../../tests/unit/plugin-rpc.test.ts)、[PDF](../../tests/unit/pdf-material.test.ts)。

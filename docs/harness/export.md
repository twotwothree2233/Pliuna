# 当前静态 HTML 导出

导出从固定选择生成可离线阅读的单文件 HTML。
导出不会启动新模型请求或补写学习内容。

## 内容选择与分类

用户按目录选择当前 View、历史片段和已保存作答。
片段分类来自 bundle 的 export 声明。
learning 内容与个人内容使用不同校验条件。

answer、feedback、mixed_personal 需要 personal_binding。
绑定指向准确的作答及其原界面历史。
草稿和未分类片段不能自动充当个人快照。

## 后台预检

export.check.start 固定输入和资源快照。
后台 worker 检查实际静态生成结果。
状态使用 check_id 查询，并支持取消。

输入变化后，预检结果会失效。
界面分批读取问题和完整性状态。
检查作业不跨应用重启继续运行。
只读 View 检查也可通过 export_check 视图访问。

## 生成与预览

export.prepare 创建受保护的导出作业。
生成在后台 worker 中完成。
用户先看实际预览与遗漏列表，再决定保存。

生成结果移除脚本、输入控件和主动导航。
媒体从被验证的资源嵌入。
静态片段保留明确类别和来源边界。
输出文件大小上限为 256 MiB。

## 保存与未知结果

主进程通过保存对话框取得目标。
覆盖已有文件需要单独确认。
先发布临时文件，再核对目标身份和作业有效性。

作业阶段包括 preparing、preview、saving 和终态。
中断或失去保存结果时进入 interrupted/unknown。
按原 operation_id 核查，不自动重复保存。
导出保护在结果明确或显式解决前保留。

## 完整性提示

预检、生成和保存状态分别记录。
有遗漏时，部分保存需要明确确认。
源内容变化后重新选择或重新检查。
导出成功只描述所选内容的静态文件结果。

相关实现：[export-check](../../src/runtime/export-check.ts)、[export-generation](../../src/runtime/export-generation.ts)、[static-export](../../src/runtime/static-export.ts)、[主进程保存](../../src/main/export-save.ts)。
相关测试：[异步预检](../../tests/unit/export-check-async.test.ts)、[历史预检](../../tests/electron/export-history-check.spec.ts)、[导出保存](../../tests/unit/export-save.test.ts)、[个人内容](../../tests/electron/evidence-bundle-export.spec.ts)。

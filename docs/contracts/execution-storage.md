# 执行与持久化契约

数据库结构来自[001-core.sql](../../src/shared/contracts/001-core.sql)。
执行协调入口为[RuntimeStore](../../src/runtime/store.ts)。

## 状态集合

| 对象 | 当前状态 |
| --- | --- |
| Task | active、stopping、stopped、deleting |
| Request | queued、confirmation_required、started、cancelled、rejected |
| Run | running、waiting、completed、failed、cancelled、interrupted |
| Action | registered、waiting、executing、ended |
| Call | registered、waiting、executing、finalizing、ended |

每个任务最多一个 running/waiting Run。
Run 的 wait_reason 表示审批、模型排队或必要清理。
结束意图通过 intended_terminal 保存。
清理未确认前，Run 可以继续保持 waiting。

## 审批维度

- decision：pending、approve、deny。
- validity：valid、expired、revoked。
- handling：evaluating、awaiting_human、resolved。

辅助模型的 escalate 结果转为等待人工。
批准记录与当前可执行资格分别保存。
提交时重新检查主体、版本、有效期和来源。

## 独立提交与修订

每次新业务提交产生独立的宿主记录。
相同载荷不会按内容或客户端标识合并。
查询已有 ID 只读取原结果。

数据对象固定创建时的 Schema。
替换和删除使用 expected_revision。
View 草稿另外使用 expected_state_revision。
相同 Run 的自动编辑资格仍需有效标记。

## 文件与数据库提交

资源正文先在私有存储发布并登记 staging。
宿主核对长度、内容身份和对象保护状态。
业务引用与 staging 提交在数据库事务中连接。
未提交内容进入必要清理记录。

SQLite 使用外键、WAL 和 synchronous FULL。
运行时是任务数据库的唯一业务写入者。
模型配置文件由主进程单独管理。

## 启动与未知结果

启动时为 runtime 生成新 epoch。
旧 Run 进入中断或原定终态，旧许可失效。
旧队列请求取消，旧调用按派发记录分类。
已保存内容保留，业务执行不自动续跑。

主进程超时可能只失去返回结果。
此时应重新读取快照或原操作记录。
重新提交属于新的独立业务操作。

## 恢复与维护

恢复点、数据库选择和导出使用独立控制记录。
维护先取得 reservation，再保存输入和确认动作。
恢复后重新绑定业务数据库并废止旧执行身份。
故障期间保留受保护资源和可核查记录。

完整流程见[存储与恢复](../harness/storage-recovery.md)。
相关测试：[崩溃写入](../../tests/unit/storage-crash.test.ts)、[恢复](../../tests/unit/restore.test.ts)、[清理关闭](../../tests/unit/recovery-shutdown.test.ts)。

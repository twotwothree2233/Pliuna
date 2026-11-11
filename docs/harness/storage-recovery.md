# 当前存储、恢复与清理

RuntimeStore 是业务数据库的唯一写入者。
数据默认位于 ~/.trellis。
数据库选择、保护与维护状态另有控制记录。

## 数据组成

| 内容 | 当前位置或管理者 |
| --- | --- |
| 初始业务数据库 | trellis.sqlite；恢复后由 journal 选择 |
| 资源正文 | resources 目录和资源记录 |
| 插件副本与配置 | plugins 目录、plugin-control.sqlite |
| 恢复点 | recovery 目录及恢复控制记录 |
| 恢复选择与退役记录 | RestoreJournal |
| 导出作业与保存目标 | export-control.sqlite |
| 模型连接与凭据 | 主进程 settings.json、auth.json |

目录和控制文件在启动时检查身份与私有权限。
未知或损坏状态会阻止写入并保留现场。
不同控制数据库承担各自事务与恢复职责。

## 正常发布

资源先写入私有文件，并记录 staging。
业务事务提交资源、引用及相关状态。
失败暂存通过必要清理队列收敛。
必要清理与用户发起的维护回收分别管理。

运行时重启使旧执行与许可失效。
数据仍可查询，旧业务不会自动续跑。
结构版本不受支持时，启动拒绝直接迁移。

## 恢复点与恢复

维护入口先取得有期限的 reservation。
客户端按预约范围保存未提交输入。
创建恢复点或恢复旧点需显式确认。

恢复流程核对数据、资源及插件保护关系。
复制、切换和回滚候选由控制记录追踪。
切换后重新绑定 runtime 的数据库连接。
恢复旧数据不会复活旧执行。

## 清理分层

| 维护类型 | 当前边界 |
| --- | --- |
| 必要清理 | 处理中断发布与执行收尾 |
| 受限 GC | 预览后回收允许范围内的暂存与候选 |
| 副本退役 | 显式释放受保护的旧数据库副本 |
| 正式资源退役 | 检查引用、恢复点、导出及副本保护 |

正式资源清理需要独立预览和本人确认。
任务删除后的资源仍可能受到历史保护。
失败按原维护 operation_id 查询和重试。
不会把未知文件直接当作可删除孤儿。

## 只读检查

storage.inspect 在独立 worker 中执行。
支持增长、资源总览和单资源检查。
作业有状态查询和取消入口。
检查不自动取得恢复、删除或回收许可。

相关实现：[recovery](../../src/runtime/recovery.ts)、[journal](../../src/runtime/restore-journal.ts)、[resource-cleanup](../../src/runtime/resource-cleanup.ts)、[inspection](../../src/runtime/storage-inspection.ts)。
相关测试：[恢复故障](../../tests/unit/restore-crash.test.ts)、[资源回收故障](../../tests/unit/resource-cleanup-crash.test.ts)、[存储检查](../../tests/unit/storage-inspection.test.ts)。

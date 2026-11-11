# 当前架构与模块边界

应用使用 Electron、TypeScript、React 和独立 runtime。
业务数据库只有 runtime 写入。
窗口、原生文件选择和配置文件由主进程管理。

## 进程分工

| 层 | 实现入口 | 职责 |
| --- | --- | --- |
| 主进程 | [main/index.ts](../../src/main/index.ts) | 窗口、IPC、原生对话框、配置落盘 |
| 预加载 | [preload/index.ts](../../src/preload/index.ts) | 固定 request 桥接与平台标识 |
| Renderer | [renderer/main.tsx](../../src/renderer/src/main.tsx) | 工作区、界面状态及用户确认 |
| Runtime utility process | [worker.ts](../../src/runtime/worker.ts) | 请求分发、数据库与执行协调 |
| 检查与导出 worker | [导出预检](../../src/runtime/export-check-worker.ts)、[生成](../../src/runtime/export-generation-worker.ts)、[存储检查](../../src/runtime/inspection-worker.ts) | 后台计算、固定快照及只读分析 |
| Monty worker | [monty/worker.ts](../../src/runtime/monty/worker.ts) | 一次性受限计算 |
| 插件进程 | [plugins/process.ts](../../src/runtime/plugins/process.ts) | 可信本地后端与双向 RPC |

窗口启用 contextIsolation、sandbox 和 webSecurity。
Renderer 关闭 Node 集成。
宿主禁止额外窗口和页面导航。

## Runtime 模块

| 模块 | 职责 |
| --- | --- |
| [store.ts](../../src/runtime/store.ts) | 对象、事务、审批和执行总协调 |
| [request-queue.ts](../../src/runtime/request-queue.ts) | 请求材料绑定及启动时复查 |
| [model](../../src/runtime/model/) | 模型适配、上下文、容量和请求记录 |
| [plugins](../../src/runtime/plugins/) | 包、权限、派发、回调和派生来源 |
| [managed.ts](../../src/runtime/managed.ts) | Bundle、HTML/CSS 和表单校验 |
| [storage-lifecycle.ts](../../src/runtime/storage-lifecycle.ts) | staging、发布与必要清理 |
| [recovery.ts](../../src/runtime/recovery.ts) | 恢复点与维护预约 |
| [restore-journal.ts](../../src/runtime/restore-journal.ts) | 数据库选择和恢复控制记录 |
| [export-control.ts](../../src/runtime/export-control.ts) | 导出状态、目标和资源保护 |

进程控制统一经过[platform](../../src/platform/)适配层。
Windows 原生模块提供 ACL 和 Job Object 辅助能力。

## 数据与配置

默认数据目录由[application-data.ts](../../src/main/application-data.ts)确定。
初始业务数据库名为 trellis.sqlite。
恢复后由控制记录选择当前业务数据库。

资源、插件包与恢复副本存放在应用私有目录。
恢复、导出和插件配置使用独立控制数据库。
settings.json 与 auth.json 由主进程管理。
这些文件不进入桌面安装包。

## 启动与关闭

启动先核对目录归属、数据库及控制记录。
异常控制状态会关闭写入并保留数据。
正常启动废止旧 epoch 的执行和许可。

主进程对 runtime 崩溃执行有界重启。
退出时先请求必要清理，确认后结束进程。
清理未确认时保留显式错误和保护状态。

## 平台门槛

原生目标来自[native-targets.json](../../src/shared/native-targets.json)。
目前只有 darwin-arm64 的 Monty runtimeVerified 为 true。
其余目标通过各自候选构建与平台测试逐步验证。
目录存在目标包不改变该执行门槛。

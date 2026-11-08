# Agent Note: Windows 原生私有权限性能适配

Status: proposed

## Problem

指定 Win11 主机的运行时启动约 16.7 秒。
10 次真实 ACL 检查约占 99%，超过既有截止。
每次启动 PowerShell 的开销导致真实首启延迟。
原有身份、权限与元数据拒绝边界必须保留。

## Proposal

以有界原生短进程处理已验证的本地 NTFS 常用路径。
产品接入前，先在指定主机完成 Node/Electron 差分门槛。
助手先加入父进程持有的 Job，再执行任何权限业务。
保留原同步接口及 15000ms 强制终止边界。

仅在句柄身份、类型及链接数核对后读取安全描述符。
仅已知不等价时请求写权限，句柄操作不重新按路径写入。
精确比较受保护 DACL、用户/SYSTEM、FullControl 和继承。
等价时零次安全描述符与属性写入，不回写时间。

owner/group/SACL 不随 DACL 修复改变。
SQLite 应用级 owner 锁、POSIX 分支和 ctime 校验保持原样。
已知不支持形态在写入前选旧后端，未知与失败直接拒绝。
不改变持久化格式，不迁移旧目录 B，不开放计算。

## Historical note audit

- [文件持久化](../../implemented/architecture/2026-11-07-platform-file-persistence.md)部分重叠。
  本篇替代常用 Windows 权限后端的选型理由。
  原篇继续持有路径、发布与恢复约束，接入时互链。
- [进程生命周期](../../implemented/architecture/2026-11-07-managed-process-lifecycle.md)部分重叠。
  复用原 Job 接口及最后句柄关闭清理，不改监督协议。
- [桌面打包](../../implemented/architecture/2026-11-07-unified-desktop-packaging.md)部分重叠。
  只补必需助手资产，测试版不进入载荷。
- [精确身份](../../implemented/architecture/2026-11-07-exact-file-identities.md)部分重叠。
  复用现有规范十进制身份，不新增编码或迁移。
- 其余活跃提案无相同权限后端决定，保留原状态。

## Alternatives considered

- 保留 PowerShell 无需新原生资产，但实测开销已阻塞原截止。
- 进程内 N-API 调用开销最低，但同步调用缺少同等强制中断边界。
- 缓存权限结论改动较小，但无法发现外部权限变化。
- 无条件重写 DACL 实现简单，但会改变后代 ctime。
- 扩大超时能让测试继续，但不减少用户首启延迟。

## Acceptance criteria

先通过 Node/Electron 身份、语义差分、零写和 Job 探针。
再补适配器、目录包必需项及安全/故障回归。
同机 20 个全新目录记录启动分布，目标 p95 小于 5 秒。
原文件 hook、调用、生命周期及 GUI 超时不变。
完整文件、恢复关闭、源码及包内 GUI 分别报告。

## Risks

新增 Windows 可执行资产需要结构、架构与依赖检查。
NTFS 之外及特殊 ACE 只在写入前选择旧后端。
任何身份、查询、协议或复验未知均保持拒绝。
普通用户、安装签名、共享盘与断电仍是独立验收范围。

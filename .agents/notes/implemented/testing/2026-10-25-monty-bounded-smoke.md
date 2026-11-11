# Agent Note: Monty 发布包的有界快速验证

Status: implemented

## Problem

此前 Monty 结论来自文档与仓库，不能证明 npm 发布物在当前机器上的实际 API 和限制行为。用户要求使用 DeepSeek 子代理快速验证，但没有要求建设完整 harness 或完成安全选型。

## Decision

在独立 prototypes/monty-smoke 目录使用精确锁定的 @pydantic/monty 1.3.0 原生包。每个用例使用独立 Node 子进程与 12 秒外部截止时间；执行会话只运行一次，不开放挂载或宿主调用，限制时间、内存和打印输出。分配测试只请求有界的 20 MB，不尝试无界 OOM。

用例检查确切返回值与错误，文件读取使用宿主可读的合成 canary，而不是把不存在路径的错误误判为隔离。主代理检查代码并独立重跑。结果与未覆盖范围见 [实测报告](../../../../docs/research/monty-smoke-results.md)。

## 历史审计

[最小 Harness 提案](../../proposed/architecture/2026-10-25-minimal-local-harness.md) 仍持有产品架构取舍。其“尚未批准原型”是先前时点事实，本篇记录后续批准的验证，不将候选改成正式选型，也不改写原提案决定。现有任务界面提案与本次执行验证无直接重复。

## Alternatives considered

- 直接安装完整 Electron 原型：能覆盖发布链，但超出快速验证范围，打包签名明确留作后续门槛。
- 继续只读文档：成本低但无法确认发行物，改用实际发布包并保存版本、锁文件与运行证据。
- 用不存在文件验证隔离：简单但 ENOENT 不能证明拒绝权限，改用仅含合成数据的现存 canary。

## Consequences

8 项检查在 Darwin arm64、Node 22.23.1 上通过，并由主代理重跑确认。获得基础执行与受限操作的具体证据，不是完整攻击测试。原型可用 npm run smoke 重现，未创建根项目依赖。

无 Electron 打包、WASM、其他系统、RSS 硬限额、取消竞态或进程泄露审计；外部强制终止分支未触发。正常清理异常被原型捕获，因此不能用测试通过证明所有销毁路径可靠。目录保留可丢弃原型，不是生产实现；当前目录非 Git 仓库，未创建提交或分支。

## 后续决定

后续用户已确认选型，见 [Monty 选型决定](../../proposed/architecture/2026-10-25-monty-runtime-selection.md)。本篇冒烟证据与未验证项不因此升级为安全验收。

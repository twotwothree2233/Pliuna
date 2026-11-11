# Monty npm Smoke Results

> 后续决定（2026-10-25）：用户已确认采用 Monty 原生后端作为首版内置计算工具的集成基线，完整验收仍待完成。见 [当前选型](../harness/code-execution.md)。本文保留研究/实测时点的结论，不改写历史证据。

状态：有界功能冒烟结果，不是安全验收、攻击测试或生产选型批准。运行日期：2026-10-25。

本次没有信任研究文档中的 API 描述，而是从 npm 实际安装并读取
`@pydantic/monty@1.3.0` 的 README、TypeScript 声明和安装后的平台包，然后运行
独立原型 [prototypes/monty-smoke](../../prototypes/monty-smoke/README.md)。

## 1. 结果

**8/8 个用例通过。** 完整机器输出保存在
[run-results.json](../../prototypes/monty-smoke/run-results.json)，原型说明在
[README.md](../../prototypes/monty-smoke/README.md)。

实际环境：

| 项目 | 实测值 |
| --- | --- |
| npm 发布版本 | `@pydantic/monty@1.3.0`（`latest`） |
| 平台包 | `@pydantic/monty-darwin-arm64@1.3.0` |
| 原生运行时 | `monty-runtime 1.3.0` |
| Node / npm | `v22.23.1` / `10.9.8` |
| OS / 内核 | macOS Darwin `25.4.0` |
| CPU | `arm64` |
| 运行命令 | `npm run smoke`（结束时 `PASS: 8/8`） |

安装与锁定命令：

```sh
cd prototypes/monty-smoke
npm install --no-audit --no-fund
npm run smoke
```

`package.json` 使用精确版本 `1.3.0`，没有 `^` 或 `~`；`package-lock.json`
固定了主包与平台包的 integrity。主包 integrity 为
`sha512-cYnJMQxz4qzJp3irBFO6Sjntm42tqwIkbhraoWwa27gowyst+hEVlcgU8w2xN+tFTwnEHGUmnfJyMr2wXpT6lQ==`。
没有创建或修改 Trellis 根 `package.json`。

## 2. 实际安装物 API

安装后的 README 和声明与本次调用方式一致：

- `Monty.create()` 创建 native pool。
- `pool.checkout({ limits })` 创建 session；session 默认可跨多次 `feedRun` 保留变量。
- `session.feedRun(code, { inputs, printCallback })` 执行一次 feed。
- `CollectString(maxBytes)` 是宿主侧打印收集器，有独立字节上限。
- pool 支持 `requestTimeout`、`maxCheckoutsPerWorker`、
  `feedDurationLimitGrace` 和 `turnDurationLimitGrace`。
- checkout 的 `ResourceLimits` 支持 `maxFeedDurationSecs`、`maxTurnDurationSecs`、
  `maxMemory`、`maxRecursionDepth`、`maxSuspensions` 和
  `maxTotalSleepSecs`。

因此测试没有依赖早期文档或未发布的接口。本次只验证 native 后端，没有验证
`@pydantic/monty/wasm`。

## 3. 用例与精确观测

每个用例在独立 Node 子进程中运行，并设置 12 秒外部截止时间。外部进程组在
超时时会被 `SIGKILL`；它不是沙箱本身，也不限制子进程 RSS。正常完成时，用例
均关闭 session 和 pool。

所有 guest 执行都只启用显式 `inputs` 与宿主侧 `CollectString`。没有启用
`mount`、`externalLookup`、`os` callback 或 `externalModules`。

1. **PASS `arithmetic_data_input`**：输入
   `{"values":[2,3,5],"offset":7}`，返回严格等于 `17`；捕获 stdout 严格等于
   `total=17\n`。
2. **PASS `fresh_execution_isolation`**：第一个 session 写
   `retained_probe = 41` 后关闭；第二个新 session 读取它得到
   `NameError: name 'retained_probe' is not defined`。worker ID 从 `1` 变为 `2`；
   `maxCheckoutsPerWorker: 1` 时未观察到跨执行变量保留。
3. **PASS `host_file_canary`**：宿主进程中确认原型目录内的合成 canary 文件可读且
   内容完全匹配；guest 对该现存文件执行 `open(...).read()` 得到
   `PermissionError: Permission denied: 'prototypes/monty-smoke/.runtime/host-canary.txt'`。
   已知 canary 内容没有出现在 guest 可观察数据中。结论不依赖不存在路径的
   `ENOENT`。
4. **PASS `host_env_canary`**：子进程宿主环境确实包含显式合成 sentinel；guest
   `os.getenv(...)` 得到
   `RuntimeError: 'os.getenv' is not supported in this environment`。
   sentinel 没有出现在 guest 可观察数据中。
5. **PASS `import_denials`**：新 session 分别 `import socket` 和
   `import subprocess`，精确得到
   `ModuleNotFoundError: No module named 'socket'` 与
   `ModuleNotFoundError: No module named 'subprocess'`。这仅说明 Python import
   能力未提供，不是网络包审计。
6. **PASS `feed_time_limit`**：`while True: pass` 在
   `maxFeedDurationSecs: 0.2`、`maxTurnDurationSecs: 0.2` 下于约 201 ms 失败，
   首次子代理运行的精确错误为
   `TimeoutError: feed time limit exceeded: 200.01875ms > 200ms`。
7. **PASS `allocation_limit`**：在已知启用 `maxMemory: 8000000` 且外部进程有
   12 秒截止时间的前提下，只请求一次有界的 20,000,000 字节字符串分配；精确得到
   `MemoryError: memory limit exceeded: 20042457 bytes > 8000000 bytes`。
   没有尝试无界 OOM。
8. **PASS `stdout_limit`**：`CollectString(64)` 捕获 201 字节打印时精确得到
   `MemoryError: memory limit exceeded: 201 bytes > 64 bytes`，失败后保留输出为
   空字符串。该上限按声明属于宿主侧 collector，不占用或替代 worker
   `maxMemory`。

外部截止时间和进程组清理逻辑已经接入每个用例，但本次 8 个用例都在截止时间前
正常结束，因此没有实际走到外部 `SIGKILL` 分支。

主代理检查脚本后独立重跑，同样 8/8 通过；当前 JSON 为最近一次运行证据，具体计时随运行变化。

## 4. 边界解释

- 本次结果只证明这些具体输入下的包 API 行为，不能外推为完整 Python 兼容性、
  资源安全或对恶意代码的隔离保证。
- `maxMemory` 是 worker allocator 计量，不是进程 RSS 或操作系统内存上限。
- native worker 子进程提供崩溃隔离，但不等于容器、VM、seccomp 或独立 OS 用户。
- guest 文件与 env 测试各使用一个合成 canary，不是全量信息泄露测试。
- 没有发起真实网络包，也没有做包级网络审计；socket/subprocess 用例仅是 import
  拒绝测试。
- 所有 worker 均通过用例代码正常关闭。当前命令沙箱不允许读取 `ps` 进程表，
  因此没有另行做 orphan-process 审计。

## 5. 未验证项

- Electron GUI、native addon 打包、ASAR/unpack、签名、公证和离线安装均未验证；
  **Electron packaging unverified**。
- WASM 后端、浏览器 Worker、Node worker-thread 行为未验证。
- Linux、Windows、macOS x64 均未验证，只测了 Darwin arm64。
- 外部 12 秒截止时间实际杀死卡死进程组的故障路径未触发。
- 取消、并发 checkout、worker crash 恢复、超时后的 worker 退役、pool 饱和和
  shutdown race 未验证。
- 深递归、复杂源码、大量小分配、返回值总量、复杂返回类型及结果/输出联合预算
  未验证。
- 文件路径变体、符号链接、其他 OS API、`os.environ` 其余接口及宿主导入绕过
  未验证。
- 启动延迟、峰值 RSS、包增量和跨后端性能没有测量。

本次没有阻塞项。结果足以说明发布包 `1.3.0` 在上述口径下具备基础一次性执行、
显式输入、变量隔离、宿主文件/env 拒绝、受限 import、时间限制、内存拒绝和
stdout 上限行为；不足以据此宣称安全验收完成。

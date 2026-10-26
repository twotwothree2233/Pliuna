# Monty 代码执行沙箱候选研究

> 后续决定（2026-10-25）：用户已确认采用 Monty 原生后端作为首版内置计算工具的集成基线，完整验收仍待完成。见 [当前选型](../harness/code-execution.md)。本文保留研究/实测时点的结论，不改写历史证据。

状态：研究，不是选型批准、实现或安全验收。研究日期：2026-10-24。

本次读取 Pydantic Monty 官方仓库，固定提交 `9000dc6cfaffa34a652c5d8e33a55b7cee58c251`。该提交的 JavaScript 包清单版本为 `1.3.0`，不等于已经核实同版本 npm 发布物与仓库完全一致。本次没有安装运行、性能测试、Electron 打包或攻击测试。[S1][S6]

## 1. 结论

**Monty 与 Trellis 的一次性、显式输入输出、禁止宿主文件与网络访问、无需 Docker 的基础代码执行 tool 高度契合，值得进入优先验证名单。** 它填补了此前 QuickJS/WASM 与 Pyodide 之间的选择：用 Python 子集执行基础计算和数据处理，但不携带完整 CPython 科学计算生态。[S1-S4，架构判断]

不能将它理解成完整 Python、任意 pip 包运行环境，或者天然满足全部要求的成品 tool。它是由 Rust 编写的语言级沙箱；最终权限取决于宿主开放了什么能力，输出持久化、单次生命周期、取消和整体资源预算仍由 Trellis 负责。[S2-S5]

当前官方 API 已经具有池化、状态保持、文件挂载、宿主对象以及 WASM 后端，不能依据项目早期介绍推断“只支持表达式”“没有类”“不能使用文件 API”或“只有原生绑定”。这些能力可以存在，但 Trellis 不必开启。[S2-S6]

## 2. Python 实际范围

Monty 明确不以 Python 完整兼容为目标；已实现部分以 CPython 3.14 为行为目标，并公开差异。[S4]

支持函数、闭包、lambda、循环、推导式、异常处理、简单类、部分 dataclass、模式匹配、格式化、部分 async/await。标准库覆盖包括 `json`、`csv`、`math`、`re`、`datetime`、`collections`、`itertools`、`base64`、`hashlib` 等，但多数模块仅实现部分表面。[S4][S5]

重要限制：[S4][S5]

- 不支持类继承、元类、方法装饰器，因此没有常规 `property`、`classmethod`、`staticmethod` 使用方式。
- 不支持 `yield` / `yield from`；生成器表达式当前会物化为 list。`map`、`filter`、`zip`、`enumerate` 等也是 eager，不能假设与 CPython 一样节约内存。
- 不支持 `del`、异常组、`async with`、`async for` 等语法。
- 没有 `sys.path` 或 site-packages，不能自行加载第三方包；NumPy、pandas、SciPy、Matplotlib 不应列为可用库。
- `decimal`、`fractions`、`io`、`zipfile`、`zlib` 等也不在当前内置模块中。不能因为支持 Python 就承诺精确十进制计算、压缩文件或 Office 文档解析。
- `os`、`pathlib` 的存在不意味着有宿主文件权限；访问请求需要宿主处理。`socket`、`subprocess`、`ctypes` 等不提供。
- 类型检查通过不是完整兼容证明：部分用于类型存根的模块能够被类型检查器解析，但执行时仍需要宿主提供。

适合 Trellis 首版的任务包括 JSON 整理、基础统计、集合计算、文本转换、CSV 内容处理和数值推导。不应将它用作完整 Python 教学环境或复杂文档处理器。[架构判断]

## 3. 安全边界

### 3.1 默认没有环境权限，但不是操作系统沙箱

官方定义是 language-level sandbox，不是容器、seccomp 或虚拟机。在没有挂载和宿主回调时，代码不能读取宿主文件、环境变量、打开 socket 或创建进程。解释器自身不执行文件系统 I/O，而是暂停后请求宿主处理。[S2]

默认仍可读取时钟，并为 random 使用系统熵；如需确定性执行，应显式配置时间和随机策略，不能声称完全没有外部信息来源。[S2]

原生 JS/Python API 使用 worker 子进程以隔离 panic/abort；这改善崩溃隔离，不意味着一旦解释器被突破仍有完整操作系统权限隔离。原生 worker 以空环境启动，Windows 保留 SystemRoot；完整威胁模型仍依赖解释器和宿主协议的正确性。[S2]

### 3.2 宿主桥接可能重新赋予全部权限

以下均属于主动授予能力：[S2][S3]

- `externalLookup` 中的宿主函数或懒加载值。
- `externalModules` 暴露的模块。
- `ClassInstance` / `ClassType` 包装的宿主对象或类。
- 目录挂载、`os` 回调。

宿主函数在宿主权限下执行。暴露 `readFile(path)`、`fetch(url)`、任意工具派发器，都会破坏 Trellis 的“无宿主文件、无网络”约束。不能因为调用来自 Monty 就跳过参数校验或审批。

**Trellis 首版建议全部不开启，只传入经过校验的纯数据。** 若将来需要返回多个产物，可以先使用结构化返回值，而不是立刻开放文件写入或通用宿主函数。时钟、熵、sleep 也应有明确策略。[架构建议，未批准]

## 4. 生命周期与输入输出

当前 JS API 是 `Monty.create()` 创建池、`checkout()` 获取 session、`feedRun(code, options)` 执行。末尾表达式作为结果返回，`inputs` 提供显式输入。**同一个 session 的多次 feed 会保留变量**，不能直接把 session 映射为 Trellis 任务。[S3]

建议 tool 内部采用：[架构建议]

```text
校验代码和输入大小
  -> 获取全新 session
  -> 一次 feedRun，不暴露宿主权限
  -> 接收结果和有上限的打印输出
  -> 校验/转换输出，交给 tool 持久化
  -> 关闭 session，清理执行 worker
```

为严格符合单次执行空间销毁要求，可设置 `maxCheckoutsPerWorker: 1`；官方说明 0 或 1 都会使 worker 每次 checkout 后退役。不要暴露 snapshots、dump/load 或多次 feed 作为首版工具功能。[S3]

输入输出并不天然是 JSON：Python int 可能映射为 BigInt，dict 映射 Map，bytes 映射 Buffer/Uint8Array，set 映射 Set。Trellis 必须指定数据转换规则、类型限制和资源引用格式，不能直接 JSON.stringify 所有返回值。[S3]

打印使用 `CollectString` / `CollectStreams` 或回调接管；默认 collector 上限为 10 MiB，但不用 printCallback 时 Node 会直接打印到 stdout/stderr。Trellis 应显式提供捕获器和更适合应用的预算，避免日志污染。[S3]

## 5. 资源限制：有机制，但必须配置

| 范围 | 官方机制 | Trellis 必须补充的约束 |
| --- | --- | --- |
| 内存 | `maxMemory`，worker 全局 allocator 请求量计量 | 不是进程 RSS 上限；宿主输入输出、线程栈和其他未计量内存需要留余量 |
| 执行时间 | `maxFeedDurationSecs`、`maxTurnDurationSecs` | 执行时钟会在等待宿主时暂停；还需要完整调用的墙钟截止时间 |
| 卡死 worker | `requestTimeout`、两种 duration grace | 本地池默认没有 requestTimeout；需主动设置，per-turn 超时不能替代完整调用预算 |
| 递归 | `maxRecursionDepth`，默认 1000 | 根据工具需求收紧，并测试内建操作的栈行为 |
| 宿主往返 | `maxSuspensions`，默认 1000 | 即使拒绝宿主请求，也要防止重复请求消耗宿主 |
| sleep | `maxTotalSleepSecs` 等策略 | 建议禁用实际等待或置零，不让一次计算长期占用资源 |
| 打印 | collector 默认 10 MiB | 必须显式捕获；打印和结果总量分别计量 |
| 返回数据 | 协议解码有独立分配预算 | 是每帧预算，不是整个宿主或最终序列化的总预算 |

以上机制来源：[S2][S3][S7]。

内存和执行时限默认可不配置，因此“默认安全”不能解释为“默认不会消耗无限资源”。原始源码编译不计入执行时钟，虽然有结构限制和 worker 隔离，仍需限制代码大小并设置外部截止时间。[S7]

**内存或执行时间限制触发后必须丢弃 session。** 官方明确不保证其堆状态和引用计数仍一致，pool 不会自动阻止随后 feed；不能捕获异常后在同一 session 继续修复运行。[S2][S7]

取消后的结果不保存、结果保存失败后的清理、审批等候是否占用预算，都是 Trellis 自身的契约，Monty 不代替这些设计。[架构判断]

## 6. TypeScript、Electron 与跨平台

### 原生后端

`@pydantic/monty` 在 Node 中使用 napi 绑定和原生 worker；平台包携带绑定和 worker，用户不需要安装 Python、Rust 或 Docker。当前清单要求 Node >=20，声明 macOS x64/arm64、Linux GNU x64/arm64、Windows x64 的构建目标；这不是已验证所有平台安装体验的证明。[S3][S6]

它适合部署在 Trellis 独立 agent runtime 后台，而不是生成的前端中。Electron 发布仍需验证 native addon、worker 打包解包、可执行路径、签名/notarization、optionalDependencies 是否被打包工具遗漏。应指定可信的 `binaryPath`，不要允许 `MONTY_BIN` 或 PATH 替换安全边界内的二进制。[S2][S3，集成推导]

### WASM 后端

同包提供 `@pydantic/monty/wasm`，浏览器用 Web Worker，Node 用 worker_threads，不支持无 worker 的回退。WASM 版本不支持文件挂载，使用随包 WASM 资产；浏览器入口已有 Vite 示例。[S3]

它与跨平台和无目录挂载约束相符，但仍不能直接认定优于原生版：worker thread 的故障隔离弱于 OS 子进程，WASM 内存限制可能表现为 trap/MontyCrashedError，打印按 turn 缓冲，资产加载、离线分发、取消和内存洪泛都需要验证。[S2][S3]

“禁止执行代码联网”不妨碍可信宿主从本地安装包加载 WASM；不应依赖运行时下载远程资产。[架构建议]

## 7. 与已有候选的关系

| 方案 | 核心定位 | 对 Trellis 的含义 |
| --- | --- | --- |
| QuickJS/WASM | 受限 JavaScript 解释器 | 适合基础计算；没有 Python 生态；继续作为 JS 对照候选 |
| Monty | 面向不可信代码的 Python 子集，原生 worker 或 WASM | 值得优先验证为 Python 风格基础执行工具，不承诺第三方包 |
| Pyodide | WASM CPython 与兼容 Python 包生态 | 如果真正需要 NumPy/pandas 等，仍是不同方向；不能由 Monty 直接替代 |

QuickJS/Pyodide 的依据和限制参见 [已有研究](code-execution-sandbox.md)。本次不提供未经同环境测量的启动时间、包体积或性能排名，也不将 Monty 官方比较文档当作独立基准。

## 8. 成熟度与待验证项

当前存在正式包结构、跨平台目标、完整安全模型、限制文档、测试入口和漏洞奖励渠道。[S1][S2][S6] 但这些不等于独立安全审计或长期生产稳定性证明。本次未核实发行物完整性、历史漏洞响应、第三方审计、各平台持续测试情况；不依据名字或版本号宣称生产安全。

进入选型前建议进行有界验证，不开发完整执行平台：[架构建议]

1. Electron 打包后的离线干净 macOS 环境能启动执行，且不依赖系统 Python/Rust/Docker；核实 arm64 与 x64 分发。
2. 纯数据输入、基础 Python 计算、受限输出、独立保存结果形成闭环，运行空间无持久内容。
3. 文件读取、环境变量、socket、子进程、宿主导入、回调绕过均失败。
4. 死循环、巨大字符串、深递归、复杂源码、输出洪泛和深嵌套返回值不能拖垮宿主。
5. 超时、取消和资源错误后 worker 退役；下一次执行无法观察上一次变量、对象、文件或随机状态。
6. 大整数、非有限浮点、bytes、Map/Set、循环引用等返回值有确定转换或拒绝行为。
7. 使用同一组用例比较原生与 WASM 后端的启动延迟、峰值内存、安装包增量和故障处理；数据出来后再定后端。

**本次建议是将 Monty 提升为优先验证候选，而不是直接写入最终技术栈。** 决策问题从“是否需要完整 Python”细化为：“基础工具是否接受明确公布的 Python 子集及无第三方库”。

## 来源

以下均固定到本次读取的提交，避免后续 main 文档变化造成误引。

- [S1 README](https://github.com/pydantic/monty/blob/9000dc6cfaffa34a652c5d8e33a55b7cee58c251/README.md)
- [S2 Security Model](https://github.com/pydantic/monty/blob/9000dc6cfaffa34a652c5d8e33a55b7cee58c251/docs/security.md)
- [S3 JavaScript quickstart and backend differences](https://github.com/pydantic/monty/blob/9000dc6cfaffa34a652c5d8e33a55b7cee58c251/docs/quickstart/javascript.md)
- [S4 Python subset](https://github.com/pydantic/monty/blob/9000dc6cfaffa34a652c5d8e33a55b7cee58c251/docs/limitations/index.md)
- [S5 Standard library modules](https://github.com/pydantic/monty/blob/9000dc6cfaffa34a652c5d8e33a55b7cee58c251/docs/limitations/modules.md)
- [S6 JavaScript package metadata and targets](https://github.com/pydantic/monty/blob/9000dc6cfaffa34a652c5d8e33a55b7cee58c251/crates/monty-js/package.json)
- [S7 Resource limits](https://github.com/pydantic/monty/blob/9000dc6cfaffa34a652c5d8e33a55b7cee58c251/docs/resource-limits.md)

# 内置代码执行工具：沙箱选型研究

> 后续决定（2026-10-25）：用户已确认采用 Monty 原生后端作为首版内置计算工具的集成基线，完整验收仍待完成。见 [当前选型](../harness/code-execution.md)。本文保留研究/实测时点的结论，不改写历史证据。

状态：研究结论，尚未选型，不代表已实现或已通过安全验收。

研究日期：2026-10-24。来源为项目维护者文档、源码仓库和平台官方文档；`stable`、`latest`、`main` 链接会变化，落地时必须固定版本并复核。本文没有运行性能基准、打包验证或攻击测试，因此不提供未经测量的包体积、启动时间或性能排名。

## 1. 已确定的约束

- 本地 Electron + TypeScript 应用，macOS 首版验收，尽可能保持跨平台能力。
- 用户不需要安装 Docker 或管理容器服务。
- 代码执行是 harness 内置 tool；显式接收输入，单次运行，运行结束后销毁状态。
- 不允许执行代码读取宿主文件或访问网络；不得通过授权弹窗解除这些硬性约束。
- 执行环境不是任务工作区；输出通过受控通道交给环境外的 tool，由后者校验和保存。
- 如语言运行时需要虚拟文件系统，只能是单次调用的临时内存状态，不能挂载用户目录、任务存储或持久化数据库。
- 内置能力保持基础和常用；不要求在核心中覆盖所有文档解析器、科学计算库或学科功能。

“不访问宿主文件”指不向不可信代码开放宿主文件能力。受信任的应用仍需从安装包加载运行时、显式读取输入、保存输出；这些动作必须在执行环境外完成。

## 2. 结论摘要

目前没有必要二选一为“Docker”或“直接启动 Python”。存在可随应用分发的嵌入式运行时，但必须分别决定语言能力和安全边界。

| 候选 | 直接执行的内容 | 与当前目标的契合度 | 关键代价或风险 |
| --- | --- | --- | --- |
| QuickJS 编译到 WASM，使用 quickjs-emscripten | JavaScript，不是 Node.js | 若首版只需基础计算和数据转换，值得优先验证 | 不提供 Python 生态；宿主桥接和整机资源仍需控制 |
| Pyodide + 受限 Chromium 环境 | Python + Pyodide 兼容包 | 若必须支持 Python、部分科学计算库，值得验证 | Python 可桥接宿主 JavaScript；默认具有包下载等能力，不能直接当成安全产品 |
| Wasmtime + 明确配置的 WASI/自定义 imports | WebAssembly 模块 | 对资源计量和宿主能力接口要求较高时值得评估 | 它不是 Python/JS 解释器；需要额外语言运行时和原生辅助程序集成 |
| isolated-vm | V8 JavaScript isolate | 可研究，但不建议作为当前默认优先项 | 原生 V8 适配、非硬内存限额、进程故障风险、维护模式 |
| Node.js `vm` / 直接子进程 / 仅 Worker | JavaScript 或任意宿主代码 | 不作为独立安全方案 | 上下文或进程分离不等于权限隔离 |

**条件式建议**：先明确内置 tool 的语言与标准库需求。若基础 JavaScript 足够，先验证 QuickJS/WASM；若 Python 是首版必需，则验证 Pyodide 的受限宿主方案。Wasmtime 是更底层的执行基础设施选项，不能仅凭“WASI 安全”就视为可直接替换 Python。此处不作最终选型。

## 3. QuickJS/WASM

### 已核实的能力

quickjs-emscripten 是 QuickJS 的 WebAssembly 封装，项目明确以执行不可信 JavaScript 为用途之一。运行时提供 `setMemoryLimit`、`setMaxStackSize`、`setInterruptHandler`，也可以由宿主控制模块加载；上下文和句柄需要显式释放。[S1]

这适合“显式输入 -> 计算 -> 显式输出”的小型工具。创建新的 runtime/context 并在调用后释放，可以落实不继承上次变量的生命周期；但不能只创建新 context 却保留共享宿主对象、模块缓存中的可变用户数据。[S1，架构推导]

### 不能误认的保证

- 这是 JavaScript 解释器，不是 Node.js：不应承诺任意 npm 包、Node 文件 API 或原生扩展可用。
- QuickJS 的内存上限不能直接宣称为整个 Electron/Node 进程的 RSS 上限。WASM 内存、输入输出复制、宿主对象和日志都要另行计量。[S1，范围推导]
- 中断回调限制解释器执行；耗时宿主函数或输出序列化不能假设都被同一机制可靠打断。必须有环境外的超时监督和销毁手段。
- 不向 guest 暴露文件、网络、任意宿主函数或可构造任意宿主调用的对象。模块加载只能从受信任、预置的允许列表读取，不把用户 import 直接映射到宿主路径。[S1，设计要求]

### 待验证

中断和内存限制在选定版本中的边界、恶意 Promise/微任务循环、超大输出、栈耗尽、冷启动、WASM 打包、macOS 签名后加载，以及 Electron 版本升级兼容性。应用主体的 TypeScript 不意味着 guest 自动支持 TypeScript 源码。

## 4. Pyodide

### 已核实的能力

Pyodide 默认文件系统为 MEMFS，即内存虚拟文件系统；官方同时支持挂载 IDBFS、NODEFS 等其他后端，其中 NODEFS 可访问 Node.js 原生文件系统。[S2]

额外包可通过 `micropip.install` 或 `loadPackage` 加载；包来源可以是 PyPI、CDN 或其他 URL。可安装的范围包括纯 Python wheel 和 Pyodide/Emscripten 兼容构建，不等于桌面 CPython 的任意二进制 wheel。[S3]

Pyodide 官方提供 Web Worker 使用方式；中断机制使用 Worker 与 SharedArrayBuffer，通常引发 `KeyboardInterrupt`。C 扩展需周期性检查信号才能合作响应，Python 还可以注册自己的信号处理器。[S4][S5]

### 关键安全区别：WASM 中的 Python 仍能获得宿主能力

官方明确：Python 的 `js` 模块可导入 JavaScript `globalThis` 中的对象。[S6] 因此，不能由“Python 在 WASM 中运行”推导出“Python 自动无法联网或访问宿主”。

如果所在环境存在 `fetch` 或过宽的消息桥，Python 就可能间接利用它们；在拥有 Node 权限的上下文加载 Pyodide也不能作为默认安全方案。隐藏一个 Python 函数名称或禁止 `import js` 字符串不是可靠安全边界。

### 条件式宿主设计

可验证的方向是：在专用、不可访问任务页面的 Chromium 沙箱环境中运行 Pyodide，关闭 Node 集成，采用单次 Worker/环境；环境外监督超时，严格控制网络、浏览器权限、持久化及 IPC。Electron 官方说明沙箱 renderer 没有 Node 环境，特权能力需经 IPC 获得；开启 Node integration 会禁用 renderer 沙箱。[S7]

这只是组合方案，不是单独安装 Pyodide 就完成隔离。尤其需要：

- 不挂载 NODEFS、宿主目录、IDBFS 或浏览器文件系统，不授予文件选择和原生文件访问能力。
- 运行时和允许包随产品预置；初始化只可读取受信任应用资源。执行期外联与任意包下载必须在外层阻断，而非依赖 guest 自律。
- 不把所有 harness RPC 暴露给 Python 可触达的 JavaScript 全局；执行桥只允许本次调用的有限输入输出。
- 阻止并测试 fetch、WebSocket、资源加载、Worker、导航及其他可用网络通道；不能把一个 CSP 配置项视为覆盖所有通道的证明。
- 合作式中断不是强制终止。Worker 可被外部 `terminate()` 立即终止，但还需验证本方案中的底层资源释放和故障范围。[S5][S8]

### 待验证

本次资料不足以确认 Pyodide 对每次执行提供可靠的总内存硬配额。WASM 线性内存上限也不等于 Python、JavaScript 桥接、消息队列和宿主缓冲区的总上限。必须实测恶意分配、输出洪泛、捕获中断、初始化开销、目标库兼容性和离线打包；没有通过这些验证前，不能宣称满足内存隔离验收。

## 5. Wasmtime/WASI

### 已核实的能力

Wasmtime 的安全说明指出，WebAssembly 对外部世界的交互依赖显式链接的 imports/exports，没有原始系统调用能力；安全边界包含宿主提供的这些接口，不只是 Wasm 模块本身。[S9]

Wasmtime 支持 fuel 与 epoch interruption。fuel 可提供确定性计算预算，但有额外执行成本；epoch 是另一种中断机制。[S10] 它们不等于对阻塞宿主调用自动提供超时，宿主接口也必须保持有界和可终止。

`StoreLimitsBuilder.memory_size` 可限制线性内存增长，但上限作用于每个 memory，并且默认不设置该字节上限。多 memory、table、instance 数量与宿主分配均需额外限制，不能把单个 memory 上限当作总内存上限。[S11]

`WasiCtxBuilder` 可以显式配置目录、环境和网络。当前文档说明默认网络地址被拒绝、DNS 查询被拒绝；实现应显式维持禁用策略，不继承网络、宿主环境或预打开宿主目录，并固定配置对应版本。[S12]

### 集成代价

Wasmtime 执行 Wasm，而不是直接执行普通 Python/JavaScript 源码。若要提供面向 agent 的脚本 tool，仍需选定编译到 Wasm 的语言解释器、包集合和通信 ABI。

在 TypeScript/Electron 产品中，可探索随应用打包专用原生辅助程序，不要求用户安装系统运行时；代价是各平台/架构构建、签名、公证、IPC 和版本维护。不能直接把 Node 的 `node:wasi` 当作 Wasmtime 的等价替代：Node 官方明确警告不要依赖其运行不可信代码，且不提供完整文件系统安全保证。[S13]

## 6. 不建议单独作为安全方案的候选

### Node.js vm

Node 官方原文明确声明：`node:vm` 不是安全机制，不要用来运行不可信代码。[S14] 它不能因具备 context 或 timeout 参数而成为本项目的沙箱。

### isolated-vm

维护者明确要求不要向 guest 泄露 `Reference`、`ExternalCopy` 等对象，错误桥接可能使 guest 取得 Node 进程控制权。项目建议与关键基础设施分进程，因为 JavaScript 仍可能导致进程崩溃或失控。[S15]

其 `memoryLimit` 官方称为指导性限额，恶意程序可能使用约 2–3 倍才终止；项目当前处于 maintenance mode。[S15] 因此它不是没有价值，但对本项目的部署维护、严格资源预期和桥接审计，不比 QuickJS/WASM 自动更简单。

### Worker、子进程与 Electron utilityProcess

Worker 是并发和生命周期工具，普通子进程是故障隔离工具；都不能单凭“不同线程/进程”推导出没有文件和网络权限。Electron `utilityProcess` 官方定义为启用 Node.js 的子进程，不能作为不可信代码的独立安全边界。[S16]

它们可以承载真正受限的解释器，并用于外部监督，但这与直接在其中执行任意 Node/Python 代码不同。

## 7. 不依赖最终运行时的最小契约建议

以下是研究建议，不覆盖已确认的产品约束，也不代表协议已经批准：

1. 调用输入限定为语言标识、源码、显式数据、允许的内置库集合和预算。预算由宿主限定，guest 不能上调。
2. 受信任 tool 把获准输入转换为值或字节；不把宿主路径、资源读取通配权限、凭据、完整任务状态注入执行环境。
3. 每次运行有唯一调用标识与外部截止时间；取消后任何迟到输出都拒绝提交。
4. 输出以有限大小的值、字节和 MIME 元数据交给 tool。文件名仅为展示元数据，不能成为任意宿主写入路径。
5. tool 先验证总大小、数量、结构，再原子保存获准输出；stdout/stderr 和错误堆栈也属于有预算的输出。
6. 成功、异常、超时、取消、超额都进入销毁流程；不把“删除局部变量”当作彻底重置。
7. sandbox 不可用时工具明确不可用，不能退回宿主直接执行。

## 8. 必须完成的验证门槛

- 文件：读取宿主绝对路径、环境变量、任务存储和其他任务资源必须失败。
- 网络：直接外联及通过桥接、动态 import、包管理器、浏览器资源加载等间接外联必须失败。
- 状态：第二次运行不能看到第一次的全局变量、虚拟文件、缓存中的用户值或持久化存储。
- 预算：死循环、递归、内存增长、异步任务洪泛、超大日志和输出均有有界失败行为。
- 故障：执行崩溃或超时不能破坏会话数据库；取消后迟到结果不能被接收。
- 输出：路径穿越元数据、恶意 MIME、未声明输出、大量小文件不能绕过 tool 的检查和配额。
- 部署：在无 Docker、无系统 Python/Node、无网络的干净 macOS 环境安装并执行；记录安装包、冷启动、峰值内存与恢复能力。

如果选定宿主无法实现严格总内存硬上限，应明确剩余风险并回到产品层重新确认要求，不能把监控后杀进程称为绝对硬配额。

## 9. 下一步决策

先回答一个产品问题：**首版基础代码执行是否必须支持 Python 和科学计算库？**

- 不必须：优先做 QuickJS/WASM 的最小安全与部署验证，不提前建设多语言工具平台。
- 必须：明确最小 Python 包清单，再验证 Pyodide 的隔离、离线运行和资源预算，不承诺完整 CPython 生态。
- 若上述路线达不到所需资源保证：再评估 Wasmtime 加限定语言运行时，以及原生辅助程序的维护成本。

此前没有确认 Python 必需，因此本研究不替用户完成这项选择。

## 来源

- [S1] quickjs-emscripten 官方 README（runtime、内存、中断、句柄、模块加载）：https://github.com/justjake/quickjs-emscripten/blob/main/README.md
- [S2] Pyodide 文件系统：https://pyodide.org/en/stable/usage/file-system.html
- [S3] Pyodide 包加载：https://pyodide.org/en/stable/usage/loading-packages.html
- [S4] Pyodide Web Worker：https://pyodide.org/en/stable/usage/webworker.html
- [S5] Pyodide 执行中断：https://pyodide.org/en/stable/usage/keyboard-interrupts.html
- [S6] Pyodide JavaScript/Python 互操作：https://pyodide.org/en/stable/usage/type-conversions.html#importing-javascript-objects-into-python
- [S7] Electron 进程沙箱：https://www.electronjs.org/docs/latest/tutorial/sandbox
- [S8] Worker 终止 API（Mozilla 平台文档）：https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate
- [S9] Wasmtime 安全模型，官方源码文档：https://github.com/bytecodealliance/wasmtime/blob/main/docs/security.md
- [S10] Wasmtime 执行中断：https://docs.wasmtime.dev/examples-interrupting-wasm.html
- [S11] Wasmtime StoreLimitsBuilder：https://docs.rs/wasmtime/latest/wasmtime/struct.StoreLimitsBuilder.html
- [S12] Wasmtime WASI 配置：https://docs.rs/wasmtime-wasi/latest/wasmtime_wasi/struct.WasiCtxBuilder.html
- [S13] Node.js WASI 安全警告：https://nodejs.org/api/wasi.html
- [S14] Node.js vm 安全警告：https://nodejs.org/api/vm.html
- [S15] isolated-vm 项目状态、安全和 API 文档：https://github.com/laverdet/isolated-vm/blob/main/README.md
- [S16] Electron utilityProcess：https://www.electronjs.org/docs/latest/api/utility-process

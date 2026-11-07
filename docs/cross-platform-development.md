# 跨平台开发与验证

A、B 阶段建立测试入口与统一资产描述。
C 阶段统一文件操作、权限与持久化接口。
D 阶段统一进程树与 Monty 生命周期。
E 阶段统一候选打包、包内验证与桌面平台提示。

计算能力仍只向 macOS ARM64 开放。
其他平台需继续通过生命周期与分发验收。

## 工程目标与验收环境

项目下限与执行器环境分别记录。

| 目标 | 工程目标下限 | 自动化执行器 | 当前计算门槛 |
| --- | --- | --- | --- |
| macOS ARM64 | macOS 12 | `macos-15` ARM64 | 保留现有开放状态 |
| macOS Intel | macOS 12 | `macos-15-intel` x64 | 关闭 |
| Windows x64 | Windows 11 | `windows-2022` x64 | 关闭 |
| Linux x64 | Ubuntu 24.04 / glibc 2.39 | `ubuntu-24.04` x64 | 关闭 |
| Linux ARM64 | 后续单独验收 | 本轮无执行器 | 关闭 |

macOS 下限来自 Electron 38 的加载要求。
Windows 执行器是 Server，不替代 Windows 11 验收。
最低版本与干净安装包仍需后续验证。
musl、未知 libc 和 Windows ARM64 暂无资产目标。

## 准备环境

开发环境固定 Node 22.23.1 与 pnpm 10.20.0。

- Node 版本见根目录 `.node-version`。
- pnpm 版本见 `package.json`。
- 无 pnpm 命令时先运行 `corepack enable`。
- SQLite 重建需要本地 C/C++ 编译工具。
- macOS 使用 Xcode Command Line Tools。
- Windows 使用 Visual Studio C++ Build Tools。
- Linux 使用 make、g++ 与 Python。
- 契约校验需要 Python 3.12 和 jsonschema。

```sh
corepack enable
corepack pnpm install --frozen-lockfile
python3 -m pip install -r scripts/requirements-dev.txt
corepack pnpm build
corepack pnpm verify:contracts
```

Windows 安装 Python 依赖时使用 `python`。
校验入口会按系统选择 Python 命令。
开发工具不纳入应用运行时依赖。

## 测试入口

通用、平台原生与桌面测试有独立入口。

| 命令 | 范围 | 前置行为 |
| --- | --- | --- |
| `pnpm test:portable` | A、B 的跨平台基线 | 检查链接权限，切 Node ABI |
| `pnpm test:files` | C 的真实文件系统与恢复测试 | 合成摘要，检查链接权限，切 Node ABI |
| `pnpm test:process` | D 的进程树、计算和插件生命周期 | 合成摘要，切 Node ABI，准备监督模块 |
| `pnpm test:process:electron` | 以 Electron 执行托管计算与生命周期 | 切 Electron ABI；测试宿主仍为 Node |
| `pnpm verify:windows-job` | Windows Job 最小原生验证 | 编译 N-API 模块；非 Windows 明确拒绝 |
| `pnpm test:unit` | 全部业务单元测试 | 切 Node ABI |
| `pnpm test:native` | 原生计算、macOS 打包契约 | 构建；仅已验收目标可运行 |
| `pnpm test` | 单元测试加原生验收 | 保留 macOS 完整回归入口 |
| `pnpm verify:native:node` | SQLite 和 Monty binding 加载 | 切 Node ABI，不启动计算 |
| `pnpm verify:native:electron` | 同一探针在 Electron 中运行 | 切 Electron ABI |
| `pnpm test:electron:portable` | 无计算能力时的启动和重启 | 构建并切 Electron ABI |
| `pnpm test:electron` | 全部 Electron 业务测试 | 构建并切 Electron ABI |
| `pnpm test:packaging` | E 的生产依赖、载荷与平台文案 | 检查链接权限，不切换 ABI |
| `pnpm package:desktop --output <绝对新目录>` | 按本机目标制作候选格式 | 构建并重建 Electron ABI |
| `pnpm verify:desktop <绝对输出目录>` | 包内入口、依赖与离线资产结构 | 不依赖源文件，不计算摘要 |
| `pnpm verify:desktop:runtime <绝对输出目录>` | 包内 SQLite、进程树及离线 PDF | 以包内 Electron 运行，PATH 为空 |
| `pnpm test:desktop:packaged <绝对输出目录>` | 包内窗口、快捷键、持久化及退出 | 先验结构，再从源码外启动 |

`test:portable` 明确列出基线用例。
它覆盖 schema、目标表、定位与能力门槛。
同时覆盖工具输入、诊断和工作区布局。
`test:files` 覆盖文件发布、恢复和清理。
它使用真实文件系统及 SQLite。
摘要比较使用测试替身，不计算文件哈希。
`test:process` 覆盖实际进程与原生计算生命周期。
原生计算用例只在既有已验证目标上执行。
它使用测试计算入口，不读取文件计算摘要。
生产资产校验与能力门槛保持不变。

完整业务单测在候选平台仍可能暴露缺口。
通用基线通过后，支持声明仍需安装包验收。
测试清单见根目录 `vitest*.config.ts` 配置。

### 原生 ABI 顺序

一个工作目录内必须顺序切换 ABI。

1. 构建应用与类型。
2. 顺序执行通用、文件和进程测试。
3. 执行 Node binding 探针。
4. 重建 Electron binding 并执行探针。
5. 执行桌面测试。

不要并发运行两种原生重建。
切回单元测试时重新使用 Node 重建入口。
探针日志记录 Node、Electron 和 ABI 版本。

### 平台测试权限

链接权限缺失必须作为覆盖缺口报告。

`test:portable` 和 `test:files` 均创建链接。
Windows 需启用 Developer Mode 或授予链接权限。
权限不足会明确失败，不跳过链接用例。
所有截图和报告写入测试框架输出目录。

Linux 桌面测试使用 Xvfb。
还需安装 GTK、NSS、GBM 和音频库。
CI 在临时执行器上允许用户命名空间。
应用的 Chromium 沙箱选项保持开启。

## 原生资产描述与加载

单一目标表供运行时和打包脚本共用。

- 数据位于 `src/shared/native-targets.json`。
- 选择函数位于相邻的 `.mjs` 模块。
- TypeScript 类型位于相邻的 `.d.mts` 文件。
- Linux 仅在确认 glibc 时匹配 GNU 目标。
- 加载器校验平台包名称、版本、系统和架构。
- binary 与 native 均须位于同一平台包。
- 开发目录和展开的安装目录使用相同定位规则。

`MontyAssets` 显式返回 native 入口。
worker 使用该入口，不再拼接架构文件名。
现有 ARM64 资产完整性门槛保持不变。
本轮只搬移已有完整性元数据。

候选包存在时，计算仍可保持关闭。
`runtimeVerified` 与完整性元数据共同控制开放。
未验证目标返回 `MONTY_PLATFORM_UNVERIFIED`。
资产不可用时不回退到 PATH 或宿主解释器。

## 当前凭据事实

主进程当前使用 `FileModelStore`。

- 默认目录仍为用户主目录下的 `.trellis`。
- `settings.json` 保存配置与凭据引用。
- `auth.json` 保存明文凭据。
- `SecureModelStore` 当前未接入主链路。
- Windows 隐藏属性不承担访问权限控制。

系统凭据迁移需独立处理旧格式与恢复规则。
本轮保留配置版本、凭据格式和提交顺序。

## 文件操作与持久化

共享文件接口位于 `src/platform/`。

- `paths.ts` 验证绝对路径与组件边界。
- `files.ts` 管理句柄、发布和刷盘。
- `permissions.ts` 实施平台私有权限。
- 配置、资源、导出与恢复共用这些接口。
- 插件、导入、GC 和副本清理同步接入。

### 路径与身份

Windows 路径必须不依赖当前盘符或目录。

- 接受绝对盘符、UNC 和扩展路径形式。
- 覆盖中文、空格与超过 260 字符的路径。
- 拒绝设备路径、ADS 和盘符相对路径。
- 拒绝保留名称、尾随点和尾随空格。
- POSIX 保留其合法文件名字符。

应用管理目录拒绝符号链接和 junction。
外部导出目录保留用户显式选择的别名。
文件打开前后检查文件与父目录身份。
悬空链接不作为缺失文件处理。

恢复日志继续保存数值 `dev`、`ino`。
无法安全表示身份时明确拒绝操作。
未知硬链接与多余链接同样拒绝。
本轮不修改日志版本、schema 或 SQL。

### 私有权限

POSIX 使用句柄设置目录和文件权限。
目录为 `0700`，文件为 `0600`。
Windows 使用系统 PowerShell 配置 DACL。
其路径由 `SystemRoot` 定位。

- 禁止继承，只允许当前用户与 SYSTEM。
- 路径通过环境变量传入固定脚本。
- 不向权限子进程转发模型密钥。
- 应用数据目录另设隐藏属性。
- 权限设置或验证失败时拒绝继续。

Windows 运行环境需允许系统 PowerShell。
首次读取已有配置时收紧其文件权限。
新文件继承受保护的应用目录权限。
隐藏属性仅用于显示，不替代 DACL。

### 发布与恢复

发布使用同目录暂存文件，先刷文件再发布。
替换失败时保留旧目标，不先删除目标。
清理暂存文件和写锁前复核所有权。
发布响应丢失时保留未知结果。

内部资源保持单次 rename 的恢复协议。
调用方持有运行时目录写锁。
不可变目标已存在时拒绝覆盖。
外部新文件使用硬链接实现无覆盖发布。

导出恢复仅接受已登记的双链接组合。
目标与暂存项须处于同一真实目录。
二者须匹配登记身份，且各有两个链接。
第三个外来硬链接会阻止恢复清理。

配置提交后刷盘失败返回结果未知。
重启读取已提交配置，不自动重放写入。
遗留写锁保留，并阻止配置加载。
人工检查后再处理锁文件。

### 持久化能力边界

目录刷盘接口明确返回实际能力。

| 平台 | 返回值 | 语义 |
| --- | --- | --- |
| macOS、Linux | `directory-synced` | 执行文件及目录刷盘 |
| Windows | `file-sync-only` | 文件刷盘，未提供目录元数据刷盘 |

Windows 文件刷盘使用可写句柄。
文件占用或只读时明确失败并保留恢复入口。
清理记录使用 confirmed，避免标为 durable。
macOS 保留既有原因字符串及目录刷盘行为。

Windows 目录元数据断电一致性仍待原生验收。
UNC 共享盘还需验证服务端文件系统语义。
路径语法用例不替代真实共享盘验收。
Windows、Linux 与 Intel Mac 的原生结果另报。

## 进程树与计算生命周期

进程树接口位于 `src/platform/process-tree.ts`。
监督入口为相邻的 `process-supervisor.mjs`。
Monty 与插件共享启动、终止和退出确认。
业务模块继续持有提交许可与清理阻塞状态。

### Windows 最小技术验证

Windows 使用父进程独占句柄的 Job Object。
原生模块位于 `native/windows-job/`。
只提供创建、纳管、查询、终止和关闭。
编译复用已固定的 node-gyp 工具链。

```sh
pnpm verify:windows-job
```

探针覆盖嵌套 Job、显式终止与父进程崩溃。
它也检查名称冲突与纳管失败时不执行后端。
非 Windows 系统返回 `WINDOWS_REQUIRED`。
本机 macOS 结果不作为 Windows 原生验收。

父进程启用 `KILL_ON_JOB_CLOSE`。
Job 句柄不继承到监督进程或后端。
监督进程先加入 Job，再接受实际启动消息。
父进程崩溃后，由内核关闭最后一个句柄。

监督进程临时打开 Job，仅用于纳管自身。
纳管成功立即关闭临时句柄。
纳管失败不启动实际后端，也不回退单进程模式。
查询活跃进程数为零后，才确认整树退出。

Windows 构建需要 Visual Studio C++ 工具。
构建将 N-API 模块放入 `out/main/native/`。
监督入口也复制到 `out/main/`。
缺失模块时明确拒绝启动受托管工作。

Node 与 Electron 探针均检查模块加载。
Windows 的 Electron 探针还执行完整 Job 探针。
候选目标的 `runtimeVerified` 保持关闭。
Job 探针通过后仍需完整目标平台验收。

### POSIX 行为与托管范围

POSIX 为监督进程建立独立进程组。
后端及普通派生进程继承该组。
父进程失联时，监督进程终止整个组。
后端退出时，父进程继续检查组内残留。

监督进程不执行插件或计算代码。
它转接标准流与受控 IPC，不继承宿主密钥。
Monty 环境仅补齐必要系统和临时目录变量。
插件继续使用既有环境允许名单。

此机制管理宿主直接启动的进程树。
可信插件主动脱离进程组仍属独立信任边界。
它不提供 OS 沙箱，也不撤回外部副作用。
原生计算的访问限制仍由 Monty 执行。

### 取消、超时和失联

取消先废止提交许可，再请求清理。
插件保留原有取消通知与宽限时间。
超时与 IPC 失联使用相同的整树终止接口。
监督进程退出事件不单独视为清理完成。

Monty 保留第一个停止原因。
未收到 native worker PID 也受整树截止控制。
报告的 worker PID 不作为独立终止目标。
清理无法确认时保留 `MONTY_CLEANUP_UNCONFIRMED`。

插件的清理失败继续保留状态和任务占用。
原有维护、删除与数据库切换仍等待真实退出。
Monty 关闭流程可以再次确认原执行的清理。
重试不修改旧 Call 结果，也不重放计算。

### 本地验证范围

进程测试使用真实 Node 进程和 SQLite。
覆盖取消、超时、父进程崩溃及 IPC 断开。
另覆盖插件派生进程、迟到结果与清理失败。
ESM 与 CommonJS 崩溃夹具均参与验证。

已验证目标还执行真实 Monty 原生计算。
覆盖内存、打印输出、宿主访问和取消。
测试入口绕开文件摘要计算，生产入口照常校验。
含文件哈希检查的完整验包与 PDF 验收另行执行。

## 统一桌面打包

新入口只制作当前原生主机的候选包。
目标取自统一资产表，Linux 需确认 glibc。
候选包存在不会开放该目标的计算能力。
未配置的跨编译、未知 libc 和未知目标明确拒绝。

| 平台 | 默认候选格式 | 安装与签名边界 |
| --- | --- | --- |
| macOS | ZIP | 本地临时签名，未公证 |
| Windows x64 | NSIS | 默认当前用户，不申请提升权限，未签名 |
| Linux / glibc | AppImage | 普通用户启动，FUSE 与沙箱需原生验收 |

`--format dir` 只生成可运行目录。
先用目录包验收，再制作相应安装格式。
所有新入口都显式禁止发布与自动上传。
旧 `package:mac:arm64` 及原验包器继续保留。

构建采用系统临时目录中的独立暂存根。
空 NPM lock 固定 builder 的包管理器探测。
该锁不声明依赖，也不随应用打包。
Corepack 不会在暂存目录选择或下载默认版本。

生产依赖经 pnpm 的实际解析图收集后展开。
只收目标 Monty 包，并拒绝版本冲突。

SQLite 仅保留运行时文件和已编译 binding。
安装器及其他未审计可选依赖不会随包收集。

ASAR 当前关闭，原生模块与 worker 都是普通文件。
所有主进程入口、共享 chunk 和 preload 随包复制。
监督进程与 Windows Job 辅助模块显式检查。
`process-control.js` 导出实际托管进程与 RPC 模块。

载荷只来自构建目录、生产依赖和 PDF 参考插件。
不复制工作区根、用户目录、凭据或数据库。
暂存和包结构检查拒绝链接及敏感文件。
打包后直接比较 Monty 字节，避免签名改写资产。

macOS 签名跳过 Monty，保留其原始签名与字节。

PDF 参考插件位于 `resources/reference-plugins/pdf-text`。
macOS 的资源目录位于 app 的 `Contents/Resources`。
插件不会自动安装、信任或执行任务。
结构检查覆盖 `vendor-source.json` 的全部本地资产。

目录包验证可使用以下命令。

```sh
pnpm package:desktop --output /absolute/new/trellis-candidate --format dir
pnpm verify:desktop /absolute/new/trellis-candidate
pnpm verify:desktop:runtime /absolute/new/trellis-candidate
pnpm test:desktop:packaged /absolute/new/trellis-candidate
```

Windows 使用原生绝对路径，例如 `C:\Trellis-QA\candidate`。
输出父目录须存在，输出本身必须是新路径。
输出及其父链接解析后均不得位于源码目录内。

本地 Electron 分发可通过 `--electron-dist` 显式指定。
该目录须有匹配固定版本的 `version` 文件。
默认仍使用已安装的 Electron 分发目录。

当 framework 链接被展开时，应重新解压官方分发。
不要把重复目录直接交给签名工具。

包内运行探针从独立临时目录启动。
它验证 SQLite 读写和 Monty binding 加载。
再验证 app-node RPC、派生进程终止和退出确认。

PDF 部分验证后端初始化及离线文本解析。
这不替代完整插件安装与导入资源验收。

桌面提示取自只读 preload 平台字段。
macOS 保留既有标题栏与 Command 文案。
Windows 和 Linux 使用 Ctrl 文案及系统窗口框。

包内启动忽略开发页面 URL，只加载本地页面。
关闭与退出继续等待运行时确认清理。

### 原生安装验收待办

安装格式验收仍需干净的目标系统。

- macOS：ZIP 解压启动、隔离属性和签名提示。
- Windows：NSIS 当前用户安装、卸载及保留数据。
- Windows：中文、空格路径和无管理员权限启动。
- Windows：Job 模块在包内纳管、父崩溃和 IPC 失联。
- Linux：AppImage、FUSE、桌面集成及 Chromium 沙箱。
- 各系统：无源码、无系统 Node 的离线首次启动。
- 各系统：完整插件安装、信任及真实材料解析。
- 各系统：运行中取消、超时、窗口退出和重启恢复。

## 持续验证边界

CI 工作流配置覆盖 A–E 基线及目录包冒烟。

Windows 先执行 Job Object 最小原生探针。
再执行文件、进程与两种 ABI 的验证。

四个执行器覆盖三种系统及两种 macOS 架构。
Node 与 Electron binding 探针在原生系统运行。
桌面冒烟显式关闭 Monty，以验证无计算路径。
工作流制作本机目录包并运行包内探针。
它不制作安装器、不上传安装包或发布物。

原生计算与包清单测试保留为独立入口。
这些既有测试包含文件摘要校验。
运行范围应遵守当前任务对文件校验的要求。
本轮增加的资产门槛单测使用合成摘要结果。
文件测试入口也使用合成摘要结果。

CI 配置需提交后才能在远端执行。
本地通过与远端平台通过应分别报告。

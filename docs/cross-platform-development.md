# 跨平台开发与验证

默认目录定向验收尚未通过。
[42618317969](https://github.com/twotwothree2233/Trellis/actions/runs/42618317969)前检报`DEFAULT_DIRECTORY_EXISTS`。
精确运行头为`09f8286b90e59fd178321d35d2a9b77093fa6e86`。
本轮只读前检拒绝，应用0，依赖及应用步骤全部跳过。
现有默认目标保留，不删除、移动或复用为fresh。

09f8286的PATH、真实PID及退出修正仍未原生执行。
42600636612失败及具体PATH类型unknown的原结论保留。
下一批需先确认默认目标保留方式及格式边界。
安装器执行和内建摘要范围仍待明确授权。

指定Win11标准账户的A隔离目录完整入口已通过。
[42587842121](https://github.com/twotwothree2233/Trellis/actions/runs/42587842121)为completed/success。
精确验证头为：
`45883cf4f9cf19a9ef358b433d73f510b9fc1a18`。

范围限DESKTOP-SFE95TP/Win11专业版26300/X64/session2。
该会话非提升、无管理员组且具备真实file-symlink能力。
完整文件、生命周期、恢复关闭、源码及目录包GUI通过。
使用新A隔离目录，默认HOME与旧目录B仍未验收。

第十轮四平台基线 CI 全部通过。
该基线已验证代码提交为：
`bc79bd422c2a306347d33a57c55c16f973b030ef`。
[运行 42386431419](https://github.com/twotwothree2233/Trellis/actions/runs/42386431419)。

后续 ACL 适配只在指定 Windows 11 主机验收。
42490233089 / ae6adba 的 Actions 结果为 success。
日志仍含真实 Job 未清空错误，未据此关闭验收。
退出确认修复的完整复验 42496582992 已 success。
该 Win11 已验证代码头为：
`c8d61fe7db89010b036b57cdb2f0d545435d19db`。
[查看指定主机运行](https://github.com/twotwothree2233/Trellis/actions/runs/42496582992)。

标准账户已在 42550357622 通过令牌门禁。
该轮停在旧检出目录清理，随后正常取消。
该轮应用测试为0，未取得完整应用结果。
42562024272 的 Git 准备与新目录检出已 success。
其验证入口头为 35bce222e7f0f77310d48ceeb7c0b1e881b80ccb。
该轮仍未执行依赖、构建或应用测试。
后续完整入口42564610043因Python缺项在依赖前停止。
其入口头为0ba9ec169e7fd130240933e354d9d2d9e44d195a。
该轮标准账户VS/SDK门禁通过，应用为0。
Python补齐后42572230985已执行一次完整入口。
入口头为31e5450518c935639de969fd993a7abb52c1a344。
Python准备通过，Portable符号链接自检因EPERM失败。
当轮独立测试部分通过，完整文件/生命周期/包内入口跳过。
用户本机准备后的链接探针42586965647已success。
运行头为b864a1a20848dd48b98675302414887b413e33f2。
同一标准会话的原file symlink与realpath自检通过。
该轮依赖与应用全部跳过，应用计数0。

工程阶段 A、B 建立测试入口与统一资产描述。
C 统一文件操作、权限与持久化接口。
D 统一进程树与 Monty 生命周期。
E 统一候选打包、包内验证与桌面平台提示。

各次验证结论始终绑定各自的代码头。
入口与文档提交标注 `[skip ci]`，仅手动派发。
后续提交不继承尚未执行的完整矩阵结果。

计算能力仍只向 macOS ARM64 开放。
其他平台通过的是上述四平台基线门禁。
后续 Windows ACL 实现没有新增其他系统实测。
正式支持仍需最低版本和安装分发验收。

| 第十轮平台 | 执行器 | 结果 |
| --- | --- | --- |
| macOS ARM64 | `macos-15` ARM64 | success |
| macOS Intel | `macos-15-intel` x64 | success |
| Windows x64 | `windows-2022` x64 | success |
| Linux glibc x64 | `ubuntu-24.04` x64 | success |

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
基线 Windows 执行器为 Server。
指定 Windows 11 自托管入口另列原生结果。
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

内存身份直接取自 BigInt Stats。
`dev`、`ino` 使用规范 u64 十进制字符串。
普通 Stats 保留原大小和时间字段精度。
路径、句柄和父目录仍须通过稳定性检查。

精确身份兼容方案 A 已授权并实施。
它与工程阶段 A、B 的命名分别记录。
仅新建 Windows 隔离测试目录可显式选择新版。
开关为 `TRELLIS_TEST_FILE_IDENTITIES=decimal-v2`。

- 新 export/GC 控制版本为 2。
- 新 restore journal 为 6，`export_control=2`。
- 新退役及资源清理嵌套记录为 2。
- 安全旧数值记录可读，保持原记录版本。
- 不安全旧数值拒绝且保留，不推算原编号。
- 混合类型、非规范字符串及版本冲突均拒绝。

旧目录按已存版本读取，不自动升级。
旧目录激活与迁移方案 B 仍冻结。
macOS 默认继续采用原数值存储版本。
业务 schema、settings/auth 和内容格式不变。

未知硬链接与多余链接同样拒绝。
身份不确定时，恢复和清理保持拒绝边界。
具体取舍见[精确身份笔记](../.agents/notes/implemented/architecture/2026-11-07-exact-file-identities.md)。

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

Windows 每次核对完整 DACL，仅按需改写。
核对主体、权限、保护位、继承和传播标记。
已有隐藏属性也不重复写入。
原生探针确认重复保护不改变 ctimeNs。

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
四平台文件与恢复测试已在第十轮通过。

Windows 结果使用新建的精确身份测试目录。
旧目录拒绝与安全旧格式读取仍有回归覆盖。

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

第十轮已分别通过最小探针和完整业务生命周期。
Windows 的真实 Monty 计算仍按原门槛跳过。

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
- Windows：普通用户安装后复验 Job 和异常退出。
- Linux：AppImage、FUSE、桌面集成及 Chromium 沙箱。
- 各系统：无源码、无系统 Node 的离线首次启动。
- 各系统：完整插件安装、信任及真实材料解析。
- 各系统：运行中取消、超时、窗口退出和重启恢复。
- 各系统：正式签名、macOS 公证及分发提示。

源码生命周期已覆盖父崩溃、取消和 IPC 失联。
目录包已覆盖 app-node RPC 和整树退出。
安装后的普通用户环境仍需复验这些行为。
Windows 的 SmartScreen 与升级路径也未验收。

## 持续验证边界

CI 工作流配置覆盖 A–E 基线及目录包冒烟。

手动派发可选择 `windows11_only=true`。
此模式只调度 `DESKTOP-SFE95TP`。
原四平台 baseline 整组跳过，不执行其他版本。
指定标签为 `self-hosted`、`Windows`、`X64`。

测试前核对主机名、Windows 11 client 及 x64。
主机不匹配时明确失败，不回退到其他执行器。
默认只发现和复用已有构建工具。
GUI 需交互桌面，服务会话保持失败和未验收。

### Windows 11 标准用户入口

标准用户验收使用额外的默认关闭门禁。
同时启用 `windows11_only` 与 `windows11_standard_user`。
安装、技术-only、诊断-only、进程-only 均须关闭。
该模式仍执行完整 Win11 入口，baseline 整组跳过。

进入依赖和应用测试前核对实际令牌。
要求非 SYSTEM、非提升权限且无 Administrators SID。
同时要求 Windows 11 x64 和有效交互桌面。
未知、缺失或不匹配时明确失败，应用测试为零。

仅 IsInRole=false 无法排除管理员的过滤令牌。
门禁另用系统 whoami 查询包含 deny-only 的组。
SID 固定比较 S-1-5-32-544，不依赖本地化组名。
只保存布尔结果，不上传账号、SID 列表或凭据。

实际标准账户必须在指定 Windows 本机登录。
现有 Runner 目录为 `C:\actions-runner`。
原实例空闲并退出后，在标准账户桌面启动 `run.cmd`。
不使用“以管理员身份运行”，不同时启动第二个实例。

目录和已有构建缓存须允许该测试账户正常工作。
权限不足时停止，不接管或递归放宽已有目录权限。
专用目录或 Runner 重新配置需在本机另行处理。
无需向聊天或 CI 提交账户密码、注册令牌和凭据文件。

此入口不自动创建账户、改服务或调整开发者模式。
源码链接夹具条件不足时保留环境阻塞。
不通过提升权限或修改原断言取得绿色结果。
应用数据仍只使用 A 新隔离目录，不触及默认 HOME。

已验证的 c8d61fe 结果仍属于提升权限会话。
新门禁的原生检查与标准用户完整结果分别记录。
默认新目录格式仅先评估，B 迁移继续冻结。
安装器、签名和正式分发仍是后续独立验收。

#### 标准用户门禁首轮结果与本机准备

[运行 42547553223](https://github.com/twotwothree2233/Trellis/actions/runs/42547553223)为环境门禁 failure。
入口头为 ad4f8057ea84fe5527e3fdd95af3ea53ae1eeaa6。
指定主机及交互桌面匹配，baseline skipped。
依赖准备、构建及应用步骤全部 skipped，应用测试数为 0。

实际 host.json 为 Win11 Pro26300、X64、session1。
elevated=false，administrators_group_present=true。
system_account=false，user_interactive=true。
该令牌仍属于管理员账户，标准用户条件不满足。

错误为 STANDARD_USER_INTERACTIVE_SESSION_REQUIRED。
这次证据验证了对管理员非提升令牌的拒绝。
不记为应用失败或通过，不改写既有提升会话结果。
标准用户的实际接受分支和完整应用矩阵仍未执行。

下一步必须由用户在指定 Win11 本机准备。

1. 确认已有不属于 Administrators 的标准账户。
   没有时，由用户决定是否新增本地标准账户。
   这会新增独立用户配置目录，不改当前日常账户类型。
2. 交互登录该账户，使用其自身可访问的专用目录。
   不接管原账户目录，不复制已有 Runner 凭据。
   旧 Runner 空闲后退出，避免同名实例并行。
3. 通过[官方 Runner 页面](https://github.com/twotwothree2233/Trellis/settings/actions/runners/new)准备 Windows x64 Runner。
   如需重新登记同名 DESKTOP-SFE95TP，由用户本机操作。
   替换登记可能改变 Runner ID，并使旧登记失效。
   注册令牌只在本机使用，不提交到聊天或附件。
4. 保留默认 self-hosted/Windows/X64 标签。
   不安装为服务，不使用管理员终端，正常运行 run.cmd。
   等待 Listening for Jobs 后，通知标准账户 Runner 已就绪。
5. 若目录权限或现有构建工具不可用，先停止并报告。
   不递归放宽权限，不改服务，不自动补装工具。
   账户、重注册或目录权限变更均由用户明确处理。

在本机准备前停止 dispatch，不重复管理员矩阵。
恢复时先重新核对真实令牌，再进入同一完整入口。
默认 HOME、格式启用和旧目录 B 均保持现状。

#### 标准账户已通过与检出准备诊断

[运行 42550357622](https://github.com/twotwothree2233/Trellis/actions/runs/42550357622)最终 completed/cancelled。
host.json 为 session2，非提升且无 Administrators 组。
非 SYSTEM、交互桌面成立，标准账户门禁已通过。
35 个后续步骤与 baseline 跳过，应用测试为 0。

checkout 的实际版本为 4.3.0，提交 11d5960。
Git 管理器初始化异常在 lfs=false 时被静默捕获。
无 Git 时会先清理已有目录，再进入 REST 下载。
缺少 .git、URL 不符或清理异常也可进入删除分支。

本轮日志在 Git 版本分组结束后进入 Deleting contents。
没有 Git 命令或下载开始记录，直到正常取消。
具体 Git 初始化错误及旧目录清理停滞原因仍未知。
旧目录停止进一步清理，不修改权限或恢复未知项。

新增默认关闭的 windows11_checkout_probe_only。
它要求 windows11_only 与 windows11_standard_user 同开。
安装和其他定向模式关闭，原标准令牌条件不变。
只做 Git 诊断、全新目录检出与 HEAD 核对。

Git 发现使用独立有界进程，只读元数据，无网络。
候选最多四个，版本每个 3 秒，内部总预算 20 秒。
诊断步骤硬截止 1 分钟，不输出原路径、配置或环境。
只保留类别、可访问性、started/exit/timeout 与脱敏错误。

只有 PATH 中发现且版本不低于 2.18 的 Git 才继续。
诊断自身不把固定候选写入 GITHUB_PATH。
前置选择步骤可复用当前账户已验证的固定 Git。
它只写当次 job PATH，再由下一步骤重新发现与验证。
不执行包装脚本，不跟随重解析或网络候选路径。
任何超时、无法判断或异常输出均保留失败。

标准模式以 run_id/attempt 生成全新受控 source 子目录。
先检查未越界且不存在，已存在或未知时失败。
不删除、覆盖或复用旧 workspace，原目录保持现状。
诊断 checkout 固定已审查提交，最多 3 分钟。

成功后只读核对 HEAD 等于本轮 GITHUB_SHA。
依赖、构建、性能、文件、进程及 GUI 步骤全部跳过。
always 保存 host.json 和 checkout-preparation.json。
准备通过也只代表检出可用，应用数仍为 0。

所有 shell 命令显式使用同一 source 工作目录。
pnpm 清单、Node 版本和锁文件输入同步加目录前缀。
标准模式关闭 setup-node 自动缓存，避免探测旧根。
普通模式仍使用原路径与缓存，应用测试超时不变。

原生诊断结果在实际运行后补记，不自动重复派发。
完整应用复验在本次诊断结果之后单独决定。
不变产品、格式、默认 HOME、旧目录 B 或计算门槛。

### 标准账户 Git-only 准备

`windows11_prepare_git` 默认关闭。
它只配 only、standard_user、checkout_probe_only 同开。
install_windows11_tools 与其他定向模式仍全部关闭。
指定主机和真实标准令牌门禁保持原样。

前置步骤只检查当前账户两个固定 Git 位置：
LOCALAPPDATA/Programs/Git 与 Trellis-Toolchain/Git。
已有 AMD64 Git 且版本不低于 2.18 时复用。
重解析、未知版本或非空冲突目录直接失败。

仅显式开关允许缺失时安装 Git 2.56.0.4 x64。
固定官方 asset 677312539，目标为本账户工具目录。
使用 CURRENTUSER、NORESTART、BashOnly 和空组件列表。
可选集成及图标关闭，不写用户或系统持久 PATH。

下载限 180 秒，安装限 5 分钟，内部总限 535 秒。
步骤限 10 分钟，不重试、不自动重启。
退出 0 后须通过 3 秒精确版本复验。
3010 记需重启并停止，其他错误和未知均失败。

子进程只继承显式必要环境，不传 GitHub 凭据。
原始安装日志只留 Runner 临时目录的独立工作子目录。
附件只存来源、阶段、退出码和脱敏候选状态。
不计算文件摘要，不读取其他用户私有目录。

后续标准账户 job 可验证两个固定位置后临时选用 Git。
安装开关关闭时，该选择步骤不会下载或安装工具。
下一步骤仍须从实际 PATH 发现并通过原版本门槛。
准备成功后只做新目录检出和 HEAD 核对，应用数为 0。

原 42556311102 为正常诊断取得的环境缺项。
其四类候选未发现 Git，不能扩写为整机没有 Git。
原 42550357622 的清理停滞原因仍 unknown。
[42562024272](https://github.com/twotwothree2233/Trellis/actions/runs/42562024272) 已 success。
验证入口头为 35bce222e7f0f77310d48ceeb7c0b1e881b80ccb。
本节后续文档提交不改变该轮验证头。
该轮没有派发完整入口。
后续42564610043已派发，但在Python工具门禁停止。

host.json 确认 Win11 Pro26300/X64、session2。
interactive=true、elevated=false、admin组=false、SYSTEM=false。
两个本账户目标原均 ABSENT，随后实际安装成功。
Git 版本为 2.56.0.windows.4，退出码 0，无超时或重启要求。

原 PATH 发现步骤随后真实启动 Git，退出 0。
checkout 使用本轮全新受控子目录，HEAD 匹配本轮提交。
准备步骤 77 秒，发现 1 秒，checkout 15 秒，HEAD 核对 1 秒。
日志没有进入旧根 Deleting contents 阶段。

三个常见固定诊断候选仍 ENOENT，未改写为成功。
35 个依赖及应用步骤全部 skipped，baseline skipped。
应用测试数为 0，JSON 附件已实际下载核对。
该轮未验证当前账户Python/VS/SDK，也没有联动安装。
后续工具只读结果见下一节。

### 标准账户完整验收的只读工具门禁

完整标准账户入口先核对现有 Python、VS 与 SDK。
该门禁在 pnpm、Node 配置和全部依赖步骤之前。
仅 only+standard_user，其他安装与定向开关全部关闭。
已有 Git 仅复用本账户固定位置与当次 job PATH。

脚本为 scripts/windows11-standard-toolchain.cjs。
它没有下载或安装分支，不读取旧账户私有目录。
当前账户 Python 查有限 PATH、固定目录与3.12注册。
机器级候选只读 Program Files、固定根目录和注册。

Python 必须为3.12/x64，并能导入 venv、ensurepip、ssl。
以隔离、禁用site和禁写字节码的模式检查，每次3秒。
注册及 vswhere 各5秒，独立子进程共享50秒总截止。
步骤硬限1分钟，未知、超时与缺项均保留失败。

VS 要求完整可启动的2022 C++ x64组件。
继续只读核对 MSBuild、vcvars、cl/link/lib及运行库。
SDK 按本机注册核对x64头、库和资源工具。
不执行编译，不改变注册、目录权限或持久PATH。

标准模式跳过旧的总工具安装脚本。
齐备时只将已验证Python暴露到当次job。
任一缺失时在依赖前失败，应用0，不自动补装或重派。
脱敏 standard-toolchain.json 随原环境附件始终保留。

用户已授权齐备后同次继续一次完整应用复验。
原10秒hook、15秒ACL预算与GUI截止保持。
文件、恢复关闭、完整进程、Electron和包内GUI逐项取证。
继续使用A新隔离目录，结果以实际运行提交与计数为准。

### 标准账户工具门禁的原生结果

[42564610043](https://github.com/twotwothree2233/Trellis/actions/runs/42564610043) completed/failure。
运行入口头为0ba9ec169e7fd130240933e354d9d2d9e44d195a。
此轮是环境工具缺项，应用测试数为0。
后续纯文档提交不改变该运行头或应用计数。

host仍为Win11 Pro26300/X64、session2真实标准账户。
interactive=true，elevated/admin组/SYSTEM均false。
Git只复用2.56.0.windows.4，新受控目录检出成功。
Git准备和总安装开关均false，没有安装工具。

只读工具门禁用时2秒，missing仅python。
PATH候选因REPARSE_PATH被拒绝，未执行版本进程。
两个本账户固定位置与两个机器常见位置均ENOENT。
HKCU/HKLM的3.12注册均未配置，不判整机没有Python。

VS2022为17.14.37827.9，MSVC为14.44.35207。
目标x64组件、MSBuild、工具和运行库均通过只读检查。
SDK10.0.26100.0的x64头、库、资源工具检查通过。
注册查询和vswhere退出0，无超时。

35个依赖及应用步骤全部skipped，baseline skipped。
另外两个诊断专用步骤skipped，总步骤跳过数37。
文件、恢复关闭、Node/Electron进程和Job均未执行。
源码/包内GUI、包内ACL/RPC/整树/PDF也均未执行。

standard-toolchain.json等脱敏附件已实际下载核对。
原失败与取消保留，旧检出清理停滞原因仍unknown。
本次停止，不自动重派或将缺项改成setup下载。
原应用超时、格式/B、A隔离目录和产品行为不变。

### 已授权的Python-only准备

当前只需补齐本账户可用的Python3.12 x64。
已有其他明确可访问安装时，可先只读验证该位置。
否则建议既有官方actions/python-versions分发的3.12.10 x64。
固定asset244701309，python-3.12.10-win32-x64.zip。
实现前元数据为uploaded、26672655字节。
本轮已按固定来源实际下载并安装，原生结果见下文。
仅提取python-3.12.10-amd64.exe，不运行setup.ps1。

目标为本账户LOCALAPPDATA/Programs/Trellis-Toolchain/Python312。
参数采用InstallAllUsers=0、PrependPath=0、Include_launcher=0。
AssociateFiles=0、Shortcuts=0，关闭可选集成。
保留venv/ensurepip/ssl，Include_pip=1。
禁用测试、文档和快捷方式，使用quiet/norestart。

安装前重查本账户候选、注册与目标，合格安装可复用。
未知注册或目录均拒绝，不覆盖其他安装。
仅提取固定ZIP条目，不执行分发包的账户注册清理脚本。
这会新增当前账户Python文件及必要HKCU/卸载登记。
不复制旧账户安装，不改服务、DACL、账户或持久PATH。
不联动Git、VS、SDK，不使用总工具安装开关。
用户已明确批准本方案及成功后一次完整复验。
准备入口仅在显式开关开启时执行，本轮结果见下文。

安装子进程只继承必要环境允许列表，不带GitHub凭据。
原始日志仅留本机临时目录，附件只留脱敏阶段和结果。
下载限180秒、提取限15秒、安装限5分钟，整体有界。
安装退出0后，以3秒隔离探针复验3.12/x64及必要模块。
3010记录需重启后停止，不自动重启；其他错误均停止。
只在job中指定PYTHON和必要临时PATH。
准备成功后同一job进入一次同主机标准账户完整入口。

Python-only脚本为scripts/windows11-python.cjs。
新开关windows11_prepare_python默认false。
须配only+standard_user，其他六个安装/定向开关false。
准备步骤在原工具门禁之前，硬截止12分钟。
这只限制工具准备，不改变任何原应用测试截止。

准备前复用原有界只读检查，不提前导出PYTHON/PATH。
只有明确缺少Python且VS/SDK齐备才允许安装。
已有合格Python则复用；未知注册、候选或目标直接失败。
安装前再次核对注册与目标，不覆盖并发出现的安装。

下载仅固定官方来源，大小/ZIP/MZ检查，不计算摘要。
新运行临时目录只提取固定Python EXE条目。
从不执行setup.ps1，也不清理已有Python注册。
Installer使用必要环境允许列表，不继承GitHub凭据。

退出0后重新通过原只读门禁，要求精确3.12.10/x64。
再以3秒隔离进程核对pip，成功后才暴露当次PYTHON/PATH。
原只读门禁还会独立再检查一次，成功才进入应用步骤。
任一准备或验证失败均停止，35个依赖应用入口全部关闭。

本机26个准备分支、10个检查分支及4个导出分支通过。
包含超时、3010、冲突、注册竞态和版本验证拒绝。
YAML/7个内联JS与256组原输入条件核对通过。
新开关的255组无效组合均拒绝，普通模式命令保持。

### Python准备成功后的标准账户验收结果

[42572230985](https://github.com/twotwothree2233/Trellis/actions/runs/42572230985) completed/failure。
运行入口头为31e5450518c935639de969fd993a7abb52c1a344。
仅only+standard_user+prepare_python=true，其余六开关false。
失败保留，不追加dispatch；后续文档提交不改变运行头。

host仍为Win11 Pro26300/X64、session2真实标准账户。
interactive=true，elevated/admin组/SYSTEM均false。
Python真实installed3.12.10，pip25.0.1，退出0。
无超时或重启要求，准备57秒，独立工具门禁4秒。

原生附件确认PATH/固定位置/HKCU均发现同一合格Python。
机器级3.12注册仍未配置；只暴露当次PYTHON及必要PATH。
Git复用，VS/MSVC/SDK检查通过，没有重装其他工具。
后续常规测试保持prepare_python=false，直接复用工具。

| 本轮入口 | 实际结果 |
| --- | --- |
| 构建、生成合同漂移、合同验证 | success |
| Node与Electron最小Job | 两者均通过 |
| Node与Electron原生ACL | 四组语义检查各通过 |
| 20目录ACL性能 | 21 passed，20目录全部初始化 |
| Portable | 自检EPERM，Vitest用例0 |
| Windows核心进程 | 15 passed / 3 skipped |
| 完整文件套件 | skipped，受Portable门禁阻断 |
| 完整进程与恢复关闭 | skipped，受Portable门禁阻断 |
| 生产载荷与打包结构检查 | skipped，受Portable门禁阻断 |
| Electron生命周期 | 5 passed / 3 skipped |
| 源码GUI首启与重启 | 1 passed，11.0秒 |
| 目录包/包内ACL/RPC/整树/PDF/GUI | skipped，上游打包前置未通过 |
| 其他平台baseline | skipped |

三项Monty原生计算用例仍按runtimeVerified门槛跳过。
Windows没有开放计算能力，binding探针未启动计算。
最小Job附加失败日志来自显式负向测试，后续汇总全true。
完整生命周期未执行，D阶段完整验收仍未关闭。

ACL性能共200次调用，均值551.610ms。
p95为587.680ms，最大599.514ms，目标仍5000ms。
原10000ms hook与15000ms调用预算未改。
源码GUI截图已实看，状态idle、error=null、gc_enabled=true。

Portable在scripts/check-test-environment.mjs:9失败。
Node22.23.1的文件symlinkSync返回EPERM。
临时源文件已可创建，创建文件符号链接被系统拒绝。
当前令牌/系统策略未满足测试夹具要求，具体策略来源未取证。

这次失败发生在Portable用例启动之前。
没有跳过符号链接覆盖、改continue-on-error或放宽门禁。
文件及完整恢复/插件/包内链路尚无本轮标准账户结果。
原恢复/插件初始拒绝未被本轮解释，旧清理停滞仍unknown。

### 待用户本机准备：文件符号链接能力

下一步无需再安装Python、Git、VS或SDK。
需要让同一标准账户能够创建测试用文件符号链接。
这是测试夹具能力条件，当前没有修改系统配置。

1. 用户在指定Win11主机的Windows设置搜索开发者模式。
   若未开启，由用户本机启用并完成管理员确认。
   开发者模式是允许非提升创建链接的一种准备方式。
   若已开启或策略受管仍EPERM，具体原因保持unknown。
2. Runner继续使用原真实标准账户和交互会话。
   不改为管理员、不放宽组门禁、不修改旧目录DACL。
   若系统要求重新登录或重启，由用户安排，不自动执行。
3. 准备后先在同一账户核对原自检命令：
   node scripts/check-test-environment.mjs。
   它仅创建并清理自身临时夹具，不读旧数据目录。
   若仍EPERM，先定位权限/策略，不重复全套CI。
4. 自检通过并获得复验指令后，仅单次完整标准入口。
   only+standard_user=true，其余开关false，复用现有工具。
   原A隔离目录、超时和全部失败门禁继续保持。

### Windows 11 工具与依赖准备

用户授权后可显式启用 `install_windows11_tools`。
安装范围限 Git、Python 3.12 x64 和 VS2022 C++/SDK。
先核对 PATH、标准目录及 Python 安装登记。
缺失项从官方 HTTPS 来源安装，不主动计算文件摘要。

安装使用独立日志，不自动重启或修改执行策略。
安装开关默认关闭，开启时也只调度 Windows 11。
工具齐全后再开始应用测试，失败保持最终门禁。
归档检出时，保存生成文件原始副本供构建后比较。
只统一 CRLF，其他生成差异仍导致失败。

Windows 11 先按锁文件安装，暂不执行依赖脚本。
再选用 `@electron/rebuild` 引用的固定 node-gyp。
当前版本为 11.5.0，tar 由项目锁定为 7.5.22。
显式重建 better-sqlite3、Electron 和 esbuild。

此处避免使用 pnpm 发行包内置的 tar 7.5.1。
第五轮在其 Node 头文件解包处出现 ENOENT。
两者的原生结果需以指定 Windows 11 运行核对。
不修改依赖源码，版本及入口保存到环境附件。

先单独重建 SQLite 与 esbuild，再准备 Electron。
第六轮原始 Electron 下载返回 HTTP 504。
同版本官方 API 资产可放入标准下载缓存。
原安装器仍负责校验和解压，失败仍阻塞测试。

缓存准备记录来源、大小及下载状态。
只检查大小和 ZIP 格式，不自行计算文件摘要。
SQLite 未完成时，不能据下载结果关闭解包故障。

`windows11_startup_probe_only=true` 仅作定向诊断。
该开关同样跳过原 baseline，限定指定 Win11 主机。
保留依赖、构建和最小 Job 前置，再测单次启动。
整套文件、生命周期、GUI 和包内入口不在此模式运行。

探针执行真实 RuntimeStore 和 ACL，不替换权限行为。
逐次记录权限耗时及初始化、建任务、关闭和清理。
诊断测试有独立有限预算，不更改原 10 秒钩子门槛。
探针成功不作为整套 Windows 11 验收通过。

指定关闭事件只读取前后两分钟的 Runner 日志尾部。
只留事件类别、时间及相关服务事件，不上传原日志。
不读取凭据或完整环境，缺少记录时触发来源为未知。
该中断与此前初始化钩子超时分别保留。

`windows11_process_package_only=true` 是独立定向模式。
默认关闭，只验证所选进程、Electron、GUI 和目录包。
该模式跳过已知阻塞的整套文件，保留第七轮失败。
常规模式的文件入口、超时及最终门禁保持原样。

独立模式名称和完整验收明确区分，不能累加为全绿。
它附带同一单次启动探针及三次空 PowerShell 计时。
探针模式与独立进程模式互斥，均只运行指定 Win11。
该诊断入口不实施原生 ACL 产品适配或修改数据格式。

此模式复用文件、Job、生命周期和目录包入口。
Node 与 Electron ABI 仍顺序切换。
Windows 数据仍为 A 的新建隔离测试目录。
默认用户目录、旧目录升级 B 和安装器仍未验收。

环境 JSON 与源码、包内 GUI 输出分别保存。
独立失败继续保留，不使用 continue-on-error。
目录包只在执行器本地生成，不上传应用包。
入口提交使用 `[skip ci]`，再单独手动派发。

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

### Windows 11 自托管验证结果

Windows 11 尚未完整通过，原生权限适配已获授权。
指定主机为 DESKTOP-SFE95TP，Build 26300，x64。
当前运行账号已提升，普通用户场景尚未验收。
测试仅使用 A 的全新隔离目录，旧目录 B 不动。

第七轮正式运行在文件阶段中断。
至少 90 项初始化 hook 超出原 10000ms。
随后 Runner 收到关闭信号，触发者仍未知。
该关闭不能解释此前已经发生的超时。

第八轮单次诊断通过，初始化约 16.6 秒。
10 次真实 ACL 调用占约 99%，原测试门槛未变。
第九轮确认空 PowerShell 平均约 1.32 秒。
单次初始化约 16.7 秒，仍超过文件和 GUI 原截止。

第九轮独立验证为 failure。
运行：[42477496405](https://github.com/twotwothree2233/Trellis/actions/runs/42477496405)。
结果对应 `fa798457d04dea10ccea996a9b8a15f884b047b2`。
后续纯状态文档头不替代此验证头。

| 独立入口 | 第九轮结果 |
| --- | --- |
| Node / Electron 最小 Job | 两次 success |
| Portable / 独立核心进程 | 94 通过 / 15 通过、3 计算跳过 |
| 完整业务进程 | 110 通过、8 超时失败、3 计算跳过 |
| 包结构 / Electron 生命周期 | 19 通过、4 夹具跳过 / 5 通过、3 计算跳过 |
| Node / Electron binding | success，未启动计算 |
| 目录包构建、包内 RPC/进程树/PDF | success |
| 源码 / 包内 GUI | 各 1 失败，均未越过首启就绪 |
| 正式文件 | 本独立模式跳过；第七轮失败保留 |

8 项业务进程失败均在 recovery-shutdown 测试。
它们未在原 15000ms 预算内完成，清理也有 30000ms 超时。
两条 GUI 均在原 15000ms 就绪轮询失败。
任务创建与重启尚未执行，不能记为 GUI 已验收。

原生截图均显示“未连接运行时”。
源码 JSON 迟到返回 idle、无恢复错误、GC 可用。
包内 JSON 为 maintenance.timeout=true，状态仍未知。
完整截图与 JSON 已上传本轮原生附件。

最佳判断为权限冷启动延迟触发既有截止。
原生命周期、GUI 失败门禁继续保留，不扩大超时。
第九轮当时仅调查原生 ACL 方案，未改产品。
后续已单独授权，实施记录见下节。
没有新修复或证据需求时，不重复同缺口测试。

### Windows 原生 ACL 性能适配

产品接入前的原生门槛已在指定 Win11 通过。
[运行 42486026436](https://github.com/twotwothree2233/Trellis/actions/runs/42486026436)。
验证头为 `1457e11e7c863a520b455e727cc14fdd2f19c22a`。
此轮只代表技术门槛，不代表完整文件或 GUI。

Node 22.23.1 与 Electron 38.2.2/Node 22.19.0 均通过。
句柄与 Node 的精确 dev/ino/ctimeNs 一致。
权限差分、等价零写、后代 ctime 和 Job 清理均通过。
助手只依赖系统 Kernel32 与 Advapi32，使用静态 CRT。

Windows 常用 NTFS 路径现在使用 `trellis_acl.exe`。
它从固定应用路径加载，先加入 owner Job 再操作句柄。
等价 DACL 与已有 hidden 不写入，不缓存权限结论。
原 POSIX 行为、ctime 校验和 15000ms 调用截止不变。

已知不支持的卷或合法 ACE 在写入前选择原后端。
查询、身份、协议、执行及复验失败不静默回退。
目录包强制检查生产助手及 PE 架构，拒绝测试助手。
测试版真实写计数和故障注入不进入生产资产。

首轮接入复验为 42487914281 / eccb804，仍为 failure。
20 个新目录初始化平均约 354ms，p95 约 408ms。
原恢复关闭 8 项及源码/目录包 GUI 均通过。
文件 4 项、业务进程 1 项原失败继续保留。
三项已定位夹具冲突，另两项初始拒绝仍原因未知。

虚拟身份测试仅在真实权限边界临时使用真实身份。
业务格式测试仍保留大整数注入与原删除断言。
CI 故障日志只记录错误类别和固定原生阶段。
不会输出路径、完整命令或环境，修复后继续同机复验。

夹具修复后的 42490233089 / ae6adba 为 success。
文件 555 通过、1 跳过；完整进程 118 通过、3 跳过。
20 次启动 p95 为约 434ms，源码/包内 GUI 均通过。
日志仍捕获真实 WINDOWS_ACL_JOB_NOT_EMPTY。
该记录来自 storage-lifecycle 的重启测试。
上层捕获后局部断言通过，整轮 green 未关闭验收。
首轮 recovery/plugin-control 两次初始拒绝仍原因未知。

适配器现只在原 15 秒总预算内等待真实 Job 清空。
执行、确认和已知旧后端共享预算，不重新执行权限。
未归零、查询失败及超预算继续失败，ctime 比较不变。
CI 对真实未确认错误增加门禁，即使上层已捕获也失败。

包内探针新增空 PATH、临时 cwd 下直接调用 ACL 助手。
同时验证实际保护、重复保护 ctime 与 Job 清空。
该修复代码头为 c8d61fe7db89010b036b57cdb2f0d545435d19db。
[单次复验 42496582992](https://github.com/twotwothree2233/Trellis/actions/runs/42496582992)已 completed/success。
本轮只启用 windows11_only，其他模式开关均关闭。
指定 Win11 job 执行，四平台 baseline 明确 skipped。
原文件 hook、生命周期及 GUI 截止均保留。
具体边界见[决策笔记](../.agents/notes/implemented/bug-fix/2026-11-08-windows-native-acl.md)。
不改变身份格式、业务 schema，不迁移旧目录 B。

#### 指定 Windows 11 最终实际矩阵

此表只属于 c8d61fe，不回填到 ae6adba 或其他平台。
主机为 DESKTOP-SFE95TP，Windows 11 专业版。
版本 10.0.26300、x64，交互 session 1、elevated=true。
数据范围为精确身份方案 A 的全新隔离目录。

| 入口 | 42496582992 实际结果 |
| --- | --- |
| 构建、类型、契约与生成漂移 | success |
| Node / Electron ACL 安全差分 | 两次 success |
| Node / Electron 最小 Job | 两次 success |
| 20 个新目录启动测量 | 21 项测试通过 |
| Portable | 94 通过 |
| 核心进程 | 15 通过，3 计算门槛跳过 |
| 文件、恢复与清理 | 559 通过，1 POSIX 刷盘跳过 |
| 完整业务进程 | 118 通过，3 计算门槛跳过 |
| 恢复关闭子套件 | 8 项全部通过，属于完整进程入口 |
| 包结构与平台提示 | 21 通过，4 非 Windows 夹具跳过 |
| Node / Electron binding | success，未启动计算 |
| Electron 生命周期 | 5 通过，3 计算门槛跳过 |
| 源码 GUI | 1 通过，7.6 秒 |
| 目录包构建 | success，仅本地目录包 |
| 包内直接 ACL、RPC、进程树、离线 PDF | 全部 true |
| 包内 GUI | 1 通过，8.3 秒 |

核心进程是完整进程子集，计数不相加。
计算跳过仍为原限制、取消与父崩溃三个门槛用例。
文件跳过为 POSIX 目录 fsync 故障场景。
包夹具跳过四个非 Windows 目标，本机载荷已验收。

技术-only 和诊断-only 步骤按关闭的模式跳过。
完整模式已执行 Node/Electron 集成 ACL 安全探针。
关闭来源取证步骤未重跑，先前触发者仍为 unknown。
本轮没有失败步骤，也未运行其他系统或 Windows 版本。

日志实测两次真实 Job 从 active=1 确认到 0。
分别来自 replicas 与 storage-lifecycle 的真实文件用例。
确认耗时为 26.3671ms、26.7259ms。
WINDOWS_ACL_FAILURE 记录数为 0，原总预算未扩大。

新增回归覆盖 pending 到零、持续活动、查询失败和迟到结果。
旧后端不得取得新的预算，真实错误 afterEach 门禁保留。
本轮无真实 ACL 失败，afterEach 错误拒绝分支未触发。
包内探针从临时 cwd、空 PATH 调用生产助手。
它确认实际保护、精确身份、重复保护 ctime 与 Job 清空。

20 个全新目录均成功，每次 10 次真实 ACL 调用。
初始化平均 358.930ms，p95 452.913ms，最大 464.174ms。
同一 Node 进程顺序执行，未清空系统缓存或重启。
p95 低于 5000ms 目标，每次低于原 10000ms hook。

两张原生 GUI 截图均显示运行时已连接。
两份状态 JSON 均 idle、error=null、restore.error=null。
GC 可用，迁移关闭；创建、设置、重启断言均通过。
首轮两次控制初始化拒绝本轮未复现，原因仍未知。

该结果限上述主机、权限会话与 A 隔离目录。
普通用户、默认 HOME、旧目录 B、其他平台均未新增验收。
安装器、签名、升级卸载及断电一致性仍未验收。
后续纯文档头标注 [skip ci]，不再派发同缺口测试。

### 第十轮 Windows Server 基线实际覆盖

Windows 原生日志已核对计数与跳过原因。
独立核心进程入口是完整进程入口的子集。
两者不相加计为独立测试总数。

| 入口 | 第十轮结果 |
| --- | --- |
| Node / Electron 最小 Job 探针 | 两次均 success |
| Portable | 94 通过 |
| 独立核心进程 | 15 通过，3 跳过 |
| 文件、身份、恢复与清理 | 532 通过，1 跳过 |
| 完整业务进程 | 118 通过，3 跳过 |
| 包结构与平台提示 | 19 通过，4 跳过 |
| Electron 生命周期 | 5 通过，3 跳过 |
| Node / Electron SQLite 与 Monty binding | success，不启动计算 |
| 源码桌面首启与重启 | 1 通过，11.6 秒 |
| 目录包构建及包内运行探针 | success |
| 目录包桌面首启与重启 | 1 通过，10.6 秒 |

三个计算跳过项来自同一 `runtimeVerified` 门槛。
分别为原生限制、原生取消及原生父崩溃测试。
Node 核心、完整进程与 Electron 入口各跳过它们。
真实进程夹具仍覆盖取消、超时、失联与父崩溃。

文件跳过项是 POSIX 目录 fsync 故障注入。
Windows 明确只提供 `file-sync-only`。
四个包结构跳过项是非 Windows 目标夹具。
Windows 另有用例确认拒绝其 POSIX 可执行位缺失。

Job 探针确认嵌套、先纳管和父崩溃清理。
启动期父崩溃也通过，Node 和 Electron 均已执行。
日志中的预期纳管失败用于验证后端不启动。
它不构成步骤失败，最终探针断言均通过。

包内 SQLite、Monty binding、app-node RPC 均通过。
派生进程清理、PDF 后端和离线 PDF 均为 true。
包内进程探针从临时 cwd 启动，PATH 为空。
GUI 冒烟使用隔离数据并显式关闭计算。

第十轮没有失败步骤。
Windows 跳过 macOS framework 与 Linux 桌面步骤。
失败附件上传因本轮成功而未执行。
这些条件跳过不削减 Windows 对应入口的覆盖。

### 保留结果与未验收范围

第七至九轮原始结果继续保留。

- [第七轮](https://github.com/twotwothree2233/Trellis/actions/runs/42352655882)：failure。
  Windows 文件、完整业务进程和 GUI 失败。
  原生截图显示 `RESTORE_JOURNAL_INVALID`。
  该轮 blocked/error JSON 只有代码路径核对。
- [第八轮](https://github.com/twotwothree2233/Trellis/actions/runs/42374570223)：cancelled。
  Windows 文件 18 项失败，总预算耗尽。
- [第九轮](https://github.com/twotwothree2233/Trellis/actions/runs/42378726207)：failure。
  仅 Windows 包内 GUI 就绪竞态失败。
  原生 JSON 为 idle、无恢复错误、GC 可用。

第十轮 green 来自文首完整代码提交。
源码与目录包的四平台自动化范围已通过。
未制作或发布 ZIP、NSIS、AppImage 安装分发产物。

尚未验收的范围如下：

- Windows 11 普通用户及各平台最低系统版本。
- 干净环境安装、卸载、升级和保留数据。
- 正式签名、公证、隔离属性及 SmartScreen。
- 完整插件安装、信任及真实材料解析。
- UNC/SMB 服务端持久化语义。
- Windows 目录元数据断电一致性。
- 旧目录升级方案 B 和新计算目标开放。

这些事项继续保留为独立授权与验收门槛。
纯状态文档提交使用 `[skip ci]`，不重复整套 CI。


### 最小符号链接探针与依赖前门禁

探针先沿用现有指定主机/真实标准账户门禁。
只复用已有Node22.23.1/x64，不调用setup-node下载。
只检查已知Runner工具缓存，缺失或未知即停止。
不改变TEMP/TMP，保持与本轮相同账户和临时目录条件。

节点发现放独立只读进程，最多5秒。
版本验证3秒，原真实文件自检10秒，总限25秒，步骤1分钟。
运行原scripts/check-test-environment.mjs，不另造替代逻辑。
实际创建文件symlink并核对realpath，不以junction代替。

附件仅host布尔事实、Node版本、started/exit/timeout/错误类别。
stderr只在内存解析EPERM等有限code，不上传路径或完整环境。
用户反馈已手动开启开发者模式，先执行一次独立探针。
该反馈作为准备完成记录，实际能力以原生自检为准。
入口不变更系统、不下载工具或切换账户。

windows11_symlink_probe_only为默认关闭的手动模式。
须only+standard_user，其余安装/诊断模式false。
该模式全部pnpm/依赖/构建/应用步骤跳过，应用0。
成功后再协调一次完整复验，不自动连续派发。

标准账户full在原工具门禁之前执行同一有界原自检。
自检失败令standard_tools不执行，现有35入口继续关闭。
通过后原工具门禁与依赖正常继续，不重装任何已成功工具。
Portable及packaging命令里的原自检仍保留，作为最终门禁。
原应用截止、标准账户约束与所有失败条件保持。

探针位于scripts/windows11-symlink-probe.cjs。
只读发现拒绝重解析路径、未知版本和非本机缓存。
独立模式使用新检出目录，3分钟截止并核对HEAD。
Git仅复用并选择job临时PATH，所有安装开关false。

本机隔离验证覆盖25个进程分支、11个元数据分支。
1024组输入及53760次原条件比较通过。
8段内联JS编译通过，35个依赖/应用入口均关闭。
这些是入口静态验证，原生结果另记具体运行头。

42586965647的原生附件已核对，stage=ready/passed=true。
Win11专业版26300/X64/session2，非提升且无管理员组。
Node22.23.1缓存复用，原TEMP/TMP保持，总用时281ms。
发现/版本/原自检均started=true/exit0/timeout=false。

新目录checkout与HEAD通过，Git2.56.0.windows.4继续复用。
35个依赖应用、Python准备、标准工具门禁共37步骤跳过。
该探针baseline跳过、应用0；后续完整结果见下。
旧EPERM及此前unknown原因保留，未改写原失败结论。


### 42587842121：指定标准账户完整入口通过

[42587842121](https://github.com/twotwothree2233/Trellis/actions/runs/42587842121) completed/success。
精确验证头为：
`45883cf4f9cf19a9ef358b433d73f510b9fc1a18`。
相较探针头b864a1a，仅开发说明和原笔记变化。

Win11 job于08:42:03Z开始，08:56:54Z结束。
50个步骤为41 success、9个预期模式步骤skipped。
其他平台baseline skipped，未运行其他版本或系统。
原10秒hook、15秒ACL预算及GUI截止未改。

host实际为DESKTOP-SFE95TP/Win11专业版10.0.26300/X64。
session2/interactive=true/elevated=false。
administrators_group_present=false/system_account=false。
范围限此标准会话与具备file-symlink能力的新A隔离目录。

| 入口 | 实际结果 | 计数边界 |
| --- | --- | --- |
| 原symlink/realpath前置 | passed，297ms | Node22.23.1缓存，原TEMP/TMP |
| Python/VS/SDK/Git | 门禁通过，全部复用 | 无工具安装 |
| 构建/合同漂移/合同验证 | success | 原有门禁 |
| 20目录性能 | 21 passed；20/20初始化；200 ACL | 独立性能套件 |
| Portable | 10文件，94 passed | 无跳过 |
| 核心进程子集 | 2文件，15 passed/3 skipped | 已包含于完整进程，不重复加总 |
| 完整文件 | 23文件，559 passed/1 skipped | 含recovery39、restore30 |
| 完整进程 | 8文件，118 passed/3 skipped | 含恢复关闭8、插件进程24 |
| 插件业务与RPC | calls35、queries7、rpc15通过 | 已包含于完整进程 |
| Node/Electron原生ACL | 各4组检查passed=true | 文件/目录身份、owner/DACL/继承、ctime、等价零写和拒绝路径 |
| Node/Electron最小Job | 各5个汇总字段true | 与完整生命周期分别记录 |
| Electron生命周期 | 1文件，5 passed/3 skipped | 单独Electron运行时 |
| 包结构 | 3文件，21 passed/4 skipped | 仅Windows生产闭包及通用拒绝检查 |
| 源码GUI | 1 passed，9.2秒 | 创建、重启恢复、窗口关闭及Utility退出 |
| 本地目录包 | success | 2173文件、22依赖、format=dir/published=false |
| 包内直接ACL | privateAcl=true | 两次保护，Job归零、身份与重复ctime检查 |
| 包内进程与PDF | SQLite/Monty绑定/RPC/后代清理/PDF均true | 合成单页文字PDF，不执行Monty计算 |
| 包内GUI | 1 passed，13.3秒 | 同源码GUI场景 |

跳过项均保留既有能力或平台条件：

- 文件1项为POSIX目录fsync失败注入，Windows不运行。
- 核心/完整进程/Electron各3项为同三种真实Monty计算场景。
  Windows的runtimeVerified仍false，没有开放新计算目标。
- 包结构4项为darwin-arm64、darwin-x64及两种Linux生产闭包。
  Windows不能保持POSIX执行位；对应Windows拒绝检查实际通过。
- 9个workflow步骤是检出诊断2项、工具安装2项、ACL技术-only3项。
  另有Runner关闭取证和startup-only各1项。
  完整文件、进程、恢复关闭和包内应用入口均实际执行。

标准工具JSON的missing为空，approved_installation=false。
Python3.12.10由当前账户固定位置及HKCU验证后选择。
PATH内应用别名仍REPARSE_PATH拒绝，未放宽未知路径边界。
VS17.14.37827.9/MSVC14.44.35207、SDK10.0.26100.0有效。

ACL性能平均424.333ms，p95=505.384ms，最大547.562ms。
20目录均低于原10秒hook，p95低于5000ms目标。
Node与Electron文件/目录的精确dev/ino/ctime与句柄一致。
继承、owner、DACL、拒绝路径和重复零写检查通过。

捕获日志与afterEach门禁已核对，真实WINDOWS_ACL_FAILURE为0。
WINDOWS_ACL_JOB_NOT_EMPTY/DEADLINE及未处理错误均未出现。
3次观察到Job短暂非空，随后均确认active=0。
对应等待79.664ms、17.223ms、9.441ms，未放宽预算。

Node/Electron各一处PROCESS_JOB_ATTACH_FAILED是预期负向用例。
两份堆栈各出现message/code，不计作四次实际故障。
它们后续最小Job汇总均true，完整进程亦独立通过。
日志中ETIMEDOUT仅为Git准备入口回显的错误分类代码。

源码与包内platform-smoke.png均已实际查看。
两份desktop-status.json均ok=true/phase=idle/error=null。
restore.error=null，gc.enabled=true/gc.error=null。
截图显示运行时连接正常，重启后的任务及缩放断言通过。

包内PDF.js有可选canvas/DOMMatrix/Path2D告警。
本轮合成单页文字提取通过，图片渲染和OCR未验收。
旧recovery/plugin初始拒绝未复现，具体先前原因仍unknown。
原EPERM、旧检出清理取消及全部先前失败记录保留。

本轮只增加测试入口和说明，未改产品或持久化格式。
精确身份方案A继续限新隔离目录，旧目录升级B冻结。
默认HOME、其他账户/策略/Win11构建和其他平台未新增验收。
安装/卸载/升级、签名/SmartScreen、UNC/SMB、断电仍待验收。

无需为同一缺口再派发测试或重装工具。
仅允许范围内文档[skip ci]收尾，代码验证头与文档头分开记录。
不主动计算摘要、不创建PR、不合并或发布安装包。


### 默认入口必需测试：独立定向模式

用户仅授权补必需测试，先补真实默认入口缺口。
windows11_default_startup_only默认关闭，限指定Win11真标准账户。
须only+standard_user，其他八个开关false；原模式保持。
GitHub.com官方上限25个inputs，现有11个，不移除旧模式。

依赖前运行只读前检，检查真实HOME及.trellis祖先。
仅查询类型、重解析、可访问性和相关进程的PID/父PID。
不枚举默认目录、不读业务或认证配置、不修改权限。
目标已存在（含空目录）、未知或有Trellis/Electron实例即应用0停止。

元数据与本机进程查询各5秒，顺序最多3次，步骤1分钟。
启动前再次确认目录不存在、无相关实例且祖先身份稳定。
脚本不预建数据根；应用自身创建新默认目录和必要私有权限。
进程出现冲突、目录身份变化或无法确认独占即失败。

只运行最终目录包Trellis.exe，cwd为独立空临时目录。
子应用PATH为空，HOME/USERPROFILE保留真实值。
环境键按Windows大小写过滤，所有TRELLIS测试键均清除。
ELECTRON_RUN_AS_NODE连空键也不传，排除NODE_OPTIONS等注入。

单个GUI场景只创建空任务、保存字号、重启并正常退出。
两次启动均核对实际环境、默认userData、维护状态及文件身份。
读取本次新目录的两个小版本标记，不读settings/auth。
默认策略仍为restore-v5/gc-v1，不启用A或迁移B。

原GUI30秒用例截止、15秒就绪等待保持。
源码GUI、文件、进程、性能和原包内套件均不重复。
19个非必要测试/合同步骤显式跳过，baseline跳过。
仅保留新目录包构建、Electron ABI准备和专用结果门禁。

结果JSON必须证明实际执行、两次启动及退出确认。
跳过用例、缺失附件、被捕获错误或不健康状态均保持失败。
只采必要状态/格式/身份和截图，不采完整环境或凭据。
新默认目录与失败证据保留，不递归清理，不作为下次新目录复用。

首次默认格式拒绝时，记录真实应用失败并停止。
不加decimal-v2重试，不修改产品或格式，不把拒绝当预期通过。
安装器、真实插件/材料/摘要、其他系统均不执行。
历史全套验收结果仍绑定45883cf，不能代替本次默认入口结果。


### 42600636612：环境断言失败，默认入口结论未取得

[42600636612](https://github.com/twotwothree2233/Trellis/actions/runs/42600636612) completed/failure。
精确运行头546b4e1dd0bf8cebbc136dd6d444c41a9795dc41。
指定Win11专业版26300/X64/session2真标准账户门禁通过。
baseline及原全套矩阵跳过，未安装Git/Python/VS/SDK或制作安装器。

只读前检实际passed=true，默认目录不存在、相关实例0。
隔离checkout/HEAD、工具门禁、构建、Electron ABI及目录包均通过。
应用实际启动1次，场景1失败，最终结果门禁也保持failure。
原JSON的failed_stage=prelaunch只是旧测试标签，应用已经启动。

已证实首个失败点为actual_environment.empty_path=false。
HOME/USERPROFILE及默认userData检查均true。
数据/格式测试变量、ELECTRON_RUN_AS_NODE、NODE_OPTIONS均未出现。
该布尔未记录缺键、非空、大小写重复等分型，具体PATH原因unknown。

锁定Playwright1.56.1的客户端与服务端都保留显式env。
源码未显示把父环境合并进options.env的步骤。
Windows Electron启动使用shell=true，返回进程可能是cmd代理。
这些源码事实不用于追认本轮PATH实际类型。

失败截图已实际查看，主界面显示早期“未连接运行时”。
本轮没有维护状态JSON返回，也没有目录身份或版本标记附件。
空任务、字号保存、重启和正常窗口退出断言均未执行。
app.close未记录异常，但真实主进程及utility退出未获确认附件。

Runner仅记录vctip编译辅助进程的孤儿清理。
该日志不作为应用树已正常退出的证明。
本轮默认目录创建字段为null，不能按不存在处理。
应用已进入真实默认userData，目录按可能已创建保留，不复用为fresh。

最小测试修正如下，尚未原生验证：

- PATH记录absent/empty/nonempty/ambiguous/unknown和键/条目计数。
  仅缺键或空值两种零条目状态合格，非空或重复大小写键仍失败。
  不记录原始PATH，不把该修正回写为首轮原因或通过。
- 从Electron主进程内process.pid取得真实owner。
  cmd代理PID单独记录，不用于named-process所有权核对。
- 环境断言前先记录默认目录身份，失败时保留必要标记与状态。
  维护状态超时/错误显式落盘，补主进程与utility退出事实。
- 每次launch清空当前PID、process_identity、环境和维护快照。
  第二次launch/firstWindow/evaluate失败时不借用首轮PID。
  首轮已确认退出只作为历史exits记录保留。

本机隔离检查：PATH分型10组、第二次启动失败3分支通过。
结果门禁2正向/44负向，父进程29/元数据19分支通过。
GUI安全3分支、TypeScript及必要文档检查通过。
所有本机检查未执行原生Windows应用或其他系统应用。

下一次fresh必须重新确认真实默认目录不存在及无相关实例。
本轮目录不清理、不移动、不迁移，也不换HOME绕过。
由用户准备满足前提的标准账户环境后，再决定单次复验。
当前没有新增dispatch，修复不继承首轮或A隔离目录的green。

产品/格式/schema/settings-auth/B/超时及计算门槛均未改。
不主动计算摘要，不合并、不创建PR或发布。

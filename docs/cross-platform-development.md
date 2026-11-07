# 跨平台开发与验证

A、B 阶段建立测试入口与统一资产描述。
C 阶段统一文件操作、权限与持久化接口。
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
| `pnpm test:unit` | 全部业务单元测试 | 切 Node ABI |
| `pnpm test:native` | 原生计算、macOS 打包契约 | 构建；仅已验收目标可运行 |
| `pnpm test` | 单元测试加原生验收 | 保留 macOS 完整回归入口 |
| `pnpm verify:native:node` | SQLite 和 Monty binding 加载 | 切 Node ABI，不启动计算 |
| `pnpm verify:native:electron` | 同一探针在 Electron 中运行 | 切 Electron ABI |
| `pnpm test:electron:portable` | 无计算能力时的启动和重启 | 构建并切 Electron ABI |
| `pnpm test:electron` | 全部 Electron 业务测试 | 构建并切 Electron ABI |

`test:portable` 明确列出基线用例。
它覆盖 schema、目标表、定位与能力门槛。
同时覆盖工具输入、诊断和工作区布局。
`test:files` 覆盖文件发布、恢复和清理。
它使用真实文件系统及 SQLite。
摘要比较使用测试替身，不计算文件哈希。
进程树验收继续由 D 阶段补齐。

完整业务单测在候选平台仍可能暴露缺口。
通用基线通过后，支持声明仍需安装包验收。
测试清单见根目录 `vitest*.config.ts` 配置。

### 原生 ABI 顺序

一个工作目录内必须顺序切换 ABI。

1. 构建应用与类型。
2. 执行 `test:portable` 与 `test:files`。
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

## 持续验证边界

CI 工作流覆盖 A–C 基线、探针与桌面冒烟。

四个执行器覆盖三种系统及两种 macOS 架构。
Node 与 Electron binding 探针在原生系统运行。
桌面冒烟显式关闭 Monty，以验证无计算路径。
工作流不制作安装包，也不上传发布物。

原生计算与包清单测试保留为独立入口。
这些既有测试包含文件摘要校验。
运行范围应遵守当前任务对文件校验的要求。
本轮增加的资产门槛单测使用合成摘要结果。
文件测试入口也使用合成摘要结果。

CI 配置需提交后才能在远端执行。
本地通过与远端平台通过应分别报告。

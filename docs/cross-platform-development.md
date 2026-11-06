# 跨平台开发与验证

A、B 阶段建立测试入口与统一资产描述。
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
文件恢复和进程树验收继续由 C、D 阶段补齐。

完整业务单测在候选平台仍可能暴露缺口。
通用基线通过后，支持声明仍需安装包验收。
测试清单见三个 `vitest*.config.ts` 配置。

### 原生 ABI 顺序

一个工作目录内必须顺序切换 ABI。

1. 构建应用与类型。
2. 执行 `test:portable` 或 `test:unit`。
3. 执行 Node binding 探针。
4. 重建 Electron binding 并执行探针。
5. 执行桌面测试。

不要并发运行两种原生重建。
切回单元测试时重新使用 Node 重建入口。
探针日志记录 Node、Electron 和 ABI 版本。

### 平台测试权限

链接权限缺失必须作为覆盖缺口报告。

`test:portable` 会实际创建文件符号链接。
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
本轮不改变已有配置和凭据行为。

## 持续验证边界

CI 工作流只运行 A、B 的基线与探针。

四个执行器覆盖三种系统及两种 macOS 架构。
Node 与 Electron binding 探针在原生系统运行。
桌面冒烟显式关闭 Monty，以验证无计算路径。
工作流不制作安装包，也不上传发布物。

原生计算与包清单测试保留为独立入口。
这些既有测试包含文件摘要校验。
运行范围应遵守当前任务对文件校验的要求。
本轮增加的资产门槛单测使用合成摘要结果。

CI 配置需提交后才能在远端执行。
本地通过与远端平台通过应分别报告。

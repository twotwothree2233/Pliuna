# 当前测试与桌面交付

测试按结构、文件、进程、原生运行和界面分组。
配置文件定义当前执行范围。
单次本地通过记录不扩大平台支持范围。

## 测试入口

| 命令 | 范围 |
| --- | --- |
| pnpm test | 顺序执行 test:unit 和 test:native |
| pnpm test:unit | 默认单元与运行时测试；先切换 Node ABI |
| pnpm test:portable | 目标目录、工具参数、契约、布局等便携检查 |
| pnpm test:files | 文件身份、权限、恢复和资源生命周期 |
| pnpm test:process | 进程树、Monty、插件和必要清理 |
| pnpm test:process:electron | Electron ABI 下的进程控制检查 |
| pnpm test:packaging | 包结构、平台配置与代理元数据拦截 |
| pnpm test:native | 当前已验证目标的真实原生验收 |
| pnpm test:electron | 完整 Electron Playwright 场景 |
| pnpm test:electron:portable | Electron 启动与重启基础场景 |
| pnpm test:desktop:packaged | 打包后桌面检查入口 |

[便携配置](../../vitest.portable.config.ts)、[文件配置](../../vitest.files.config.ts)、[进程配置](../../vitest.process.config.ts)明确各自范围。
[打包配置](../../vitest.packaging.config.ts)包含两套流程的回归。
原生验收由[native 配置](../../vitest.native.config.ts)检查目标资格。

## 合成与真实运行

文件和进程分组使用合成完整性适配。
打包代理文件测试使用临时目录和外部进程桩。
原生验收单独检查实际原生包和应用运行条件。
这些分组的验证范围分别报告。

## 当前平台目录

| 目标 | Monty runtimeVerified |
| --- | --- |
| darwin-arm64 | true |
| darwin-x64 | false |
| linux-x64-gnu | false |
| linux-arm64-gnu | false |
| win32-x64-msvc | false |

目录来自[native-targets.json](../../src/shared/native-targets.json)。
CI 定义在[cross-platform.yml](../../.github/workflows/cross-platform.yml)。
工作流覆盖平台候选的构建、测试与目录包。
目标包存在不自动打开 Monty 执行门槛。

## 两套打包流程

| 流程 | 入口与产物 |
| --- | --- |
| 跨平台桌面 | [package-desktop.mjs](../../scripts/package-desktop.mjs)；dir、macOS zip、Windows NSIS、Linux AppImage |
| macOS ARM64 专用入口 | [package-macos.mjs](../../scripts/package-macos.mjs)；应用目录、清单与 zip |

两套入口均保留在当前 package scripts 中。
输出要求工作区之外的新绝对目录。
桌面候选配置禁用发布，macOS 使用临时签名配置。
专用入口的可选 guide 只读取显式指定的文件。

目录包生成后可运行 verify:desktop 检查结构。
verify:desktop:runtime 检查包内运行环境。
test:desktop:packaged 接收同一输出目录并启动测试。

## 包内范围

桌面包只复制构建输出、生产依赖闭包和 PDF 参考插件。
不会复制整个工作区或用户数据目录。
Node 原生模块、utility worker 和监督器保持固定路径。
框架的合法相对链接在 macOS 流程中保留。

本地代理元数据通过[共享规则](../../scripts/local-agent-files.mjs)拒绝。
覆盖配置目录、指引文件和笔记路径。
也覆盖 `.github` 下的 Copilot 指引、指令、代理和提示词。
复制阶段与成品检查均可阻止混入。
规则不按 agent 关键词排除应用代码和提示词。

## 回归覆盖

- 构建输出、依赖和插件中的本地代理文件。
- 空目录、大小写差异和 Windows 路径分隔符。
- 已暂存包被再次污染后的拒绝。
- 应用 agent 代码和原始提示词保留。
- 原有凭据、数据库及不安全链接保护。
- macOS 框架相对符号链接保留。

相关测试：[desktop-packaging](../../tests/unit/desktop-packaging.test.ts)、[package-agent-files](../../tests/unit/package-agent-files.test.ts)。

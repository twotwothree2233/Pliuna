# 开发与本地验证

当前工程使用锁定的 Node、pnpm 和依赖版本。
版本入口为 [.node-version](../.node-version)与[package.json](../package.json)。

## 工具链

| 工具 | 当前版本 |
| --- | --- |
| Node | 22.23.1；package engines 要求至少 22 |
| pnpm | 10.20.0 |
| Electron | 38.2.2 |
| TypeScript | 5.9.3 |
| React | 19.2.0 |
| electron-vite | 4.0.1 |
| Vitest / Playwright | 3.2.4 / 1.56.1 |

依赖安装遵循 [pnpm-lock.yaml](../pnpm-lock.yaml)。
Python 的契约检查依赖见[requirements-dev.txt](../scripts/requirements-dev.txt)。

## 安装与构建

```sh
pnpm install --frozen-lockfile --config.side-effects-cache=false
python3 -m pip install -r scripts/requirements-dev.txt
pnpm build
pnpm dev
```

`build` 依次生成类型、执行类型检查并构建应用。
最后一步复制进程监督器，并按平台构建原生辅助模块。
生成文件位于 `out/`。

`dev` 会先将 SQLite 模块切换到 Electron ABI。
Node 测试与 Electron 测试使用不同的原生 ABI。
相关命令分别提供 `rebuild:node` 和 `rebuild:electron`。

## 常用检查

| 命令 | 检查对象 |
| --- | --- |
| `pnpm generate` | 从当前 Schema 生成 TypeScript 类型 |
| `pnpm typecheck` | 源码、测试和配置的静态类型 |
| `pnpm verify:contracts` | 当前 Schema 样例及内存 SQL 约束 |
| `python3 docs/contracts/verify.py` | 运行契约、文档示例及本地链接 |
| `pnpm test:packaging` | 两套打包流程的结构和隐私保护 |
| `pnpm test:portable` | 平台候选的便携检查 |
| `pnpm test:files` | 文件行为、恢复及资源生命周期 |
| `pnpm test:process` | 进程树、插件和取消清理 |
| `pnpm test:electron` | Electron 界面和端到端行为 |

完整测试分组见[测试与交付](harness/testing-delivery.md)。
运行原生测试前，先确认目标平台的验收门槛。

## 数据与诊断入口

默认数据目录为 `~/.pliuna`。
`PLIUNA_TEST_DATA` 可指定独立数据目录。
测试和本地诊断应使用独立目录。

新目录不存在时，应用沿用已有的 `~/.trellis`。
旧资料保持原位，不自动合并两个目录。
旧诊断变量仍可读取，新变量优先。

正式启动默认启用界面替换与 Monty 功能入口。
`PLIUNA_ENABLE_VIEW_REPLACEMENT=0` 可关闭界面替换。
`PLIUNA_ENABLE_MONTY=0` 可关闭计算入口。
Monty 仍需通过平台与原生资产门槛。

`fixture` 是设置中可选的固定示例模型。
它用于本地夹具，不会发送模型网络请求。
配置和插件启用本身不会自动提交任务。

## 桌面候选包

```sh
pnpm build
pnpm rebuild:electron
node scripts/package-desktop.mjs --output /absolute/new/directory --format dir
```

输出必须是工作区以外的新绝对路径。
省略 `--format dir` 时使用平台默认分发格式。
macOS ARM64 专用入口为 `scripts/package-macos.mjs`。
它同样要求显式指定新的输出目录。

打包配置禁用自动发布。
包内文件范围及代理元数据拦截见[交付说明](harness/testing-delivery.md)。

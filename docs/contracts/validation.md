# 契约与文档校验

检查使用当前运行契约和当前测试样例。
文档目录不再保留旧版验证数据或历史验收记录。

## 当前检查入口

```sh
pnpm verify:contracts
python3 docs/contracts/verify.py
```

Python 依赖来自[requirements-dev.txt](../../scripts/requirements-dev.txt)。
运行契约检查由[verify-contracts.py](../../scripts/verify-contracts.py)执行。
文档检查复用该入口，再检查本目录及领域术语。

## 检查内容

- 当前 Schema 符合 JSON Schema 2020-12。
- 当前 manifest 中的正反例按预期接受或拒绝。
- 当前 SQL 可装载到内存数据库。
- 未结束 Run、恢复点唯一性及事务回滚约束成立。
- Markdown 围栏及 JSON 示例语法正确。
- 标注 Schema 名称的 JSON 示例通过对应定义。
- 相对文档链接、代码文件链接和本地锚点存在。

## 示例写法

普通 JSON 围栏检查语法。
在语言后标注定义名，可增加 Schema 检查。
例如协议页的 `json ipc_request`。
定义名直接使用核心 Schema 的 $defs 名称。

模型服务端参数由 tools.ts 定义。
这类示例不与内部 model_request 形态混用。
转换行为由[tool-input 测试](../../tests/unit/tool-input.test.ts)覆盖。

## 行为证据

| 关注点 | 对应测试 |
| --- | --- |
| 当前契约正反例 | [contracts.test.ts](../../tests/unit/contracts.test.ts) |
| 工具参数与错误诊断 | [tool-input.test.ts](../../tests/unit/tool-input.test.ts) |
| 契约正文交付 | [contract-delivery.test.ts](../../tests/unit/contract-delivery.test.ts) |
| 当前角色请求 | [prompt-requests.test.ts](../../tests/unit/prompt-requests.test.ts) |
| 打包代理元数据保护 | [package-agent-files.test.ts](../../tests/unit/package-agent-files.test.ts) |

Schema 检查负责结构与基础数据库约束。
状态、审批、文件故障及界面行为使用专门测试。
完整分组见[测试与交付](../harness/testing-delivery.md)。

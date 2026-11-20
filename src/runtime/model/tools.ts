import core from '../../shared/contracts/core.schema.json'
import type { ToolDefinition } from './adapter'

export const modelTools: ToolDefinition[] = [
  {
    "type": "function",
    "function": {
      "name": "list",
      "description": "列出当前任务的对象或能力。kind=\"object_type\" 返回 contract_target 契约入口。示例：{\"kind\":\"resource\",\"limit\":20}",
      "parameters": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string",
            "enum": core.$defs.list.properties.kind.enum
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 200
          },
          "cursor": {
            "type": "string"
          },
          "filters": {
            "type": "object",
            "properties": {
              "name_query": {
                "type": "string"
              },
              "status": {
                "type": "string"
              },
              "since": {
                "type": "string"
              },
              "until": {
                "type": "string"
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "kind"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read",
      "description": "读取正文、对象或契约。content_tree 以 View/节点 ID 分页查询子结构，可用 find 搜索标题；content_node 返回准确 HTML 和基线。续读使用 kind/id/cursor。纯文本支持 lines/pages/find。示例：{\"kind\":\"resource\",\"id\":\"<资源ID>\"}",
      "parameters": {
        "type": "object",
        "properties": {
          "kind": {
            "type": "string"
          },
          "id": {
            "type": "string"
          },
          "max_chars": {
            "type": "integer",
            "minimum": 1,
            "maximum": 32000
          },
          "cursor": {
            "type": "string"
          },
          "selection": {
            "type": "object",
            "properties": {
              "view": {
                "type": "string",
                "enum": [
                  "object",
                  "text",
                  "guide",
                  "schema",
                  "example",
                  "metadata",
                  "export_check"
                ]
              },
              "lines": { "type": "array", "items": { "type": "integer", "minimum": 1 }, "minItems": 2, "maxItems": 2 },
              "pages": { "type": "array", "items": { "type": "integer", "minimum": 1 }, "minItems": 2, "maxItems": 2 },
              "find": { "type": "string", "minLength": 1 },
              "revision": {
                "type": "integer"
              },
              "section": {
                "type": "string"
              }
            },
            "additionalProperties": false
          }
        },
        "required": [
          "kind",
          "id"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write",
      "description": "写入任务内容。resource.create 优先用 input 对象，避免重复转义。其他操作用 input_json JSON 文本。二者恰一，仍按操作契约校验。示例：{\"operation\":\"resource.create\",\"input\":{\"display_name\":\"说明\",\"content\":{\"type\":\"text\",\"text\":\"正文\"}}}",
      "parameters": {
        "type": "object",
        "properties": {
          "operation": {
            "type": "string",
            "enum": core.$defs.write.oneOf.map(branch => branch.properties.type.const)
          },
          "input_json": {
            "type": "string"
          },
          "input": {
            "type": "object"
          }
        },
        "required": [
          "operation"
        ],
        "anyOf": [{ "required": ["input"] }, { "required": ["input_json"] }],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "call",
      "description": "调用已发现的能力。input_json 是能力参数的 JSON 文本，按契约解码一次。示例：{\"capability\":\"builtin:monty:v1\",\"input_json\":\"{\\\"code\\\":\\\"result = sum(values)\\\",\\\"inputs\\\":{\\\"values\\\":[2,3,5]}}\"}",
      "parameters": {
        "type": "object",
        "properties": {
          "capability": {
            "type": "string"
          },
          "input_json": {
            "type": "string"
          },
          "references": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string"
                },
                "target": {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string"
                    },
                    "id": {
                      "type": "string"
                    },
                    "expected_revision": {
                      "type": "integer"
                    }
                  },
                  "required": [
                    "kind",
                    "id"
                  ],
                  "additionalProperties": false
                }
              },
              "required": [
                "name",
                "target"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "capability",
          "input_json"
        ],
        "additionalProperties": false
      }
    }
  }
]

export const toolDescriptions = Object.fromEntries(modelTools.map(tool => [tool.function.name, tool.function.description]))

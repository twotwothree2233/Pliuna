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
      "description": "读取正文、对象或契约。纯文本默认正文，契约默认指南；lines/pages 为含首尾范围，find 为字面搜索。续读只需 kind/id/cursor。示例：{\"kind\":\"resource\",\"id\":\"<资源ID>\",\"selection\":{\"lines\":[1,20]}}",
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
      "description": "写入任务内容。input_json 是操作输入的 JSON 文本，按契约解码一次。示例：{\"operation\":\"resource.create\",\"input_json\":\"{\\\"display_name\\\":\\\"说明\\\",\\\"content\\\":{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"正文\\\"}}\"}",
      "parameters": {
        "type": "object",
        "properties": {
          "operation": {
            "type": "string",
            "enum": core.$defs.write.oneOf.map(branch => branch.properties.type.const)
          },
          "input_json": {
            "type": "string"
          }
        },
        "required": [
          "operation",
          "input_json"
        ],
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

import { createHash } from 'node:crypto'
import { modelTools } from './tools'
import agent from './prompts/agent-v0.1.txt?raw'
import approval from './prompts/approval-v0.1.txt?raw'
import summary from './prompts/summary-v0.1.txt?raw'
import schema from '../../shared/contracts/core.schema.json'
import defaults from '../../shared/contracts/development-defaults.json'

// Bump the adapter revision when its behavioral contract changes without schema changes.
export const modelProtocol = createHash('sha256').update(JSON.stringify({ adapter: 'chat-sse-export-selection-v8', evidence: 'request-evidence-v1', managed: 'managed-v1-open-markup-shadow-2', tools: modelTools, schema, defaults, agent, approval, summary })).digest('hex')

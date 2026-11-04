import Ajv2020 from 'ajv/dist/2020.js'
import { ContractError, validateModel } from '../../shared/validation'
import type { ModelRequest } from '../../shared/contracts.generated'
import defaults from '../../shared/contracts/development-defaults.json'
import { modelTools } from './tools'
import core from '../../shared/contracts/core.schema.json'
import { inputDiagnostic } from './input-diagnostics'
import { jsonDiagnostic } from './json-diagnostic'

export interface ReadSelection {
  view?: 'object' | 'text' | 'guide' | 'schema' | 'example' | 'metadata' | 'export_check'
  lines?: [number, number]
  pages?: [number, number]
  find?: string
  revision?: number
  section?: string
}
export interface ModelReadOptions { max_chars: number; selection: ReadSelection; explicit?: { max_chars?: number; selection?: ReadSelection } }
const reads = new WeakMap<object, ModelReadOptions>()
export const setModelReadOptions = (request: object, options: ModelReadOptions): void => { reads.set(request, options) }
export const modelReadOptions = (request: object): ModelReadOptions | undefined => reads.get(request)
const ajv = new Ajv2020({ strict: false })
const validators = new Map(modelTools.map(tool => [tool.function.name, ajv.compile(tool.function.parameters as object)]))
const diagnosticAjv = new Ajv2020({ strict: false, allErrors: true })
diagnosticAjv.addSchema(core)
const executionValidators = new Map(['list', 'read', 'call'].map(name => [name, diagnosticAjv.getSchema(`${core.$id}#/$defs/${name}`)!]))
for (const [index, branch] of core.$defs.write.oneOf.entries()) executionValidators.set(branch.properties.type.const, diagnosticAjv.getSchema(`${core.$id}#/$defs/write/oneOf/${index}`)!)
const fail = (message: string): never => { throw new ContractError('INVALID_REQUEST', message) }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function decodeModelInput(text: string, layer = 'input_json'): unknown {
  try { return JSON.parse(text) } catch { return fail(jsonDiagnostic(text, layer)) }
}

// Presentation options are ephemeral; the validated execution contract stays unchanged.
export function modelToolRequest(name: string, raw: unknown): ModelRequest {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > defaults.transport.rpc_message_bytes) fail('Model wire exceeds transport limit')
  const check = validators.get(name)
  if (!check || !check(raw)) fail(check ? inputDiagnostic(check.errors, raw, check.schema) : 'Unknown tool')
  const value = raw as Record<string, any>
  let input: Record<string, unknown> = value, options: ModelReadOptions | undefined
  if (name === 'read') {
    const selection: ReadSelection = value.selection ?? {}
    const contract = ['object_type', 'capability'].includes(value.kind)
    const view = selection.view ?? (contract ? 'guide' : value.kind === 'resource' ? undefined : 'object')
    if (['guide', 'schema', 'example'].includes(view ?? '') && !contract) fail('Contract views require object_type or capability')
    if (view === 'metadata' && value.kind !== 'resource') fail('metadata requires a resource')
    if (view === 'export_check' && (!['view', 'view_history'].includes(value.kind) || selection.lines || selection.pages || selection.find !== undefined || selection.section !== undefined)) fail('export_check requires a View or view_history without text selections or contract sections')
    if (selection.section !== undefined && (!contract || !['guide', 'schema', 'example'].includes(view ?? ''))) fail('section requires a contract view')
    if ([selection.lines, selection.pages, selection.find].filter(item => item !== undefined).length > 1) fail('Choose only one of lines, pages or find')
    for (const range of [selection.lines, selection.pages]) if (range && (!range.every(Number.isSafeInteger) || range[0] > range[1])) fail('Selection start must not exceed end')
    const locating = selection.lines || selection.pages || selection.find !== undefined
    if (locating && !(value.kind === 'resource' && (view === undefined || view === 'text') || selection.lines && view === 'object')) fail('lines require text or object; pages/find require a text resource')
    if (selection.find !== undefined && Buffer.from(selection.find).toString() !== selection.find) fail('find must contain valid Unicode text')
    if (selection.revision !== undefined && (!Number.isSafeInteger(selection.revision) || selection.revision < 1)) fail('Invalid revision')
    if (view === 'text' && (value.kind !== 'resource' || selection.revision !== undefined)) fail('Text requires an immutable resource without revision')
    options = { max_chars: value.max_chars ?? defaults.read.content_default_chars, selection: { ...selection, ...(view ? { view } : {}) }, explicit: { ...(value.max_chars !== undefined ? { max_chars: value.max_chars } : {}), ...(value.selection !== undefined ? { selection: value.selection } : {}) } }
    input = { target: { kind: value.kind, id: value.id, ...(selection.revision !== undefined ? { expected_revision: selection.revision } : {}) }, ...(value.cursor !== undefined ? { cursor: value.cursor } : {}) }
  } else if (name === 'write') {
    const decoded = decodeModelInput(value.input_json)
    if (!object(decoded)) return fail('write input_json must decode to an object')
    if (Object.hasOwn(decoded, 'type')) fail('input_json.type cannot override operation')
    input = { type: value.operation, ...decoded }
  } else if (name === 'call') input = { capability: value.capability, arguments: decodeModelInput(value.input_json), references: value.references ?? [] }
  let request: ModelRequest
  try { request = validateModel({ type: name, input }) }
  catch (error) {
    if (!(error instanceof ContractError)) throw error
    if (name === 'list' && !(core.$defs.list.properties.kind.enum as string[]).includes(value.kind)) fail('kind must be one of: ' + core.$defs.list.properties.kind.enum.join(', ') + '. Contract discovery uses object_type, not contract_target')
    const selected = executionValidators.get(name === 'write' ? value.operation : name)
    if (!selected) fail('Unknown operation; list object_type for supported operation contracts')
    selected!(input)
    return fail(inputDiagnostic(selected!.errors, input, selected!.schema))
  }
  if (options) reads.set(request, options)
  return request
}

export function modelToolResult(name: string, raw: unknown, result: unknown): unknown {
  if (!['list', 'read'].includes(name) || !object(result) || result.execution !== 'success' || result.delivery !== 'delivered' || !object(result.data) || typeof result.data.next_cursor !== 'string') return result
  return { ...result, data: { ...result.data, next_call: { name, arguments: name === 'read' ? { kind: (raw as any).kind, id: (raw as any).id, cursor: result.data.next_cursor } : { ...raw as object, cursor: result.data.next_cursor } } } }
}

export function modelToolSuggestion(name: string, raw: unknown, error: ContractError): string | undefined {
  if (error.suggestion) return error.suggestion
  if (!object(raw)) return undefined
  const target = name === 'write' && typeof raw.operation === 'string' && (core.$defs.write.oneOf.some(branch => branch.properties.type.const === raw.operation))
    ? { kind: 'object_type', id: raw.operation }
    : name === 'call' && typeof raw.capability === 'string' && raw.capability.length <= 200
      ? { kind: 'capability', id: raw.capability }
      : ['read', 'list'].includes(name) ? { kind: 'object_type', id: 'tool.' + name } : undefined
  if (!target) return undefined
  let section: string | undefined
  if (name === 'write' && raw.operation === 'surface.update') {
    if (['PERSONAL_BINDING_REQUIRED', 'PERSONAL_BINDING_INVALID', 'EXPORT_FRAGMENT_OVERLAP', 'EXPORT_FRAGMENT_INVALID', 'INVALID_SNAPSHOT'].includes(error.code)) section = 'export-rules'
    else if (typeof raw.input_json === 'string') {
      try {
        const input = JSON.parse(raw.input_json), index = /^\/operations\/(\d+)(?:\s|\/)/.exec(error.message)?.[1]
        const type = index !== undefined ? input?.operations?.[Number(index)]?.type : undefined
        if (core.$defs.view_op.oneOf.some(branch => branch.properties.type.const === type)) section = type
      } catch { /* An invalid input stays invalid; only a readable branch may be linked. */ }
    }
  }
  return JSON.stringify({ name: 'read', arguments: { ...target, ...(section ? { selection: { view: 'guide', section } } : {}) } })
}

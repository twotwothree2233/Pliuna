import type { LogicalWork, ModelRequest } from '../../shared/contracts.generated'
import { ContractError, validateModel } from '../../shared/validation'
import type { Completion, ToolDefinition } from '../model/adapter'
import { modelTools } from '../model/tools'

export type WorkerRole = LogicalWork['role']
export type WorkerGrant =
  | { type: 'list'; kind: string }
  | { type: 'read'; kind: string; ids?: readonly string[] }
  | { type: 'write'; operation: string }
  | { type: 'call'; capability: string }

export interface WorkerProfile<Result> {
  readonly id: string
  readonly role: WorkerRole
  readonly system: string
  readonly tools: ToolDefinition[]
  readonly resultCorrection?: string
  authorize(request: unknown): void
  parseResult(response: Completion): Result
}
export interface WorkerProfileInput<Result> {
  id: string
  role: WorkerRole
  system: string
  grants: readonly WorkerGrant[]
  resultCorrection?: string
  parseResult(response: Completion): Result
}

const invalid = (): never => { throw new ContractError('INVALID_WORKER_PROFILE', 'Worker profile requires an explicit role, system and exact tool grants') }
const denied = (): never => { throw new ContractError('WORKER_CAPABILITY_DENIED', 'Worker profile does not grant this object or operation') }
const roles: readonly string[] = ['router', 'producer', 'lightweight', 'integrator', 'collator', 'diagnostic']
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0

// This is a host-side capability Interface, not a model instruction. The actual
// dispatch Adapter must call authorize again after checking current work identity.
export function createWorkerProfile<Result>(input: WorkerProfileInput<Result>): WorkerProfile<Result> {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['id', 'role', 'system', 'grants', 'parseResult', 'resultCorrection'].includes(key)) || !text(input.id) || !roles.includes(input.role) || !text(input.system) || !Array.isArray(input.grants) || typeof input.parseResult !== 'function' || input.resultCorrection !== undefined && !text(input.resultCorrection)) invalid()
  const grants = input.grants.map(grant => {
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return invalid()
    const allowed = grant.type === 'read' ? ['type', 'kind', 'ids'] : grant.type === 'list' ? ['type', 'kind'] : grant.type === 'write' ? ['type', 'operation'] : grant.type === 'call' ? ['type', 'capability'] : invalid()
    if (Object.keys(grant).some(key => !allowed.includes(key))) invalid()
    if (grant.type === 'list' || grant.type === 'read') {
      if (!text(grant.kind)) invalid()
      if (grant.type === 'read' && grant.ids !== undefined) {
        if (!Array.isArray(grant.ids) || !grant.ids.every(text)) invalid()
        return { ...grant, ids: [...grant.ids] }
      }
    } else if (grant.type === 'write' ? !text(grant.operation) : !text(grant.capability)) invalid()
    return { ...grant }
  })
  const tools = modelTools.filter(tool => grants.some(grant => grant.type === tool.function.name))
  Object.freeze(tools)
  return Object.freeze({
    id: input.id, role: input.role, system: input.system, tools,
    ...(input.resultCorrection !== undefined ? { resultCorrection: input.resultCorrection } : {}),
    parseResult: input.parseResult,
    authorize(raw: unknown): void {
      let request: ModelRequest
      // Invalid/unknown fields never become a broader grant, and validator
      // diagnostics cannot echo request text through a permission rejection.
      try { request = validateModel(raw) } catch { return denied() }
      const granted = grants.some(grant => {
        if (grant.type === 'list' && request.type === 'list') return grant.kind === request.input.kind
        if (grant.type === 'read' && request.type === 'read') return grant.kind === request.input.target.kind && (grant.ids === undefined || grant.ids.includes(request.input.target.id))
        if (grant.type === 'write' && request.type === 'write') return grant.operation === request.input.type
        if (grant.type === 'call' && request.type === 'call') return grant.capability === request.input.capability
        return false
      })
      if (!granted) denied()
    }
  })
}

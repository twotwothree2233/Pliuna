import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { ExecutionAttempt, ExecutionScope, LogicalWork, WorkDependency } from '../../shared/contracts.generated'
import { dependencyKey, sameDependencies, validateRunnerContract } from '../../shared/runner-validation'
import { assertContract, ContractError } from '../../shared/validation'
import { ModelError, type ChatMessage } from '../model/adapter'
import { interactions, recordedMessage, restoreMessages, summaryMessage, type HistoryRecord, type InstalledSummary } from '../model/context'
import { attachEvidence, captureExecutionScope, messageEvidence } from '../model/request-evidence'

const recordBytes = 1024 * 1024, contextBytes = 8 * recordBytes, recordCount = 4096
const navigationBytes = 64 * 1024
const historyKinds = "'worker.input','worker.conversation','model.response','model.tool_result'"
const scopeFields = ['task_id', 'run_id', 'work_id', 'attempt_id', 'role', 'purpose', 'request_id', 'intent_revision', 'message_id', 'update_id', 'batch_id', 'composition_version', 'trigger_request_id'] as const
// Guard json_extract independently: unrelated legacy records can contain invalid JSON.
const scopeWhere = `task_id=? AND ${scopeFields.map(field => `json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.owner.${field}') IS ?`).join(' AND ')}`
const selectedRecord = `id,sequence,kind,length(CAST(payload_json AS BLOB)) AS bytes,CASE WHEN length(CAST(payload_json AS BLOB))<=${recordBytes} THEN payload_json END AS payload_json`
interface RecordRow { id: string; sequence: number; kind: string; bytes: number; payload_json: string | null }
function invalid(): never { throw new ContractError('WORKER_CONTEXT_INVALID', 'Worker history is invalid; raw records are retained') }
function invalidSummary(): never { throw new ContractError('SUMMARY_STORED_INVALID', 'Worker summary or retained originals are invalid; raw records are retained') }
function denied(): never { throw new ContractError('WORKER_DEPENDENCY_DENIED', 'Worker dependency is outside the granted input set') }
function limit(): never { throw new ModelError('CONTEXT_RECORD_LIMIT') }
const sequence = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

function scopeValues(owner: ExecutionScope): (string | number | null)[] {
  return [owner.task_id, owner.run_id, owner.work_id, owner.attempt_id, owner.role, owner.purpose,
    owner.purpose === 'production' ? owner.request_id : null, owner.purpose === 'production' ? owner.intent_revision : null,
    owner.purpose === 'production' ? owner.message_id ?? null : null,
    owner.purpose === 'production' ? owner.update_id ?? null : null,
    owner.purpose === 'composition' ? owner.batch_id : null, owner.purpose === 'composition' ? owner.composition_version : null, owner.purpose === 'composition' ? owner.trigger_request_id : null]
}
function sameOwner(raw: unknown, expected: ExecutionScope): boolean {
  try {
    const actual = captureExecutionScope(raw)
    return actual !== undefined && scopeValues(actual).every((value, index) => value === scopeValues(expected)[index])
  } catch { return false }
}
function sourceOwner(source: ExecutionAttempt | LogicalWork, role: ExecutionScope['role'], attempt_id: string): ExecutionScope {
  return { task_id: source.task_id, run_id: source.run_id, work_id: source.work_id, attempt_id, role,
    ...(source.purpose === 'production' ? { purpose: source.purpose, request_id: source.request_id, intent_revision: source.intent_revision, ...(source.message_id ? { message_id: source.message_id } : {}), ...(source.update_id ? { update_id: source.update_id } : {}) } : { purpose: source.purpose, batch_id: source.batch_id, composition_version: source.composition_version, trigger_request_id: source.trigger_request_id }) }
}
function validMessage(record: HistoryRecord, owner: ExecutionScope): ChatMessage {
  if (!sameOwner(record.payload.owner, owner) || record.payload.task_id !== undefined && record.payload.task_id !== owner.task_id || record.payload.run_id !== undefined && record.payload.run_id !== owner.run_id) invalid()
  let message: ChatMessage | undefined
  try { message = recordedMessage(record) } catch { invalid() }
  if (!message || typeof message !== 'object' || Array.isArray(message)) invalid()
  if (Object.keys(message).some(key => !['role', 'content', 'tool_calls', 'tool_call_id'].includes(key))) invalid()
  if (record.kind === 'worker.input') {
    if (typeof record.payload.text !== 'string') invalid()
  } else if (record.kind === 'worker.conversation') {
    const source = record.payload.conversation_source
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['task_id', 'id', 'sequence', 'kind'].includes(key))
      || source.task_id !== owner.task_id || typeof source.id !== 'string' || !source.id || !sequence(source.sequence) || source.sequence < 1 || source.sequence >= record.sequence
      || (message.role === 'user' ? !['message.user', 'runner.input.received'].includes(source.kind) : message.role === 'assistant' ? !['runner.answer', 'message.assistant', 'model.response', 'conversation.reply'].includes(source.kind) : true)
      || typeof message.content !== 'string' || message.tool_calls !== undefined || message.tool_call_id !== undefined) invalid()
  } else if (record.kind === 'model.response') {
    if (message.role !== 'assistant' || message.content !== null && typeof message.content !== 'string' || message.tool_call_id !== undefined) invalid()
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) invalid()
      const ids = new Set<string>()
      for (const call of message.tool_calls) {
        if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id) || call.type !== 'function' || !call.function || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') invalid()
        if (Object.keys(call).some(key => !['id', 'type', 'function'].includes(key)) || Object.keys(call.function).some(key => !['name', 'arguments'].includes(key))) invalid()
        ids.add(call.id)
      }
    }
  } else if (record.kind !== 'model.tool_result' || message.role !== 'tool' || typeof message.tool_call_id !== 'string' || !message.tool_call_id || typeof message.content !== 'string' || message.tool_calls !== undefined) invalid()
  return message
}

// Execution qualification stays at the host. This loader never broadens the
// attempt's persisted history or exact dependency grants into Task-wide access.
export class WorkerContext {
  private readonly owner: ExecutionScope
  private readonly parameters: (string | number | null)[]
  constructor(private readonly db: Database.Database, owner: ExecutionScope) {
    let captured: ExecutionScope | undefined
    try { captured = captureExecutionScope(owner) } catch { invalid() }
    if (!captured) invalid()
    this.owner = Object.freeze(captured)
    this.parameters = [captured.task_id, ...scopeValues(captured)]
  }

  sequence(): number {
    const row = this.db.prepare(`SELECT MAX(sequence) AS through FROM records WHERE ${scopeWhere} AND kind IN (${historyKinds})`).get(...this.parameters) as { through: number | null }
    const through = row.through ?? 0
    if (!sequence(through)) invalid()
    return through
  }

  hasFresh(through: number): boolean {
    if (!sequence(through)) invalid()
    return !!this.db.prepare(`SELECT 1 FROM records WHERE ${scopeWhere} AND sequence>? AND kind IN (${historyKinds}) LIMIT 1`).get(...this.parameters, through)
  }

  summary(): InstalledSummary | null {
    return this.db.transaction(() => this.currentSummary()?.value ?? null)()
  }

  load(system: ChatMessage): ChatMessage[] {
    if (system.role !== 'system' || typeof system.content !== 'string' || system.tool_calls !== undefined || system.tool_call_id !== undefined) invalid()
    return this.db.transaction(() => {
      const summary = this.currentSummary(), originals = [...(summary?.retained ?? [])]
      let bytes = summary ? Buffer.byteLength(JSON.stringify(summary.value)) : 0
      for (const record of originals) bytes += Buffer.byteLength(JSON.stringify(record.payload))
      const rows = this.db.prepare(`SELECT ${selectedRecord} FROM records WHERE ${scopeWhere} AND sequence>? AND kind IN (${historyKinds}) ORDER BY sequence LIMIT ${recordCount + 1}`).iterate(...this.parameters, summary?.value.through_sequence ?? 0) as Iterable<RecordRow>
      for (const row of rows) {
        if (originals.length >= recordCount || row.bytes > recordBytes || bytes + row.bytes > contextBytes) limit()
        const record = this.original(row)
        validMessage(record, this.owner)
        originals.push(record); bytes += row.bytes
      }
      if (originals.length > recordCount || bytes > contextBytes) limit()
      originals.sort((left, right) => left.sequence - right.sequence)
      const restored = restoreMessages(originals)
      for (const message of restored) {
        const evidence = messageEvidence(message)
        if (evidence && !evidence.owner) attachEvidence(message, { ...evidence, owner: this.owner, owner_run_id: this.owner.run_id })
      }
      interactions(restored)
      return [system, ...(summary ? [summaryMessage(summary.value)] : []), ...restored]
    })()
  }

  installSummary(value: InstalledSummary): void {
    let body: string
    try { body = JSON.stringify(value) } catch { invalidSummary() }
    if (typeof body !== 'string') invalidSummary()
    if (Buffer.byteLength(body) > recordBytes) limit()
    this.db.transaction(() => {
      const candidate = JSON.parse(body) as InstalledSummary
      this.validateSummary(candidate)
      if (this.hasFresh(candidate.through_sequence)) throw new ContractError('SUMMARY_SNAPSHOT_CHANGED', 'Worker history changed while organizing context; previous summary retained')
      const current = this.currentSummary()
      if (current && current.value.through_sequence > candidate.through_sequence) throw new ContractError('SUMMARY_SNAPSHOT_CHANGED', 'Worker history changed while organizing context; previous summary retained')
      const task = this.db.prepare("SELECT next_sequence FROM tasks WHERE id=? AND state='active'").get(this.owner.task_id) as { next_sequence: number } | undefined
      if (!task || !sequence(task.next_sequence) || task.next_sequence < 1) invalid()
      this.db.prepare('INSERT INTO records(id,task_id,sequence,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), this.owner.task_id, task.next_sequence, 'context.summary.installed', JSON.stringify({ ...candidate, run_id: this.owner.run_id }), new Date().toISOString())
      this.db.prepare('UPDATE tasks SET next_sequence=next_sequence+1,revision=revision+1 WHERE id=?').run(this.owner.task_id)
    }).immediate()
  }

  navigation(dependencies: readonly WorkDependency[]): WorkDependency[] {
    if (!Array.isArray(dependencies)) denied()
    if (dependencies.length > recordCount) limit()
    let requested: WorkDependency[]
    try { requested = dependencies.map(value => structuredClone(validateRunnerContract('runner_work_dependency', value))) } catch { denied() }
    if (Buffer.byteLength(JSON.stringify(requested)) > navigationBytes) limit()
    const row = this.db.prepare(`SELECT CASE WHEN length(CAST(a.payload_json AS BLOB))<=${recordBytes} THEN a.payload_json END AS attempt_json,CASE WHEN length(CAST(w.payload_json AS BLOB))<=${recordBytes} THEN w.payload_json END AS work_json FROM runner_attempts a JOIN runner_work w ON w.work_id=a.work_id WHERE a.attempt_id=? AND a.task_id=? AND a.run_id=? AND a.work_id=? AND w.task_id=a.task_id AND w.run_id=a.run_id`).get(this.owner.attempt_id, this.owner.task_id, this.owner.run_id, this.owner.work_id) as { attempt_json: string | null; work_json: string | null } | undefined
    if (!row?.attempt_json || !row.work_json) denied()
    try {
      const attempt = validateRunnerContract('runner_execution_attempt', JSON.parse(row.attempt_json)), work = validateRunnerContract('runner_logical_work', JSON.parse(row.work_json))
      if (!sameOwner(sourceOwner(attempt, work.role, attempt.attempt_id), this.owner) || !sameOwner(sourceOwner(work, work.role, attempt.attempt_id), this.owner) || work.current_attempt_id !== attempt.attempt_id || !sameDependencies(attempt.input_versions, work.dependencies)) denied()
      const granted = new Set(attempt.input_versions.map(dependencyKey)), keys = requested.map(dependencyKey)
      if (new Set(keys).size !== keys.length || requested.some(dependency => dependency.task_id !== this.owner.task_id) || keys.some(key => !granted.has(key))) denied()
      return requested
    } catch { return denied() }
  }

  private original(row: RecordRow): HistoryRecord {
    if (row.bytes > recordBytes || typeof row.payload_json !== 'string') limit()
    if (!sequence(row.sequence) || row.sequence < 1) invalid()
    let payload: Record<string, any>
    try { payload = JSON.parse(row.payload_json) } catch { invalid() }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid()
    return { id: row.id, sequence: row.sequence, kind: row.kind, payload }
  }

  private currentSummary(): { value: InstalledSummary; retained: HistoryRecord[] } | null {
    const row = this.db.prepare(`SELECT ${selectedRecord} FROM records WHERE ${scopeWhere} AND kind='context.summary.installed' ORDER BY sequence DESC LIMIT 1`).get(...this.parameters) as RecordRow | undefined
    if (!row) return null
    let value: InstalledSummary
    try { value = this.original(row).payload as InstalledSummary } catch { return invalidSummary() }
    const retained = this.validateSummary(value)
    if (value.through_sequence >= row.sequence) invalidSummary()
    return { value, retained }
  }

  private validateSummary(value: InstalledSummary): HistoryRecord[] {
    try {
      assertContract('installed_summary', value)
      if (!sameOwner(value.owner, this.owner) || !value.text.trim() || !sequence(value.through_sequence) || !Number.isSafeInteger(value.model_revision) || value.through_sequence > this.sequence()) invalidSummary()
      const root = value as InstalledSummary & { run_id?: string }
      if (root.run_id !== undefined && root.run_id !== this.owner.run_id) invalidSummary()
      const ids = [...(value.latest_user_id ? [value.latest_user_id] : []), ...value.retained_interactions.flat()]
      if (ids.length > recordCount || new Set(ids).size !== ids.length) invalidSummary()
      let bytes = Buffer.byteLength(JSON.stringify(value))
      const retained = ids.map(id => {
        const row = this.db.prepare(`SELECT ${selectedRecord} FROM records WHERE ${scopeWhere} AND id=? AND sequence<=? AND kind IN (${historyKinds})`).get(...this.parameters, id, value.through_sequence) as RecordRow | undefined
        if (!row) invalidSummary()
        if (bytes + row.bytes > contextBytes) limit()
        bytes += row.bytes
        const record = this.original(row); validMessage(record, this.owner)
        return record
      })
      if (value.latest_user_id && retained[0]?.kind !== 'worker.input') invalidSummary()
      let previous = 0
      for (const group of value.retained_interactions) {
        const records = group.map(id => retained.find(record => record.id === id)!)
        for (const record of records) {
          if (record.sequence <= previous) invalidSummary()
          previous = record.sequence
        }
        const messages = records.map(record => validMessage(record, this.owner))
        if (records.some(record => !['model.response', 'model.tool_result', 'worker.conversation'].includes(record.kind)) || messages[0]?.role !== 'assistant' || interactions(messages).length !== 1) invalidSummary()
      }
      return retained
    } catch (error) {
      if (error instanceof ModelError && error.code === 'CONTEXT_RECORD_LIMIT') throw error
      return invalidSummary()
    }
  }
}

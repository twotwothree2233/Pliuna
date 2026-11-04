import type Database from 'better-sqlite3'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import defaults from '../shared/contracts/development-defaults.json'
import type { ModelRequest } from '../shared/contracts.generated'
import { ContractError } from '../shared/validation'
import { readPluginResource, readResourceContent } from './plugins/resource-reader'
import { accountingPage, readRequestAccounting } from './model/accounting-query'
import { operationContract, operationDirectory, contractRepresentation } from './model/operation-contracts'
import { modelReadOptions } from './model/tool-input'
import { readTextSelection } from './plugins/text-selection'
import { RepresentationPager } from './model/representation'

type Row = Record<string, any>
type Query = Extract<ModelRequest, { type: 'list' | 'read' }>
const fail = (code: string, message: string): never => { throw new ContractError(code, message) }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url')
const directories: Record<string, { from: string; scope: string; time?: string; status?: string; name?: string; extra?: string }> = {
  task: { from: 'tasks o', scope: 'o.id=?', status: 'o.state', name: 'o.title' },
  surface: { from: 'surfaces o', scope: 'o.task_id=?' },
  view: { from: 'views o JOIN surfaces s ON s.id=o.surface_id', scope: 's.task_id=?' },
  view_history: { from: 'view_history o', scope: 'o.task_id=?' },
  task_data: { from: 'task_data o', scope: 'o.task_id=?' },
  message: { from: 'records o', scope: 'o.task_id=?', time: 'o.created_at', extra: "o.kind LIKE 'message.%'" },
  event: { from: 'records o', scope: 'o.task_id=?', time: 'o.created_at' },
  answer: { from: 'answers o', scope: 'o.task_id=?', time: 'o.created_at' },
  run: { from: 'runs o', scope: 'o.task_id=?', time: 'o.created_at', status: 'o.state' },
  action: { from: 'actions o', scope: 'o.task_id=?', time: 'o.created_at', status: 'o.state' },
  approval: { from: 'approvals o JOIN actions a ON a.id=o.action_id', scope: 'a.task_id=?', time: 'a.created_at', status: 'o.decision' },
  resource: { from: 'resources o JOIN task_resources t ON t.resource_id=o.id', scope: 't.task_id=?', time: 'o.created_at', name: 'o.display_name' },
  call: { from: 'calls o', scope: 'o.task_id=?', time: 'o.created_at', status: 'o.state' }
}

export class ObjectQueries {
  private secret = randomBytes(32)
  private pager = new RepresentationPager()
  constructor(private db: Database.Database, private readView: (row: Row) => Row, private definition: (id: string) => Row | undefined, private readResource: (row: Row) => Row, private readHistory: (row: Row) => Row, private readText?: (row: Row, offset: number) => Row, private pluginRoot?: string, private checkPluginResource?: (row: Row) => void, private provenance?: (task: string, resource: string) => Row | null, private derivedResults?: (task: string, resource: string) => Row, private exportCheck?: (task: string, row: Row) => Row) {}
  rebind(db: Database.Database): void { this.db = db; this.secret = randomBytes(32); this.pager.reset() }
  private token(binding: string, position: unknown): string {
    const body = Buffer.from(JSON.stringify([binding, position])).toString('base64url')
    return body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url')
  }
  private position(token: string, binding: string): any {
    try {
      const parts = token.split('.')
      if (parts.length !== 2) throw Error()
      const [body, signature] = parts
      const actual = Buffer.from(signature!, 'base64url'), expected = createHmac('sha256', this.secret).update(body!).digest()
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error()
      const [scope, position] = JSON.parse(Buffer.from(body!, 'base64url').toString())
      if (scope !== binding) throw Error()
      return position
    } catch { return fail('INVALID_CURSOR', 'Cursor expired or belongs to another source, task, query or representation; restart this query') }
  }
  accounting(task: string, run: string, cursor?: string): unknown {
    if (!this.db.prepare('SELECT id FROM runs WHERE task_id=? AND id=?').get(task, run)) fail('NOT_FOUND', 'Run unavailable within current task')
    const binding = hash(['host-accounting-v1', task, run])
    const previous = cursor ? this.position(cursor, binding) : null
    if (previous && (!Array.isArray(previous) || previous.length !== 3 || !Number.isSafeInteger(previous[0]) || !Number.isSafeInteger(previous[1]) || previous[0] < previous[1] || previous[1] < 0 || typeof previous[2] !== 'string')) fail('INVALID_CURSOR', 'Invalid ledger snapshot')
    const latest = this.db.prepare('SELECT sequence,id FROM records WHERE task_id=? ORDER BY sequence DESC LIMIT 1').get(task) as Row | undefined
    const through: number = previous?.[0] ?? latest?.sequence ?? 0
    const anchor: string = previous?.[2] ?? latest?.id ?? ''
    const saved = this.db.prepare('SELECT id FROM records WHERE task_id=? AND sequence=?').get(task, through) as Row | undefined
    if (through && saved?.id !== anchor) fail('INVALID_CURSOR', 'Ledger snapshot removed; refresh the query')
    const page = accountingPage(this.db, task, run, through, previous?.[1] ?? 0)
    return { version: 1, consistency: 'snapshot', through_sequence: through, requests: page.requests, next_cursor: page.next_after === null ? null : this.token(binding, [through, page.next_after, anchor]), complete: page.next_after === null, notice: 'Only this fixed snapshot is covered. Refresh for new requests or late usage. Missing usage is unknown, never zero; no automatic retry.' }
  }
  query(taskId: string, source: string, request: Query, globalTasks = false, signal?: AbortSignal): unknown {
    if (signal?.aborted) fail('MODEL_CANCELLED', 'Read cancelled; no write was performed')
    const kind = request.type === 'list' ? request.input.kind : request.input.target.kind
    const descriptor = directories[kind]
    if (!descriptor && !['object_type', 'plugin', 'capability', 'summary'].includes(kind)) fail('UNSUPPORTED_QUERY', 'Object directory is not enabled')
    const binding = hash([source, taskId, request.type, kind, request.type === 'list' ? request.input.filters ?? {} : request.input.target, globalTasks]).slice(0, 22)
    let where = globalTasks ? "o.state!='deleting'" : descriptor?.scope ?? ''
    const args: unknown[] = globalTasks ? [] : [taskId]
    if (descriptor?.extra) where += ' AND ' + descriptor.extra
    if (request.type === 'list') {
      const filters = request.input.filters ?? {}
      for (const [key, value] of Object.entries(filters)) {
        if (key === 'status' && descriptor?.status) { where += ` AND ${descriptor.status}=?`; args.push(value) }
        else if (key === 'name_query' && descriptor?.name) { where += ` AND instr(lower(${descriptor.name}),lower(?))>0`; args.push(value) }
        else if (['since', 'until'].includes(key) && descriptor?.time && typeof value === 'string' && Number.isFinite(Date.parse(value))) { where += ` AND ${descriptor.time}${key === 'since' ? '>=' : '<='}?`; args.push(new Date(value).toISOString()) }
        else fail('UNSUPPORTED_FILTER', 'Filter is not defined for this directory or timestamp is invalid')
      }
      const limit = request.input.limit ?? defaults.list.default_items
      const previous = request.input.cursor ? this.position(request.input.cursor, binding) : undefined
      const order = descriptor?.time ?? 'o.rowid'
      if (previous && descriptor) {
        const anchor = this.db.prepare(`SELECT o.id,${order} AS _key FROM ${descriptor.from} WHERE ${where} AND o.rowid=?`).get(...args, previous[0]) as Row | undefined
        if (!anchor || hash([anchor._key, anchor.id]).slice(0, 16) !== previous[1]) return fail('INVALID_CURSOR', 'Page anchor changed or was removed; restart this query')
        where += ` AND (${order}>? OR (${order}=? AND o.id>?))`; args.push(anchor._key, anchor._key, anchor.id)
      }
      const columns: Record<string, string> = {
        task: 'o.id,o.title,o.state,o.revision', surface: 'o.id,o.revision', view: 'o.id,o.revision,o.state_revision', task_data: 'o.id,o.revision',
        view_history: 'o.id,o.view_id,o.view_revision AS revision', message: 'o.id,o.kind,o.created_at', event: 'o.id,o.kind,o.created_at', answer: 'o.id,o.created_at',
        run: 'o.id,o.state,o.created_at', action: 'o.id,o.state,o.kind,o.result,o.run_id,o.created_at',
        approval: 'o.id,o.action_id,o.decision,o.validity,o.handling,a.created_at', call: 'o.id,o.state,o.run_id,o.created_at', resource: 'o.id,o.display_name,o.byte_length,o.media_type,o.sha256,o.created_at'
      }
      const rows: Row[] = descriptor
        ? this.db.prepare(`SELECT ${columns[kind]},o.rowid AS _rowid,${order} AS _key FROM ${descriptor.from} WHERE ${where} ORDER BY ${order},o.id LIMIT ?`).all(...args, limit + 1) as Row[]
        : kind === 'object_type' ? [...Object.keys(directories).map(id => ({ id })), ...operationDirectory].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(row => ({ ...row, _key: row.id })).filter(r => !previous || r.id > previous[1]).slice(0, limit + 1) : []
      const items: Row[] = []; let size = 0
      for (const row of rows.slice(0, limit)) {
        const item = this.metadata(kind, row, taskId), bytes = Buffer.byteLength(JSON.stringify(item))
        if (items.length && size + bytes > defaults.read.text_bytes / 2) break
        items.push(item); size += bytes
      }
      const last = rows[items.length - 1]
      return { items, next_cursor: rows.length > items.length && last ? this.token(binding, descriptor ? [last._rowid, hash([last._key, last.id]).slice(0, 16)] : [last._key, last.id]) : null, consistency: 'live' }
    }
    const target = request.input.target
    const options = modelReadOptions(request)
    if (kind === 'resource' && options) {
      const row = this.db.prepare(`SELECT o.* FROM ${descriptor!.from} WHERE ${where} AND o.id=?`).get(...args, target.id) as Row | undefined
      if (!row) return fail('NOT_FOUND', 'Resource unavailable within current task')
      const view = options.selection.view
      const plain = ['text/plain', 'text/plain; charset=utf-8'].includes(row.media_type)
      if (view === 'text' || view === undefined && plain) return this.modelContent(taskId, source, request, row, signal)
      if (options.selection.lines && view !== 'object' || options.selection.pages || options.selection.find !== undefined) throw new ContractError('UNSUPPORTED_REPRESENTATION', 'This selection requires a UTF-8 plain-text resource', JSON.stringify({ name: 'read', arguments: { kind, id: row.id, selection: { view: 'object' } } }))
      if (view === 'metadata' || view === undefined && !['application/json'].includes(row.media_type)) {
        if (target.expected_revision !== undefined) return fail('READ_VERSION_CHANGED', 'Immutable resource has no mutable revision')
        const metadata = { ...this.metadata(kind, row, taskId), provenance: this.provenance?.(taskId, row.id) ?? null, derived_results: this.derivedResults?.(taskId, row.id) }
        return this.pager.page(metadata, [source, taskId, target], options, request.input.cursor, {})
      }
    }
    if (request.input.content) return this.content(taskId, source, request)
    if (request.input.cursor?.startsWith('c.')) return this.content(taskId, source, request)
    if(kind==='resource' && this.readText && !request.input.range && !options?.selection.lines) {
      const row=this.db.prepare(`SELECT o.* FROM ${descriptor!.from} WHERE ${where} AND o.id=?`).get(...args,target.id) as Row|undefined
      const importedResult = row && this.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state='ended' AND result='success' AND json_extract(request_json,'$.type')='material.import' AND json_extract(result_json,'$.resource.id')=? LIMIT 1").get(taskId,row.id)
      const pluginResult = row && this.pluginRoot && this.db.prepare("SELECT 1 FROM actions WHERE task_id=? AND state='ended' AND result='success' AND json_extract(request_json,'$.type')='plugin.result.upload' AND json_extract(result_json,'$.resource.id')=? LIMIT 1").get(taskId,row.id)
      const calculationResult = row && this.db.prepare("SELECT 1 FROM calls WHERE task_id=? AND capability_id='builtin:monty:v1' AND state='ended' AND execution='success' AND delivery='delivered' AND json_extract(result_json,'$.data.result_resource.id')=? LIMIT 1").get(taskId,row.id)
      if ((pluginResult || importedResult || calculationResult) && this.pluginRoot && row && ['text/plain', 'text/plain; charset=utf-8', 'application/json'].includes(row.media_type) && row.byte_length > 262144) {
        if (target.expected_revision !== undefined) fail('READ_VERSION_CHANGED', 'Immutable resource has no mutable revision')
        const streamBinding = options ? hash([binding, options]).slice(0, 22) : binding
        const previous = request.input.cursor ? this.position(request.input.cursor,streamBinding) : undefined, version = hash(row)
        if (previous && previous[0] !== version) fail('READ_VERSION_CHANGED', 'Resource changed; discard previous fragments')
        this.checkPluginResource?.(row)
        const database = this.db
        return readPluginResource(this.pluginRoot!, row as Parameters<typeof readPluginResource>[1], previous?.[1] ?? 0, false, options?.max_chars).then(part => {
          if (this.db !== database || !database.open) fail('READ_VERSION_CHANGED', 'Runtime database changed during resource reading')
          const current = database.prepare("SELECT o.* FROM resources o JOIN task_resources t ON t.resource_id=o.id JOIN tasks task ON task.id=t.task_id WHERE o.id=? AND t.task_id=? AND task.state!='deleting'").get(row.id,taskId)
          if (!current || hash(current) !== version) fail('READ_VERSION_CHANGED', 'Task resource association changed during reading')
          this.checkPluginResource?.(row)
          return { metadata: { ...this.metadata(kind,row), provenance: this.provenance?.(taskId, row.id) ?? null, derived_results: this.derivedResults?.(taskId, row.id) }, representation: row.media_type, content_version: version, data: { text: part.text }, truncated: part.truncated, next_cursor: part.next_offset === null ? null : this.token(streamBinding,[version,part.next_offset]) }
        })
      }

    }
    let value: Row | undefined
    if (kind === 'object_type') value = operationContract(target.id) ?? this.definition(target.id)
    else if (descriptor) {
      const row = this.db.prepare(`SELECT o.*${kind === 'approval' ? ',a.state AS action_state,a.result AS action_result,a.result_json AS action_result_json' : ''} FROM ${descriptor.from} WHERE ${where} AND o.id=?`).get(...args, target.id) as Row | undefined
      if (row) {
        if (kind === 'view' && target.expected_revision !== undefined && row.revision !== target.expected_revision) fail('READ_VERSION_CHANGED', 'Requested revision changed; read current content explicitly')
        if (kind === 'view_history' && target.expected_revision !== undefined && row.view_revision !== target.expected_revision) fail('READ_VERSION_CHANGED', 'Requested revision does not match this immutable history; current View was not substituted')
        value = ['view', 'view_history'].includes(kind) && options?.selection.view === 'export_check' && this.exportCheck ? this.exportCheck(taskId, row) : this.value(kind, row)
        if (kind === 'resource') { value.provenance = this.provenance?.(taskId, row.id) ?? null; value.derived_results = this.derivedResults?.(taskId, row.id) }
      }
    }
    if (!value) return fail('NOT_FOUND', 'Object unavailable within current task')
    if (target.expected_revision !== undefined && value.revision !== target.expected_revision) fail('READ_VERSION_CHANGED', `Requested revision changed (requested ${target.expected_revision}); current revision ${value.revision ?? 'unavailable'}. Read current content explicitly; saved references were not updated`)
    if (signal?.aborted) fail('MODEL_CANCELLED', 'Read cancelled; no write was performed')
    if (options) return this.pager.page(kind === 'object_type' ? contractRepresentation({ id: target.id, ...value }, options.selection) : value, [source, taskId, target], options, request.input.cursor, { metadata: this.metadata(kind, value, taskId), revision: value.revision })
    const text = JSON.stringify(value, null, 2), version = hash(value)
    const previous = request.input.cursor ? this.position(request.input.cursor, binding) : undefined
    if (previous && previous[0] !== version) fail('READ_VERSION_CHANGED', 'Content changed; discard earlier fragments and restart from current content')
    if (!previous && !request.input.range && Buffer.byteLength(text) <= defaults.read.text_bytes / 2) return { metadata: this.metadata(kind, value), revision: value.revision, data: value, truncated: false, next_cursor: null }
    let start = previous?.[1] ?? 0, end = text.length
    if (request.input.range) {
      const { start_line, end_line } = request.input.range
      if (start_line > end_line) fail('INVALID_RANGE', 'Start line must not exceed end line')
      const lines = text.split('\n')
      if (start_line > lines.length) fail('INVALID_RANGE', 'Start line exceeds representation')
      start = lines.slice(0, start_line - 1).reduce((n, line) => n + line.length + 1, 0)
      end = Math.min(text.length, lines.slice(0, end_line).reduce((n, line) => n + line.length + 1, 0))
    } else if (previous) end = previous[2]
    // Count the serialized fragment, not just its UTF-8 body; never split a surrogate pair.
    let stop = start, bytes = 0
    for (const point of text.slice(start, end)) {
      const cost = Buffer.byteLength(JSON.stringify(point)) - 2
      if (bytes + cost > defaults.read.text_bytes / 2) break
      bytes += cost; stop += point.length
    }
    const fragment = text.slice(start, stop)
    return { metadata: this.metadata(kind, value), revision: value.revision, representation: 'application/json; charset=utf-8', content_version: version, data: { text: fragment }, actual_range: { start_line: text.slice(0, start).split('\n').length, end_line: text.slice(0, Math.max(start, stop - 1)).split('\n').length }, truncated: stop < end, next_cursor: stop < end ? this.token(binding, [version, stop, end]) : null }
  }
  private async modelContent(task: string, source: string, request: Extract<ModelRequest, { type: 'read' }>, row: Row, signal?: AbortSignal): Promise<unknown> {
    if (!this.pluginRoot || request.input.target.expected_revision !== undefined) return fail('RESOURCE_RANGE_INVALID', 'Text requires an immutable resource without revision')
    if (!['text/plain', 'text/plain; charset=utf-8'].includes(row.media_type)) return fail('UNSUPPORTED_REPRESENTATION', 'Text requires a UTF-8 plain-text resource')
    const options = modelReadOptions(request)!, provenance = this.provenance?.(task, row.id)
    const version = hash([row, provenance]), binding = hash(['model-text-v1', task, source, request.input.target, options])
    const saved = request.input.cursor ? this.position(request.input.cursor, binding) : undefined
    if (saved && saved.version !== version) return fail('READ_VERSION_CHANGED', 'Resource or source index changed; restart this read')
    let pageRange: { start: number; end: number } | undefined
    if (options.selection.pages) {
      const [first, last] = options.selection.pages, pages = provenance?.pages?.filter((page: Row) => page.page >= first && page.page <= last)
      if (!pages || pages.length !== last - first + 1) throw new ContractError('RESOURCE_RANGE_INVALID', 'Requested pages require a complete saved page index', JSON.stringify({ name: 'read', arguments: { kind: 'resource', id: row.id, selection: { view: 'metadata' } } }))
      pageRange = { start: pages[0].start, end: pages.at(-1).end }
    }
    const database = this.db
    const valid = () => {
      if (signal?.aborted) return fail('MODEL_CANCELLED', 'Read cancelled; no write was performed')
      if (this.db !== database || !database.open) return fail('READ_VERSION_CHANGED', 'Runtime changed during reading')
      const current = database.prepare("SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id JOIN tasks task ON task.id=t.task_id WHERE t.task_id=? AND r.id=? AND task.state!='deleting'").get(task, row.id)
      if (!current || hash([current, this.provenance?.(task, row.id)]) !== version) return fail('READ_VERSION_CHANGED', 'Resource or source association changed')
      this.checkPluginResource?.(row)
    }
    valid()
    const { position, ...part } = await readTextSelection(this.pluginRoot, row as any, options.selection, options.max_chars, saved?.position, pageRange, valid)
    const complete = part.completion.selection_complete
    return { metadata: this.metadata('resource', row, task), representation: 'text/plain; charset=utf-8', content_version: version, content_selection: true, ...part, ...(provenance ? { partial: provenance.partial, location_verification: provenance.location_verification } : {}), truncated: !complete, next_cursor: complete ? null : this.token(binding, { version, position }) }
  }
  private async content(task: string, source: string, request: Extract<ModelRequest, { type: 'read' }>): Promise<unknown> {
    const { target, content, cursor } = request.input
    if (target.kind !== 'resource' || target.expected_revision !== undefined || !this.pluginRoot) return fail('RESOURCE_RANGE_INVALID', 'Content selection requires an immutable text resource')
    const row = this.db.prepare("SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id JOIN tasks task ON task.id=t.task_id WHERE t.task_id=? AND r.id=? AND task.state!='deleting'").get(task, target.id) as Row | undefined
    if (!row) return fail('NOT_FOUND', 'Text resource unavailable in this task')
    if (!['text/plain', 'text/plain; charset=utf-8'].includes(row.media_type)) fail('UNSUPPORTED_REPRESENTATION', 'Content selection supports UTF-8 text only; parsing is explicit')
    const options = modelReadOptions(request)
    const binding = hash(['content', source, task, target, ...(options ? [options] : [])]).slice(0, 22), previous = cursor ? this.position(cursor.startsWith('c.') ? cursor.slice(2) : cursor, binding) : undefined
    const provenance = this.provenance?.(task, row.id), version = hash([row, provenance]).slice(0, 22)
    if (previous && previous[0] !== version) fail('READ_VERSION_CHANGED', 'Content or source index changed; restart the selection')
    const selection: { offset_bytes?: number; end_bytes?: number; max_chars?: number; pages?: { start: number; end: number } } = content ?? (previous ? { offset_bytes: previous[2], end_bytes: previous[3], max_chars: previous[4] } : {}), maxChars = selection.max_chars ?? defaults.read.content_default_chars
    let start = selection.offset_bytes ?? 0, end = selection.end_bytes ?? row.byte_length
    if (selection.pages) {
      if (!provenance || selection.pages.start > selection.pages.end) return fail('RESOURCE_RANGE_INVALID', 'No matching saved page index')
      const { start: first, end: last } = selection.pages
      const pages = provenance.pages.filter((p: Row) => p.page >= first && p.page <= last)
      if (pages.length !== selection.pages.end - selection.pages.start + 1) fail('RESOURCE_RANGE_INVALID', 'Requested pages are not present; partial extraction is not a complete document')
      start = pages[0].start; end = pages.at(-1).end
    }
    if (previous && (start !== previous[2] || end !== previous[3] || maxChars !== previous[4])) fail('INVALID_CURSOR', 'Continue with the same selection or only the cursor')
    const database = this.db
    const valid = () => {
      if (this.db !== database || !database.open) fail('READ_VERSION_CHANGED', 'Runtime changed during reading')
      const current = database.prepare("SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id JOIN tasks task ON task.id=t.task_id WHERE t.task_id=? AND r.id=? AND task.state!='deleting'").get(task, row.id)
      if (!current || hash([current, this.provenance?.(task, row.id)]).slice(0, 22) !== version) fail('READ_VERSION_CHANGED', 'Resource or source association changed')
      this.checkPluginResource?.(row)
    }
    valid()
    const offset = previous?.[1] ?? start
    const part = await readResourceContent(this.pluginRoot, row as any, offset, end, maxChars, valid)
    const result = { metadata: this.metadata('resource', row), representation: 'text/plain; charset=utf-8', content_version: version, content_selection: true, data: { text: part.text }, actual_range: { start_bytes: offset, end_bytes: part.end, chars: part.chars }, selected_range: { start_bytes: start, end_bytes: end }, partial: provenance?.partial ?? null, location_verification: provenance?.location_verification ?? null, truncated: part.end < end, next_cursor: part.end < end ? 'c.' + this.token(binding, [version, part.end, start, end, maxChars]) : null }
    if (Buffer.byteLength(JSON.stringify(result)) > defaults.read.content_response_bytes) fail('TOOL_RESULT_LIMIT', 'Selected content response exceeds 256KiB; request fewer characters')
    return result
  }
  private metadata(kind: string, row: Row, task?: string): Row {
    const result: Row = { id: row.id }
    for (const key of ['view_id', 'revision', 'state_revision', 'created_at', 'state', 'title', 'kind', 'result', 'decision', 'validity', 'handling', 'action_id', 'run_id', 'display_name', 'byte_length', 'media_type', 'sha256']) if (row[key] !== undefined) result[key] = row[key]
    if (kind === 'object_type') Object.assign(result, { kind: row.id, ...(row.description ? { description: row.description, contract_target: row.contract_target } : {}) })
    if (kind === 'view' || kind === 'view_history') result.read_options = { export_check: { kind, id: row.id, selection: { view: 'export_check', revision: row.revision ?? row.view_revision } } }
    if (kind === 'resource') {
      const plain = ['text/plain', 'text/plain; charset=utf-8'].includes(row.media_type)
      const pages = plain && task ? this.provenance?.(task, row.id)?.pages : undefined
      result.read_options = { default_view: plain ? 'text' : row.media_type === 'application/json' ? 'object' : 'metadata', views: plain ? ['text', 'object', 'metadata'] : ['object', 'metadata'], selections: plain ? ['lines', 'find', ...(pages?.length ? ['pages'] : [])] : ['object'], page_index_available: !!pages?.length, object: { kind: 'resource', id: row.id, selection: { view: 'object' } } }
    }
    return result
  }
  private value(kind: string, row: Row): Row {
    const result = this.metadata(kind, row)
    if (kind === 'task_data') Object.assign(result, { schema: JSON.parse(row.schema_json), value: JSON.parse(row.value_json), references: JSON.parse(row.references_json) })
    if (kind === 'resource') return this.readResource(row)
    if (kind === 'view_history') return this.readHistory(row)
    if (kind === 'view') return this.readView(row)
    if (kind === 'surface') result.layout = JSON.parse(row.layout_json)
    if (kind === 'message' || kind === 'event') result.payload = JSON.parse(row.payload_json)
    if (kind === 'answer') {
      const history = this.db.prepare('SELECT * FROM view_history WHERE id=? AND task_id=?').get(row.view_history_id, row.task_id) as Row | undefined
      if (!history) fail('HISTORY_MISSING', 'Original answer history unavailable; current evidence was not substituted')
      result.view_history = this.readHistory(history!)
      Object.assign(result, { raw: JSON.parse(row.raw_json), value: JSON.parse(row.value_json), view_history_id: row.view_history_id, form_id: row.form_id })
    }
    if (kind === 'run') Object.assign(result, { primary_reason: row.primary_reason, wait_reason: row.wait_reason, budget: JSON.parse(row.budget_json), accounting: readRequestAccounting(this.db, row.task_id, row.id), ended_at: row.ended_at })
    if (kind === 'action') { const approval = this.db.prepare('SELECT binding_json FROM approvals WHERE action_id=?').get(row.id) as Row | undefined; if (approval) { const binding = JSON.parse(approval.binding_json); if (binding.version === 2) result.resolved_approval = binding.resolved } }
    if (kind === 'action') Object.assign(result, { source: JSON.parse(row.source_json), request: JSON.parse(row.request_json), result_data: row.result_json ? JSON.parse(row.result_json) : null, wait_reason: row.wait_reason, ended_at: row.ended_at })
    if (kind === 'approval') Object.assign(result, { mode: row.mode, evaluation: row.evaluation_json ? JSON.parse(row.evaluation_json) : null, expires_at: row.expires_at, action_state: row.action_state, action_result: row.action_result, result_data: row.action_result_json ? JSON.parse(row.action_result_json) : null })
    if (kind === 'call') Object.assign(result, { capability_id: row.capability_id, dispatch: row.dispatch, execution: row.execution, delivery: row.delivery, result_data: row.result_json ? JSON.parse(row.result_json) : null, ended_at: row.ended_at })
    return result
  }
}

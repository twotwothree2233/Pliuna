import type Database from 'better-sqlite3'
import type { ChapterDependency, ChapterInheritance, ChapterManifest, ChapterProposal, ChapterPublication, ChapterUpdate } from '../../shared/contracts.generated'
import { sameDependencies, validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import chapterSql from '../../shared/contracts/003-chapters.sql?raw'
import { registerRunnerResources } from './resource-references'

type Row = { payload_json: string }
type PublicationRow = Row & { state: ChapterPublication['state']; result_json: string | null }
type StageFields = Pick<ChapterUpdate, 'reason' | 'source' | 'proposal_id' | 'publication_operation_id' | 'action_id'>
export const chapterTerminal = new Set<ChapterUpdate['state']>(['succeeded', 'failed', 'cancelled', 'interrupted', 'superseded'])
function fail(code: string, message: string): never { throw new ContractError(code, message) }
const conflict = (message: string): never => fail('CHAPTER_CONFLICT', message)
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function json(value: unknown): string {
  const seen = new Set<object>()
  const check = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || seen.has(item) || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('INVALID_RUNNER_CONTRACT', 'Chapter evidence must be finite plain JSON')
    seen.add(item)
    for (const child of Object.values(item)) check(child)
    seen.delete(item)
  }
  check(value)
  return JSON.stringify(value)
}
function equivalent(left: unknown, right: unknown): boolean {
  const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
  return json(ordered(left)) === json(ordered(right))
}
function original(update: ChapterUpdate): unknown {
  const { task_id, update_id, input_event_id, record_id, request_id, intent_revision, view_id, base_manifest, region_ids, dependencies, text, model_config_id } = update
  return { task_id, update_id, input_event_id, record_id, request_id, intent_revision, view_id, base_manifest, region_ids, dependencies, text, ...(model_config_id ? { model_config_id } : {}) }
}

// Safe on an existing v2 database and on a private upgrade candidate.
// A pre-chapter Run remains an ordinary Run: no historical authority is invented.
export function installChapterSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
  const installed = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_chapter_assemblies'").get()
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='one_active_request_run'").get() as { sql: string } | undefined
  if (installed && columns.some(column => column.name === 'chapter_update_id') && index?.sql.includes('chapter_update_id')) return
  db.transaction(() => {
    if (!columns.some(column => column.name === 'chapter_update_id')) db.exec('ALTER TABLE runs ADD COLUMN chapter_update_id TEXT')
    db.exec(chapterSql)
    if (!index?.sql.includes('chapter_update_id')) {
      db.exec("DROP INDEX IF EXISTS one_active_request_run; CREATE UNIQUE INDEX one_active_request_run ON runs(request_id,COALESCE(chapter_update_id,'')) WHERE request_id IS NOT NULL AND state IN ('running','waiting')")
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='business_upgrade_state'").get()) {
      for (const table of ['runner_chapter_manifests', 'runner_chapter_heads', 'runner_chapter_updates', 'runner_chapter_intents', 'runner_chapter_proposals', 'runner_chapter_inheritance', 'runner_chapter_publications', 'runner_chapter_resources', 'runner_chapter_publication_evidence', 'runner_chapter_assemblies']) {
        for (const event of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS business_v2_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE business_upgrade_state SET v2_writes=1 WHERE id=1 AND v2_writes=0; END`)
      }
    }
  })()
}

export class ChapterState {
  constructor(private readonly db: Database.Database) { installChapterSchema(db) }

  manifest(task: string, view: string, revision?: number): ChapterManifest | null {
    const row = revision === undefined
      ? this.db.prepare('SELECT m.payload_json FROM runner_chapter_heads h JOIN runner_chapter_manifests m USING(task_id,view_id,manifest_revision) WHERE h.task_id=? AND h.view_id=?').get(task, view) as Row | undefined
      : this.db.prepare('SELECT payload_json FROM runner_chapter_manifests WHERE task_id=? AND view_id=? AND manifest_revision=?').get(task, view, revision) as Row | undefined
    return row ? validateRunnerContract('runner_chapter_manifest', JSON.parse(row.payload_json)) : null
  }
  installManifest(raw: ChapterManifest, expectedManifestRevision: number | null): ChapterManifest {
    const manifest = validateRunnerContract('runner_chapter_manifest', raw)
    return this.db.transaction(() => {
      const current = this.manifest(manifest.task_id, manifest.view_id)
      const existing = this.manifest(manifest.task_id, manifest.view_id, manifest.manifest_revision)
      if (existing) {
        if (!equivalent(existing, manifest)) conflict('A chapter manifest revision retains its original binding')
        if (current?.manifest_revision !== manifest.manifest_revision) conflict('An old manifest cannot become current again')
        return existing
      }
      if ((current?.manifest_revision ?? null) !== expectedManifestRevision || manifest.manifest_revision !== (expectedManifestRevision ?? 0) + 1) conflict('Chapter mapping no longer matches its installation baseline')
      const view = this.db.prepare('SELECT v.revision,v.state_revision,v.bundle_resource_id FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=?').get(manifest.task_id, manifest.view_id) as { revision: number; state_revision: number; bundle_resource_id: string } | undefined
      if (!view || view.revision !== manifest.view_revision || view.state_revision !== manifest.state_revision || view.bundle_resource_id !== manifest.bundle_resource_id) conflict('Chapter mapping requires the exact currently published View and state')
      this.protect(manifest.task_id, 'manifest', `${manifest.view_id}:${manifest.manifest_revision}`, [manifest.bundle_resource_id])
      this.db.prepare('INSERT INTO runner_chapter_manifests(task_id,view_id,manifest_revision,view_revision,bundle_resource_id,payload_json,installed_at) VALUES (?,?,?,?,?,?,?)').run(manifest.task_id, manifest.view_id, manifest.manifest_revision, manifest.view_revision, manifest.bundle_resource_id, json(manifest), new Date().toISOString())
      this.db.prepare('INSERT INTO runner_chapter_heads(task_id,view_id,manifest_revision) VALUES (?,?,?) ON CONFLICT(task_id,view_id) DO UPDATE SET manifest_revision=excluded.manifest_revision').run(manifest.task_id, manifest.view_id, manifest.manifest_revision)
      return copy(manifest)
    })()
  }
  update(task: string, id: string): ChapterUpdate | null {
    const row = this.db.prepare('SELECT payload_json FROM runner_chapter_updates WHERE task_id=? AND update_id=?').get(task, id) as Row | undefined
    return row ? validateRunnerContract('runner_chapter_update', JSON.parse(row.payload_json)) : null
  }
  updates(task: string, view?: string): ChapterUpdate[] {
    const rows = view === undefined
      ? this.db.prepare('SELECT payload_json FROM runner_chapter_updates WHERE task_id=? ORDER BY rowid').all(task) as Row[]
      : this.db.prepare('SELECT payload_json FROM runner_chapter_updates WHERE task_id=? AND view_id=? ORDER BY rowid').all(task, view) as Row[]
    return rows.map(row => validateRunnerContract('runner_chapter_update', JSON.parse(row.payload_json)))
  }
  start(raw: ChapterUpdate): ChapterUpdate {
    const input = validateRunnerContract('runner_chapter_update', raw)
    return this.db.transaction(() => {
      const saved = this.db.prepare('SELECT task_id,update_id,input_json FROM runner_chapter_updates WHERE update_id=? OR input_event_id=?').all(input.update_id, input.input_event_id) as { task_id: string; update_id: string; input_json: string }[]
      if (saved.length) {
        if (saved.length !== 1 || saved[0]!.task_id !== input.task_id || saved[0]!.update_id !== input.update_id || !equivalent(JSON.parse(saved[0]!.input_json), original(input))) conflict('Chapter input identity retains its original payload')
        return this.update(input.task_id, input.update_id)!
      }
      if (input.state !== 'queued' || input.source || input.proposal_id || input.publication_operation_id || input.action_id) conflict('New chapter work must start without execution or publication authority')
      this.assertGoal(input)
      if (!this.db.prepare('SELECT 1 FROM records WHERE id=? AND task_id=?').get(input.record_id, input.task_id)) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter input record does not belong to its Task')
      const manifest = this.manifest(input.task_id, input.view_id)
      if (!manifest || !equivalent(manifest, input.base_manifest)) conflict('Chapter request must bind the current published manifest')
      if (input.dependencies.some(dependency => !this.dependencyCurrent(dependency))) conflict('Chapter input dependency changed')
      const superseded = this.updates(input.task_id, input.view_id).filter(update => !chapterTerminal.has(update.state) && update.region_ids.some(id => input.region_ids.includes(id)))
      for (const update of superseded) this.stage(input.task_id, update.update_id, 'superseded', { reason: 'newer_chapter_intent' })
      const region_intents = input.region_ids.map(region_id => {
        const previous = this.db.prepare('SELECT intent_revision FROM runner_chapter_intents WHERE task_id=? AND view_id=? AND region_id=?').get(input.task_id, input.view_id, region_id) as { intent_revision: number } | undefined
        return { region_id, intent_revision: (previous?.intent_revision ?? 0) + 1 }
      })
      const update = validateRunnerContract('runner_chapter_update', { ...input, region_intents, previous_update_ids: superseded.map(previous => previous.update_id) })
      this.db.prepare('INSERT INTO runner_chapter_updates(task_id,update_id,input_event_id,request_id,intent_revision,view_id,state,input_json,payload_json,installed_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(update.task_id, update.update_id, update.input_event_id, update.request_id, update.intent_revision, update.view_id, update.state, json(original(input)), json(update), new Date().toISOString())
      for (const intent of region_intents) this.db.prepare('INSERT INTO runner_chapter_intents(task_id,view_id,region_id,intent_revision,update_id) VALUES (?,?,?,?,?) ON CONFLICT(task_id,view_id,region_id) DO UPDATE SET intent_revision=excluded.intent_revision,update_id=excluded.update_id').run(update.task_id, update.view_id, intent.region_id, intent.intent_revision, update.update_id)
      this.protect(update.task_id, 'update', update.update_id, [update.base_manifest.bundle_resource_id])
      return copy(update)
    })()
  }
  private assertGoal(update: ChapterUpdate): void {
    if (!this.db.prepare("SELECT 1 FROM tasks WHERE id=? AND state='active'").get(update.task_id)) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter Task is not active')
    const row = this.db.prepare('SELECT r.payload_json FROM runner_goal_heads h JOIN runner_goal_revisions r USING(request_id,intent_revision) WHERE h.task_id=? AND h.request_id=?').get(update.task_id, update.request_id) as Row | undefined
    if (!row) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter goal is unavailable')
    const goal = validateRunnerContract('runner_goal_revision', JSON.parse(row.payload_json))
    if (goal.state !== 'active' || goal.intent_revision !== update.intent_revision) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter goal revision is no longer current')
  }
  dependencyCurrent(dependency: ChapterDependency): boolean {
    validateRunnerContract('runner_chapter_dependency', dependency)
    const manifest = this.manifest(dependency.task_id, dependency.view_id)
    return !!manifest && this.viewCurrent(manifest) && (dependency.region_id === undefined ? manifest.shared_revision === dependency.revision : manifest.chapters.some(chapter => chapter.region_id === dependency.region_id && chapter.revision === dependency.revision))
  }
  assertCurrent(task: string, id: string): ChapterUpdate {
    const update = this.update(task, id) ?? fail('RUNNER_NOT_FOUND', 'Chapter update is unavailable')
    this.assertGoal(update)
    if (chapterTerminal.has(update.state)) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter update no longer has commit authority')
    const manifest = this.manifest(task, update.view_id)
    if (!manifest || !this.viewCurrent(manifest)) fail('RUNNER_OWNERSHIP_INVALID', 'Published chapter mapping is unavailable or replaced')
    for (const intent of update.region_intents) {
      const head = this.db.prepare('SELECT intent_revision,update_id FROM runner_chapter_intents WHERE task_id=? AND view_id=? AND region_id=?').get(task, update.view_id, intent.region_id) as { intent_revision: number; update_id: string } | undefined
      const before = update.base_manifest.chapters.find(chapter => chapter.region_id === intent.region_id)
      if (!head || head.update_id !== id || head.intent_revision !== intent.intent_revision || !before || !manifest.chapters.some(chapter => chapter.region_id === intent.region_id && chapter.revision === before.revision)) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter scope or local intent is no longer current')
    }
    if (update.dependencies.some(dependency => !this.dependencyCurrent(dependency))) fail('RUNNER_OWNERSHIP_INVALID', 'An actual chapter dependency changed')
    return update
  }
  stage(task: string, id: string, state: ChapterUpdate['state'], fields: Partial<StageFields> = {}): ChapterUpdate {
    const update = this.update(task, id) ?? fail('RUNNER_NOT_FOUND', 'Chapter update is unavailable')
    if (chapterTerminal.has(update.state) && update.state !== state) conflict('A terminal chapter update cannot resume')
    if (update.state === 'unknown' && !['unknown', 'succeeded', 'failed', 'cancelled', 'interrupted', 'superseded'].includes(state)) conflict('Unknown publication must be reconciled before chapter work continues')
    const next = validateRunnerContract('runner_chapter_update', { ...update, ...fields, state })
    this.db.prepare('UPDATE runner_chapter_updates SET state=?,payload_json=? WHERE task_id=? AND update_id=?').run(state, json(next), task, id)
    return copy(next)
  }
  proposal(task: string, id: string): ChapterProposal | null {
    const row = this.db.prepare('SELECT payload_json FROM runner_chapter_proposals WHERE task_id=? AND proposal_id=?').get(task, id) as Row | undefined
    return row ? validateRunnerContract('runner_chapter_proposal', JSON.parse(row.payload_json)) : null
  }
  recordProposal(raw: ChapterProposal): ChapterProposal {
    const proposal = validateRunnerContract('runner_chapter_proposal', raw)
    return this.db.transaction(() => {
      const existing = this.proposal(proposal.task_id, proposal.proposal_id)
      if (existing) {
        if (!equivalent(existing, proposal)) conflict('Chapter proposal identity retains its original payload')
        return existing
      }
      const update = this.assertCurrent(proposal.task_id, proposal.update_id)
      if (proposal.intent_revision !== update.intent_revision || proposal.source.purpose !== 'production' || proposal.source.request_id !== update.request_id || proposal.source.update_id !== update.update_id || update.source && !equivalent(update.source, proposal.source) || !sameDependencies(proposal.dependencies, update.dependencies)) fail('RUNNER_OWNERSHIP_INVALID', 'Chapter proposal source does not match its authorized work')
      const replaced = proposal.replacements.flatMap(group => group.previous_region_ids)
      if (replaced.length !== update.region_ids.length || update.region_ids.some(id => !replaced.includes(id))) conflict('Chapter proposal must replace its entire authorized group')
      this.protect(proposal.task_id, 'proposal', proposal.proposal_id, [proposal.bundle_resource_id])
      this.db.prepare('INSERT INTO runner_chapter_proposals(task_id,proposal_id,update_id,bundle_resource_id,payload_json) VALUES (?,?,?,?,?)').run(proposal.task_id, proposal.proposal_id, proposal.update_id, proposal.bundle_resource_id, json(proposal))
      this.stage(proposal.task_id, proposal.update_id, 'assembling', { proposal_id: proposal.proposal_id })
      return copy(proposal)
    })()
  }
  keep(raw: ChapterInheritance): ChapterInheritance {
    const keep = validateRunnerContract('runner_chapter_inheritance', raw)
    return this.db.transaction(() => {
      const update = this.update(keep.task_id, keep.update_id) ?? fail('RUNNER_NOT_FOUND', 'Chapter inheritance update is unavailable')
      const source = this.manifest(keep.task_id, keep.view_id, keep.source_manifest_revision)
      const region = source?.chapters.find(chapter => chapter.region_id === keep.region_id && chapter.revision === keep.region_revision)
      if (update.view_id !== keep.view_id || update.region_ids.includes(keep.region_id) || !source || !region || source.bundle_resource_id !== keep.source_bundle_resource_id || source.request_id !== keep.request_id || source.intent_revision !== keep.intent_revision || !sameDependencies(region.dependencies, keep.dependencies)) conflict('Kept contribution requires its exact original source and dependencies')
      if (keep.valid && keep.dependencies.some(dependency => !this.dependencyCurrent(dependency))) conflict('Changed dependencies cannot be inherited as current')
      this.protect(keep.task_id, 'inheritance', `${keep.update_id}:${keep.region_id}`, [keep.source_bundle_resource_id])
      const existing = this.db.prepare('SELECT payload_json FROM runner_chapter_inheritance WHERE task_id=? AND update_id=? AND region_id=?').get(keep.task_id, keep.update_id, keep.region_id) as Row | undefined
      if (existing && !equivalent(JSON.parse(existing.payload_json), keep)) conflict('Inherited contribution retains its exact source')
      if (!existing) this.db.prepare('INSERT INTO runner_chapter_inheritance(task_id,update_id,region_id,payload_json) VALUES (?,?,?,?)').run(keep.task_id, keep.update_id, keep.region_id, json(keep))
      return copy(keep)
    })()
  }
  inheritance(task: string, update: string): ChapterInheritance[] {
    return (this.db.prepare('SELECT payload_json FROM runner_chapter_inheritance WHERE task_id=? AND update_id=? ORDER BY rowid').all(task, update) as Row[]).map(row => validateRunnerContract('runner_chapter_inheritance', JSON.parse(row.payload_json)))
  }
  publication(task: string, id: string): { operation: ChapterPublication; result: unknown | null } | null {
    const row = this.db.prepare('SELECT payload_json,state,result_json FROM runner_chapter_publications WHERE task_id=? AND operation_id=?').get(task, id) as PublicationRow | undefined
    return row ? { operation: validateRunnerContract('runner_chapter_publication', { ...JSON.parse(row.payload_json), state: row.state }), result: row.result_json === null ? null : JSON.parse(row.result_json) } : null
  }
  registerPublication(raw: ChapterPublication): ChapterPublication {
    const operation = validateRunnerContract('runner_chapter_publication', raw)
    return this.db.transaction(() => {
      const existing = this.publication(operation.task_id, operation.operation_id)
      if (existing) {
        const { state: _oldState, ...oldBinding } = existing.operation, { state: _newState, ...newBinding } = operation
        if (!equivalent(oldBinding, newBinding)) conflict('Publication parameters cannot change under an existing operation identity')
        return existing.operation
      }
      const update = this.assertCurrent(operation.task_id, operation.update_id)
      if (operation.state !== 'registered' || update.proposal_id !== operation.proposal_id || !this.proposal(operation.task_id, operation.proposal_id)) conflict('Publication requires an accepted chapter proposal')
      const previous = this.db.prepare('SELECT operation_id,state,result_json FROM runner_chapter_publications WHERE task_id=? AND update_id=? ORDER BY rowid DESC LIMIT 1').get(operation.task_id, operation.update_id) as { operation_id: string; state: ChapterPublication['state']; result_json: string | null } | undefined
      if (previous) {
        const result = previous.result_json === null ? null : JSON.parse(previous.result_json)
        if (operation.previous_operation_id !== previous.operation_id || !['superseded', 'failure', 'cancelled'].includes(previous.state) || result?.code === 'APPROVAL_DENIED' || result?.denied === true) conflict('The original publication must be settled without bypassing a refusal')
      } else if (operation.previous_operation_id) conflict('Publication predecessor is unavailable')
      this.protect(operation.task_id, 'publication', operation.operation_id, [operation.assembled_bundle_resource_id, ...operation.source_bundle_resource_ids])
      this.db.prepare('INSERT INTO runner_chapter_publications(task_id,operation_id,update_id,previous_operation_id,state,payload_json,result_json) VALUES (?,?,?,?,?,?,NULL)').run(operation.task_id, operation.operation_id, operation.update_id, operation.previous_operation_id ?? null, operation.state, json(operation))
      this.stage(operation.task_id, operation.update_id, 'assembling', { publication_operation_id: operation.operation_id })
      return copy(operation)
    })()
  }
  publicationStage(task: string, id: string, state: ChapterPublication['state'], result?: unknown): ChapterPublication {
    return this.db.transaction(() => {
      const saved = this.publication(task, id) ?? fail('RUNNER_NOT_FOUND', 'Chapter publication is unavailable')
      const transitions: Record<ChapterPublication['state'], ChapterPublication['state'][]> = {
        registered: ['prepared', 'cancelled', 'failure', 'superseded'], prepared: ['dispatched', 'cancelled', 'failure', 'superseded'],
        dispatched: ['published', 'failure', 'unknown'], unknown: ['published', 'failure', 'cancelled'],
        published: [], failure: [], cancelled: [], superseded: []
      }
      if (saved.operation.state !== state && !transitions[saved.operation.state].includes(state)) conflict('Publication transition would replay or replace an unresolved operation')
      const terminal = ['published', 'failure', 'cancelled', 'superseded'].includes(state)
      if (terminal && saved.result !== null && result !== undefined && !equivalent(saved.result, result)) conflict('Publication outcome retains its original evidence')
      const next = validateRunnerContract('runner_chapter_publication', { ...saved.operation, state })
      if (result !== undefined) {
        const evidence = this.db.prepare('SELECT sequence,state,payload_json FROM runner_chapter_publication_evidence WHERE task_id=? AND operation_id=? ORDER BY sequence DESC LIMIT 1').get(task, id) as { sequence: number; state: string; payload_json: string } | undefined
        if (!evidence || evidence.state !== state || !equivalent(JSON.parse(evidence.payload_json), result)) this.db.prepare('INSERT INTO runner_chapter_publication_evidence(task_id,operation_id,sequence,state,payload_json,installed_at) VALUES (?,?,?,?,?,?)').run(task, id, (evidence?.sequence ?? 0) + 1, state, json(result), new Date().toISOString())
      }
      this.db.prepare('UPDATE runner_chapter_publications SET state=?,result_json=COALESCE(result_json,?) WHERE task_id=? AND operation_id=?').run(state, terminal && result !== undefined ? json(result) : null, task, id)
      return next
    })()
  }
  private viewCurrent(manifest: ChapterManifest): boolean {
    const row = this.db.prepare('SELECT v.revision,v.bundle_resource_id FROM views v JOIN surfaces s ON s.id=v.surface_id WHERE s.task_id=? AND v.id=?').get(manifest.task_id, manifest.view_id) as { revision: number; bundle_resource_id: string } | undefined
    return !!row && row.revision === manifest.view_revision && row.bundle_resource_id === manifest.bundle_resource_id
  }
  protect(task: string, ownerKind: string, ownerId: string, resources: string[]): void {
    this.db.transaction(() => {
      registerRunnerResources(this.db, task, 'runner_chapter_resources', JSON.stringify([task, ownerKind, ownerId]), resources)
      for (const resource of new Set(resources)) this.db.prepare('INSERT OR IGNORE INTO runner_chapter_resources(task_id,owner_kind,owner_id,resource_id) VALUES (?,?,?,?)').run(task, ownerKind, ownerId, resource)
    })()
  }
}

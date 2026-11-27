import type Database from 'better-sqlite3'
import { artifactRepair, repairRoutingWork, repairSuccessor } from './repair-state'
import type { ArtifactCandidate, ArtifactIndex, CompositionBatch, CompositionScope, ContributionInventory, ExecutionAttempt, ContentPlan, LogicalWork, RunnerRun, WorkDependency, WorkOutputDeclaration } from '../../shared/contracts.generated'
import { sameDependencies, validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { RunnerArtifactState, type ArtifactOwner } from './artifact-state'
import { assertRunnerId, RUNNER_LIMITS } from './limits'
import { RunnerIndexPages, type ArtifactIndexPage } from './index-pages'
import { ChapterState } from './chapter-state'
import { registerRunnerResources } from './resource-references'
import { RunnerWorkState } from './work-state'

export interface InventorySource {
  task_id: string; request_id: string; intent_revision: number; work_id: string; plan_revision: number
}
export interface IntegrationInputs {
  task_id: string
  run_id: string
  work_id: string
  attempt_id: string
  dependencies: WorkDependency[]
  artifacts: ArtifactIndex[]
  results: { work_id: string; result_revision: number; result_ref: WorkOutputDeclaration['result_ref'] }[]
  resources: string[]
}
type PayloadRow = { payload_json: string }
type GoalIdentity = Pick<ContentPlan, 'task_id' | 'request_id' | 'intent_revision'>
function fail(code: string, message: string): never { throw new ContractError(code, message) }
function revision(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('INVALID_RUNNER_CONTRACT', 'Composition revisions must be positive safe integers')
}
function json(value: unknown): string {
  try {
    const result = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item) || !['object', 'string', 'boolean', 'number'].includes(typeof item)) throw Error()
      return item
    })
    if (result === undefined) throw Error()
    return result
  } catch { return fail('INVALID_RUNNER_CONTRACT', 'Composition state must be finite JSON') }
}
function equivalent(left: unknown, right: unknown): boolean {
  const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
  return json(normalize(left)) === json(normalize(right))
}
function sameGoal(left: GoalIdentity, right: GoalIdentity): boolean {
  return left.task_id === right.task_id && left.request_id === right.request_id && left.intent_revision === right.intent_revision
}
function distinct(values: string[], name: string): void {
  if (new Set(values).size !== values.length) fail('INVALID_RUNNER_CONTRACT', `Duplicate ${name}`)
}

// These records close an enumerated contribution set. Content review and
// publication completeness remain separate host installations.
export class RunnerCompositionState {
  private readonly indexPages: RunnerIndexPages
  constructor(private readonly db: Database.Database, private readonly work: RunnerWorkState, private readonly artifacts: RunnerArtifactState) { this.indexPages = new RunnerIndexPages(db, work.epoch) }

  private activeTask(taskId: string): void {
    if (!this.db.prepare("SELECT id FROM tasks WHERE id=? AND state='active'").get(taskId)) fail('RUNNER_OWNERSHIP_INVALID', 'Task is not active')
  }
  private currentGoal(identity: GoalIdentity): ContentPlan {
    const goal = this.work.goal(identity.request_id)
    if (!sameGoal(goal, identity) || goal.state !== 'active') fail('RUNNER_OWNERSHIP_INVALID', 'Contribution goal revision is no longer current')
    return goal
  }
  private requirements(goal: ContentPlan, ids: string[]): void {
    if (ids.some(id => !goal.requirements.some(requirement => requirement.requirement_id === id))) fail('RUNNER_OWNERSHIP_INVALID', 'Contribution requirements do not belong to this goal')
  }
  private resultReference(taskId: string, reference: WorkOutputDeclaration['result_ref']): void {
    const exists = reference.kind === 'record'
      ? this.db.prepare('SELECT id FROM records WHERE task_id=? AND id=?').get(taskId, reference.id)
      : reference.kind === 'action'
        ? this.db.prepare('SELECT id FROM actions WHERE task_id=? AND id=?').get(taskId, reference.id)
        : this.db.prepare('SELECT r.id FROM task_resources t JOIN resources r ON r.id=t.resource_id WHERE t.task_id=? AND r.id=?').get(taskId, reference.id)
    if (reference.task_id !== taskId || !exists) fail('RUNNER_RESULT_INVALID', 'Final work result must reference an existing result in this Task')
  }

  private resultRunCurrent(run: RunnerRun, work: LogicalWork, attempt?: ExecutionAttempt): boolean {
    if (run.state === 'completed') return true
    if (['running', 'waiting'].includes(run.state)) return run.commit_valid && run.runtime_epoch === this.work.epoch
    const assigned = work.purpose === 'production' && !!work.assignment
    if (!['interrupted', 'closing'].includes(run.state) && !(assigned && run.state === 'failed')) return false
    if (work.state !== 'succeeded' || !work.current_attempt_id) return false
    const settled = attempt ?? this.work.attempt(work.current_attempt_id)
    if (settled.attempt_id !== work.current_attempt_id || settled.work_id !== work.work_id || settled.run_id !== run.run_id || settled.task_id !== run.task_id || settled.runtime_epoch !== run.runtime_epoch || settled.state !== 'succeeded' || settled.dispatch_state !== 'dispatched' || !settled.result_ref || work.result_revision === undefined) return false
    if (run.state === 'failed') return !run.commit_valid
    if (run.state === 'interrupted' && run.purpose === 'production') return !!this.db.prepare(`WITH RECURSIVE lineage(run_id) AS (
      SELECT @original
      UNION
      SELECT successor.run_id FROM lineage
      JOIN runs prior ON prior.id=lineage.run_id AND prior.task_id=@task AND prior.request_id=@request AND prior.state='interrupted' AND prior.commit_valid=0
      JOIN records r ON r.task_id=prior.task_id AND r.kind='runner.production.resumed' AND json_extract(r.payload_json,'$.previous_run_id')=prior.id
      JOIN runner_runs successor ON successor.task_id=r.task_id AND successor.run_id=json_extract(r.payload_json,'$.run_id')
      WHERE successor.purpose='production' AND successor.request_id=@request AND successor.intent_revision=@intent AND successor.budget_id=@budget
        AND json_extract(successor.payload_json,'$.previous_run_id')=prior.id
        AND json_extract(r.payload_json,'$.request_id')=@request AND json_extract(r.payload_json,'$.intent_revision')=@intent
      ), related AS (
        SELECT c.id,c.state,c.commit_valid,c.runtime_epoch,c.intended_terminal FROM lineage
        JOIN runs c ON c.id=lineage.run_id AND c.task_id=@task AND c.request_id=@request
      ) SELECT 1 FROM related c
      WHERE c.state='completed' OR c.state='failed' AND @assigned=1 AND c.commit_valid=0
        OR c.state IN ('running','waiting') AND c.runtime_epoch=@epoch
          AND (c.commit_valid=1 OR c.intended_terminal='completed' OR c.intended_terminal='failed' AND @assigned=1)
      UNION ALL SELECT 1 WHERE @assigned=1 AND NOT EXISTS (
        SELECT 1 FROM related r WHERE r.state!='interrupted' OR r.commit_valid!=0
          OR EXISTS (SELECT 1 FROM runner_work w WHERE w.run_id=r.id AND w.state IN ('planned','queued','running','waiting'))
          OR EXISTS (SELECT 1 FROM runner_attempts a WHERE a.run_id=r.id AND (a.state NOT IN ('succeeded','failed','cancelled','revoked') OR json_extract(a.payload_json,'$.dispatch_state')='unknown'))
          OR EXISTS (SELECT 1 FROM calls c WHERE c.run_id=r.id AND (c.state!='ended' OR c.execution='unknown'))
          OR EXISTS (SELECT 1 FROM actions a WHERE a.run_id=r.id AND (a.state!='ended' OR a.result='unknown'))
      ) LIMIT 1`)
      .get({ original: run.run_id, task: run.task_id, request: run.request_id, intent: run.intent_revision, budget: run.budget_id, epoch: this.work.epoch, assigned: Number(assigned) })
    if (run.state !== 'closing' || run.runtime_epoch !== this.work.epoch) return false
    const row = this.db.prepare('SELECT intended_terminal FROM runs WHERE id=? AND task_id=? AND runtime_epoch=?').get(run.run_id, run.task_id, run.runtime_epoch) as { intended_terminal: string | null } | undefined
    return row?.intended_terminal === 'completed' || assigned && row?.intended_terminal === 'failed'
  }

  source(taskId: string, requestId: string, intentRevision: number): InventorySource | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(requestId, 'request_id'); revision(intentRevision)
    return this.db.prepare('SELECT task_id,request_id,intent_revision,work_id,plan_revision FROM runner_inventory_sources WHERE task_id=? AND request_id=? AND intent_revision=?').get(taskId, requestId, intentRevision) as InventorySource | undefined ?? null
  }

  designateSource(raw: InventorySource, expected: Pick<InventorySource, 'work_id' | 'plan_revision'> | null = null): InventorySource {
    const source = JSON.parse(json(raw)) as InventorySource
    if (!source || typeof source !== 'object' || Object.keys(source).some(key => !['task_id', 'request_id', 'intent_revision', 'work_id', 'plan_revision'].includes(key))) fail('INVALID_RUNNER_CONTRACT', 'Invalid inventory source')
    for (const key of ['task_id', 'request_id', 'work_id'] as const) assertRunnerId(source[key], key)
    revision(source.intent_revision); revision(source.plan_revision)
    if (expected !== null) { assertRunnerId(expected.work_id, 'work_id'); revision(expected.plan_revision) }
    return this.db.transaction(() => {
      const previous = this.source(source.task_id, source.request_id, source.intent_revision)
      if (previous && equivalent(previous, source)) return previous
      if (previous ? !expected || previous.work_id !== expected.work_id || previous.plan_revision !== expected.plan_revision : expected !== null) fail('RUNNER_INVENTORY_SOURCE_CONFLICT', 'Inventory source must compare its exact predecessor')
      this.activeTask(source.task_id); this.currentGoal(source)
      const work = this.work.work(source.work_id), run = this.work.run(work.run_id)
      if (work.purpose !== 'production' || !sameGoal(source, work) || work.plan_revision !== source.plan_revision || !['router', 'producer'].includes(work.role) || !['planned', 'queued', 'running', 'waiting', 'succeeded'].includes(work.state) || run.purpose !== 'production' || !sameGoal(source, run) || !run.commit_valid || run.runtime_epoch !== this.work.epoch || !['queued', 'running', 'waiting'].includes(run.state)) fail('RUNNER_OWNERSHIP_INVALID', 'Only a current Router or direct Producer may be designated to seal')
      this.db.prepare('INSERT INTO runner_inventory_sources(task_id,request_id,intent_revision,work_id,plan_revision) VALUES (?,?,?,?,?) ON CONFLICT(request_id,intent_revision) DO UPDATE SET work_id=excluded.work_id,plan_revision=excluded.plan_revision').run(source.task_id, source.request_id, source.intent_revision, source.work_id, source.plan_revision)
      return source
    }).immediate()
  }

  output(taskId: string, workId: string, planRevision: number, resultRevision: number): WorkOutputDeclaration | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(workId, 'work_id'); revision(planRevision); revision(resultRevision)
    const row = this.db.prepare('SELECT payload_json FROM runner_work_outputs WHERE task_id=? AND work_id=? AND plan_revision=? AND result_revision=?').get(taskId, workId, planRevision, resultRevision) as PayloadRow | undefined
    return row ? validateRunnerContract('runner_work_output_declaration', JSON.parse(row.payload_json)) : null
  }

  checkOutput(taskId: string, workId: string, planRevision: number, resultRevision: number): WorkOutputDeclaration | null {
    const output = this.output(taskId, workId, planRevision, resultRevision)
    if (output) { this.finalWork(output); this.outputArtifacts(output) }
    return output
  }

  private finalWork(output: WorkOutputDeclaration): { work: LogicalWork; attempt: ExecutionAttempt; goal: ContentPlan } {
    const goal = this.currentGoal(output), work = this.work.work(output.work_id), attempt = this.work.attempt(output.attempt_id), run = this.work.run(output.run_id)
    if (work.purpose !== 'production' || attempt.purpose !== 'production' || run.purpose !== 'production' || !sameGoal(output, work) || !sameGoal(output, attempt) || !sameGoal(output, run) || work.run_id !== output.run_id || attempt.run_id !== output.run_id || attempt.work_id !== output.work_id || work.current_attempt_id !== output.attempt_id || work.plan_revision !== output.plan_revision || work.result_revision !== output.result_revision || work.state !== 'succeeded' || attempt.state !== 'succeeded' || attempt.dispatch_state !== 'dispatched' || attempt.result_ref === undefined || !equivalent(attempt.result_ref, output.result_ref) || !sameDependencies(work.dependencies, attempt.input_versions) || !this.resultRunCurrent(run, work, attempt)) fail('RUNNER_OWNERSHIP_INVALID', 'Output declaration must match the exact successful final work and attempt')
    this.requirements(goal, [...output.requirement_ids, ...output.unresolved.map(item => item.requirement_id)])
    if (output.requirement_ids.some(id => !work.requirement_ids.includes(id))) fail('RUNNER_OWNERSHIP_INVALID', 'Output coverage must belong to its work')
    this.resultReference(output.task_id, output.result_ref)
    this.work.checkHandoffs(work, attempt.attempt_id)
    this.dependenciesCurrent(attempt.input_versions)
    return { work, attempt, goal }
  }

  private outputArtifacts(output: WorkOutputDeclaration): void {
    const owners = this.db.prepare('SELECT * FROM runner_artifact_owners WHERE task_id=? AND work_id=? AND plan_revision=? ORDER BY artifact_id').all(output.task_id, output.work_id, output.plan_revision) as ArtifactOwner[]
    const inherited = new Set(output.artifacts.filter(reference => {
      const original = this.artifacts.artifact(output.task_id, reference.artifact_id, reference.artifact_revision)
      return original && this.resolveContribution(original)
    }).map(reference => reference.artifact_id))
    if (owners.length + inherited.size !== output.artifacts.length || owners.some(owner => !output.artifacts.some(reference => reference.artifact_id === owner.artifact_id && reference.artifact_revision === owner.current_revision && owner.current_revision > 0))) fail('RUNNER_OUTPUT_INCOMPLETE', 'Output declaration must enumerate every assigned final fragment or explicit chapter descendant')
    const previousArtifacts = this.db.prepare("SELECT a.artifact_id FROM runner_artifacts a JOIN runner_candidates c ON c.candidate_id=a.candidate_id WHERE a.task_id=? AND json_extract(c.payload_json,'$.work_id')=? AND json_extract(c.payload_json,'$.plan_revision')=?").all(output.task_id, output.work_id, output.plan_revision) as { artifact_id: string }[]
    if (previousArtifacts.some(item => !owners.some(owner => owner.artifact_id === item.artifact_id) && !inherited.has(item.artifact_id))) fail('RUNNER_OWNERSHIP_INVALID', 'Final output no longer owns a previously produced fragment')
    for (const reference of output.artifacts) {
      const index = this.artifacts.artifact(output.task_id, reference.artifact_id, reference.artifact_revision)
      if (!index || !sameGoal(output, index) || index.work_id !== output.work_id || index.attempt_id !== output.attempt_id || index.run_id !== output.run_id) fail('RUNNER_OWNERSHIP_INVALID', 'Final fragment does not belong to the exact declared result')
      const candidate = this.currentIndex(this.resolveContribution(index) ?? index)
      if (candidate.unresolved.some(item => !output.unresolved.some(unresolved => unresolved.requirement_id === item.requirement_id))) fail('RUNNER_OUTPUT_INCOMPLETE', 'Output cannot omit unresolved fragment requirements')
    }
  }

  declareOutputs(raw: WorkOutputDeclaration): WorkOutputDeclaration {
    const output = validateRunnerContract('runner_work_output_declaration', JSON.parse(json(raw)))
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT payload_json FROM runner_work_outputs WHERE work_id=? AND plan_revision=? AND result_revision=?').get(output.work_id, output.plan_revision, output.result_revision) as PayloadRow | undefined
      if (row) {
        const previous = validateRunnerContract('runner_work_output_declaration', JSON.parse(row.payload_json))
        if (!equivalent(previous, output)) fail('RUNNER_OUTPUT_CONFLICT', 'A complete output declaration cannot change its original payload')
        return previous
      }
      this.work.qualify(output.attempt_id)
      const final = this.finalWork(output)
      this.outputArtifacts(output)
      this.db.prepare('INSERT INTO runner_work_outputs(task_id,request_id,intent_revision,work_id,plan_revision,result_revision,payload_json) VALUES (?,?,?,?,?,?,?)').run(output.task_id, output.request_id, output.intent_revision, output.work_id, output.plan_revision, output.result_revision, json(output))
      registerRunnerResources(this.db, output.task_id, 'runner_work_output', json([output.work_id, output.plan_revision, output.result_revision]), [...(output.result_ref.kind === 'resource' ? [output.result_ref.id] : []), ...final.work.dependencies.flatMap(input => input.kind === 'resource' ? [input.resource_id] : [])])
      return output
    }).immediate()
  }

  inventory(taskId: string, requestId: string, intentRevision: number, inventoryRevision?: number): ContributionInventory | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(requestId, 'request_id'); revision(intentRevision)
    if (inventoryRevision !== undefined) revision(inventoryRevision)
    const row = (inventoryRevision === undefined
      ? this.db.prepare('SELECT payload_json FROM runner_contribution_inventories WHERE task_id=? AND request_id=? AND intent_revision=? ORDER BY inventory_revision DESC LIMIT 1').get(taskId, requestId, intentRevision)
      : this.db.prepare('SELECT payload_json FROM runner_contribution_inventories WHERE task_id=? AND request_id=? AND intent_revision=? AND inventory_revision=?').get(taskId, requestId, intentRevision, inventoryRevision)) as PayloadRow | undefined
    return row ? validateRunnerContract('runner_contribution_inventory', JSON.parse(row.payload_json)) : null
  }

  checkInventory(taskId: string, requestId: string, intentRevision: number, inventoryRevision: number): ContributionInventory {
    const inventory = this.inventory(taskId, requestId, intentRevision)
    if (!inventory || inventory.inventory_revision !== inventoryRevision) fail('RUNNER_OUTPUT_INCOMPLETE', 'Composition requires the exact current sealed contribution inventory')
    this.inventoryOutputs(inventory)
    if (this.pendingChapterUpdates(taskId, requestId, intentRevision).length) fail('RUNNER_OUTPUT_INCOMPLETE', 'Required chapter updates have not been successfully published')
    return inventory
  }

  pendingChapterUpdates(taskId: string, requestId: string, intentRevision: number): string[] {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_chapter_assemblies'").get()) return []
    const rows = this.db.prepare("SELECT u.update_id,u.state,a.operation_id FROM runner_chapter_updates u LEFT JOIN runner_chapter_assemblies a ON a.task_id=u.task_id AND a.update_id=u.update_id WHERE u.task_id=? AND u.request_id=? AND u.intent_revision=? AND EXISTS(SELECT 1 FROM runner_chapter_intents i WHERE i.task_id=u.task_id AND i.update_id=u.update_id) ORDER BY u.rowid").all(taskId, requestId, intentRevision) as { update_id: string; state: string; operation_id: string | null }[]
    return rows.filter(row => row.state !== 'succeeded' || row.operation_id === null).map(row => row.update_id)
  }

  currentArtifacts(inventory: ContributionInventory): ArtifactIndex[] {
    this.inventoryOutputs(inventory)
    const indexes = inventory.required_works.flatMap(output => output.artifacts.map(reference => {
      const original = this.artifacts.artifact(inventory.task_id, reference.artifact_id, reference.artifact_revision) ?? fail('RUNNER_DEPENDENCY_INVALID', 'The sealed contribution is unavailable')
      return this.resolveContribution(original) ?? original
    }))
    return [...new Map(indexes.filter(index => this.publicationArtifact(index)).map(index => [index.artifact_id, index])).values()]
  }

  private resolveContribution(index: ArtifactIndex): ArtifactIndex | null {
    const head = this.artifacts.artifact(index.task_id, index.artifact_id)
    if (head && repairSuccessor(this.db, index, head)) return head
    return this.artifacts.resolveChapterReference(index)
  }

  publicationArtifact(index: ArtifactIndex): boolean {
    const work = this.work.work(index.work_id)
    if (work.purpose !== 'production' || !work.assignment || artifactRepair(this.db, index.task_id, index.work_id)) return true
    const slot = this.db.prepare('SELECT output_key FROM runner_artifact_slots WHERE task_id=? AND work_id=? AND artifact_id=?').get(index.task_id, work.work_id, index.artifact_id) as { output_key: string } | undefined
    return !!slot && work.assignment.outputs.some(output => output.kind === 'artifact' && output.output_key === slot.output_key && output.exposure !== 'handoff')
  }

  private inventoryOutputs(inventory: ContributionInventory): void {
    const goal = this.currentGoal(inventory)
    const required = this.work.taskWorks(inventory.task_id).filter(work => work.purpose === 'production' && !work.update_id && sameGoal(inventory, work) && work.required && !artifactRepair(this.db, work.task_id, work.work_id) && (work.role !== 'router' || !repairRoutingWork(this.db, work.task_id, work.work_id)))
    if (required.length !== inventory.required_works.length || required.some(work => !inventory.required_works.some(output => output.work_id === work.work_id && output.plan_revision === work.plan_revision && output.result_revision === work.result_revision))) fail('RUNNER_OUTPUT_INCOMPLETE', 'Inventory must enumerate every current required work and its exact final result')
    for (const output of inventory.required_works) {
      const declared = this.output(output.task_id, output.work_id, output.plan_revision, output.result_revision)
      if (!declared || !equivalent(declared, output)) fail('RUNNER_OUTPUT_INCOMPLETE', 'Inventory must retain each persisted complete output declaration')
      this.finalWork(output); this.outputArtifacts(output)
    }
    this.requirements(goal, [...inventory.requirement_ids, ...inventory.unresolved.map(item => item.requirement_id)])
    if (goal.requirements.some(requirement => requirement.required && !inventory.requirement_ids.includes(requirement.requirement_id) && !inventory.unresolved.some(item => item.requirement_id === requirement.requirement_id))) fail('RUNNER_OUTPUT_INCOMPLETE', 'Uncovered required outcomes must remain unresolved')
  }

  inventorySealer(source: InventorySource): ExecutionAttempt {
    const work = this.work.work(source.work_id)
    if (work.purpose !== 'production' || !sameGoal(source, work) || work.plan_revision !== source.plan_revision || !['producer', 'router'].includes(work.role) || !work.current_attempt_id) fail('RUNNER_OWNERSHIP_INVALID', 'Inventory seal requires its designated planning source')
    const run = this.work.run(work.run_id)
    if (run.state === 'interrupted' && work.state === 'succeeded' && work.result_revision !== undefined) {
      this.activeTask(source.task_id)
      const output = this.checkOutput(source.task_id, work.work_id, work.plan_revision, work.result_revision)
      if (output) return this.work.attempt(output.attempt_id)
    }
    const { attempt } = this.work.qualify(work.current_attempt_id)
    if (!['running', 'waiting', 'succeeded'].includes(attempt.state)) fail('RUNNER_OWNERSHIP_INVALID', 'Inventory seal requires an eligible attempt from the designated planning source')
    return attempt
  }

  sealInventory(raw: ContributionInventory): ContributionInventory {
    const inventory = validateRunnerContract('runner_contribution_inventory', JSON.parse(json(raw)))
    return this.db.transaction(() => {
      const previous = this.inventory(inventory.task_id, inventory.request_id, inventory.intent_revision, inventory.inventory_revision)
      if (previous) {
        if (!equivalent(previous, inventory)) fail('RUNNER_INVENTORY_CONFLICT', 'A sealed contribution inventory cannot be overwritten')
        return previous
      }
      const head = this.inventory(inventory.task_id, inventory.request_id, inventory.intent_revision)
      if ((inventory.previous_revision ?? 0) !== (head?.inventory_revision ?? 0) || inventory.inventory_revision !== (head?.inventory_revision ?? 0) + 1) fail('RUNNER_INVENTORY_CONFLICT', 'Inventory must advance its exact current predecessor')
      const source = this.source(inventory.task_id, inventory.request_id, inventory.intent_revision), seal = inventory.sealed_by
      this.currentGoal(inventory)
      if (!source) fail('RUNNER_OWNERSHIP_INVALID', 'Inventory has no designated planning source')
      const attempt = this.inventorySealer(source)
      if (source.work_id !== seal.work_id || source.plan_revision !== seal.plan_revision || attempt.attempt_id !== seal.attempt_id || attempt.run_id !== seal.run_id || this.work.work(source.work_id).role !== seal.role) fail('RUNNER_OWNERSHIP_INVALID', 'Inventory seal must come from its designated planning source or its accepted predecessor result')
      this.inventoryOutputs(inventory)
      this.db.prepare('INSERT INTO runner_contribution_inventories(task_id,request_id,intent_revision,inventory_revision,payload_json) VALUES (?,?,?,?,?)').run(inventory.task_id, inventory.request_id, inventory.intent_revision, inventory.inventory_revision, json(inventory))
      return inventory
    }).immediate()
  }

  scope(taskId: string, version?: number): CompositionScope | null {
    assertRunnerId(taskId, 'task_id'); if (version !== undefined) revision(version)
    const row = (version === undefined
      ? this.db.prepare('SELECT payload_json FROM runner_scopes WHERE task_id=? ORDER BY composition_version DESC LIMIT 1').get(taskId)
      : this.db.prepare('SELECT payload_json FROM runner_scopes WHERE task_id=? AND composition_version=?').get(taskId, version)) as PayloadRow | undefined
    return row ? validateRunnerContract('runner_composition_scope', JSON.parse(row.payload_json)) : null
  }

  pageIndexes(taskId: string, compositionVersion: number, cursor?: string): ArtifactIndexPage {
    return this.indexPages.scope(taskId, compositionVersion, cursor)
  }

  pageBatchIndexes(taskId: string, batchId: string, cursor?: string): ArtifactIndexPage {
    return this.indexPages.batch(taskId, batchId, cursor)
  }

  // Navigation grants only the content sources installed on this exact work.
  // The host rechecks this before reading bodies or sending input to a model.
  integrationInputs(attemptId: string): IntegrationInputs {
    return this.db.transaction(() => {
      const qualified = this.work.qualify(attemptId), work = qualified.work
      if (work.purpose !== 'production' || work.role !== 'integrator') fail('RUNNER_OWNERSHIP_INVALID', 'Content integration requires its own current production Integrator')
      this.dependenciesCurrent(work.dependencies)
      const inputs: IntegrationInputs = { task_id: work.task_id, run_id: work.run_id, work_id: work.work_id, attempt_id: attemptId, dependencies: structuredClone(work.dependencies), artifacts: [], results: [], resources: [] }
      const resources = new Set<string>(), artifacts = new Map<string, ArtifactIndex>()
      const resource = (resourceId: string): void => { this.resultReference(work.task_id, { task_id: work.task_id, kind: 'resource', id: resourceId }); resources.add(resourceId) }
      const artifact = (index: ArtifactIndex): void => { this.currentIndex(index); resource(index.bundle_resource_id); artifacts.set(json([index.artifact_id, index.artifact_revision]), index) }
      for (const dependency of work.dependencies) {
        if (dependency.kind === 'artifact') {
          const index = this.artifacts.artifact(work.task_id, dependency.artifact_id, dependency.artifact_revision)
          if (!index) fail('RUNNER_DEPENDENCY_INVALID', 'Integration artifact input is unavailable')
          artifact(index)
        } else if (dependency.kind === 'resource') resource(dependency.resource_id)
        else if (dependency.kind === 'work') {
          const source = this.work.work(dependency.work_id), attempt = source.current_attempt_id ? this.work.attempt(source.current_attempt_id) : null
          if (source.purpose !== 'production' || !attempt || attempt.purpose !== 'production' || attempt.state !== 'succeeded' || !attempt.result_ref) fail('RUNNER_DEPENDENCY_INVALID', 'Integration work input must retain its exact successful result')
          this.resultReference(work.task_id, attempt.result_ref)
          inputs.results.push({ work_id: source.work_id, result_revision: dependency.result_revision, result_ref: structuredClone(attempt.result_ref) })
          if (attempt.result_ref.kind === 'resource') resource(attempt.result_ref.id)
          const output = this.output(work.task_id, source.work_id, source.plan_revision, dependency.result_revision)
          if (output) {
            this.finalWork(output); this.outputArtifacts(output)
            for (const reference of output.artifacts) artifact(this.artifacts.artifact(work.task_id, reference.artifact_id, reference.artifact_revision)!)
          }
        }
      }
      if (!work.dependencies.some(dependency => dependency.kind !== 'goal')) fail('RUNNER_DEPENDENCY_INVALID', 'Content integration requires explicit versioned content inputs')
      inputs.artifacts = [...artifacts.values()]; inputs.resources = [...resources]
      if (Buffer.byteLength(json(inputs)) > RUNNER_LIMITS.index.page_bytes) fail('RUNNER_LIMIT_EXCEEDED', 'Integration source metadata exceeds its bounded input size')
      return inputs
    })()
  }

  installScope(raw: CompositionScope): CompositionScope {
    const scope = validateRunnerContract('runner_composition_scope', JSON.parse(json(raw)))
    return this.db.transaction(() => {
      const previous = this.scope(scope.task_id, scope.composition_version)
      if (previous) {
        if (!equivalent(previous, scope)) fail('RUNNER_SCOPE_CONFLICT', 'An installed composition scope cannot change its bindings')
        return previous
      }
      this.activeTask(scope.task_id)
      if (scope.state !== 'working' || scope.publication_manifest_id !== undefined) fail('RUNNER_SCOPE_CONFLICT', 'Scope storage does not install publication completeness')
      const head = this.scope(scope.task_id)
      if ((scope.previous_version ?? 0) !== (head?.composition_version ?? 0) || scope.composition_version !== (head?.composition_version ?? 0) + 1) fail('RUNNER_SCOPE_CONFLICT', 'Scope must advance its exact current predecessor')
      for (const target of scope.targets) {
        const goal = this.currentGoal({ ...target, task_id: scope.task_id })
        this.requirements(goal, target.requirement_ids)
        if (target.required && goal.requirements.some(item => item.required && !target.requirement_ids.includes(item.requirement_id))) fail('RUNNER_SCOPE_CONFLICT', 'A required scope target must retain its required outcomes')
        const inventory = this.inventory(scope.task_id, target.request_id, target.intent_revision)
        if (target.contribution_inventory !== undefined) {
          if (!inventory || target.contribution_inventory.inventory_revision !== inventory.inventory_revision) fail('RUNNER_SCOPE_CONFLICT', 'A new scope must bind the exact current sealed inventory')
          this.inventoryOutputs(inventory)
        }
      }
      for (const item of scope.unresolved) if (!scope.targets.some(target => target.request_id === item.request_id && target.intent_revision === item.intent_revision && target.requirement_ids.includes(item.requirement_id))) fail('RUNNER_SCOPE_CONFLICT', 'Scope unresolved outcomes must belong to its exact targets')
      this.db.prepare('INSERT INTO runner_scopes(task_id,composition_version,payload_json) VALUES (?,?,?)').run(scope.task_id, scope.composition_version, json(scope))
      return scope
    }).immediate()
  }

  batch(taskId: string, batchId: string): CompositionBatch | null {
    assertRunnerId(taskId, 'task_id'); assertRunnerId(batchId, 'batch_id')
    const row = this.db.prepare('SELECT payload_json FROM runner_batches WHERE task_id=? AND batch_id=?').get(taskId, batchId) as PayloadRow | undefined
    return row ? validateRunnerContract('runner_composition_batch', JSON.parse(row.payload_json)) : null
  }

  private dependenciesCurrent(dependencies: WorkDependency[], visiting = new Set<string>()): void {
    for (const dependency of dependencies) {
      if (dependency.kind === 'goal') this.currentGoal(dependency)
      else if (dependency.kind === 'chapter') {
        if (!new ChapterState(this.db).dependencyCurrent(dependency)) fail('RUNNER_DEPENDENCY_INVALID', 'An actual chapter contribution dependency has changed')
      }
      else if (dependency.kind === 'resource') {
        if (!this.db.prepare('SELECT resource_id FROM task_resources WHERE task_id=? AND resource_id=?').get(dependency.task_id, dependency.resource_id)) fail('RUNNER_DEPENDENCY_INVALID', 'Resource dependency no longer belongs to this Task')
      } else {
        const key = dependency.kind === 'work' ? json(['work', dependency.work_id, dependency.result_revision]) : json(['artifact', dependency.artifact_id, dependency.artifact_revision])
        if (visiting.has(key)) fail('RUNNER_DEPENDENCY_INVALID', 'Contribution dependencies must be acyclic')
        visiting.add(key)
        if (dependency.kind === 'work') {
          const work = this.work.work(dependency.work_id), run = this.work.run(work.run_id)
          if (work.task_id !== dependency.task_id || work.state !== 'succeeded' || work.result_revision !== dependency.result_revision || !this.resultRunCurrent(run, work)) fail('RUNNER_DEPENDENCY_INVALID', 'Work dependency is no longer an eligible exact result')
          if (work.purpose === 'production') this.currentGoal(work)
          this.dependenciesCurrent(work.dependencies, visiting)
        } else {
          const index = this.artifacts.artifact(dependency.task_id, dependency.artifact_id, dependency.artifact_revision)
          if (!index) fail('RUNNER_DEPENDENCY_INVALID', 'Artifact dependency is unavailable')
          this.currentIndex(index, visiting)
        }
        visiting.delete(key)
      }
    }
  }

  private currentIndex(index: ArtifactIndex, visiting = new Set<string>()): ArtifactCandidate {
    this.currentGoal(index)
    const assembly = this.artifacts.checkChapterAssembly(index)
    if (assembly) return assembly
    const owner = this.artifacts.owner(index.task_id, index.artifact_id), work = this.work.work(index.work_id), attempt = this.work.attempt(index.attempt_id), run = this.work.run(index.run_id)
    const row = this.db.prepare('SELECT candidate_id FROM runner_artifacts WHERE task_id=? AND artifact_id=? AND artifact_revision=?').get(index.task_id, index.artifact_id, index.artifact_revision) as { candidate_id: string } | undefined
    const record = row ? this.artifacts.candidate(index.task_id, row.candidate_id) : null
    if (!owner || owner.current_revision !== index.artifact_revision || owner.work_id !== index.work_id || owner.plan_revision !== work.plan_revision || owner.section_id !== index.section_id || work.purpose !== 'production' || attempt.purpose !== 'production' || run.purpose !== 'production' || !sameGoal(index, work) || !sameGoal(index, attempt) || !sameGoal(index, run) || work.run_id !== index.run_id || attempt.work_id !== index.work_id || attempt.run_id !== index.run_id || work.current_attempt_id !== index.attempt_id || !['running', 'waiting', 'succeeded'].includes(work.state) || !['running', 'waiting', 'succeeded'].includes(attempt.state) || !this.resultRunCurrent(run, work, attempt) || !record || record.result.state !== 'accepted' || !equivalent(record.result.index, index) || record.candidate.plan_revision !== work.plan_revision || !sameDependencies(record.candidate.dependencies, work.dependencies) || !sameDependencies(record.candidate.dependencies, attempt.input_versions)) fail('RUNNER_DEPENDENCY_INVALID', 'Artifact is no longer the exact current accepted contribution')
    this.work.checkHandoffs(work, attempt.attempt_id)
    this.dependenciesCurrent(record.candidate.dependencies, visiting)
    return record.candidate
  }

  checkArtifact(taskId: string, artifactId: string, artifactRevision: number): ArtifactIndex {
    const index = this.artifacts.artifact(taskId, artifactId, artifactRevision)
    if (!index) fail('RUNNER_DEPENDENCY_INVALID', 'Artifact dependency is unavailable')
    this.currentIndex(index)
    return index
  }

  private currentBatch(batch: CompositionBatch): ArtifactIndex[] {
    this.activeTask(batch.task_id)
    const scope = this.scope(batch.task_id, batch.composition_version)
    if (!scope) fail('RUNNER_NOT_FOUND', 'Composition scope does not exist')
    distinct(batch.targets.map(target => target.request_id), 'batch targets')
    distinct(batch.sections.map(section => section.section_id), 'batch sections')
    if (!batch.targets.some(target => target.request_id === batch.trigger_request_id)) fail('RUNNER_OWNERSHIP_INVALID', 'Batch trigger must be one of its exact targets')
    for (const target of batch.targets) {
      this.currentGoal(target)
      if (!scope.targets.some(item => item.request_id === target.request_id && item.intent_revision === target.intent_revision)) fail('RUNNER_OWNERSHIP_INVALID', 'Batch target is outside its fixed scope')
    }
    const outline = this.artifacts.outline(batch.task_id)
    for (const position of batch.sections) {
      const section = outline?.sections.find(item => item.section_id === position.section_id)
      if (!section || section.position_revision !== position.position_revision || section.order_key !== position.order_key || !batch.targets.some(target => target.request_id === section.request_id && target.intent_revision === section.intent_revision)) fail('RUNNER_DEPENDENCY_INVALID', 'Batch section position is no longer current')
    }
    const indexes = batch.indexes.map(reference => {
      const index = this.artifacts.artifact(batch.task_id, reference.artifact_id, reference.artifact_revision)
      if (!index || !batch.targets.some(target => sameGoal(target, index)) || !batch.sections.some(section => section.section_id === index.section_id)) fail('RUNNER_DEPENDENCY_INVALID', 'Batch index is outside its fixed targets or sections')
      if (!this.publicationArtifact(index)) fail('RUNNER_DEPENDENCY_INVALID', 'Batch index is not designated for publication')
      this.currentIndex(index)
      return index
    })
    const run = this.db.prepare('SELECT payload_json FROM runner_runs WHERE run_id=?').get(batch.run_id) as PayloadRow | undefined
    if (run) {
      const source = this.work.run(batch.run_id)
      if (source.purpose !== 'composition' || source.task_id !== batch.task_id || source.batch_id !== batch.batch_id || source.composition_version !== batch.composition_version || source.trigger_request_id !== batch.trigger_request_id) fail('RUNNER_OWNERSHIP_INVALID', 'Batch Run belongs to another execution source')
    }
    return indexes
  }

  // Retrieval preserves historical bindings; callers use this recheck before
  // preparing or committing a stored batch against current dependencies.
  checkBatch(taskId: string, batchId: string): CompositionBatch {
    const batch = this.batch(taskId, batchId)
    if (!batch) fail('RUNNER_NOT_FOUND', 'Composition batch does not exist')
    if (['invalidated', 'cancelled', 'failed'].includes(batch.state)) fail('RUNNER_DEPENDENCY_INVALID', 'Composition batch no longer permits work')
    this.currentBatch(batch)
    return batch
  }

  installBatch(raw: CompositionBatch): CompositionBatch {
    const batch = validateRunnerContract('runner_composition_batch', JSON.parse(json(raw)))
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT payload_json FROM runner_batches WHERE batch_id=?').get(batch.batch_id) as PayloadRow | undefined
      if (row) {
        const previous = validateRunnerContract('runner_composition_batch', JSON.parse(row.payload_json))
        if (!equivalent(previous, batch)) fail('RUNNER_BATCH_CONFLICT', 'An installed batch cannot change its fixed read set')
        return previous
      }
      if (!['queued', 'preparing', 'prepared', 'waiting'].includes(batch.state)) fail('RUNNER_BATCH_CONFLICT', 'A new batch must start before publication')
      const indexes = this.currentBatch(batch)
      if (batch.previous_batch_id !== undefined) {
        const previous = this.batch(batch.task_id, batch.previous_batch_id)
        if (!previous || previous.composition_version > batch.composition_version) fail('RUNNER_BATCH_CONFLICT', 'Batch predecessor must belong to the same Task and an equal or earlier scope')
      }
      this.db.prepare('INSERT INTO runner_batches(batch_id,task_id,composition_version,payload_json) VALUES (?,?,?,?)').run(batch.batch_id, batch.task_id, batch.composition_version, json(batch))
      registerRunnerResources(this.db, batch.task_id, 'runner_batch', batch.batch_id, indexes.flatMap(index => [index.bundle_resource_id, ...(index.provenance_ref.kind === 'resource' ? [index.provenance_ref.id] : [])]))
      return batch
    }).immediate()
  }
}

import type Database from 'better-sqlite3'
import type { ArtifactCandidate, ArtifactIndex, ContributionInventory, ExecutionAttempt, ExecutionScope, GoalRevision, LogicalWork, WorkOutputDeclaration } from '../../shared/contracts.generated'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import type { WorkerResultIssue } from '../model/agent'
import type { Completion } from '../model/adapter'
import { canonical } from '../surface-transition'
import { RunnerArtifactState } from './artifact-state'
import { RunnerCompositionState } from './composition-state'
import { validateProducerDraft, validateProducerResult, type ProducerDraft, type ProducerResult } from './production-profile'
import { bindProductionIdentities } from './production-identity'
import { RunnerWorkState } from './work-state'

function fail(code: string, message: string): never { throw new ContractError(code, message) }
type AcceptedProduction = { output: WorkOutputDeclaration; inventory: ContributionInventory | null; indexes: ArtifactIndex[] }
class ProductionAcceptanceFailure extends ContractError {
  constructor(code: string, readonly owner: ExecutionScope, readonly candidate: ArtifactCandidate, readonly resultRecordId: string) { super(code, 'Production fragment failed current-source acceptance') }
}

// Execution, acceptance and publication are separate installations. This adapter
// accepts the exact final producer result while its source still has authority.
export class RunnerHostProduction {
  private readonly work: RunnerWorkState
  private readonly artifacts: RunnerArtifactState
  private readonly composition: RunnerCompositionState
  constructor(private readonly db: Database.Database, epoch: string) {
    this.work = new RunnerWorkState(db, epoch)
    this.artifacts = new RunnerArtifactState(db, this.work)
    this.composition = new RunnerCompositionState(db, this.work, this.artifacts)
  }

  private resultRecord(owner: ExecutionScope): { id: string; value: ProducerResult } {
    const row = this.db.prepare("SELECT id,payload_json FROM records WHERE task_id=? AND kind='worker.result' AND json_extract(payload_json,'$.owner.attempt_id')=? ORDER BY sequence DESC LIMIT 1").get(owner.task_id, owner.attempt_id) as { id: string; payload_json: string } | undefined
    const payload = row ? JSON.parse(row.payload_json) : null
    if (!row || canonical(payload.owner) !== canonical(owner)) fail('RUNNER_RESULT_INVALID', 'Production acceptance requires its exact persisted final result')
    return { id: row!.id, value: payload.value }
  }

  normalize(raw: ProducerDraft, rawOwner: ExecutionScope, response: Completion): ProducerResult {
    return this.db.transaction(() => {
      const owner = validateRunnerContract('runner_execution_scope', rawOwner), { work, goal } = this.work.qualify(owner.attempt_id)
      if (!goal || owner.purpose !== 'production' || work.purpose !== 'production' || work.task_id !== owner.task_id || work.work_id !== owner.work_id || work.run_id !== owner.run_id || work.role !== owner.role || work.request_id !== owner.request_id || work.intent_revision !== owner.intent_revision) fail('RUNNER_OWNERSHIP_INVALID', 'Draft normalization requires its current exact production source')
      const lookup = "SELECT id,payload_json FROM records WHERE task_id=? AND kind='model.response' AND json_extract(payload_json,'$.owner.attempt_id')=?"
      const row = (response.request_link
        ? this.db.prepare(lookup + " AND json_extract(payload_json,'$.request_link.request_id')=? AND json_extract(payload_json,'$.request_link.evidence_event_id')=? ORDER BY sequence DESC LIMIT 1").get(owner.task_id, owner.attempt_id, response.request_link.request_id, response.request_link.evidence_event_id)
        : this.db.prepare(lookup + ' ORDER BY sequence DESC LIMIT 1').get(owner.task_id, owner.attempt_id)) as { id: string; payload_json: string } | undefined
      const evidence = row ? JSON.parse(row.payload_json) : null
      if (!row || canonical(evidence.owner) !== canonical(owner) || evidence.finish !== 'stop' || evidence.message?.content !== response.text || evidence.message?.tool_calls?.length || canonical(evidence.request_link ?? null) !== canonical(response.request_link ?? null)) fail('RUNNER_RESULT_INVALID', 'Draft identities require their original recorded model response')
      const sections = this.artifacts.outline(owner.task_id)?.sections.filter(section => section.request_id === work.request_id && section.intent_revision === work.intent_revision) ?? []
      const source = { owner, work, goal, sections }, draft = validateProducerDraft(raw, source)
      return bindProductionIdentities(this.db, draft, source, row!.id)
    }).immediate()
  }

  private artifactSource(candidate: ArtifactCandidate, work: LogicalWork): ReturnType<RunnerArtifactState['owner']> {
    const previous = this.artifacts.owner(candidate.task_id, candidate.artifact_id)
    if (!previous) {
      if (candidate.base_artifact_revision !== 0) fail('RUNNER_OWNERSHIP_INVALID', 'An update must reference an existing artifact in this Task')
      return null
    }
    const source = this.work.work(previous.work_id)
    if (work.purpose !== 'production' || source.purpose !== 'production' || source.request_id !== work.request_id || source.task_id !== work.task_id || previous.work_id !== work.work_id && source.intent_revision === work.intent_revision) fail('RUNNER_OWNERSHIP_INVALID', 'A result cannot acquire another current work fragment without an installed reassignment')
    if (previous.current_revision !== candidate.base_artifact_revision) fail('RUNNER_ARTIFACT_CONFLICT', 'Artifact accepted baseline is no longer current')
    return previous
  }

  private receipt(owner: ExecutionScope): AcceptedProduction | null {
    const row = this.db.prepare("SELECT payload_json FROM runner_work_outputs WHERE task_id=? AND work_id=? AND json_extract(payload_json,'$.run_id')=? AND json_extract(payload_json,'$.attempt_id')=? ORDER BY rowid LIMIT 1").get(owner.task_id, owner.work_id, owner.run_id, owner.attempt_id) as { payload_json: string } | undefined
    if (!row) return null
    const output = validateRunnerContract('runner_work_output_declaration', JSON.parse(row.payload_json))
    if (owner.purpose !== 'production' || output.request_id !== owner.request_id || output.intent_revision !== owner.intent_revision) fail('RUNNER_OWNERSHIP_INVALID', 'Production receipt does not match its exact source')
    const indexes = output.artifacts.map(reference => this.artifacts.artifact(output.task_id, reference.artifact_id, reference.artifact_revision) ?? fail('RUNNER_RESULT_INVALID', 'Accepted output artifact history is unavailable'))
    const inventory = this.db.prepare("SELECT payload_json FROM runner_contribution_inventories WHERE task_id=? AND request_id=? AND intent_revision=? AND json_extract(payload_json,'$.sealed_by.attempt_id')=? ORDER BY inventory_revision LIMIT 1").get(output.task_id, output.request_id, output.intent_revision, owner.attempt_id) as { payload_json: string } | undefined
    return { output, indexes, inventory: inventory ? validateRunnerContract('runner_contribution_inventory', JSON.parse(inventory.payload_json)) : null }
  }

  private deliveryIssue(result: ProducerResult, owner: ExecutionScope): WorkerResultIssue | null {
    if (result.artifacts.length || result.unresolved.length) return null
    const rows = this.db.prepare(`SELECT a.source_json,json_extract(a.result_json,'$.data.id') AS resource_id
      FROM actions a JOIN task_resources r ON r.task_id=a.task_id AND r.resource_id=json_extract(a.result_json,'$.data.id')
      WHERE a.task_id=? AND a.run_id=? AND a.state='ended' AND a.result='success'
        AND json_extract(a.source_json,'$.type')='worker' AND json_extract(a.source_json,'$.owner.attempt_id')=?
        AND json_extract(a.request_json,'$.type')='resource.create' AND json_extract(a.request_json,'$.content.type')='json'
        AND json_extract(a.request_json,'$.content.value.profile')='managed-v1'
        AND json_extract(a.result_json,'$.operation_id')=a.id AND json_extract(a.result_json,'$.execution')='success'
        AND json_extract(a.result_json,'$.delivery')='delivered' ORDER BY a.rowid`).all(owner.task_id, owner.run_id, owner.attempt_id) as { source_json: string; resource_id: string }[]
    const resources = rows.filter(row => canonical(JSON.parse(row.source_json).owner) === canonical(owner)).map(row => row.resource_id)
    if (!resources.length) return null
    return {
      code: 'RUNNER_DELIVERY_MISSING', path: 'artifacts', value: [], bundle_resource_ids: resources,
      message: 'Created managed-v1 content has not been delivered. Include its ArtifactCandidate entries in artifacts, or mark the unfinished requirements unresolved.'
    }
  }

  preflight(raw: ProducerResult, rawOwner: ExecutionScope, sources: readonly ArtifactCandidate['provenance_ref'][] = []): WorkerResultIssue | null {
    const owner = validateRunnerContract('runner_execution_scope', rawOwner)
    const qualified = this.work.qualify(owner.attempt_id), { work, goal } = qualified
    if (!goal || owner.purpose !== 'production' || work.purpose !== 'production' || work.work_id !== owner.work_id || work.run_id !== owner.run_id || work.task_id !== owner.task_id || work.role !== owner.role || work.request_id !== owner.request_id || work.intent_revision !== owner.intent_revision) fail('RUNNER_OWNERSHIP_INVALID', 'Production preflight requires its current exact work owner')
    const sections = this.artifacts.outline(owner.task_id)?.sections.filter(section => section.request_id === work.request_id && section.intent_revision === work.intent_revision) ?? []
    const result = validateProducerResult(raw, { owner, work, goal, sections })
    const delivery = this.deliveryIssue(result, owner)
    if (delivery) return delivery
    for (const [index, candidate] of result.artifacts.entries()) {
      try { this.artifactSource(candidate, work) }
      catch (error) {
        if (!(error instanceof ContractError)) throw error
        return { code: error.code, path: `artifacts[${index}]`, value: { artifact_id: candidate.artifact_id, base_artifact_revision: candidate.base_artifact_revision }, message: error.message }
      }
      try { this.artifacts.checkProvenance(owner.task_id, candidate.provenance_ref) }
      catch (error) {
        if (!(error instanceof ContractError) || error.code !== 'RUNNER_PROVENANCE_INVALID') throw error
        const available = sources.filter(source => {
          try { this.artifacts.checkProvenance(owner.task_id, source); return true }
          catch (error) { if (error instanceof ContractError && error.code === 'RUNNER_PROVENANCE_INVALID') return false; throw error }
        })
        return { code: error.code, path: `artifacts[${index}].provenance_ref`, value: candidate.provenance_ref, message: error.message, sources: available }
      }
    }
    return null
  }

  // Call again after an enclosing installation transaction has rolled back.
  // Only this adapter's checked failure and its original result record qualify.
  retainFailure(error: unknown): void {
    if (!(error instanceof ProductionAcceptanceFailure)) return
    if (this.db.inTransaction) fail('RUNNER_RESULT_INVALID', 'Rejected production evidence must install after the failed transaction')
    this.db.transaction(() => {
      const owner = validateRunnerContract('runner_execution_scope', error.owner), candidate = validateRunnerContract('runner_artifact_candidate', error.candidate)
      const task = this.db.prepare('SELECT id FROM tasks WHERE id=?').get(owner.task_id), attempt = this.work.attempt(owner.attempt_id)
      const record = this.resultRecord(owner)
      if (!task || attempt.task_id !== owner.task_id || attempt.run_id !== owner.run_id || attempt.work_id !== owner.work_id || record.id !== error.resultRecordId || candidate.task_id !== owner.task_id || candidate.run_id !== owner.run_id || candidate.work_id !== owner.work_id || candidate.attempt_id !== owner.attempt_id || !record.value.artifacts.some(item => canonical(item) === canonical(candidate)) || !/^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)) fail('RUNNER_RESULT_INVALID', 'Rejected production evidence lost its exact Task and result binding')
      const previous = this.artifacts.candidate(candidate.task_id, candidate.candidate_id)
      if (previous) {
        if (canonical(previous.candidate) !== canonical(candidate)) fail('RUNNER_CANDIDATE_CONFLICT', 'Candidate identity retains its original payload')
        return
      }
      this.db.prepare('INSERT INTO runner_candidates(candidate_id,task_id,artifact_id,payload_json,result_json) VALUES (?,?,?,?,?)').run(candidate.candidate_id, candidate.task_id, candidate.artifact_id, JSON.stringify(candidate), JSON.stringify({ state: 'rejected', code: error.code }))
    }).immediate()
  }

  accept(raw: ProducerResult, rawOwner: ExecutionScope, validateResource: (resourceId: string) => void): AcceptedProduction {
    const owner = validateRunnerContract('runner_execution_scope', rawOwner), record = this.resultRecord(owner)
    if (canonical(record.value) !== canonical(raw)) fail('RUNNER_OUTPUT_CONFLICT', 'Production acceptance must retain its exact persisted final result')
    const previous = this.receipt(owner)
    if (previous) return previous
    for (const candidate of raw.artifacts) {
      const prior = this.artifacts.candidate(owner.task_id, candidate.candidate_id)
      if (prior && canonical(prior.candidate) !== canonical(candidate)) fail('RUNNER_CANDIDATE_CONFLICT', 'Candidate identity retains its original payload')
      if (prior?.result.state === 'rejected') fail(prior.result.code, 'Production fragment retains its original rejected outcome')
    }
    try { return this.db.transaction(() => {
      const qualified = this.work.qualify(owner.attempt_id), work = qualified.work
      if (work.purpose !== 'production' || !qualified.goal || work.work_id !== owner.work_id || work.run_id !== owner.run_id || work.task_id !== owner.task_id || work.role !== owner.role) fail('RUNNER_OWNERSHIP_INVALID', 'Production result requires its current exact work owner')
      const sections = this.artifacts.outline(owner.task_id)?.sections.filter(section => section.request_id === work.request_id && section.intent_revision === work.intent_revision) ?? []
      const result = validateProducerResult(raw, { owner, work, goal: qualified.goal, sections })
      const delivery = this.deliveryIssue(result, owner)
      if (delivery) fail(delivery.code, delivery.message)
      const indexes = result.artifacts.map(candidate => {
        try {
        validateResource(candidate.bundle_resource_id)
        const previous = this.artifactSource(candidate, work)
        this.artifacts.assign([{
          task_id: work.task_id, artifact_id: candidate.artifact_id, section_id: candidate.section_id,
          work_id: work.work_id, plan_revision: work.plan_revision, base_artifact_revision: candidate.base_artifact_revision,
          ...(previous ? { previous_owner: { work_id: previous.work_id, plan_revision: previous.plan_revision } } : {})
        }])
        const decision = this.artifacts.decide(candidate, { state: 'accepted' })
        if (decision.state !== 'accepted') fail(decision.code, 'Production fragment failed current-source acceptance')
        return decision.index
        } catch (error) {
          if (!(error instanceof ContractError)) throw error
          throw new ProductionAcceptanceFailure(error.code, owner, candidate, record.id)
        }
      })
      const attempt = this.work.attempt(owner.attempt_id), current = this.work.work(work.work_id)
      if (!attempt.result_ref || current.result_revision === undefined) fail('RUNNER_RESULT_INVALID', 'Production result has no persisted final result')
      const output = this.composition.declareOutputs({
        task_id: current.task_id, request_id: work.request_id, intent_revision: work.intent_revision,
        run_id: current.run_id, work_id: current.work_id, attempt_id: attempt.attempt_id,
        plan_revision: current.plan_revision, result_revision: current.result_revision, result_ref: attempt.result_ref,
        complete: true, artifacts: indexes.map(index => ({ task_id: index.task_id, artifact_id: index.artifact_id, artifact_revision: index.artifact_revision })),
        requirement_ids: result.requirement_ids, unresolved: result.unresolved
      })
      const inventory = this.sealIfReady(current, qualified.goal)
      return { output, inventory, indexes }
    }).immediate() } catch (error) {
      if (!this.db.inTransaction) this.retainFailure(error)
      throw error
    }
  }

  private sealIfReady(work: LogicalWork, goal: GoalRevision): ContributionInventory | null {
    const source = this.composition.source(work.task_id, goal.request_id, goal.intent_revision)
    if (!source) return null
    const planner = this.work.work(source.work_id)
    if (planner.purpose !== 'production' || planner.task_id !== work.task_id || planner.request_id !== goal.request_id || planner.intent_revision !== goal.intent_revision || planner.plan_revision !== source.plan_revision || !['producer', 'router'].includes(planner.role) || !planner.current_attempt_id) return null
    // Other required work may finish last. Reuse the designated source's
    // persisted authority; the completing Integrator never becomes the sealer.
    let attempt: ExecutionAttempt
    try { attempt = this.work.qualify(planner.current_attempt_id).attempt }
    catch (error) { if (error instanceof ContractError) return null; throw error }
    if (!['running', 'waiting', 'succeeded'].includes(attempt.state)) return null
    const required = this.work.taskWorks(work.task_id).filter(item => item.purpose === 'production' && item.request_id === goal.request_id && item.intent_revision === goal.intent_revision && item.required)
    const outputs = required.map(item => item.result_revision === undefined ? null : this.composition.output(item.task_id, item.work_id, item.plan_revision, item.result_revision))
    if (outputs.some(output => output === null)) return null
    const final = outputs as WorkOutputDeclaration[]
    const requirement_ids = [...new Set(final.flatMap(output => output.requirement_ids))]
    const unresolved = [...new Map(final.flatMap(output => output.unresolved).map(item => [item.requirement_id, item])).values()]
    for (const requirement of goal.requirements) if (requirement.required && !requirement_ids.includes(requirement.requirement_id) && !unresolved.some(item => item.requirement_id === requirement.requirement_id)) unresolved.push({ task_id: goal.task_id, request_id: goal.request_id, intent_revision: goal.intent_revision, requirement_id: requirement.requirement_id })
    const previous = this.composition.inventory(work.task_id, goal.request_id, goal.intent_revision)
    if (previous && canonical(previous.required_works) === canonical(final) && canonical(previous.requirement_ids) === canonical(requirement_ids) && canonical(previous.unresolved) === canonical(unresolved)) return previous
    return this.composition.sealInventory({
      task_id: work.task_id, request_id: goal.request_id, intent_revision: goal.intent_revision,
      inventory_revision: (previous?.inventory_revision ?? 0) + 1,
      ...(previous ? { previous_revision: previous.inventory_revision } : {}),
      required_works: final, requirement_ids, unresolved,
      sealed_by: { work_id: planner.work_id, plan_revision: planner.plan_revision, run_id: planner.run_id, attempt_id: attempt.attempt_id, role: planner.role as 'producer' | 'router' }
    })
  }
}

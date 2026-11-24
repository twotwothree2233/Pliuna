import type Database from 'better-sqlite3'
import type { PublicationEntry } from '../../shared/contracts.generated'
import { validateRunnerContract } from '../../shared/runner-validation'
import { ContractError } from '../../shared/validation'
import { validateExportComposition, type FrozenExportComposition } from '../export-composition'
import { RunnerArtifactState } from './artifact-state'
import { RunnerCompositionState } from './composition-state'
import { compositionCompleteness } from './completeness'
import { RunnerPublicationState } from './publication-state'
import { RunnerWorkState } from './work-state'

export interface SelectedPublishedView { id: string; revision: number; bundle_resource_id: string; learning_complete: boolean }
type Payload = { payload_json: string }

// The owning export pins the actual immutable resources separately. This read
// captures only bounded attribution and completeness; it grants no execution.
export function freezeExportComposition(db: Database.Database, epoch: string, taskId: string, selected: SelectedPublishedView[]): FrozenExportComposition | undefined {
  return db.transaction(() => {
    const work = new RunnerWorkState(db, epoch), artifacts = new RunnerArtifactState(db, work), composition = new RunnerCompositionState(db, work, artifacts), publications = new RunnerPublicationState(db)
    const scope = composition.scope(taskId)
    const goals = work.contentPlans(taskId)
    if (!scope && !goals.length) return undefined
    const surface = db.prepare('SELECT id,revision FROM surfaces WHERE task_id=?').get(taskId) as { id: string; revision: number } | undefined
    if (!surface) throw new ContractError('EXPORT_COMPOSITION_INVALID', 'Published Task Surface is unavailable')
    const current = scope ? compositionCompleteness(db, work, composition, publications, taskId, scope.composition_version, surface.id) : { state: 'partial' as const, targets: [], contributions: [], unresolved: [] }
    const pending = goals.filter(goal => !scope?.targets.some(target => target.request_id === goal.request_id && target.intent_revision === goal.intent_revision))
    const targets = [...current.targets], unresolved = [...current.unresolved]
    for (const goal of pending) {
      const reference = { task_id: taskId, request_id: goal.request_id, intent_revision: goal.intent_revision }
      const prior = targets.findIndex(target => target.request_id === goal.request_id)
      if (prior === -1) targets.push(reference)
      else targets[prior] = reference
      for (let position = unresolved.length - 1; position >= 0; position--) if (unresolved[position]!.request_id === goal.request_id) unresolved.splice(position, 1)
      for (const requirement of goal.requirements.filter(requirement => requirement.required)) unresolved.push({ ...reference, requirement_id: requirement.requirement_id })
    }
    const selectedEntries: PublicationEntry[] = []
    for (const view of selected) {
      const row = db.prepare('SELECT payload_json FROM runner_view_mappings WHERE task_id=? AND view_id=? AND view_revision=? AND published_bundle_resource_id=? ORDER BY rowid DESC LIMIT 1').get(taskId, view.id, view.revision, view.bundle_resource_id) as Payload | undefined
      const entry = row ? validateRunnerContract('runner_publication_entry', JSON.parse(row.payload_json)) : undefined
      if (!entry) continue
      if (entry.task_id !== taskId || entry.view_id !== view.id || entry.view_revision !== view.revision || entry.published_bundle_resource_id !== view.bundle_resource_id) throw new ContractError('EXPORT_COMPOSITION_INVALID', 'Selected publication binding is inconsistent')
      const history = publications.history(taskId, entry.surface_history_id)
      if (!history || history.surface_id !== surface.id || !history.views.some(saved => saved.view_id === view.id && saved.view_revision === view.revision)) throw new ContractError('EXPORT_COMPOSITION_INVALID', 'Selected publication history is inconsistent')
      selectedEntries.push(entry)
    }
    const omitted = current.contributions.filter(entry => !selected.some(view => view.id === entry.view_id && view.revision === entry.view_revision && view.bundle_resource_id === entry.published_bundle_resource_id && view.learning_complete)).map(entry => ({ task_id: taskId, artifact_id: entry.artifact_id, artifact_revision: entry.artifact_revision }))
    const manifestRow = scope ? db.prepare('SELECT payload_json FROM runner_manifests WHERE task_id=? AND composition_version=? ORDER BY rowid DESC LIMIT 1').get(taskId, scope.composition_version) as Payload | undefined : undefined
    const result: FrozenExportComposition = { version: 1, task_id: taskId, surface_id: surface.id, surface_revision: surface.revision, scope, manifest: manifestRow ? validateRunnerContract('runner_publication_manifest', JSON.parse(manifestRow.payload_json)) : null, state: current.state === 'complete' && !pending.length && !omitted.length ? 'complete' : 'partial', scope_pending: !scope || pending.length > 0, targets, publications: selectedEntries, unresolved, omitted }
    validateExportComposition(result, taskId)
    return result
  })()
}

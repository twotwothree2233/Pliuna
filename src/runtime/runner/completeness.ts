import type Database from 'better-sqlite3'
import type { PublicationEntry, PublicationManifest } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import type { RunnerWorkState } from './work-state'
import type { RunnerCompositionState } from './composition-state'
import type { RunnerPublicationState } from './publication-state'

export type CompositionCompleteness = Pick<PublicationManifest, 'state' | 'targets' | 'contributions' | 'unresolved'>

// This projection reads the whole fixed scope. The current batch is only one
// source of delivery evidence; it never defines the necessary contribution set.
export function compositionCompleteness(db: Database.Database, work: RunnerWorkState, composition: RunnerCompositionState, publications: RunnerPublicationState, taskId: string, version: number, surfaceId: string, pending: PublicationEntry[] = []): CompositionCompleteness {
  const scope = composition.scope(taskId, version)
  if (!scope) throw new ContractError('RUNNER_NOT_FOUND', 'Composition scope is unavailable')
  const targets = scope.targets.map(target => ({ task_id: taskId, request_id: target.request_id, intent_revision: target.intent_revision }))
  const unresolved = [...scope.unresolved], contributions: PublicationEntry[] = pending.filter(entry => scope.targets.some(target => target.request_id === entry.request_id && target.intent_revision === entry.intent_revision))
  let valid = composition.scope(taskId)?.composition_version === version
  const missing = (target: typeof scope.targets[number], ids = target.requirement_ids): void => {
    valid = false
    for (const requirement_id of ids) if (!unresolved.some(item => item.request_id === target.request_id && item.intent_revision === target.intent_revision && item.requirement_id === requirement_id)) unresolved.push({ task_id: taskId, request_id: target.request_id, intent_revision: target.intent_revision, requirement_id })
  }
  const surface = db.prepare('SELECT layout_json FROM surfaces WHERE task_id=? AND id=?').get(taskId, surfaceId) as { layout_json: string } | undefined
  const visible = new Set<string>(surface ? (JSON.parse(surface.layout_json).slots as { groups: { views: string[] }[] }[]).flatMap(slot => slot.groups.flatMap(group => group.views)) : [])
  if (!surface) valid = false
  for (const target of scope.targets) {
    if (!target.required) continue
    try {
      const goal = work.goal(target.request_id)
      if (goal.task_id !== taskId || goal.intent_revision !== target.intent_revision || goal.state !== 'active' || !target.contribution_inventory) { missing(target); continue }
      const inventory = composition.checkInventory(taskId, target.request_id, target.intent_revision, target.contribution_inventory.inventory_revision)
      if (inventory.unresolved.length) { missing(target, inventory.unresolved.map(item => item.requirement_id)); continue }
      for (const requirement of goal.requirements.filter(item => item.required)) {
        if (!target.requirement_ids.includes(requirement.requirement_id) || !inventory.requirement_ids.includes(requirement.requirement_id) || !inventory.required_works.some(output => output.requirement_ids.includes(requirement.requirement_id) && (requirement.kind !== 'artifact' || output.artifacts.length > 0))) missing(target, [requirement.requirement_id])
      }
      for (const output of inventory.required_works) {
        if (output.unresolved.length) missing(target, output.unresolved.map(item => item.requirement_id))
        for (const artifact of output.artifacts) {
          const entry = pending.find(item => item.artifact_id === artifact.artifact_id && item.artifact_revision === artifact.artifact_revision)
            ?? publications.mapping(taskId, artifact.artifact_id, artifact.artifact_revision)
          const view = entry ? db.prepare('SELECT revision,bundle_resource_id FROM views WHERE id=? AND surface_id=?').get(entry.view_id, surfaceId) as { revision: number; bundle_resource_id: string } | undefined : undefined
          const pendingEntry = entry && pending.includes(entry)
          if (!entry || entry.request_id !== target.request_id || entry.intent_revision !== target.intent_revision || !view || view.revision !== entry.view_revision || view.bundle_resource_id !== entry.published_bundle_resource_id || !visible.has(entry.view_id) || !pendingEntry && !publications.history(taskId, entry.surface_history_id)) { missing(target, output.requirement_ids); continue }
          if (!contributions.some(item => item.artifact_id === entry.artifact_id)) contributions.push(entry)
        }
      }
    } catch (error) {
      if (!(error instanceof ContractError)) throw error
      missing(target)
    }
  }
  if (unresolved.length) valid = false
  contributions.sort((left, right) => left.artifact_id.localeCompare(right.artifact_id))
  return { state: valid ? 'complete' : 'partial', targets, contributions, unresolved }
}

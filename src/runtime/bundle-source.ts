import type Database from 'better-sqlite3'
import type { Bundle } from '../shared/contracts.generated'
import { ContractError, validateBundle } from '../shared/validation'
import { resourceBody } from './resources'
import defaults from '../shared/contracts/development-defaults.json'
import { checkExportFragments } from './export-fragments'
import { isBundleMediaType } from '../shared/branding'

export interface BundleSource { id: string; storage_key: string; sha256: string; byte_length: number; media_type: string; display_name: string; created_at: string }
export function loadBundleSource(db: Database.Database, root: string, task: string, input: { type: 'inline'; bundle: Bundle } | { type: 'resource'; resource: { kind: string; id: string; expected_revision?: number } }, assertResource: (resource: BundleSource) => void): { bundle: Bundle; source?: BundleSource } {
  if (input.type === 'inline') { checkExportFragments(input.bundle); return { bundle: input.bundle } }
  if (input.resource.kind !== 'resource' || input.resource.expected_revision !== undefined) throw new ContractError('INVALID_BUNDLE_SOURCE', 'Bundle input requires an immutable same-task resource')
  const source = db.prepare('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(task, input.resource.id) as BundleSource | undefined
  if (!source) throw new ContractError('RESOURCE_MISSING', 'Bundle source unavailable in this task')
  if ((source.media_type !== 'application/json' && !isBundleMediaType(source.media_type)) || source.byte_length > defaults.surface.inline_bundle_bytes) throw new ContractError('INVALID_BUNDLE_SOURCE', 'Bundle source must be bounded JSON; resource references do not increase bundle capacity')
  assertResource(source)
  const body = resourceBody(root, source)
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { throw new ContractError('INVALID_BUNDLE_SOURCE', 'Bundle source is not valid UTF-8 JSON') }
  const bundle = validateBundle(value)
  checkExportFragments(bundle)
  return { bundle, source }
}

export function checkPersonalBindings(db: Database.Database, task: string, bundle: Bundle, publishing = false): void {
  for (const fragment of bundle.export) {
    const personal = ['answer', 'feedback', 'mixed_personal'].includes(fragment.category), binding = fragment.personal_binding
    if (binding && !personal) throw new ContractError('PERSONAL_BINDING_INVALID', 'Only personal fragments may bind an answer')
    if (!binding) {
      if (publishing && personal) throw new ContractError('PERSONAL_BINDING_REQUIRED', 'New personal fragments require an exact answer and original question history')
      continue
    }
    if (!db.prepare('SELECT 1 FROM answers a JOIN view_history h ON h.id=a.view_history_id AND h.task_id=a.task_id WHERE a.task_id=? AND a.id=? AND h.id=?').get(task, binding.answer_id, binding.view_history_id)) throw new ContractError('PERSONAL_BINDING_INVALID', 'Answer and original question history do not match within this task')
  }
}

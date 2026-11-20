import type { CompositionScope, PublicationEntry, PublicationManifest } from '../shared/contracts.generated'
import { validateRunnerContract } from '../shared/runner-validation'
import { ContractError } from '../shared/validation'
import { assertRunnerId } from './runner/limits'

export const EXPORT_COMPOSITION_BYTES = 256 * 1024
export interface FrozenExportComposition {
  version: 1
  task_id: string
  surface_id: string
  surface_revision: number
  scope: CompositionScope | null
  manifest: PublicationManifest | null
  state: 'partial' | 'complete'
  scope_pending: boolean
  targets: PublicationManifest['targets']
  publications: PublicationEntry[]
  unresolved: PublicationManifest['unresolved']
  omitted: { task_id: string; artifact_id: string; artifact_revision: number }[]
}
const fail = (): never => { throw new ContractError('EXPORT_COMPOSITION_INVALID', 'Frozen composition metadata is inconsistent') }
const keys = (value: unknown, expected: string): boolean => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected
const revision = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0

export function validateExportComposition(value: FrozenExportComposition, taskId?: string): void {
  if (!keys(value, 'manifest,omitted,publications,scope,scope_pending,state,surface_id,surface_revision,targets,task_id,unresolved,version') || value.version !== 1 || !revision(value.surface_revision) || !['partial', 'complete'].includes(value.state) || typeof value.scope_pending !== 'boolean') fail()
  assertRunnerId(value.task_id); assertRunnerId(value.surface_id)
  if (taskId !== undefined && value.task_id !== taskId) fail()
  if (Buffer.byteLength(JSON.stringify(value)) > EXPORT_COMPOSITION_BYTES) throw new ContractError('EXPORT_COMPOSITION_LIMIT', 'Frozen composition metadata exceeds the enabled 256 KiB limit')
  if (value.scope !== null) {
    validateRunnerContract('runner_composition_scope', value.scope)
    if (value.scope.task_id !== value.task_id) fail()
  }
  if (value.manifest !== null) {
    validateRunnerContract('runner_publication_manifest', value.manifest)
    if (!value.scope || value.manifest.task_id !== value.task_id || value.manifest.composition_version !== value.scope.composition_version || value.manifest.surface_id !== value.surface_id || value.manifest.surface_revision > value.surface_revision) fail()
  }
  if (!Array.isArray(value.targets) || !Array.isArray(value.publications) || !Array.isArray(value.unresolved) || !Array.isArray(value.omitted)) fail()
  const targetIds = new Set<string>(), artifactIds = new Set<string>(), missingIds = new Set<string>(), omittedIds = new Set<string>()
  for (const target of value.targets) {
    if (!keys(target, 'intent_revision,request_id,task_id') || target.task_id !== value.task_id || !revision(target.intent_revision)) fail()
    assertRunnerId(target.request_id)
    if (targetIds.has(target.request_id)) fail()
    targetIds.add(target.request_id)
  }
  for (const entry of value.publications) {
    validateRunnerContract('runner_publication_entry', entry)
    if (entry.task_id !== value.task_id || artifactIds.has(entry.artifact_id)) fail()
    artifactIds.add(entry.artifact_id)
  }
  for (const missing of value.unresolved) {
    if (!keys(missing, 'intent_revision,request_id,requirement_id,task_id') || missing.task_id !== value.task_id || !revision(missing.intent_revision) || !value.targets.some(target => target.request_id === missing.request_id && target.intent_revision === missing.intent_revision)) fail()
    assertRunnerId(missing.request_id); assertRunnerId(missing.requirement_id)
    const identity = JSON.stringify([missing.request_id, missing.intent_revision, missing.requirement_id])
    if (missingIds.has(identity)) fail()
    missingIds.add(identity)
  }
  for (const omitted of value.omitted) {
    if (!keys(omitted, 'artifact_id,artifact_revision,task_id') || omitted.task_id !== value.task_id || !revision(omitted.artifact_revision)) fail()
    assertRunnerId(omitted.artifact_id)
    if (omittedIds.has(omitted.artifact_id)) fail()
    omittedIds.add(omitted.artifact_id)
  }
  if (value.state === 'complete' && (!value.scope || value.scope_pending || value.unresolved.length || value.omitted.length)) fail()
}

export function exportCompositionSummary(value: FrozenExportComposition) {
  return { composition_version: value.scope?.composition_version ?? null, surface_revision: value.surface_revision, state: value.state, scope_pending: value.scope_pending, target_count: value.targets.length, published_count: value.publications.length, unresolved_count: value.unresolved.length, omitted_count: value.omitted.length }
}

export function exportCompositionIssue(value?: FrozenExportComposition): string[] { return value?.state === 'partial' ? ['RUNNER_COMPOSITION_PARTIAL'] : [] }

export function withExportComposition(html: string, value: FrozenExportComposition): string {
  validateExportComposition(value)
  const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const missing = value.unresolved.map(item => `<li>目标 ${escape(item.request_id)} · 修订 ${item.intent_revision} · 缺项 ${escape(item.requirement_id)}</li>`).join('')
  const omitted = value.omitted.map(item => `<li>本次未完整选择片段 ${escape(item.artifact_id)} · 版本 ${item.artifact_revision}</li>`).join('')
  const notice = `<aside><h2>${value.state === 'complete' ? '完整工作版' : '部分导出 · 成稿尚有缺项'}</h2><p>范围版本 ${value.scope?.composition_version ?? '尚未建立'} · 已发布界面版本 ${value.surface_revision}。导出保留所选版本，不生成缺失内容。</p>${value.scope_pending ? '<p>当前目标尚未全部纳入有效成稿范围。</p>' : ''}<ul>${missing}${omitted}</ul><details><summary>冻结发布清单与完整性</summary><pre>${escape(JSON.stringify(value, null, 2))}</pre></details></aside>`
  const result = html.replace('</body></html>', `${notice}</body></html>`)
  if (result === html) throw new ContractError('EXPORT_GENERATION_FAILED', 'Offline generation did not return a complete document')
  if (Buffer.byteLength(result) > 16 * 1024 * 1024) throw new ContractError('EXPORT_SIZE_LIMIT', 'Enabled export size limit is 16 MiB; reduce the selection')
  return result
}

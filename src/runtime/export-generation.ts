import type { Bundle } from '../shared/contracts.generated'
import type { ExportResource } from './export-control'
import { resourceBody } from './resources'
import { imageBodyUrl } from './view-resources'
import { staticDocument, type ExportIssue } from './static-export'
import { ContractError } from '../shared/validation'
import { isBundleMediaType } from '../shared/branding'

export interface ExportInput {
  root: string; title: string; resources: ExportResource[]; views: { bundle_id: string; resource_ids: string[]; fragment_ids?: string[] }[];
  answers: { bundle_id: string; resource_ids: string[]; value: unknown; label: string }[]
}
export interface ExportResult { html: string; issues: string[] }
export interface ExportGeneration { result: Promise<ExportResult>; stop(): Promise<void> }
export type ExportRunner = (input: ExportInput) => ExportGeneration
export function generateExport(input: ExportInput, diagnose?: (issue: ExportIssue) => void): ExportResult {
  return generateExportBody(input, r => resourceBody(input.root, r as any), diagnose)
}
export function generateExportBody(input: Omit<ExportInput, 'root'>, body: (resource: ExportResource) => Buffer, diagnose?: (issue: ExportIssue) => void): ExportResult {
  const resources = new Map(input.resources.map(r => [r.id, r]))
  const load = (id: string, allowed: string[]) => {
    const r = resources.get(id)
    if (!r || r.byte_length > 262144 || !isBundleMediaType(r.media_type)) throw new ContractError('EXPORT_HISTORY_INVALID', 'Invalid fixed bundle')
    const bundle = JSON.parse(body(r).toString()) as Bundle
    if (new Set(bundle.references.map(r => r.name)).size !== bundle.references.length || bundle.references.some(ref => ref.target.kind !== 'resource' || ref.target.expected_revision !== undefined || !allowed.includes(ref.target.id) || !resources.has(ref.target.id))) throw new ContractError('EXPORT_HISTORY_INVALID', 'Direct resources are not frozen in this historical version')
    const resolve = (name: string) => {
      const ref = bundle.references.find(ref => ref.name === name), resource = ref && resources.get(ref.target.id)
      if (!resource || !allowed.includes(resource.id) || ref!.target.kind !== 'resource' || ref!.target.expected_revision !== undefined) throw new ContractError('EXPORT_HISTORY_INVALID', 'Resource is not in the fixed snapshot')
      if (!['image/png', 'image/jpeg'].includes(resource.media_type) || resource.byte_length > 4 * 1024 * 1024) throw new ContractError('UNSUPPORTED_IMAGE', 'Only bounded PNG/JPEG images are enabled')
      return imageBodyUrl(resource, body(resource))
    }
    return { bundle, resolve }
  }
  const result = staticDocument(input.title, input.views.map(v => ({ ...load(v.bundle_id, v.resource_ids), fragment_ids: v.fragment_ids })), input.answers.map(a => ({ value: a.value, label: a.label, question: load(a.bundle_id, a.resource_ids) })), 'export', diagnose)
  return { html: result.html, issues: result.issues }
}

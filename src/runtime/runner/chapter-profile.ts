import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ChapterProposal, ChapterRegion, ChapterUpdate, ExecutionScope } from '../../shared/contracts.generated'
import { sameDependencies, validateRunnerContract } from '../../shared/runner-validation'
import { ContractError, validateModel } from '../../shared/validation'
import { createWorkerProfile, type WorkerGrant, type WorkerProfile } from './worker-profile'
import { validateProducerBundle } from './production-profile'

export function createChapterProfile(rawUpdate: ChapterUpdate, rawOwner: ExecutionScope, grants: readonly WorkerGrant[] = [], checkCandidate?: (proposal: ChapterProposal) => void, templateChapters?: readonly ChapterRegion[]): WorkerProfile<ChapterProposal> {
  const update = structuredClone(validateRunnerContract('runner_chapter_update', rawUpdate)), owner = structuredClone(validateRunnerContract('runner_execution_scope', rawOwner))
  if (owner.task_id !== update.task_id || owner.role !== 'producer' || owner.purpose !== 'production' || owner.update_id !== update.update_id || owner.request_id !== update.request_id || owner.intent_revision !== update.intent_revision || update.source && !isDeepStrictEqual(owner, update.source)) throw new ContractError('RUNNER_OWNERSHIP_INVALID', 'Chapter producer requires its exact local authority')
  if (grants.some(grant => grant.type === 'write')) throw new ContractError('INVALID_WORKER_PROFILE', 'Supplemental chapter grants cannot add mutations')
  const binding = { task_id: update.task_id, update_id: update.update_id, intent_revision: update.intent_revision, source: owner, dependencies: update.dependencies }
  const chapters = update.base_manifest.chapters.filter(chapter => update.region_ids.includes(chapter.region_id)).map(({ region_id, revision, title, dependencies, ownership }) => ({ region_id, revision, title, dependencies, ownership }))
  const replacements = templateChapters && structuredClone(templateChapters).map(chapter => ({ previous_region_ids: [chapter.region_id], chapters: [validateRunnerContract('runner_chapter_region', chapter)] }))
  if (replacements && (replacements.length !== update.region_ids.length || new Set(replacements.map(group => group.previous_region_ids[0])).size !== update.region_ids.length || replacements.some(group => !update.region_ids.includes(group.previous_region_ids[0]!) || group.chapters[0]!.revision !== update.base_manifest.chapters.find(chapter => chapter.region_id === group.previous_region_ids[0])!.revision + 1 || !sameDependencies(group.chapters[0]!.dependencies, update.dependencies)))) throw new ContractError('INVALID_WORKER_PROFILE', 'Chapter template must match its exact authorized replacement group')
  let candidateError: string | undefined
  const base = createWorkerProfile<ChapterProposal>({
    id: 'chapter-producer-v1', role: 'producer',
    system: `Continue the Task conversation and fulfill the latest requested chapter update.
Modify only the bound chapter group and its owned metadata; preserve shared state and use only explicitly supplied dependencies.
Create a managed-v1 JSON bundle with resource.create using content:{type:"json",value:bundle}. Only reference real resources. Never publish the Surface or claim publication.
${replacements ? 'Edit chapter_template while preserving its shared CSS/state and declared boundaries. Return only JSON {"bundle_resource_id":"actual returned resource id"}; the bound replacements apply by default. If changing titles, boundaries, ownership or splitting/merging, include complete replacements with bound dependencies; new identities start at revision 1.' : 'Return only JSON {"bundle_resource_id":"actual returned resource id","replacements":[{"previous_region_ids":["bound region id"],"chapters":[ChapterRegion]}]}. Each ChapterRegion requires region_id,revision,title,title_selector,body_selector,dependencies,ownership:{form_ids,behavior_ids,reference_ids,export_ids,css_selectors}. Copy bound dependencies; retain identity with revision+1 for one-to-one changes, or use new identities at revision 1 for splits/merges. Each complete body uses one div/section/article/main immediately after its heading, both addressed by unique letter-starting ASCII #id selectors.'}
Bound data: ${JSON.stringify({ ...binding, ...(replacements ? { replacements } : { chapters }) })}`,
    grants: [{ type: 'list', kind: 'object_type' }, { type: 'read', kind: 'object_type' }, { type: 'write', operation: 'resource.create' }, ...grants],
    resultCorrection: 'Return the exact chapter result JSON with a real created bundle and the complete authorized replacement group. Check its declared boundaries and ownership. Reuse valid resources; create corrected content when a candidate is invalid.',
    parseResult(response) {
      candidateError = undefined
      let proposal: ChapterProposal
      try {
        if (response.finish !== 'stop' || response.calls.length || !response.text.trim()) throw Error()
        const raw = JSON.parse(response.text)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['bundle_resource_id', 'replacements'].includes(key))) throw Error()
        proposal = validateRunnerContract('runner_chapter_proposal', { ...(replacements ? { replacements: structuredClone(replacements) } : {}), ...raw, ...structuredClone(binding), proposal_id: randomUUID() })
        const replaced = proposal.replacements.flatMap(group => group.previous_region_ids)
        if (replaced.length !== update.region_ids.length || update.region_ids.some(id => !replaced.includes(id)) || proposal.replacements.some(group => group.chapters.some(chapter => !sameDependencies(chapter.dependencies, update.dependencies)))) throw Error()
      } catch { throw new ContractError('INVALID_WORKER_RESULT', 'Chapter result must cover its exact authorized replacement group') }
      // Check the exact immutable candidate before ending production. Only
      // candidate errors are correctable; provenance and current authority fail.
      if (checkCandidate) {
        try { checkCandidate(proposal) }
        catch (error) {
          if (!(error instanceof ContractError) || !['CHAPTER_MAPPING_INVALID', 'CHAPTER_OWNERSHIP_INVALID', 'CHAPTER_STYLE_INVALID', 'CHAPTER_STYLE_SCOPE', 'CHAPTER_SHARED_CONFLICT', 'CHAPTER_REPLACEMENT_INVALID', 'BUNDLE_SIZE_LIMIT'].includes(error.code)) throw error
          candidateError = `${error.code}: ${error.message}`
          throw new ContractError('INVALID_WORKER_RESULT', 'The created chapter candidate does not satisfy its authorized replacement contract')
        }
      }
      candidateError = undefined
      return proposal
    }
  })
  return Object.freeze({ ...base, get resultCorrection() { return base.resultCorrection + (candidateError ? `\nCandidate check: ${candidateError}` : '') }, authorize(raw: unknown): void {
    base.authorize(raw)
    const request = validateModel(raw)
    if (request.type === 'write' && request.input.type === 'resource.create' && request.input.content.type === 'json') {
      const value = request.input.content.value
      if (value && typeof value === 'object' && !Array.isArray(value) && value.profile === 'managed-v1') validateProducerBundle(value)
    }
  } })
}

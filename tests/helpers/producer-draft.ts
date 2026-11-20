import type { ArtifactCandidate } from '../../src/shared/contracts.generated'
import type { ArtifactDraft, ProducerDraft, ProducerResult } from '../../src/runtime/runner/production-profile'

// Existing fixtures still describe formal history. Model responses use drafts.
export function artifactDraft(candidate: ArtifactCandidate): ArtifactDraft {
  const { artifact_id, candidate_id: _candidate, base_artifact_revision, task_id: _task, request_id: _request, intent_revision: _intent, run_id: _run, work_id: _work, attempt_id: _attempt, plan_revision: _plan, dependencies: _dependencies, section_position_revision: _position, order_key: _order, ...body } = candidate
  return { ...body, ...(base_artifact_revision === 0 ? { output_key: artifact_id } : { artifact_id, base_artifact_revision }) }
}
export function producerDraft(result: ProducerResult): ProducerDraft {
  return { ...result, artifacts: result.artifacts.map(artifactDraft) }
}

import type { Bundle, DeliveryRecord, ExecutionScope, IpcRequest, HostModelRequest, HostPluginRequest, RunnerRun } from './contracts.generated'
export type { ArtifactCandidate, ArtifactIndex, ChapterDependency, ChapterInheritance, ChapterIntent, ChapterManifest, ChapterOwnership, ChapterProposal, ChapterPublication, ChapterRegion, ChapterReplacement, ChapterUpdate, CompositionBatch, CompositionScope, ConsumptionStage, ContentLineage, ContentNode, ContentOperation, ContentOperationPlan, ContentTree, ContributionInventory, ContributionInventoryRef, DeliveryQuery, DeliveryRecord, ExecutionAttempt, ExecutionScope, ContentPlan, InputEvent, LogicalWork, Outline, OutlineSection, OutcomeRequirement, PresentationPlan, PublicationEntry, PublicationManifest, RunnerRun, WorkDependency, WorkOutputDeclaration } from './contracts.generated'
export interface Task { id: string; title: string; state: 'active' | 'stopping' | 'stopped' | 'deleting'; revision: number }
export type TaskDirectoryPhase = 'ready' | 'review' | 'running'
export interface TaskListItem extends Task { archived: boolean; pinned: boolean; archived_at: number | null; phase: TaskDirectoryPhase; last_activity_at: string | null }
export interface View { id: string; revision: number; state_revision: number; draft: Record<string, unknown>; bundle: Bundle; presentation: { html: string; css: string; error?: { code: string; message: string } }; chapter_manifest?: import('./contracts.generated').ChapterManifest; chapter_updates?: import('./contracts.generated').ChapterUpdate[] }
export interface Run { id: string; state: string; primary_reason: string | null; wait_reason?: string; budget_json?: string; source?: RunnerRun; message_id?: string | null }
export interface RecordEntry { id: string; kind: string; payload: Record<string, unknown>; created_at: string; owner?: ExecutionScope; delivery?: DeliveryRecord }
export interface LatestMessages { request: Pick<RecordEntry, 'id' | 'kind' | 'created_at'> | null; reply: Pick<RecordEntry, 'id' | 'kind' | 'created_at'> | null }
export interface TaskMessage {
  id: string; sequence: number; created_at: string; role: 'user' | 'assistant'; kind: string
  text: string; truncated: boolean; request_id: string | null; run_id: string | null; reply_to: string | null
  execution?: Run
  request_state?: MessageRequestState
}
export interface MessageRequestState { id: string; state: string; code: string | null }
export interface TaskMessagePage {
  items: TaskMessage[]; older_cursor: string | null; update_cursor: string; more_updates: boolean
}
export interface TaskMessageText { text: string; next_cursor: string | null }
export type HostMessageRequest =
  | { type: 'host.messages.page'; task_id: string; before?: string; after?: string }
  | { type: 'host.messages.read'; task_id: string; message_id: string; cursor?: string }
export interface RunnerFinalAnswer {
  id: string; kind: 'runner.answer'; created_at: string; purpose: 'final_answer'
  request_id: string; intent_revision: number; input_event_id: string; run_id: string
}
export interface RunnerGoalProjection {
  request_id: string; intent_revision: number; input_event_id: string; title: string; state: 'active' | 'withdrawn'
  run: Run | null
  waits: { reason: string; run_id?: string; work_id?: string; approval_id?: string; batch_id?: string; operation_id?: string }[]
  delivery: 'pending' | 'accepted' | 'published' | 'pending_update' | 'incomplete'
  artifact_count?: number
  unresolved_count: number
  request: LatestMessages['request']; reply: RunnerFinalAnswer | null
}
export interface RunnerScopeProjection {
  composition_version: number; state: 'working' | 'partial' | 'complete'
  required_content_count: number; unresolved_count: number; pending_update_count: number; published_count: number
}
export interface RunnerProjection {
  goals: RunnerGoalProjection[]; next_cursor: string | null; scope: RunnerScopeProjection | null
}
export interface RunActivity {
  request: string | null
  items: { id: string; type: 'tool' | 'reply'; name: string; operation: string | null; target_kind: string | null; target_id: string | null; label: string | null; execution: string | null; delivery: string | null; error: string | null }[]
}
export interface RunnerFlowScope { run_id: string }
export interface RunnerFlowOption extends RunnerFlowScope { state: string; at: string | null; input: string | null }
export type RunnerFlowRole = 'Router' | 'Worker' | 'Collator' | 'Host'
export interface RunnerFlowEvidence {
  id: string; kind: 'work' | 'accepted' | 'indexes' | 'plan'; state: string; at: string | null
  from?: RunnerFlowRole; to?: RunnerFlowRole; work_id?: string; role?: string; attempt?: number
  batch_id?: string; shared?: boolean; count?: number; work_ids?: string[]
  ref?: { kind: 'event' | 'resource' | 'action' | 'run'; id: string }
}
export interface RunnerFlowPage {
  task_id: string; scope: RunnerFlowScope; through_sequence: number; work_count: number
  items: RunnerFlowEvidence[]; next_cursor: string | null; graph?: RunnerFlowEvidence[]
}
export interface RunnerFlowOptions { task_id: string; options: RunnerFlowOption[]; next_cursor: string | null }
export interface RunUsageSummary {
  task_id: string; run_id: string; through_sequence: number
  dispatched_requests: number; reported_requests: number; cache_reported_requests: number
  input_tokens: number; output_tokens: number; cached_input_tokens: number
  cache_hit_ratio: number | null
}
export interface Snapshot {
  runner?: RunnerProjection
  message_requests?: MessageRequestState[]
  runtime_epoch: string; task: Task; surface: { id: string; revision: number; layout?: { slots: { id: string; groups: { id: string; type: string; views: string[]; gap?: string; align?: string; column_weights?: number[] }[] }[] } }; views: View[];
  view_page?: { offset: number; limit: number; total: number };
  task_data: { items: { id: string; revision: number }[]; total: number };
  approvals: { id: string; action_id: string; run_id: string | null; message_ids?: string[]; decision: string; validity: string; handling: string; mode: string; expires_at: string; summary?: { type: string; target?: string; operations?: string[] }; request: unknown; request_truncated?: boolean; evaluation: unknown; result: string | null }[];
  approval_total?: number; record_total?: number;
  answer_total: number;
  runs: Run[]; records: RecordEntry[]; answers: { id: string; raw: unknown; value: unknown; truncated?: boolean; created_at: string }[]
  surface_updates: { action_id: string; run_id: string | null; request: unknown; request_truncated?: boolean; reset_requires_confirmation: boolean; expires_at: string }[]
}
export type ExportRequest = { type: 'export.catalog'; task_id: string; offset: number; expected_revision: number } | { type: 'export.check'; task_id: string; answer_ids: string[]; view_ids?: string[]; expected_revision?: number; fragment_selection?: { view_id: string; fragment_ids: string[] }[]; offset?: number } | { type: 'export.check.start'; task_id: string; answer_ids: string[]; view_ids?: string[]; expected_revision?: number; fragment_selection?: { view_id: string; fragment_ids: string[] }[] } | { type: 'export.check.status'; task_id: string; check_id: string; offset?: number } | { type: 'export.check.cancel'; task_id: string; check_id: string } | { type: 'export.prepare'; task_id: string; answer_ids: string[]; view_ids?: string[]; expected_revision?: number; fragment_selection?: { view_id: string; fragment_ids: string[] }[] } | { type: 'export.list'; task_id: string } | { type: 'export.status' | 'export.cancel' | 'export.preview'; task_id: string; operation_id: string } | { type: 'export.save'; task_id: string; operation_id: string; partial: boolean } | { type: 'export.resolve'; task_id: string; operation_id: string; acknowledge: boolean }
export type HostRunnerRequest =
  | { type: 'host.runner.status'; task_id: string; request_id?: string; cursor?: string; limit?: number }
  | { type: 'host.runner.flow'; task_id: string; scope?: RunnerFlowScope; cursor?: string }
  | { type: 'host.runner.input'; task_id: string; input_event_id: string; kind: 'query' | 'explanation' | 'correction' | 'cancel_work' | 'cancel_run' | 'stop_task' | 'withdraw_goal'; text?: string; request_id?: string; run_id?: string; work_id?: string }
export type HostRequest = IpcRequest | HostModelRequest | HostPluginRequest | ExportRequest | HostRunnerRequest | HostMessageRequest | { type: 'host.messages.latest'; task_id: string } | { type: 'host.run.activity' | 'host.run.usage'; task_id: string; run_id: string } | { type: 'host.run.accounting'; task_id: string; run_id: string; cursor?: string } | { type: 'host.run.results'; task_id: string; run_id: string; offset: number } | { type: 'host.views.page'; task_id: string; offset: number; expected_revision: number } | { type: 'host.tasks' } | { type: 'host.cache.clear' } | { type: 'host.directory.clear' } | { type: 'host.directory.lookup'; base_url: string; provider_id: string; wire_model_id: string; refresh: boolean }
export type HostResponse = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }
export interface Bridge { readonly platform: string; readonly transport?: 'desktop' | 'web'; request(request: HostRequest): Promise<HostResponse> }
declare global { interface Window { pliuna: Bridge } }

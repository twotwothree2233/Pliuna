import type { Bundle, IpcRequest, HostModelRequest, HostPluginRequest } from './contracts.generated'
export interface Task { id: string; title: string; state: 'active' | 'stopping' | 'stopped' | 'deleting'; revision: number }
export interface View { id: string; revision: number; state_revision: number; draft: Record<string, unknown>; bundle: Bundle; presentation: { html: string; css: string; error?: { code: string; message: string } } }
export interface Run { id: string; state: string; primary_reason: string | null; wait_reason?: string; budget_json?: string }
export interface RecordEntry { id: string; kind: string; payload: Record<string, unknown>; created_at: string }
export interface Snapshot {
  runtime_epoch: string; task: Task; surface: { id: string; revision: number; layout?: { slots: { id: string; groups: { id: string; type: string; views: string[]; gap?: string; align?: string; column_weights?: number[] }[] }[] } }; views: View[];
  view_page?: { offset: number; limit: number; total: number };
  task_data: { items: { id: string; revision: number }[]; total: number };
  approvals: { id: string; action_id: string; run_id: string | null; decision: string; validity: string; handling: string; mode: string; expires_at: string; request: unknown; request_truncated?: boolean; evaluation: unknown; result: string | null }[];
  approval_total?: number; record_total?: number;
  answer_total: number;
  runs: Run[]; records: RecordEntry[]; answers: { id: string; raw: unknown; value: unknown; truncated?: boolean; created_at: string }[]
  surface_updates: { action_id: string; run_id: string | null; request: unknown; request_truncated?: boolean; reset_requires_confirmation: boolean; expires_at: string }[]
}
export type ExportRequest = { type: 'export.catalog'; task_id: string; offset: number; expected_revision: number } | { type: 'export.check'; task_id: string; answer_ids: string[]; view_ids?: string[]; expected_revision?: number; fragment_selection?: { view_id: string; fragment_ids: string[] }[]; offset?: number } | { type: 'export.check.start'; task_id: string; answer_ids: string[]; view_ids?: string[]; expected_revision?: number; fragment_selection?: { view_id: string; fragment_ids: string[] }[] } | { type: 'export.check.status'; task_id: string; check_id: string; offset?: number } | { type: 'export.check.cancel'; task_id: string; check_id: string } | { type: 'export.prepare'; task_id: string; answer_ids: string[]; view_ids?: string[]; expected_revision?: number; fragment_selection?: { view_id: string; fragment_ids: string[] }[] } | { type: 'export.list'; task_id: string } | { type: 'export.status' | 'export.cancel' | 'export.preview'; task_id: string; operation_id: string } | { type: 'export.save'; task_id: string; operation_id: string; partial: boolean } | { type: 'export.resolve'; task_id: string; operation_id: string; acknowledge: boolean }
export type HostRequest = IpcRequest | HostModelRequest | HostPluginRequest | ExportRequest | { type: 'host.run.accounting'; task_id: string; run_id: string; cursor?: string } | { type: 'host.run.results'; task_id: string; run_id: string; offset: number } | { type: 'host.views.page'; task_id: string; offset: number; expected_revision: number } | { type: 'host.tasks' } | { type: 'host.cache.clear' } | { type: 'host.directory.clear' } | { type: 'host.directory.lookup'; base_url: string; provider_id: string; wire_model_id: string; refresh: boolean }
export type HostResponse = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }
export interface Bridge { request(request: HostRequest): Promise<HostResponse> }
declare global { interface Window { trellis: Bridge } }

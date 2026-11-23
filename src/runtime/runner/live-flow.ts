import type Database from 'better-sqlite3'
import { liveFlowPageSize as pageSize, type LiveFlowItem, type LiveFlowLane, type LiveFlowSnapshot, type LiveFlowSource, type RunnerFlowRole } from '../../shared/types'
import { ContractError } from '../../shared/validation'
import { runMessage } from './conversation-query'
import { assertRunnerId } from './limits'

const roles = ['Router', 'Worker', 'Collator', 'Host'] as const
const unfinished = "('running','waiting')"
const unsettledRuns = `WITH uncertain AS (
  SELECT run_id FROM runner_attempts WHERE task_id=@task AND state='unknown'
  UNION SELECT run_id FROM calls WHERE task_id=@task AND execution='unknown'
  UNION SELECT run_id FROM actions WHERE task_id=@task AND result='unknown'
), cleanup AS (
  SELECT c.run_id FROM cleanup_jobs j JOIN calls c ON c.task_id=j.task_id AND c.id=j.owner_id
  WHERE j.task_id=@task AND j.necessary=1 AND j.state!='done' AND j.owner_kind='call'
  UNION SELECT COALESCE(a.run_id,json_extract(a.source_json,'$.owner.run_id')) FROM cleanup_jobs j
  LEFT JOIN staging s ON j.owner_kind='staging' AND s.id=j.owner_id AND s.owner_kind='action'
  JOIN actions a ON a.task_id=j.task_id AND a.id=CASE j.owner_kind WHEN 'action' THEN j.owner_id ELSE s.owner_id END
  WHERE j.task_id=@task AND j.necessary=1 AND j.state!='done' AND j.owner_kind IN ('action','staging')
  UNION SELECT c.run_id FROM cleanup_jobs j JOIN json_each(j.detail_json,'$.call_ids') affected
  JOIN calls c ON c.task_id=j.task_id AND c.id=affected.value
  WHERE j.task_id=@task AND j.necessary=1 AND j.state!='done' AND j.owner_kind='plugin_instance'
)`
const approvalQuery = `SELECT a.id action_id,p.id approval_id,a.run_id,p.handling,
  json_extract(a.source_json,'$.owner.attempt_id') attempt_id
  FROM approvals p JOIN actions a ON a.id=p.action_id
  WHERE a.task_id=@task AND a.state!='ended' AND a.commit_valid=1
    AND p.decision='pending' AND p.validity='valid' AND p.expires_at>@now
    AND json_extract(p.binding_json,'$.runtime_epoch')=@epoch ORDER BY a.rowid`

type Approval = { action_id: string; approval_id: string; run_id: string | null; attempt_id: string | null; handling: string }
type Request = { id: string; state: string; message_id: string | null; code: string | null; material_pending: number }
type Run = { id: string; state: string; wait_reason: string | null; intended_terminal: string | null; commit_valid: number; runtime_epoch: string; request_id: string | null; message_id: string | null; purpose: string | null; chapter_update_id: string | null; unknown_result: number; cleanup_pending: number }
type Work = { work_id: string; role: string; attempt_id: string | null; attempt_state: string | null; profile: string | null; wait_reason: string | null; input_sequence: number | null }
type Params = { task: string; epoch: string; now: string }
type Options = { checking?: (id: string) => boolean; compositionWaiting?: boolean; canCompose?: (artifact: string, revision: number) => boolean }

const source = (request?: string | null, message?: string | null, run?: string): LiveFlowSource => ({
  ...(request ? { request_id: request } : {}), ...(message ? { message_id: message } : {}), ...(run ? { run_id: run } : {})
})
const reasonCode = (value?: string | null) => value && /^[a-z0-9_]{1,80}$/i.test(value) ? value : undefined
const waiting = (reason?: string | null): LiveFlowItem['state'] => ['input', 'input_required', 'user_input', 'clarification'].includes(reason ?? '') ? 'input' : 'waiting'
function approvalState(approval: Approval): Pick<LiveFlowItem, 'state' | 'approval_id' | 'action_id' | 'reason'> {
  return approval.handling === 'awaiting_human'
    ? { state: 'approval', approval_id: approval.approval_id, action_id: approval.action_id }
    : { state: 'waiting', reason: 'approval_evaluating' }
}

export function liveRunnerFlow(db: Database.Database, raw: Record<string, unknown>, epoch: string, options: Options = {}): LiveFlowSnapshot {
  const { task_id: task, pages, focus_run_id: focusRun } = raw
  if (Object.keys(raw).some(key => !['type', 'task_id', 'pages', 'focus_run_id'].includes(key)) || pages !== undefined && (
    !pages || typeof pages !== 'object' || Array.isArray(pages) || Object.entries(pages).some(([role, page]) =>
      !roles.includes(role as RunnerFlowRole) || !Number.isSafeInteger(page) || page < 0))) throw new ContractError('INVALID_REQUEST', 'Invalid live flow lookup')
  assertRunnerId(task, 'task_id')
  if (focusRun !== undefined) assertRunnerId(focusRun, 'run_id')
  const requested = (pages ?? {}) as Partial<Record<RunnerFlowRole, number>>
  return db.transaction(() => {
    const meta = db.prepare("SELECT next_sequence-1 sequence FROM tasks WHERE id=? AND state!='deleting'").get(task) as { sequence: number } | undefined
    if (!meta) throw new ContractError('NOT_FOUND', 'Task unavailable')
    const params = { task, epoch, now: new Date().toISOString() }
    const approvals = db.prepare(approvalQuery).all(params) as Approval[]
    const chapters = chapterItems(db, params, approvals)
    const items = [...executionItems(db, params, options, approvals, chapters), ...batchItems(db, params, options, approvals, focusRun), ...chapters]
    const lanes = {} as LiveFlowSnapshot['lanes']
    const focused = typeof focusRun === 'string' ? items.find(item => item.run_id === focusRun || item.sources.some(ref => ref.run_id === focusRun)) : undefined
    for (const role of roles) {
      const matching = items.filter(item => item.role === role)
      const index = focused?.role === role ? matching.indexOf(focused) : -1
      const page = index >= 0 ? Math.floor(index / pageSize) : Math.min(requested[role] ?? 0, Math.max(0, Math.ceil(matching.length / pageSize) - 1))
      lanes[role] = { items: matching.slice(page * pageSize, (page + 1) * pageSize), total: matching.length, page } satisfies LiveFlowLane
    }
    return { task_id: task, runtime_epoch: epoch, through_sequence: meta.sequence, lanes, ...(focused ? { focus: { role: focused.role, id: focused.id } } : {}) }
  })()
}

function executionItems(db: Database.Database, params: Params, options: Options, approvals: Approval[], chapters: LiveFlowItem[]): LiveFlowItem[] {
  const items: LiveFlowItem[] = []
  const requests = db.prepare(`SELECT q.id,q.state,json_extract(q.input_json,'$.user_record_id') message_id,
    json_extract(q.input_json,'$.code') code,
    EXISTS(SELECT 1 FROM json_each(q.input_json,'$.import_ids') entry JOIN actions a ON a.id=entry.value AND a.task_id=q.task_id WHERE a.state!='ended') material_pending
    FROM requests q WHERE q.task_id=@task AND q.state IN ('queued','confirmation_required')
      AND json_extract(q.input_json,'$.epoch')=@epoch ORDER BY q.rowid`).all(params) as Request[]
  const runs = db.prepare(`${unsettledRuns} SELECT c.id,c.state,c.wait_reason,c.intended_terminal,c.commit_valid,c.runtime_epoch,c.request_id,
    ${runMessage('c')} message_id,rr.purpose,c.chapter_update_id,
    COALESCE(c.id IN uncertain,0) unknown_result,COALESCE(c.id IN cleanup,0) cleanup_pending
    FROM runs c LEFT JOIN runner_runs rr ON rr.task_id=c.task_id AND rr.run_id=c.id
    WHERE c.task_id=@task AND (rr.purpose IS NULL OR rr.purpose='production') AND (
      c.state IN ${unfinished} AND (c.runtime_epoch=@epoch OR c.intended_terminal IS NOT NULL OR c.wait_reason='ending_cleanup') OR
      c.id IN uncertain OR c.id IN cleanup) ORDER BY c.rowid`).all(params) as Run[]
  const queued = new Map(requests.map(row => [row.id, row]))
  for (const run of runs) {
    const request = run.request_id ? queued.get(run.request_id) : undefined
    const ref = source(run.request_id, run.message_id, run.id)
    const owned = approvals.filter(value => value.run_id === run.id)
    const active = run.runtime_epoch === params.epoch && run.commit_valid && !run.intended_terminal && (run.state === 'running' || run.state === 'waiting')
    const chapter = chapters.find(item => item.id === `chapter:${run.chapter_update_id}`)
    if (!active) {
      const closing = run.cleanup_pending || run.state === 'waiting' && (run.intended_terminal || run.wait_reason === 'ending_cleanup')
      if (run.unknown_result && chapter?.state !== 'unknown' || !chapter && closing) {
        items.push({ id: `run:${run.id}`, role: 'Host', kind: 'run', state: run.unknown_result ? 'unknown' : 'closing', sources: [ref] })
      }
      continue
    }
    if (request?.state === 'queued' && !run.purpose) {
      items.push({ id: `request:${request.id}`, role: 'Router', kind: 'request', state: run.state === 'waiting' ? 'waiting' : 'running', sources: [ref] })
      queued.delete(request.id)
      continue
    }
    const work = db.prepare(`SELECT w.work_id,json_extract(w.payload_json,'$.role') role,
      a.attempt_id,a.state attempt_state,json_extract(a.payload_json,'$.profile_id') profile,
      CASE WHEN a.state='waiting' THEN (SELECT json_extract(r.payload_json,'$.reason') FROM records r
        WHERE r.task_id=w.task_id AND r.kind='worker.state' AND json_extract(r.payload_json,'$.owner.attempt_id')=a.attempt_id
        ORDER BY r.sequence DESC LIMIT 1) END wait_reason,
      (SELECT r.sequence FROM records r WHERE r.task_id=w.task_id AND r.kind='worker.input'
        AND json_extract(r.payload_json,'$.owner.attempt_id')=a.attempt_id AND json_extract(r.payload_json,'$.owner.work_id')=w.work_id
        AND json_extract(r.payload_json,'$.owner.run_id')=w.run_id ORDER BY r.sequence DESC LIMIT 1) input_sequence
      FROM runner_work w LEFT JOIN runner_attempts a ON a.attempt_id=json_extract(w.payload_json,'$.current_attempt_id')
        AND a.task_id=w.task_id AND a.run_id=w.run_id AND a.work_id=w.work_id
      WHERE w.task_id=? AND w.run_id=? AND (w.state IN ('planned','queued','running','waiting') OR a.state='unknown') ORDER BY w.rowid`).all(params.task, run.id) as Work[]
    let shown = false
    for (const row of work) {
      if (run.chapter_update_id && row.profile === 'chapter-host-publisher-v1') continue
      // The chapter producer can be awaiting its publisher inside a tool call
      // while the original attempt still says running.
      if (chapter?.role === 'Host' && row.profile === 'chapter-producer-v1' && row.attempt_state !== 'unknown') continue
      const approval = owned.find(value => value.attempt_id === row.attempt_id && row.attempt_id !== null)
      const state = row.attempt_state === 'unknown' ? 'unknown' : row.attempt_state === 'waiting' ? waiting(row.wait_reason) :
        row.attempt_state === 'running' || row.attempt_state === 'dispatched' ? 'running' : 'queued'
      items.push({ id: `work:${row.work_id}`, role: state === 'unknown' ? 'Host' : 'Worker', kind: 'work', work_role: reasonCode(row.role), state,
        reason: reasonCode(row.wait_reason === 'approval' ? null : row.wait_reason), sources: [ref],
        ...(approval && state !== 'unknown' ? approvalState(approval) : {}),
        ...(row.input_sequence && state !== 'unknown' ? { handoff: { sequence: row.input_sequence, from: row.role === 'diagnostic' ? 'Host' : 'Router', kind: 'work' } } : {}) })
      shown = true
    }
    const approval = owned.find(value => value.attempt_id === null)
    if (!shown && !run.chapter_update_id && (!run.purpose || approval || !db.prepare('SELECT 1 FROM runner_work WHERE task_id=? AND run_id=?').get(params.task, run.id))) {
      items.push({ id: `run:${run.id}`, role: 'Worker', kind: 'run', state: run.state === 'waiting' ? waiting(run.wait_reason) : 'running',
        reason: reasonCode(run.wait_reason === 'approval' ? null : run.wait_reason), sources: [ref], ...(approval ? approvalState(approval) : {}) })
    }
  }
  for (const request of queued.values()) {
    const state = request.state === 'confirmation_required' ? 'input' : request.material_pending || options.checking?.(request.id) || request.code === 'CONVERSATION_WAITING_FOR_RESULT' ? 'waiting' : 'queued'
    const reason = reasonCode(request.code) ?? (request.material_pending ? 'material_pending' : options.checking?.(request.id) ? 'material_preflight' : undefined)
    items.push({ id: `request:${request.id}`, role: 'Router', kind: 'request', state, reason, sources: [source(request.id, request.message_id)] })
  }
  return items
}

// A composition batch can outlive every production Run that contributed to it.
// Associate the exact index revisions; trigger and targets alone don't prove contribution.
const artifactSources = `json_extract(a.payload_json,'$.request_id') request_id,
  json_extract(a.payload_json,'$.run_id') run_id,
  (SELECT i.record_id FROM runner_content_plans g JOIN runner_inputs i
    ON i.task_id=g.task_id AND i.input_event_id=g.input_event_id
    WHERE g.task_id=a.task_id AND g.request_id=json_extract(a.payload_json,'$.request_id')
      AND g.intent_revision=json_extract(a.payload_json,'$.intent_revision')) message_id`
type SourceRow = { request_id: string; run_id: string; message_id: string | null }
const references = (rows: SourceRow[]) => rows.map(row => source(row.request_id, row.message_id, row.run_id))
type BatchRow = { batch_id: string; run_id: string; state: string; batch_state: string; runtime_epoch: string; commit_valid: number; intended_terminal: string | null; wait_reason: string | null; action_id: string | null; publication: string | null; layout: string | null; indexes_sequence: number | null; plan_sequence: number | null; unknown_result: number; cleanup_pending: number }

function batchItems(db: Database.Database, params: Params, options: Options, approvals: Approval[], focusRun: unknown): LiveFlowItem[] {
  const batches = db.prepare(`${unsettledRuns} SELECT b.batch_id,c.id run_id,c.state,c.runtime_epoch,c.commit_valid,c.intended_terminal,c.wait_reason,
    COALESCE(c.id IN uncertain,0) unknown_result,COALESCE(c.id IN cleanup,0) cleanup_pending,
    json_extract(b.payload_json,'$.state') batch_state,p.state publication,p.action_id,
    (SELECT a.state FROM runner_attempts a JOIN runner_work w ON w.task_id=a.task_id AND w.run_id=a.run_id
      AND w.work_id=a.work_id AND json_extract(w.payload_json,'$.current_attempt_id')=a.attempt_id
      WHERE a.task_id=b.task_id AND a.run_id=c.id AND json_extract(a.payload_json,'$.profile_id')='collator-indexed-v1') layout,
    (SELECT r.sequence FROM records r WHERE r.task_id=b.task_id AND r.kind='runner.composition.prepared'
      AND json_extract(r.payload_json,'$.batch_id')=b.batch_id AND json_extract(r.payload_json,'$.run_id')=c.id ORDER BY r.sequence DESC LIMIT 1) indexes_sequence,
    (SELECT r.sequence FROM runner_work w JOIN runner_attempts a ON a.task_id=w.task_id AND a.run_id=w.run_id
      AND a.work_id=w.work_id AND a.attempt_id=json_extract(w.payload_json,'$.current_attempt_id')
      JOIN records r ON r.task_id=a.task_id AND r.id=json_extract(a.payload_json,'$.result_ref.id')
      WHERE w.task_id=b.task_id AND w.run_id=c.id AND a.state='succeeded'
      AND json_extract(a.payload_json,'$.profile_id')='collator-indexed-v1'
      AND ((r.kind='worker.result' AND json_extract(r.payload_json,'$.owner.attempt_id')=a.attempt_id)
        OR (r.kind='runner.composition.rule_plan' AND json_extract(r.payload_json,'$.batch_id')=b.batch_id)) LIMIT 1) plan_sequence
    FROM runner_batches b JOIN runner_runs rr ON rr.task_id=b.task_id AND rr.batch_id=b.batch_id AND rr.purpose='composition'
    JOIN runs c ON c.task_id=rr.task_id AND c.id=rr.run_id AND c.id=json_extract(b.payload_json,'$.run_id')
    LEFT JOIN runner_publications p ON p.task_id=b.task_id AND p.batch_id=b.batch_id
    WHERE b.task_id=@task AND (p.state='unknown' OR c.id IN uncertain OR c.id IN cleanup OR c.state IN ${unfinished}
      AND (c.runtime_epoch=@epoch OR c.intended_terminal IS NOT NULL OR c.wait_reason='ending_cleanup')) ORDER BY b.rowid`).all(params) as BatchRow[]
  const items: LiveFlowItem[] = []
  for (const batch of batches) {
    const unknown = batch.publication === 'unknown' || !batch.publication && !!batch.unknown_result
    const closing = batch.cleanup_pending && !batch.commit_valid || batch.state === 'waiting' && !!(batch.intended_terminal || batch.wait_reason === 'ending_cleanup')
    const active = batch.commit_valid && batch.runtime_epoch === params.epoch && !['failed', 'cancelled', 'invalidated', 'published', 'unknown'].includes(batch.batch_state)
      && !['failure', 'cancelled', 'published'].includes(batch.publication ?? '')
    if (!unknown && !closing && !active) continue
    const publishing = !!batch.publication || batch.batch_state === 'publishing' || batch.layout === 'succeeded'
    const role = publishing || unknown || closing ? 'Host' : 'Collator'
    const state = unknown ? 'unknown' : closing ? 'closing' : role === 'Host'
      ? batch.state === 'waiting' ? 'waiting' : batch.publication || batch.batch_state === 'publishing' ? 'publishing' : 'queued'
      : ['running', 'dispatched'].includes(batch.layout ?? '') ? 'running' : batch.state === 'waiting' || batch.layout === 'waiting' ? 'waiting' : 'queued'
    const rows = db.prepare(`SELECT DISTINCT ${artifactSources} FROM runner_batches b JOIN json_each(b.payload_json,'$.indexes') i
      JOIN runner_artifacts a ON a.task_id=b.task_id AND a.artifact_id=json_extract(i.value,'$.artifact_id')
        AND a.artifact_revision=json_extract(i.value,'$.artifact_revision')
      WHERE b.task_id=? AND b.batch_id=? AND json_extract(i.value,'$.task_id')=b.task_id ORDER BY CAST(i.key AS INTEGER)`).all(params.task, batch.batch_id) as SourceRow[]
    const approval = active && !closing && approvals.find(value => value.action_id === batch.action_id && value.run_id === batch.run_id)
    items.push({ id: `batch:${batch.batch_id}`, run_id: batch.run_id, role, kind: 'batch', state, sources: references(rows),
      reason: reasonCode(batch.wait_reason === 'approval' ? null : batch.wait_reason), ...(approval ? approvalState(approval) : {}),
      ...(role === 'Collator' && batch.indexes_sequence ? { handoff: { sequence: batch.indexes_sequence, from: 'Worker', kind: 'indexes' } } : {}),
      ...(role === 'Host' && batch.plan_sequence ? { handoff: { sequence: batch.plan_sequence, from: 'Collator', kind: 'plan' } } : {}) })
  }
  if (options.compositionWaiting) {
    const candidates = db.prepare(`SELECT ${artifactSources},a.artifact_id,a.artifact_revision
      FROM runner_artifacts a JOIN runner_artifact_owners o ON o.task_id=a.task_id AND o.artifact_id=a.artifact_id AND o.current_revision=a.artifact_revision
      JOIN runner_current_content_plans g ON g.task_id=a.task_id AND g.request_id=json_extract(a.payload_json,'$.request_id')
        AND g.intent_revision=json_extract(a.payload_json,'$.intent_revision') AND json_extract(g.payload_json,'$.state')='active'
      JOIN runner_scopes s ON s.task_id=a.task_id AND s.composition_version=(SELECT max(composition_version) FROM runner_scopes WHERE task_id=a.task_id)
      JOIN json_each(s.payload_json,'$.targets') t ON json_extract(t.value,'$.request_id')=g.request_id AND json_extract(t.value,'$.intent_revision')=g.intent_revision
      WHERE a.task_id=@task AND NOT EXISTS(SELECT 1 FROM runner_view_mappings m WHERE m.task_id=a.task_id
        AND m.artifact_id=a.artifact_id AND m.artifact_revision=a.artifact_revision)
      AND NOT EXISTS(SELECT 1 FROM runner_batches b JOIN runner_runs rr ON rr.task_id=b.task_id AND rr.batch_id=b.batch_id
        JOIN runs c ON c.task_id=rr.task_id AND c.id=rr.run_id AND c.state IN ${unfinished}
        JOIN json_each(b.payload_json,'$.indexes') i ON json_extract(i.value,'$.artifact_id')=a.artifact_id
        WHERE b.task_id=a.task_id) ORDER BY a.rowid`).all(params) as (SourceRow & { artifact_id: string; artifact_revision: number })[]
    const sources = new Map<string, SourceRow>()
    for (const row of candidates) if (!sources.has(row.run_id) && options.canCompose?.(row.artifact_id, row.artifact_revision)) sources.set(row.run_id, row)
    if (sources.size) {
      const rows = [...sources.values()]
      const focused = rows.find(row => row.run_id === focusRun)
      const visible = rows.slice(0, 16)
      if (focused && !visible.includes(focused)) visible[visible.length - 1] = focused
      items.push({ id: 'composition:waiting', role: 'Collator', kind: 'batch', state: 'queued', reason: 'composition_queue', sources: references(visible), source_count: sources.size })
    }
  }
  return items
}

type ChapterRow = { update_id: string; request_id: string; message_id: string | null; run_id: string | null; update_state: string; reason: string | null; action_id: string | null; publication: string | null; prepared_sequence: number | null; run_state: string | null; commit_valid: number | null; runtime_epoch: string | null; intended_terminal: string | null; wait_reason: string | null; producing: number }
function chapterItems(db: Database.Database, params: Params, approvals: Approval[]): LiveFlowItem[] {
  const rows = db.prepare(`SELECT u.update_id,u.request_id,COALESCE(json_extract(origin.payload_json,'$.source_record_id'),origin.id) message_id,
    c.id run_id,c.state run_state,c.runtime_epoch,c.commit_valid,c.intended_terminal,c.wait_reason,u.state update_state,
    json_extract(u.payload_json,'$.reason') reason,p.state publication,json_extract(p.payload_json,'$.action_id') action_id,
    (SELECT r.sequence FROM records r WHERE r.task_id=u.task_id AND r.kind='chapter.publication.prepared'
      AND json_extract(r.payload_json,'$.update_id')=u.update_id AND json_extract(r.payload_json,'$.operation_id')=p.operation_id ORDER BY r.sequence DESC LIMIT 1) prepared_sequence,
    EXISTS(SELECT 1 FROM runner_work w JOIN runner_attempts a ON a.task_id=w.task_id AND a.run_id=w.run_id
      AND a.work_id=w.work_id AND a.attempt_id=json_extract(w.payload_json,'$.current_attempt_id')
      WHERE w.task_id=u.task_id AND w.run_id=c.id AND w.state IN ('planned','queued','running','waiting')
        AND json_extract(a.payload_json,'$.profile_id')='chapter-producer-v1') producing
    FROM runner_chapter_updates u
    LEFT JOIN records origin ON origin.task_id=u.task_id AND origin.id=json_extract(u.payload_json,'$.record_id')
    LEFT JOIN runs c ON c.task_id=u.task_id AND c.chapter_update_id=u.update_id AND c.id=COALESCE(json_extract(u.payload_json,'$.source.run_id'),
      (SELECT run.id FROM runs run WHERE run.task_id=u.task_id AND run.chapter_update_id=u.update_id ORDER BY run.rowid DESC LIMIT 1))
    LEFT JOIN runner_chapter_publications p ON p.task_id=u.task_id AND p.update_id=u.update_id AND p.operation_id=json_extract(u.payload_json,'$.publication_operation_id')
    WHERE u.task_id=@task AND (p.state='unknown' OR u.state IN ('queued','generating','waiting_input','waiting_approval','assembling','publishing','unknown')
      OR c.state='waiting' AND (c.intended_terminal IS NOT NULL OR c.wait_reason='ending_cleanup')) ORDER BY u.rowid`).all(params) as ChapterRow[]
  const items: LiveFlowItem[] = []
  for (const row of rows) {
    const unknown = row.publication === 'unknown' || row.update_state === 'unknown' && !row.publication
    const closing = row.run_state === 'waiting' && !!(row.intended_terminal || row.wait_reason === 'ending_cleanup')
    const active = row.commit_valid && row.runtime_epoch === params.epoch && ['running', 'waiting'].includes(row.run_state ?? '')
    const unstarted = !row.run_id && ['queued', 'waiting_input'].includes(row.update_state)
    if (!unknown && !closing && !active && !unstarted) continue
    const publishing = ['assembling', 'publishing', 'waiting_approval'].includes(row.update_state) || ['registered', 'prepared', 'dispatched'].includes(row.publication ?? '')
    if (!unknown && !closing && !publishing && row.producing) continue
    if (!unknown && !closing && ['succeeded', 'failed', 'cancelled', 'interrupted', 'superseded'].includes(row.update_state)) continue
    const role = unknown || closing || publishing ? 'Host' : unstarted ? 'Router' : 'Worker'
    const state = unknown ? 'unknown' : closing ? 'closing' : row.update_state === 'waiting_approval' ? 'waiting'
      : row.update_state === 'waiting_input' ? publishing ? 'waiting' : 'input' : row.update_state === 'queued' ? 'queued'
      : row.update_state === 'publishing' ? 'publishing' : 'running'
    const approval = active && !closing && !unknown && approvals.find(value => value.action_id === row.action_id && value.run_id === row.run_id)
    items.push({ id: `chapter:${row.update_id}`, role, kind: 'chapter', state,
      sources: [source(row.request_id, row.message_id, row.run_id ?? undefined)], reason: reasonCode(row.reason),
      ...(approval ? approvalState(approval) : {}), ...(row.prepared_sequence && role === 'Host' ? { handoff: { sequence: row.prepared_sequence, from: 'Worker', kind: 'plan' } } : {}) })
  }
  return items
}

import type Database from 'better-sqlite3'
import type { RunnerFlowEvidence, RunnerFlowOption, RunnerFlowOptions, RunnerFlowPage, RunnerFlowScope } from '../../shared/types'
import { ContractError } from '../../shared/validation'
import { assertRunnerId } from './limits'
import { runMessage } from './conversation-query'

const limit = 24
const byteLimit = 24 * 1024
type Cursor = { after: number[]; through: number[] }
type Token = { read(binding: string, value: string): Cursor; write(binding: string, value: Cursor): string }
const unavailable = () => new ContractError('RUNNER_NOT_FOUND', 'Run is unavailable within this task')

// The graph and record list share the same ownership and status facts.
// Input, output and plans stay in their original records.
const scopeEvidence = `
WITH work AS (
  SELECT w.rowid AS position,w.*,a.state AS attempt_state,a.attempt_number,
    json_extract(w.payload_json,'$.role') AS role
  FROM runner_work w LEFT JOIN runner_attempts a ON a.attempt_id=json_extract(w.payload_json,'$.current_attempt_id')
    AND a.task_id=w.task_id AND a.work_id=w.work_id AND a.run_id=w.run_id
  WHERE w.task_id=@task AND w.run_id=@run AND w.rowid<=@work
), accepted AS (
  SELECT a.rowid AS position,a.artifact_id,a.artifact_revision,a.bundle_resource_id,w.work_id
  FROM runner_artifacts a JOIN runner_artifact_owners o ON o.artifact_id=a.artifact_id AND o.task_id=a.task_id
  JOIN work w ON w.work_id=o.work_id
  WHERE a.task_id=@task AND a.rowid<=@artifact AND json_extract(a.payload_json,'$.run_id')=@run
    AND json_extract(a.payload_json,'$.request_id')=@request AND json_extract(a.payload_json,'$.intent_revision')=@rev
    AND json_extract(a.payload_json,'$.acceptance_state')='accepted'
), batch_inputs AS (
  SELECT b.rowid AS position,b.batch_id,json_extract(b.payload_json,'$.run_id') AS composition_run,
    json_extract(b.payload_json,'$.state') AS batch_state,
    json_array_length(b.payload_json,'$.targets')>1 AS shared,COUNT(*) AS item_count,json_group_array(DISTINCT a.work_id) AS work_ids
  FROM runner_batches b JOIN json_each(b.payload_json,'$.indexes') i
  JOIN accepted a ON a.artifact_id=json_extract(i.value,'$.artifact_id') AND a.artifact_revision=json_extract(i.value,'$.artifact_revision')
  WHERE b.task_id=@task AND b.rowid<=@batch AND json_extract(i.value,'$.task_id')=@task
    AND EXISTS (SELECT 1 FROM json_each(b.payload_json,'$.targets') t WHERE json_extract(t.value,'$.task_id')=@task
      AND json_extract(t.value,'$.request_id')=@request AND json_extract(t.value,'$.intent_revision')=@rev)
  GROUP BY b.rowid
), batches AS (
  SELECT b.*,p.state AS publication_state,a.id AS action_id,substr(COALESCE(a.ended_at,a.created_at),1,64) AS action_at,
    substr(cr.created_at,1,64) AS batch_at,
    r.id AS plan_id,substr(r.created_at,1,64) AS plan_at
  FROM batch_inputs b JOIN runner_runs c ON c.task_id=@task AND c.run_id=b.composition_run AND c.batch_id=b.batch_id AND c.purpose='composition'
  JOIN runs cr ON cr.task_id=c.task_id AND cr.id=c.run_id
  LEFT JOIN runner_publications p ON p.task_id=@task AND p.batch_id=b.batch_id AND p.rowid<=@publication
  LEFT JOIN actions a ON a.id=p.action_id AND a.task_id=@task AND a.run_id=b.composition_run
  LEFT JOIN records r ON r.id=(SELECT aa.id FROM runner_work cw JOIN runner_attempts ca
    ON ca.attempt_id=json_extract(cw.payload_json,'$.current_attempt_id') AND ca.work_id=cw.work_id AND ca.run_id=cw.run_id AND ca.task_id=cw.task_id
    JOIN records aa ON aa.id=json_extract(ca.payload_json,'$.result_ref.id') AND aa.task_id=ca.task_id AND aa.sequence<=@sequence
    WHERE cw.task_id=@task AND cw.run_id=b.composition_run AND json_extract(cw.payload_json,'$.role')='collator'
      AND ca.state='succeeded' AND json_extract(ca.payload_json,'$.result_ref.kind')='record'
    ORDER BY ca.rowid DESC LIMIT 1)
)`

export function runnerFlow(db: Database.Database, raw: Record<string, unknown>, token: Token): RunnerFlowOptions | RunnerFlowPage {
  const { task_id: taskId, scope, cursor } = raw
  if (Object.keys(raw).some(key => !['type', 'task_id', 'scope', 'cursor'].includes(key)) || cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048)) throw new ContractError('INVALID_REQUEST', 'Invalid execution flow lookup')
  assertRunnerId(taskId, 'task_id')
  if (scope === undefined) return options(db, taskId, token, cursor)
  if (!scope || typeof scope !== 'object' || Object.keys(scope).join(',') !== 'run_id') throw new ContractError('INVALID_REQUEST', 'Invalid execution flow scope')
  const selected = scope as RunnerFlowScope
  assertRunnerId(selected.run_id, 'run_id')
  const binding = JSON.stringify(['runner-flow', taskId, selected.run_id])
  const previous = cursor ? token.read(binding, cursor) : null
  const run = db.prepare(`SELECT c.created_at,COALESCE(rr.request_id,c.request_id) AS request_id,rr.intent_revision,
      t.next_sequence-1 AS sequence,COALESCE(${runMessage('c')},i.record_id) AS record_id,
      substr(COALESCE(i.created_at,c.created_at),1,64) AS input_at,
      EXISTS (SELECT 1 FROM runner_consumptions rc WHERE rc.input_event_id=i.input_event_id AND rc.task_id=c.task_id AND rc.stage='installed') AS routed
    FROM runs c JOIN tasks t ON t.id=c.task_id
    LEFT JOIN runner_runs rr ON rr.run_id=c.id AND rr.task_id=c.task_id AND rr.purpose='production'
    LEFT JOIN runner_content_plans g ON g.task_id=c.task_id AND g.request_id=rr.request_id AND g.intent_revision=rr.intent_revision
    LEFT JOIN runner_inputs i ON i.input_event_id=g.input_event_id AND i.task_id=g.task_id
    WHERE c.task_id=? AND c.id=?`).get(taskId, selected.run_id) as { created_at: string; request_id: string | null; intent_revision: number | null; sequence: number; record_id: string | null; input_at: string; routed: number } | undefined
  if (!run) throw unavailable()
  const base = { task_id: taskId, scope: selected, through_sequence: previous?.through[0] ?? run.sequence, work_count: 0 }
  const watermark = (table: string) => (db.prepare(`SELECT COALESCE(MAX(rowid),0) AS n FROM ${table}`).get() as { n: number }).n
  const through = previous?.through ?? [run.sequence, ...['runner_work', 'runner_artifacts', 'runner_batches', 'runner_publications'].map(watermark)]
  const [sequence, work, artifact, batch, publication] = through
  const [stage, position] = previous?.after ?? [0, 0]
  const params = { task: taskId, request: run.request_id, rev: run.intent_revision, run: selected.run_id, sequence, work, artifact, batch, publication, stage, position, limit: limit + 1 }
  const evidenceQuery = `${scopeEvidence}, evidence AS (
    SELECT 1 AS stage,position,work_id AS id,work_id,role,attempt_number AS attempt,
      CASE WHEN attempt_state='unknown' THEN 'unknown' ELSE state END AS state,
      NULL AS batch_id,NULL AS shared,NULL AS item_count,NULL AS resource_id,NULL AS action_id,NULL AS plan_id,NULL AS at,NULL AS composition_run,NULL AS work_ids FROM work
    UNION ALL SELECT 2,position,artifact_id||':'||artifact_revision,work_id,NULL,NULL,'accepted',NULL,NULL,NULL,bundle_resource_id,NULL,NULL,NULL,NULL,NULL FROM accepted
    UNION ALL SELECT 3,position,batch_id,NULL,NULL,NULL,
      CASE WHEN publication_state IS NOT NULL OR plan_id IS NOT NULL THEN 'indexes_received'
        WHEN batch_state IN ('failed','cancelled','unknown') THEN batch_state ELSE 'pending_layout' END,
      batch_id,shared,item_count,NULL,NULL,NULL,batch_at,composition_run,work_ids FROM batches
    UNION ALL SELECT 4,position,batch_id,NULL,NULL,NULL,
      CASE publication_state WHEN 'published' THEN 'published' WHEN 'failure' THEN 'failed' WHEN 'cancelled' THEN 'cancelled'
        WHEN 'unknown' THEN 'unknown' ELSE 'pending_publication' END,
      batch_id,shared,NULL,NULL,action_id,plan_id,COALESCE(action_at,plan_at),composition_run,NULL FROM batches
      WHERE publication_state IS NOT NULL OR plan_id IS NOT NULL
  )`
  const rows = db.prepare(`${evidenceQuery} SELECT * FROM evidence
    WHERE stage>@stage OR (stage=@stage AND position<@position) ORDER BY stage,position DESC LIMIT @limit`).all(params) as EvidenceRow[]
  const { count } = db.prepare('SELECT count(*) AS count FROM runner_work WHERE task_id=? AND run_id=? AND rowid<=?').get(taskId, selected.run_id, work) as { count: number }
  const page: RunnerFlowPage = { ...base, work_count: count, items: [], next_cursor: null }
  const origin = run.routed && run.record_id ? { id: run.record_id, at: run.input_at } : null
  const project = (row: EvidenceRow) => evidence(row, selected.run_id!, run.created_at.slice(0, 64), origin)
  for (const row of rows.slice(0, limit)) {
    const item = project(row)
    if (Buffer.byteLength(JSON.stringify([...page.items, item])) > byteLimit) break
    page.items.push(item)
  }
  const last = rows[page.items.length - 1]
  if (last && rows.length > page.items.length) page.next_cursor = token.write(binding, { after: [last.stage, last.position], through })
  if (!cursor) {
    // Keep a bounded live view even when earlier evidence fills the first page.
    // Favor the workers that contributed to composition when the board is full.
    const graph = db.prepare(`${evidenceQuery},
      owners AS (SELECT b.batch_id,b.position,j.value AS work_id FROM batches b JOIN json_each(b.work_ids) j),
      visible AS (SELECT w.work_id FROM work w LEFT JOIN owners o ON o.work_id=w.work_id
        GROUP BY w.work_id ORDER BY MAX(o.position) DESC,w.position DESC LIMIT ${limit}),
      latest_accepted AS (SELECT MAX(e.position) AS position FROM evidence e JOIN visible v USING(work_id) WHERE e.stage=2 GROUP BY e.work_id),
      latest_batch AS (SELECT o.batch_id,o.work_id,ROW_NUMBER() OVER (PARTITION BY o.work_id ORDER BY o.position DESC) AS rank
        FROM owners o JOIN visible v USING(work_id)),
      graph_batches AS (SELECT DISTINCT batch_id FROM latest_batch WHERE rank=1)
      SELECT * FROM evidence e WHERE (stage=1 AND work_id IN (SELECT work_id FROM visible))
        OR (stage=2 AND position IN (SELECT position FROM latest_accepted))
        OR (stage=3 AND batch_id IN (SELECT batch_id FROM graph_batches))
        OR (stage=4 AND batch_id=(SELECT b.batch_id FROM batches b JOIN graph_batches g USING(batch_id) ORDER BY b.position DESC LIMIT 1))
      ORDER BY stage,position DESC`).all(params) as EvidenceRow[]
    page.graph = graph.map(project)
  }
  return page
}

type EvidenceRow = { stage: number; position: number; id: string; state: string; work_id: string | null; role: string | null; attempt: number | null; batch_id: string | null; item_count: number | null; shared: number | null; resource_id: string | null; at: string | null; action_id: string | null; plan_id: string | null; composition_run: string | null; work_ids: string | null }
function evidence(row: EvidenceRow, run: string, runAt: string, origin: { id: string; at: string | null } | null): RunnerFlowEvidence {
  const base = { id: `${row.stage}:${row.id}`, state: row.state, at: row.at }
  if (row.stage === 1) return { ...base, kind: 'work', at: origin?.at ?? runAt, work_id: row.work_id!, ...(row.role ? { role: row.role } : {}), ...(row.attempt ? { attempt: row.attempt } : {}), ...(origin ? { from: 'Router', to: 'Worker', ref: { kind: 'event', id: origin.id } } : { ref: { kind: 'run', id: run } }) }
  if (row.stage === 2) return { ...base, kind: 'accepted', from: 'Worker', to: 'Host', work_id: row.work_id!, ...(row.resource_id ? { ref: { kind: 'resource', id: row.resource_id } } : {}) }
  const batch = { batch_id: row.batch_id!, shared: row.shared === 1 }
  if (row.stage === 3) return { ...base, ...batch, kind: 'indexes', from: 'Worker', to: 'Collator', count: row.item_count!, work_ids: JSON.parse(row.work_ids!), ref: { kind: 'run', id: row.composition_run! } }
  return { ...base, ...batch, kind: 'plan', from: 'Collator', to: 'Host', ref: row.action_id ? { kind: 'action', id: row.action_id } : row.plan_id ? { kind: 'event', id: row.plan_id } : { kind: 'run', id: row.composition_run! } }
}

function options(db: Database.Database, task: string, token: Token, cursor?: string): RunnerFlowOptions {
  const binding = JSON.stringify(['runner-flow-options', task])
  const previous = cursor ? token.read(binding, cursor) : null
  const [before] = previous?.after ?? [Number.MAX_SAFE_INTEGER]
  const [through] = previous?.through ?? [(db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM runs').get() as { n: number }).n]
  const rows = db.prepare(`SELECT c.rowid AS position,c.id AS run_id,c.state,substr(c.created_at,1,64) AS at,
    (SELECT substr(json_extract(r.payload_json,'$.text'),1,64) FROM records r WHERE r.task_id=c.task_id AND r.id=${runMessage('c')}) AS input
    FROM runs c WHERE c.task_id=@task AND c.rowid<=@through AND c.rowid<@before
    ORDER BY c.rowid DESC LIMIT @limit`).all({ task, before, through, limit: limit + 1 }) as (RunnerFlowOption & { position: number })[]
  const items = rows.slice(0, limit), last = items.at(-1)
  return { task_id: task, options: items.map(({ position: _, ...item }) => item), next_cursor: last && rows.length > limit ? token.write(binding, { after: [last.position], through: [through!] }) : null }
}

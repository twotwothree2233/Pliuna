import { performance } from 'node:perf_hooks'

// This is failure evidence, never a second completion wait or a retry.
export async function captureCandidateFailure(failure: unknown, report: Record<string, any>, scenarioDeadline: number,
  read: () => Promise<unknown>, now = () => performance.now()): Promise<never> {
  if (report.failure_snapshot) throw failure
  const started = now()
  const record = report.failure_snapshot = { started_monotonic_ms: started, ended_monotonic_ms: null as number | null,
    duration_ms: 0, read_count: 0, timeout: false, skipped: null as string | null, error: null as string | null, data: undefined as unknown }
  if (scenarioDeadline - started < 25000) {
    record.skipped = 'INSUFFICIENT_CLEANUP_BUDGET'; record.ended_monotonic_ms = now(); throw failure
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    record.read_count = 1
    const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { record.timeout = true; resolve(undefined) }, 5000) })
    record.data = await Promise.race([Promise.resolve().then(read), timeout])
  } catch { record.error = 'SNAPSHOT_READ_FAILED' }
  finally {
    clearTimeout(timer); record.ended_monotonic_ms = now(); record.duration_ms = record.ended_monotonic_ms - started
  }
  throw failure
}

// Serialized into the renderer. Strip values here, before returning to Node.
export async function candidateSnapshotInRenderer({ taskId, requestId }: { taskId: string; requestId: string }) {
  const started = performance.now()
  const label = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null
  const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value :
    typeof value === 'string' && /^[0-9TZ:+.-]{1,40}$/.test(value) ? value : null
  const select = (value: any, keys: string[]) => Object.fromEntries(keys.map(key => [key, typeof value?.[key] === 'number' ? time(value[key]) : label(value?.[key])]))
  const get = async (request: any): Promise<any> => {
    try { const value = await window.trellis.request(request); return value.ok ? { ok: true, data: value.data } : { ok: false, code: label(value.error.code) } }
    catch { return { ok: false, code: 'SNAPSHOT_RPC_FAILED' } }
  }
  const [request, calls, plugins] = await Promise.all([
    get({ type: 'request.status', task_id: taskId, request_id: requestId }),
    get({ type: 'task.query', task_id: taskId, query: { type: 'list', input: { kind: 'call' } } }),
    get({ type: 'plugin.list', task_id: taskId })
  ])
  const runId = request.ok ? request.data.run_id : null
  const matching = calls.ok ? calls.data.items.filter((item: any) => item.run_id === runId).slice(0, 1) : []
  // A stalled first batch must never start another read after the outer budget.
  const canReadMetadata = performance.now() - started < 4500
  const [call, run] = await Promise.all([
    canReadMetadata && matching.length ? get({ type: 'task.query', task_id: taskId, query: { type: 'read', input: { target: { kind: 'call', id: matching[0].id } } } }) : Promise.resolve({ ok: false, code: 'CALL_METADATA_UNAVAILABLE' }),
    canReadMetadata && runId ? get({ type: 'task.query', task_id: taskId, query: { type: 'read', input: { target: { kind: 'run', id: runId } } } }) : Promise.resolve({ ok: false, code: 'RUN_METADATA_UNAVAILABLE' })
  ])
  return {
    request: request.ok ? { ...select(request.data, ['request_id', 'run_id', 'state', 'run_state', 'code']), created_at: time(request.data.created_at) } : request,
    call: call.ok ? { ...select(call.data.data, ['id', 'run_id', 'state', 'dispatch', 'execution', 'delivery']), created_at: time(call.data.data.created_at), ended_at: time(call.data.data.ended_at),
      result_execution: label(call.data.data?.result_data?.execution), result_error: label(call.data.data?.result_data?.error?.code) } : call,
    run: run.ok ? { ...select(run.data.data, ['id', 'state', 'primary_reason', 'wait_reason']), created_at: time(run.data.data.created_at), ended_at: time(run.data.data.ended_at) } : run,
    plugin_instances: plugins.ok ? plugins.data.items.filter((item: any) => item.id === 'trellis.pdf-text').slice(0, 4).map((item: any) => ({
      plugin: item.id, instances: item.instances.slice(0, 8).map((instance: any) => select(instance, ['instance_id', 'call_id', 'state', 'pending', 'cleanup_error'])) })) : plugins,
    listed_calls: calls.ok ? calls.data.items.length : null
  }
}

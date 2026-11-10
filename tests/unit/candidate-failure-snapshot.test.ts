import { afterEach, expect, it, vi } from 'vitest'
import { captureCandidateFailure, candidateSnapshotInRenderer } from '../helpers/candidate-failure-snapshot'
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('keeps the identical original failure even if the read later observes completed', async () => {
  const original = Error('original five-second assertion'), report: Record<string, any> = {}
  const read = vi.fn(async () => ({ request: { run_state: 'completed' } }))
  await expect(captureCandidateFailure(original, report, 90000, read, () => 1000)).rejects.toBe(original)
  expect(read).toHaveBeenCalledTimes(1); expect(report.failure_snapshot.read_count).toBe(1)
  expect(report.failure_snapshot.data.request.run_state).toBe('completed')
  await expect(captureCandidateFailure(original, report, 90000, read, () => 1001)).rejects.toBe(original)
  expect(read).toHaveBeenCalledTimes(1)
})
it('keeps cleanup reachable when the snapshot fails without exposing its error message', async () => {
  const original = Error('original'), report: Record<string, any> = {}; let cleaned = false
  const work = async () => { try { await captureCandidateFailure(original, report, 90000, async () => { throw Error('SECRET_CREDENTIAL') }, () => 1000) } finally { cleaned = true } }
  await expect(work()).rejects.toBe(original); expect(cleaned).toBe(true)
  expect(report.failure_snapshot.error).toBe('SNAPSHOT_READ_FAILED'); expect(JSON.stringify(report)).not.toContain('SECRET_CREDENTIAL')
})
it('reads once for at most five seconds and then throws the original failure', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  const original = Error('original'), report: Record<string, any> = {}, read = vi.fn(() => new Promise(() => {}))
  const outcome = captureCandidateFailure(original, report, 90000, read, () => Date.now()).catch(error => error)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await outcome).toBe(original); expect(read).toHaveBeenCalledTimes(1)
  expect(report.failure_snapshot).toMatchObject({ timeout: true, duration_ms: 5000, read_count: 1, started_monotonic_ms: 1000, ended_monotonic_ms: 6000 })
})
it.each([24000, 0, -1])('skips reads if only %s ms remain before the scenario deadline', async remaining => {
  const original = Error('original'), report: Record<string, any> = {}, read = vi.fn()
  await expect(captureCandidateFailure(original, report, 1000 + remaining, read, () => 1000)).rejects.toBe(original)
  expect(read).not.toHaveBeenCalled(); expect(report.failure_snapshot.skipped).toBe('INSUFFICIENT_CLEANUP_BUDGET')
})
it('strips prompts, arguments, body, credentials and model configuration in the renderer', async () => {
  const requests: any[] = []
  vi.stubGlobal('window', { trellis: { request: async (request: any) => {
    requests.push(request)
    if (request.type === 'request.status') return { ok: true, data: { request_id: 'request-one', run_id: 'run-one', state: 'active', run_state: 'running', text: 'PRIVATE_PROMPT', model_selection: 'SECRET_KEY', created_at: 100 } }
    if (request.type === 'plugin.list') return { ok: true, data: { items: [{ id: 'trellis.pdf-text', secret: 'SECRET_KEY', instances: [{ instance_id: 'instance-one', call_id: 'call-one', state: 'executing_or_finalizing', pending: 1, cleanup_error: null, environment: 'SECRET_ENV' }] }] } }
    if (request.query.type === 'list') return { ok: true, data: { items: [{ id: 'call-one', run_id: 'run-one', body: 'PRIVATE_BODY' }] } }
    if (request.query.input.target.kind === 'call') return { ok: true, data: { data: { id: 'call-one', state: 'executing', dispatch: 'sent', execution: null, delivery: 'pending', created_at: '2026-11-10T10:41:16.000Z', arguments: 'PRIVATE_BODY', result_data: { error: { code: 'TEST_CODE', message: 'SECRET_KEY' } } } } }
    return { ok: true, data: { data: { id: 'run-one', state: 'running', wait_reason: 'tool_pending', budget: 'PRIVATE_BODY' } } }
  } } })
  const result = await candidateSnapshotInRenderer({ taskId: 'task-one', requestId: 'request-one' })
  expect(result.request).toMatchObject({ run_state: 'running' })
  expect(result.call).toMatchObject({ state: 'executing', dispatch: 'sent', created_at: '2026-11-10T10:41:16.000Z' })
  expect(result.plugin_instances[0].instances[0]).toMatchObject({ instance_id: 'instance-one', call_id: 'call-one', pending: 1 })
  expect(requests).toHaveLength(5); expect(requests.every(r => r.task_id === 'task-one' && ['request.status', 'task.query', 'plugin.list'].includes(r.type))).toBe(true)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|SECRET_/)
})
it('does not start follow-up metadata reads when the first batch exhausts the evidence budget', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(4500), requests: any[] = []
  vi.stubGlobal('window', { trellis: { request: async (request: any) => {
    requests.push(request)
    if (request.type === 'request.status') return { ok: true, data: { run_id: 'run-one', run_state: 'running' } }
    if (request.type === 'plugin.list') return { ok: true, data: { items: [] } }
    return { ok: true, data: { items: [{ id: 'call-one', run_id: 'run-one' }] } }
  } } })
  const result = await candidateSnapshotInRenderer({ taskId: 'task-one', requestId: 'request-one' })
  expect(clock).toHaveBeenCalledTimes(2); expect(requests).toHaveLength(3)
  expect(result.call).toEqual({ ok: false, code: 'CALL_METADATA_UNAVAILABLE' })
})

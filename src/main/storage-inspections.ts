import { randomUUID } from 'node:crypto'
import type { InspectionRequest } from '../runtime/storage-inspection'
type Process = { postMessage(value: unknown): void; kill(): boolean; on(event: string, callback: (...args: any[]) => void): unknown }
type Job = { id: string; phase: 'running' | 'completed' | 'cancelled' | 'failed'; started_at: string; progress: unknown; result: unknown }
// Ephemeral, host-only observations. No authority or recovery facts are persisted here.
export class StorageInspections {
  private jobs = new Map<string, Job>()
  private child?: Process
  private timer?: ReturnType<typeof setTimeout>
  constructor(private launch: () => Process) {}
  handle(request: any): unknown {
    if (request.type === 'storage.inspect.start') {
      if (this.child) throw new Error('INSPECT_BUSY')
      if ((request.scope === 'resource') !== !!request.resource_id || (request.scope !== 'resources' && request.after !== undefined)) throw new Error('INSPECT_SCOPE_INVALID')
      while (this.jobs.size >= 4) this.jobs.delete(this.jobs.keys().next().value!)
      const job: Job = { id: randomUUID(), phase: 'running', started_at: new Date().toISOString(), progress: { phase: 'starting', checked: 0 }, result: null }
      this.jobs.set(job.id, job)
      try {
        const child = this.launch(); this.child = child
        const finish = (phase: Job['phase']) => { if (job.phase !== 'running') return; job.phase = phase; clearTimeout(this.timer); if (this.child === child) this.child = undefined; child.kill() }
        child.on('message', (message: any) => {
          if (job.phase !== 'running') return
          if (message.progress) job.progress = message.progress
          if (message.result) { job.result = message.result; finish(message.result.complete ? 'completed' : 'failed') }
        })
        child.on('exit', () => { if (job.phase === 'running') { job.result = { error: 'INSPECT_PROCESS_EXIT', complete: false }; finish('failed') } })
        this.timer = setTimeout(() => { if (job.phase === 'running') { job.result = { error: 'INSPECT_TIME_LIMIT', complete: false }; finish('failed') } }, 120000)
        this.timer.unref?.(); child.postMessage({ scope: request.scope, ...(request.resource_id ? { resource_id: request.resource_id } : {}), ...(request.after !== undefined ? { after: request.after } : {}) } satisfies InspectionRequest)
      } catch { clearTimeout(this.timer); job.phase = 'failed'; job.result = { error: 'INSPECT_START_FAILED', complete: false }; this.child?.kill(); this.child = undefined }
      return structuredClone(job)
    }
    const job = this.jobs.get(request.job_id); if (!job) throw new Error('INSPECT_JOB_UNAVAILABLE')
    if (request.type === 'storage.inspect.cancel' && job.phase === 'running') { job.phase = 'cancelled'; job.result = { error: 'INSPECT_CANCELLED', complete: false, readonly: true, deletion_authority: false }; clearTimeout(this.timer); this.child?.kill(); this.child = undefined }
    return structuredClone(job)
  }
  close(): void { clearTimeout(this.timer); this.child?.kill(); this.child = undefined }
}

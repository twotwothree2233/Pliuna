import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { ContractError } from '../shared/validation'
import { digest, resourceBody } from './resources'
import { generateExportBody, type ExportInput } from './export-generation'
import type { ExportIssue } from './static-export'
import { isBundleMediaType } from '../shared/branding'

export interface CheckSnapshot {
  input: Omit<ExportInput, 'root'>
  bodies: { id: string; bytes?: Uint8Array; error?: string; observation?: string }[]
}
export interface CheckResult { complete: boolean; issues: ExportIssue[]; issue_codes: string[]; worker_metrics?: { elapsed_ms: number; rss_bytes: number; process_peak_rss_bytes: number; heap_used_bytes: number; external_bytes: number; array_buffer_bytes: number } }
export interface CheckGeneration { result: Promise<CheckResult>; stop(): Promise<void> }
export type CheckRunner = (snapshot: CheckSnapshot) => CheckGeneration
export function captureCheck(input: ExportInput): { snapshot: CheckSnapshot; fingerprint: string; bytes: number; capture_ms: number; copy_ms: number } {
  const started = performance.now()
  let bytes = 0, copy_ms = 0
  const bodies = input.resources.map(resource => {
    try {
      const verified = resourceBody(input.root, resource as any), start = performance.now()
      // A dedicated transferable allocation never detaches Node's shared Buffer pool.
      const body = Uint8Array.from(verified)
      copy_ms += performance.now() - start; bytes += body.byteLength
      return { id: resource.id, bytes: body }
    } catch (error) {
      if (isBundleMediaType(resource.media_type) || !(error instanceof ContractError)) throw error
      let observation = 'unavailable'
      if (/^[a-zA-Z0-9_-]+$/.test(resource.storage_key)) {
        try {
          const stat = lstatSync(join(input.root, 'resources', resource.storage_key), { bigint: true })
          observation = digest(Buffer.from([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink, stat.mode].join(',')))
        } catch { /* The missing resource is an omission, not a regenerated asset. */ }
      }
      return { id: resource.id, error: error.code, observation }
    }
  })
  const { root: _root, ...fixed } = input
  const snapshot = { input: fixed, bodies }
  return { snapshot, fingerprint: checkFingerprint(snapshot), bytes, capture_ms: performance.now() - started, copy_ms }
}
export function checkFingerprint(snapshot: CheckSnapshot): string {
  return digest(Buffer.from(JSON.stringify([snapshot.input, snapshot.bodies.map(b => [b.id, b.error ? [b.error, b.observation] : createHash('sha256').update(b.bytes!).digest('hex')]) ])))
}
export function generateCheck(snapshot: CheckSnapshot): CheckResult {
  const bodies = new Map(snapshot.bodies.map(b => [b.id, b])), issues: ExportIssue[] = []
  const generated = generateExportBody(snapshot.input, resource => {
    const body = bodies.get(resource.id)
    if (!body || body.error) throw new ContractError(body?.error ?? 'RESOURCE_MISSING', 'Snapshot resource is unavailable')
    return Buffer.from(body.bytes!.buffer, body.bytes!.byteOffset, body.bytes!.byteLength)
  }, issue => issues.push(issue))
  return { complete: generated.issues.length === 0, issues, issue_codes: generated.issues }
}

type Phase = 'checking' | 'cancelling' | 'cancelled' | 'ready' | 'failed' | 'invalidated'
interface Check {
  id: string; task: string; phase: Phase; generation?: CheckGeneration; stopped?: Promise<void>; result?: CheckResult; error?: string
  fingerprint: string; metrics: { snapshot_bytes: number; capture_ms: number; copy_ms: number; dispatch_ms: number }; validate(): void
}
export class ExportChecks {
  private current?: Check
  constructor(private runner: CheckRunner) {}
  busy(): boolean { return !!this.current?.generation }
  start(task: string, captured: ReturnType<typeof captureCheck>, validate: () => void, decorate: (result: CheckResult) => CheckResult = result => result): unknown {
    if (this.busy()) throw new ContractError('EXPORT_CHECK_BUSY', 'Cancel the active check and wait for worker exit before starting another')
    const started = performance.now(), generation = this.runner(captured.snapshot)
    const check: Check = { id: randomUUID(), task, phase: 'checking', generation, fingerprint: captured.fingerprint, validate, metrics: { snapshot_bytes: captured.bytes, capture_ms: captured.capture_ms, copy_ms: captured.copy_ms, dispatch_ms: performance.now() - started } }
    this.current = check
    // Runners settle only after worker exit; no result is installed while cancelling.
    void generation.result.then(result => {
      if (check.phase !== 'checking') return
      try { check.validate(); check.result = decorate(result); check.phase = 'ready' }
      catch { check.phase = 'invalidated'; check.error = 'EXPORT_SOURCE_CHANGED' }
    }, error => {
      if (check.phase === 'checking') { check.phase = 'failed'; check.error = error instanceof ContractError ? error.code : 'EXPORT_CHECK_FAILED' }
    }).finally(() => { check.generation = undefined; if (check.phase === 'cancelling') check.phase = 'cancelled'; if (check.phase !== 'ready') check.validate = () => {} })
    return this.status(task, check.id, 0)
  }
  private get(task: string, id: string): Check {
    if (!this.current || this.current.id !== id || this.current.task !== task) throw new ContractError('EXPORT_CHECK_NOT_FOUND', 'Check is absent or expired; checks do not survive restart')
    return this.current
  }
  status(task: string, id: string, offset: number): unknown {
    const check = this.get(task, id)
    if (check.phase === 'ready') {
      try { check.validate() } catch { check.result = undefined; check.phase = 'invalidated'; check.error = 'EXPORT_SOURCE_CHANGED'; check.validate = () => {} }
    }
    const result = check.result
    return { id: check.id, phase: check.phase, exited: !check.generation, ...(check.error ? { error: check.error } : {}), metrics: { ...check.metrics, ...result?.worker_metrics },
      ...(result ? { complete: result.complete, selection_hash: check.fingerprint, issues: result.issues.slice(offset, offset + 50), issue_count: result.issues.length, offset, next_offset: offset + 50 < result.issues.length ? offset + 50 : null } : {}),
      notice: 'Read-only in-memory check. No persistent job or pin. Actual export validates independently.' }
  }
  cancel(task: string, id: string): unknown {
    const check = this.get(task, id)
    check.result = undefined
    if (check.generation) {
      check.phase = 'cancelling'
      check.stopped ??= check.generation.stop().then(() => { check.generation = undefined; check.phase = 'cancelled'; check.validate = () => {} })
      void check.stopped.catch(() => { check.error = 'EXPORT_CHECK_STOP_UNCONFIRMED' })
    } else { check.phase = 'cancelled'; check.validate = () => {} }
    return this.status(task, id, 0)
  }
  async stop(task?: string): Promise<void> {
    const check = this.current
    if (!check || task !== undefined && check.task !== task) return
    this.cancel(check.task, check.id)
    await check.stopped
    if (this.current === check) this.current = undefined
  }
}

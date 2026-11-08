import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, expect, it, vi } from 'vitest'
import { setTimeout as yieldReports } from 'node:timers/promises'
import * as permissions from '../../src/platform/permissions'
import { RuntimeStore } from '../../src/runtime/store'

type Sample = { index: number; initialize_ms: number; acl_ms: number; acl_calls: number; initialized: boolean }
const enabled = process.env.TRELLIS_WINDOWS11_ACL_PERFORMANCE === '1', samples: Sample[] = []
const p95 = () => samples.length ? samples.map(s => s.initialize_ms).sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]! : null
const targetHost = () => {
  if (process.platform !== 'win32' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP' || !process.env.TRELLIS_WIN11_EVIDENCE) throw Error('DESIGNATED_WINDOWS11_HOST_REQUIRED')
}
afterAll(() => {
  if (!enabled) return
  targetHost()
  const report = { samples, p95_ms: p95(), target_ms: 5000, original_hook_ms: 10000,
    passed: samples.length === 20 && samples.every(s => s.initialized && s.initialize_ms < 10000) && p95()! < 5000 }
  fs.writeFileSync(join(process.env.TRELLIS_WIN11_EVIDENCE!, 'acl-performance.json'), JSON.stringify(report, null, 2) + '\n')
  console.log('WINDOWS_ACL_PERFORMANCE ' + JSON.stringify(report))
})
for (let index = 1; index <= 20; index++) it.skipIf(!enabled)(`initializes fresh isolated directory ${index} within the original hook budget`, async () => {
  targetHost()
  const root = fs.mkdtempSync(join(tmpdir(), 'trellis-acl-performance-'))
  const sample: Sample = { index, initialize_ms: 0, acl_ms: 0, acl_calls: 0, initialized: false }
  const original = permissions.protectPrivatePath
  const spy = vi.spyOn(permissions, 'protectPrivatePath').mockImplementation((file, kind, hidden) => {
    const start = performance.now()
    try { return original(file, kind, hidden) } finally { sample.acl_calls++; sample.acl_ms += performance.now() - start }
  })
  let store: RuntimeStore | undefined
  const start = performance.now()
  try {
    try { store = new RuntimeStore(root, undefined, { viewReplacement: true }); sample.initialized = true }
    finally { sample.initialize_ms = performance.now() - start; spy.mockRestore() }
    expect(sample.initialize_ms).toBeLessThan(10000)
    expect(sample.acl_calls).toBeGreaterThan(0)
    expect(store.handle({ type: 'maintenance.status' })).toMatchObject({ phase: 'idle' })
  } finally {
    samples.push(sample)
    try { store?.close() } finally { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) }
  }
  await yieldReports(0)
})
it.skipIf(!enabled)('keeps p95 initialization below five seconds over twenty new directories', () => {
  expect(samples).toHaveLength(20)
  expect(samples.every(s => s.initialized)).toBe(true)
  expect(p95()).toBeLessThan(5000)
})

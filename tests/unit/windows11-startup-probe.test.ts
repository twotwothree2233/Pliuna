import { expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import { setTimeout as yieldReports } from 'node:timers/promises'
import * as permissions from '../../src/platform/permissions'
import { RuntimeStore } from '../../src/runtime/store'

it.skipIf(process.platform !== 'win32' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP' || process.env.TRELLIS_WINDOWS11_STARTUP_PROBE !== '1')('measures real private ACL calls and isolated startup without changing their behavior', async () => {
  const evidence = process.env.TRELLIS_WIN11_EVIDENCE
  if (!evidence) throw Error('WINDOWS11_EVIDENCE_REQUIRED')
  const root = fs.mkdtempSync(join(os.tmpdir(), 'trellis-win11-startup-'))
  const phases: { name: string; elapsed_ms: number }[] = []
  const acl: { path: string; kind: string; elapsed_ms: number }[] = []
  const report = { node: process.version, logical_cpus: os.availableParallelism(),
    total_memory_mb: Math.round(os.totalmem() / 1024 ** 2),
    free_memory_mb: Math.round(os.freemem() / 1024 ** 2), phases, acl }
  function measure<T>(name: string, operation: () => T): T {
    const start = performance.now()
    try { return operation() } finally { phases.push({ name, elapsed_ms: Math.round(performance.now() - start) }) }
  }
  const original = permissions.protectPrivatePath
  vi.spyOn(permissions, 'protectPrivatePath').mockImplementation((file, kind, hidden) => {
    const start = performance.now()
    try { return original(file, kind, hidden) }
    finally { acl.push({ path: relative(root, file), kind, elapsed_ms: Math.round(performance.now() - start) }) }
  })
  let store: RuntimeStore | undefined
  try {
    store = measure('initialize', () => new RuntimeStore(root, undefined, { viewReplacement: true }))
    measure('create_task', () => store!.create('Windows 11 isolated startup probe'))
    expect(store.tasks()).toHaveLength(1)
    expect(measure('maintenance_status', () => store!.handle({ type: 'maintenance.status' }))).toMatchObject({ phase: 'idle' })
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw Error('WINDOWS_SYSTEM_ROOT_REQUIRED')
    for (let index = 1; index <= 3; index++) measure('powershell_baseline_' + index, () => {
      expect(execFileSync(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("[Console]::Write('ok')", 'utf16le').toString('base64')],
        { encoding: 'utf8', timeout: 15000, windowsHide: true,
          env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } })).toBe('ok')
    })
  } finally {
    try { if (store) measure('close', () => store!.close()) }
    finally {
      vi.restoreAllMocks()
      try { measure('cleanup', () => fs.rmSync(root, { recursive: true, force: true })) }
      finally {
        fs.writeFileSync(join(evidence, 'file-startup-timing.json'), JSON.stringify(report, null, 2) + '\n')
        console.log('WINDOWS11_STARTUP_TIMING ' + JSON.stringify(report))
      }
    }
  }
  await yieldReports(0)
})

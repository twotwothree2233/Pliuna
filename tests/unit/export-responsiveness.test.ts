import { expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import type { Bundle } from '../../src/shared/contracts.generated'

it('measures synchronous selection preflight and a queued independent read within existing quotas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-export-response-audit-'))
  vi.useFakeTimers()
  const store = new RuntimeStore(root), task = store.create('Synthetic export response baseline').task.id
  const run = store.start(task, 'held synthetic fixture', 'fixture', [])
  const db = new Database(join(root, 'pliuna.sqlite'))
  try {
    const viewIds: string[] = []
    const bundle: Bundle = {
      profile: 'managed-v1',
      html: '<section id="lesson"><table>' + Array.from({ length: 1800 }, (_, i) => `<tr><td>ROW-${i}</td><td>${i}</td></tr>`).join('') + '</table></section>',
      css: 'table{border-collapse:collapse}td{padding:4px}',
      state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'baseline' },
      forms: [], behaviors: [], references: [],
      export: [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }]
    }
    for (let i = 0; i < 50; i++) {
      const surface = db.prepare('SELECT id,revision FROM surfaces WHERE task_id=?').get(task) as any
      store.modelTool(task, run, { type: 'write', input: { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'v' + i, slot_id: 'main', bundle: { type: 'inline', bundle } }] } })
      viewIds.push((db.prepare('SELECT id FROM views ORDER BY rowid DESC LIMIT 1').get() as any).id)
    }
    store.handle({ type: 'run.cancel', task_id: task, run_id: run })
    vi.useRealTimers()
    const results: unknown[] = []
    for (const count of [1, 10, 50]) {
      const selection = { type: 'export.check', task_id: task, view_ids: viewIds.slice(0, count), answer_ids: [] }
      const samples: unknown[] = []
      for (let attempt = 0; attempt <= (count === 50 ? 5 : 20); attempt++) {
        let resolve_ms = 0
        const resolve = (store as any).resolveExportSelection.bind(store)
        const measured = vi.spyOn(store as any, 'resolveExportSelection').mockImplementation((request: any) => {
          const started = performance.now(), result = resolve(request)
          resolve_ms += performance.now() - started
          return result
        })
        const start = performance.now()
        const read = new Promise<number>(resolve => setTimeout(() => {
          store.handle({ type: 'export.list', task_id: task })
          resolve(performance.now() - start)
        }, 0))
        const check: any = store.handle(selection)
        const preflight_ms = performance.now() - start
        measured.mockRestore()
        expect(check).toMatchObject({ complete: true, issues: [] })
        samples.push({ attempt, warmup: attempt === 0, resolve_ms, conversion_and_hash_ms: preflight_ms - resolve_ms, preflight_ms, queued_read_ms: await read, rss_bytes: process.memoryUsage().rss })
      }
      results.push({ views: count, rows: count * 1800, samples })
    }
    console.log('EXPORT_RESPONSE_BASELINE', JSON.stringify({ root, runtime: process.versions, bundle_bytes: Buffer.byteLength(JSON.stringify(bundle)), results }))
    expect(store.handle({ type: 'export.list', task_id: task })).toEqual([])
  } finally { db.close(); store.close(); vi.useRealTimers() }
}, 120000)

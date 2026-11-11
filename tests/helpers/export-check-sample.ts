import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import type { Bundle } from '../../src/shared/contracts.generated'

export function exportCheckSample() {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-async-export-sample-')), store = new RuntimeStore(root), task = store.create('Async export acceptance synthetic').task.id
  const run = store.start(task, 'held synthetic fixture', 'fixture', []), db = new Database(join(root, 'pliuna.sqlite')), views: string[] = []
  const bundle: Bundle = { profile: 'managed-v1', html: '<section id="lesson"><h2>LONG_TABLE</h2><table>' + Array.from({ length: 1800 }, (_, i) => `<tr><td>ROW-${i}</td><td>${i}</td></tr>`).join('') + '</table><label for="draft">Saved draft</label><input id="draft"><button id="send">Submit</button></section>', css: 'table{border-collapse:collapse}td{padding:4px}', state: { schema: { type: 'object', properties: { draft: { type: 'string' } }, required: ['draft'], additionalProperties: false }, initial: { draft: '' }, compatibility_version: 'async-1' }, forms: [{ id: 'form', fields: ['/draft'] }], behaviors: [{ type: 'input', element_id: 'draft', field: '/draft', control: 'text' }, { type: 'submit', element_id: 'send', form_id: 'form' }], references: [], export: [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }] }
  try {
    for (let i = 0; i < 50; i++) {
      const surface: any = db.prepare('SELECT id,revision FROM surfaces WHERE task_id=?').get(task)
      store.modelTool(task, run, { type: 'write', input: { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'v' + i, slot_id: 'main', bundle: { type: 'inline', bundle } }] } })
      views.push((db.prepare('SELECT id FROM views ORDER BY rowid DESC LIMIT 1').get() as any).id)
    }
    store.handle({ type: 'run.cancel', task_id: task, run_id: run })
    return { root, task, views, bundle_bytes: Buffer.byteLength(JSON.stringify(bundle)) }
  } finally { db.close(); store.close() }
}

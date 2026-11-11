import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { managedControls } from '../helpers/managed-controls'

it('blocks historical top-layer presentation without altering source, draft or history across restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-top-layer-history-'))
  let store = new RuntimeStore(root)
  const initial = store.create('Historical top-layer fixture'), task = initial.task.id
  const run = store.start(task, 'held fixture', 'fixture', [])
  clearTimeout((store as any).timers.get(run)); (store as any).timers.delete(run)
  const safe = managedControls()
  store.modelTool(task, run, {type:'write',input:{type:'surface.update',surface_id:initial.surface.id,expected_revision:1,operations:[0,1].map(i=>({type:'view.create',client_ref:'v'+i,slot_id:'main',bundle:{type:'inline',bundle:safe}}))}})
  const before = store.snapshot(task), view = before.views[0]!
  const old = structuredClone(safe)
  old.html += `<button popovertarget="v-${view.id}-cover">Open</button><aside id="cover" popover="manual" style="position:fixed;inset:0">COVER</aside>`
  const resource: any = store.modelTool(task, run, {type:'write',input:{type:'resource.create',display_name:'historical-bundle.json',content:{type:'json',value:old}}})
  const resourceId = resource.data.id
  const db = new Database(join(root,'pliuna.sqlite'))
  // Simulate a bundle accepted by the previous publisher, not a new validation bypass.
  db.prepare('UPDATE views SET bundle_resource_id=? WHERE id=?').run(resourceId,view.id)
  db.prepare('UPDATE view_history SET bundle_resource_id=? WHERE view_id=?').run(resourceId,view.id)
  const history = db.prepare('SELECT * FROM view_history WHERE view_id=?').all(view.id)
  const draft = db.prepare('SELECT draft_json,state_revision,revision FROM views WHERE id=?').get(view.id)
  const bytes = readFileSync(join(root,'resources',resourceId))
  const check = () => {
    const snapshot = store.snapshot(task)
    expect(snapshot.views[0]).toMatchObject({id:view.id,presentation:{html:'',css:'',error:{code:'VIEW_TOP_LAYER_DISABLED'}}})
    expect(snapshot.views[0]!.bundle).toEqual(old)
    expect(snapshot.views[1]!.presentation.html).toContain('Visible checkbox')
    expect(snapshot.views[1]!.presentation.error).toBeUndefined()
    expect(db.prepare('SELECT * FROM view_history WHERE view_id=?').all(view.id)).toEqual(history)
    expect(db.prepare('SELECT draft_json,state_revision,revision FROM views WHERE id=?').get(view.id)).toEqual(draft)
    expect(readFileSync(join(root,'resources',resourceId))).toEqual(bytes)
  }
  try { check(); store.close(); store = new RuntimeStore(root); check() }
  finally { store.close(); db.close() }
})

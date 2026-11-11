import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { ExportControl } from '../../src/runtime/export-control'
import { RuntimeStore } from '../../src/runtime/store'
import { RestoreJournal } from '../../src/runtime/restore-journal'
const roots: string[] = [], close: { close(): void }[] = []
const root = () => { const r = mkdtempSync(join(tmpdir(), 'pliuna-export-control-')); roots.push(r); return r }
const open = (r: string, established = false) => { const c = new ExportControl(r, established); close.push(c); return c }
const resource = () => ({ id: randomUUID(), storage_key: randomUUID(), sha256: 'a'.repeat(64), byte_length: 1, media_type: 'text/plain', display_name: 'synthetic' })
afterEach(() => { vi.unstubAllEnvs(); close.splice(0).reverse().forEach(c => c.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })) })
describe('independent export authority', () => {
  it('pins before preview and keeps private paths out of all public summaries', () => {
    const c = open(root()), r = resource(), job = c.create(randomUUID(), randomUUID(), 'pliuna.sqlite', [r], { revision: 1 })
    expect(c.protects(r.id)).toBe(true); expect(c.protects(r.storage_key)).toBe(true)
    c.preview(job.id, '<!doctype html><p>synthetic</p>', [])
    c.beginSave(job.id, '/private/synthetic/output.html', '/private/synthetic/temporary', false)
    expect(JSON.stringify(c.list(job.task_id))).not.toContain('/private/')
    expect(() => c.cancel(job.id)).toThrow()
    c.finish(job.id, 'saved', null); c.cancel(job.id)
    expect(c.protects(r.id)).toBe(false); expect(c.get(job.id).phase).toBe('saved')
  })
  it('does not resume or release interrupted and unknown work after restart', () => {
    const r = root(), c = open(r), material = resource(), j = c.create(randomUUID(), randomUUID(), 'pliuna.sqlite', [material], {})
    c.preview(j.id, '<p>data</p>', []); c.close()
    const restarted = open(r, true)
    expect(restarted.get(j.id).phase).toBe('interrupted'); expect(restarted.busy()).toBe(true)
    restarted.cancel(j.id); expect(restarted.busy()).toBe(false)
    const j2 = restarted.create(randomUUID(), randomUUID(), 'pliuna.sqlite', [material], {})
    restarted.preview(j2.id, '<p>data</p>', []); restarted.beginSave(j2.id, '/private/synthetic/result', '/private/synthetic/temp', false); restarted.close()
    const again = open(r, true); expect(again.get(j2.id).phase).toBe('unknown'); expect(again.protects(material.id)).toBe(true)
    expect(() => again.cancelTask(j2.task_id)).toThrow()
  })
  it('requires explicit partial confirmation and never reopens terminal jobs', () => {
    const c = open(root()), j = c.create(randomUUID(), randomUUID(), 'pliuna.sqlite', [], {})
    c.preview(j.id, '<p>omitted</p>', ['MISSING_STATIC'])
    expect(() => c.beginSave(j.id, '/a', '/b', false)).toThrow()
    c.cancel(j.id); expect(() => c.beginSave(j.id, '/a', '/b', true)).toThrow()
  })
  it('establishes v5 and refuses missing dependency without recreating it', () => {
    vi.stubEnv('PLIUNA_TEST_FILE_IDENTITIES', '')
    const r = root(), store = new RuntimeStore(r); store.close()
    const db = new Database(join(r, 'restore-control.sqlite'))
    expect(JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest)).toMatchObject({ version: 5, export_control: 1 }); db.close()
    expect(readFileSync(join(r, 'restore-established'), 'utf8')).toBe('restore-v5\n')
    unlinkSync(join(r, 'export-control.sqlite'))
    expect(() => new RuntimeStore(r)).toThrow(); expect(() => readFileSync(join(r, 'export-control.sqlite'))).toThrow()
  })
  it('rejects corrupt controls and a marker downgrade', () => {
    const r = root(), store = new RuntimeStore(r); store.close()
    writeFileSync(join(r, 'export-control.sqlite'), 'corrupt')
    expect(() => new RuntimeStore(r)).toThrow()
    const r2 = root(), s2 = new RuntimeStore(r2); s2.close()
    const db = new Database(join(r2, 'restore-control.sqlite')), v = JSON.parse((db.prepare('SELECT manifest FROM restore_control').get() as any).manifest)
    delete v.export_control; v.version = 4; db.prepare('UPDATE restore_control SET manifest=?').run(JSON.stringify(v)); db.close()
    expect(() => new RuntimeStore(r2)).toThrow()
  })
  it('normalizes exact v4 without losing old deletion facts', () => {
    const v = { version: 4, selected: 'pliuna.sqlite', deleted_tasks: [randomUUID()], operations: [], verified_head: null, retirements: [], task_deletions: [], resource_cleanups: [] }
    expect(RestoreJournal.normalizeControl(v)).toEqual({ ...v, version: 5, export_control: 1 })
    expect(() => RestoreJournal.normalizeControl({ ...v, unknown: true })).toThrow()
  })
})

it.each(['preparing','preview','saving'] as const)('reconciles real SIGKILL at durable %s without replay or pin release', async phase => {
  const { spawn } = await import('node:child_process')
  const r = root(), c = open(r), material = resource(), job = c.create(randomUUID(),randomUUID(),'pliuna.sqlite',[material],{})
  if(phase!=='preparing')c.preview(job.id,'<p>fixed</p>',[])
  if(phase==='saving')c.beginSave(job.id,join(r,'output.html'),join(r,'registered.tmp'),false)
  c.close()
  const child=spawn(process.execPath,[join(process.cwd(),'tests/helpers/export-crash-worker.cjs'),r,phase],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']})
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('crash worker timeout'))},5000);child.stdout.on('data',data=>{if(String(data).includes('DURABLE_READY')){clearTimeout(timer);resolve()}});child.once('error',reject)})
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited
  const restarted=open(r,true);expect(restarted.get(job.id).phase).toBe(phase==='saving'?'unknown':'interrupted');expect(restarted.protects(material.id)).toBe(true)
})

it('validates versioned fragment snapshots without upgrading legacy manifests',()=>{
 const c=open(root()),answer=randomUUID(),history=randomUUID(),view=randomUUID()
 const snapshot={version:1,title:'Synthetic',views:[{view_id:view,history_id:history,view_revision:1,fragments:[{id:'feedback',category:'feedback',personal_binding:{version:1,answer_id:answer,view_history_id:history}}]}],answer_ids:[answer]}
 const j=c.create(randomUUID(),randomUUID(),'pliuna.sqlite',[],snapshot);expect(c.get(j.id).snapshot).toEqual(snapshot)
 for(const broken of [{...snapshot,version:2},{...snapshot,answer_ids:[]},{...snapshot,views:[{...snapshot.views[0],view_revision:0}]},{...snapshot,extra:true},{...snapshot,views:[{...snapshot.views[0],fragments:[{id:'feedback',category:'feedback'}]}]}]) expect(()=>ExportControl.validate({...j,snapshot:broken})).toThrow()
 c.cancel(j.id);const legacy=c.create(randomUUID(),randomUUID(),'pliuna.sqlite',[],{views:[],answer_ids:[]});expect(c.get(legacy.id).snapshot).toEqual({views:[],answer_ids:[]})
})

import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeStore } from '../../src/runtime/store'
import { validateModel } from '../../src/shared/validation'
import { digest } from '../../src/runtime/resources'
import { randomUUID } from 'node:crypto'
let root: string, store: RuntimeStore, db: Database.Database, task: string, other: string
beforeEach(() => { vi.useFakeTimers(); root = mkdtempSync(join(tmpdir(), 'trellis-content-read-')); store = new RuntimeStore(root); db = new Database(join(root, 'trellis.sqlite')); task = store.create('synthetic content').task.id; other = store.create('other').task.id })
afterEach(() => { store.close(); db.close(); vi.useRealTimers() })
function save(text: string, media = 'text/plain; charset=utf-8') {
 const id = randomUUID(), bytes = Buffer.from(text); writeFileSync(join(root, 'resources', id), bytes)
 db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(id,id,digest(bytes),bytes.length,media,'synthetic','now'); db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task,id)
 return id
}
const read = (id: string, input: Record<string, unknown>, owner = task): Promise<any> => Promise.resolve(store.handle({ type: 'task.query', task_id: owner, query: { type: 'read', input: { target: { kind: 'resource', id }, ...input } } }))
it('uses default4000, accepts32000 Unicode codepoints and continues without loss or writes', async () => {
 const text = '中😀\\\n'.repeat(10000), id = save(text), count = db.prepare('SELECT count(*) n FROM records').get()
 const first = await read(id, { content: {} }); expect(first.actual_range.chars).toBe(4000); expect([...first.data.text]).toHaveLength(4000)
 let part = await read(id, { content: { max_chars: 32000 } }), whole = ''
 do { whole += part.data.text; expect(part.actual_range.chars).toBeLessThanOrEqual(32000); expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(262144); if (!part.next_cursor) break; part = await read(id, { cursor: part.next_cursor }) } while (true)
 expect(whole).toBe(text); expect(db.prepare('SELECT count(*) n FROM records').get()).toEqual(count)
 expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({n:0})
})
it('binds selections and subject, rejects broken UTF8 bounds, wrong representations and excessive counts', async () => {
 const id = save('中😀'.repeat(10000)), first = await read(id,{content:{max_chars:10}})
 await expect(read(id,{content:{offset_bytes:1}})).rejects.toThrow('UTF-8')
 await expect(read(id,{content:{end_bytes:2}})).rejects.toThrow('UTF-8')
 await expect(read(id,{cursor:first.next_cursor,content:{max_chars:11}})).rejects.toThrow('same selection')
 await expect(read(id,{content:{}},other)).rejects.toThrow('unavailable')
 await expect(read(save('{}','application/json'),{content:{}})).rejects.toThrow('UTF-8 text only')
 expect(()=>validateModel({type:'read',input:{target:{kind:'resource',id},content:{max_chars:32001}}})).toThrow()
 expect(()=>validateModel({type:'read',input:{target:{kind:'resource',id},content:{},range:{start_line:1,end_line:2}}})).toThrow()
})
it('rejects split UTF8 boundaries with exact safe neighbors without adjusting the read', async () => {
 const text = 'A中😀Z', id = save(text), records = db.prepare('SELECT count(*) n FROM records').get()
 for (const [offset, previous, next] of [[2,1,4],[3,1,4],[5,4,8],[6,4,8],[7,4,8]]) {
   await expect(read(id,{content:{offset_bytes:offset}})).rejects.toThrow(`offset_bytes=${offset} splits a UTF-8 character; nearest valid byte boundaries: ${previous}, ${next}`)
   await expect(read(id,{content:{end_bytes:offset}})).rejects.toThrow(`end_bytes=${offset} splits a UTF-8 character; nearest valid byte boundaries: ${previous}, ${next}`)
 }
 expect((await read(id,{content:{offset_bytes:1,end_bytes:8}})).data.text).toBe('中😀')
 expect(db.prepare('SELECT count(*) n FROM records').get()).toEqual(records)
})
it('rejects corrupted files, old cursors after restart and no-index pages',async()=>{
 const id=save('a'.repeat(20000)), first=await read(id,{content:{max_chars:10}})
 await expect(read(id,{content:{pages:{start:1,end:1}}})).rejects.toThrow('page index')
 writeFileSync(join(root,'resources',id),'b'.repeat(20000));await expect(read(id,{cursor:first.next_cursor})).rejects.toThrow('changed')
 store.close();store=new RuntimeStore(root);await expect(read(id,{cursor:first.next_cursor})).rejects.toThrow('Cursor')
})
it('rejects association deletion while asynchronous integrity verification is pending', async () => {
 const id = save('中😀'.repeat(10000)), pending = read(id, { content: { max_chars: 32000 } })
 db.prepare('DELETE FROM task_resources WHERE resource_id=?').run(id)
 await expect(pending).rejects.toThrow('association changed')
 expect(db.prepare('SELECT count(*) n FROM calls').get()).toEqual({n:0})
})
it.each(['', '\u0000'.repeat(40000), '😀'.repeat(40000), 'a'.repeat(40000), '\ufeff中😀'.repeat(12000)])('handles empty, escaped and maximum width text without exceeding response cap (%#)', async text => {
 const id=save(text), first=await read(id,{content:{max_chars:32000}})
 expect(first.actual_range.chars).toBe(Math.min(32000,[...text].length));expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(262144)
 expect(first.data.text).toBe([...text].slice(0,32000).join(''))
 const atEnd=await read(id,{content:{offset_bytes:Buffer.byteLength(text)}});expect(atEnd.data.text).toBe('');expect(atEnd.next_cursor).toBeNull()
})
it('measures bounded tail selection against legacy from-start JSON continuation without rewriting stored content', async () => {
 const text='unrelated material\n'.repeat(10000)+'TAIL_INDEPENDENT_EVIDENCE',id=save(text)
 let cursor:string|null=null,total=0,fragments=0,last:any
 do { last=await read(id,cursor?{cursor}:{});total+=Buffer.byteLength(JSON.stringify(last));fragments++;cursor=last.next_cursor } while(cursor)
 const selected=await read(id,{content:{offset_bytes:Buffer.byteLength(text)-25,max_chars:4000}}),bytes=Buffer.byteLength(JSON.stringify(selected))
 expect(selected.data.text).toContain('TAIL_INDEPENDENT_EVIDENCE');expect(bytes).toBeLessThan(total*0.1)
 console.info(JSON.stringify({benchmark:'same-tail-goal-not-equal-payload',resource_bytes:Buffer.byteLength(text),legacy_fragments:fragments,legacy_response_bytes:total,selected_response_bytes:bytes,reduction:1-bytes/total,real_api_requests:0}))
})

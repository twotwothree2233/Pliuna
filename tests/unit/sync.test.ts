import { expect, it, vi } from 'vitest'
import { TaskSync } from '../../src/runtime/sync'
import { applySync } from '../../src/renderer/src/sync'
import type { Snapshot } from '../../src/shared/types'
const snapshot = (revision = 1): Snapshot => ({ runtime_epoch: 'epoch', task: { id: 'task', title: 'test', state: 'active', revision }, surface: { id: 'surface', revision: 1 }, views: [], task_data: { items: [], total: 0 }, runs: [], records: [], approvals: [], answers: [], answer_total: 0, surface_updates: [] })
it('binds a consistent initial snapshot and sends only subsequent bounded changes', () => {
 const sync=new TaskSync(), first=sync.subscribe(snapshot());expect(first.snapshot).toEqual(snapshot())
 const cursor={runtime_epoch:first.runtime_epoch,cache_generation:first.cache_generation,sequence:first.sequence}, noChange=sync.subscribe(snapshot(),cursor);expect(noChange.deltas).toEqual([]);expect(noChange.snapshot).toBeUndefined()
 const next=sync.subscribe(snapshot(2),cursor);expect(next.deltas).toHaveLength(1);expect(applySync(first.snapshot!,cursor,next)).toEqual(snapshot(2))
})
it('recovers missing sequences, epoch changes and expired buffers via snapshot, never replaying requests',()=>{
 const sync=new TaskSync(), first=sync.subscribe(snapshot()); for(let n=2;n<1005;n++)sync.subscribe(snapshot(n))
 expect(sync.subscribe(snapshot(1005),first).snapshot).toBeDefined()
 expect(sync.subscribe({...snapshot(),runtime_epoch:'new'},{...first,sequence:1004}).snapshot?.runtime_epoch).toBe('new')
 const previous=snapshot();expect(applySync(previous,first,{runtime_epoch:'epoch',cache_generation:first.cache_generation,sequence:2,deltas:[{runtime_epoch:'epoch',task_id:'task',sequence:2,changes:[{type:'remove',target:{kind:'view',id:'old'}}]}]})).toBeNull()
})
it('invalidates large objects instead of pushing large content and leaves previous inputs untouched',()=>{
 const sync=new TaskSync(), old=snapshot(), first=sync.subscribe(old), next=snapshot(2);next.records=[{id:'huge',kind:'message.user',payload:{text:'x'.repeat(100000)},created_at:''}]
 const reply=sync.subscribe(next,first);expect(reply.deltas[0]?.changes[0]?.type).toBe('invalidate');expect(JSON.stringify(reply).length).toBeLessThan(1000)
 expect(applySync(old,first,reply)).toBeNull();expect(old.records).toEqual([])
})
it('always returns a fresh snapshot after eviction even when an old client cursor is zero',()=>{
 const sync=new TaskSync(), first=sync.subscribe(snapshot());for(let n=0;n<9;n++)sync.subscribe({...snapshot(),task:{...snapshot().task,id:'other-'+n}})
 const changed=snapshot(2);expect(sync.subscribe(changed,first).snapshot).toEqual(changed)
})
it('refreshes a stale page after another client has already reopened it', () => {
 const now = vi.spyOn(Date, 'now').mockReturnValue(0)
 try {
  const sync = new TaskSync(), original = snapshot(), first = sync.subscribe(original)
  now.mockReturnValue(60001)
  const changed = snapshot(2)
  sync.subscribe(changed, undefined, 10)
  const reopened = sync.subscribe(changed)
  expect(reopened.sequence).toBe(first.sequence)
  const resumed = sync.subscribe(changed, first)
  expect(resumed.snapshot).toEqual(changed)
  expect(applySync(original, first, resumed)).toEqual(changed)
  expect(sync.subscribe(changed, resumed).snapshot).toBeUndefined()
 } finally { now.mockRestore() }
})

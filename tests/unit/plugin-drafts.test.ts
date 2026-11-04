import { afterEach, expect, it, vi } from 'vitest'
import { PluginDrafts } from '../../src/runtime/plugins/drafts'
import type { PluginIdentity } from '../../src/runtime/plugins/process'
const identity: PluginIdentity = { instance_id: 'connection', digest: 'package', task_id: 'task', call_id: null }
const setup = () => new PluginDrafts(1000, () => {})
const stage = (drafts: PluginDrafts, value: unknown = { type: 'surface.update' }): any => drafts.stage(identity, 'task', value, () => {})
afterEach(() => vi.useRealTimers())
it('freezes the exact staged value and returns detached reads without granting authority', () => {
  const drafts = setup(), value = { title: 'before' }, result = stage(drafts, value)
  value.title = 'after'; const read = drafts.read(identity, 'task', result.draft_id) as any; read.title = 'changed'
  expect(drafts.read(identity, 'task', result.draft_id)).toEqual({ title: 'before' })
  expect(result.checks.authority).toBe('not_granted')
})
it('rejects other connections, tasks and package identities', () => {
  const drafts = setup(), result = stage(drafts)
  for (const [source, task] of [[{ ...identity, instance_id: 'other' }, 'task'], [{ ...identity, digest: 'other' }, 'task'], [{ ...identity, call_id: 'old-call' }, 'task'], [identity, 'other']] as const) expect(() => drafts.read(source, task, result.draft_id)).toThrow()
})
it('expires drafts and releases their capacity', () => {
  vi.useFakeTimers(); const drafts = setup(), result = stage(drafts)
  vi.advanceTimersByTime(1000); expect(() => drafts.read(identity, 'task', result.draft_id)).toThrow()
  expect(stage(drafts).draft_id).toBeTruthy()
})
it('does not register a failed inspection or invalid source', () => {
  const drafts = setup(); expect(() => drafts.stage(identity, 'task', {}, () => { throw Error('conflict') })).toThrow('conflict')
  for (let n = 0; n < 20; n++) stage(drafts)
  expect(() => stage(drafts)).toThrow()
  expect(() => new PluginDrafts(1000, () => { throw Error('revoked') }).stage(identity, 'task', {}, () => {})).toThrow('revoked')
})
it('revocation, stop and close invalidate drafts without deleting business data', () => {
  for (const invalidate of [(d: PluginDrafts) => d.revoke('package'), (d: PluginDrafts) => d.cancelTask('task'), (d: PluginDrafts) => d.close()]) {
    const drafts = setup(), result = stage(drafts); invalidate(drafts)
    expect(() => drafts.read(identity, 'task', result.draft_id)).toThrow()
  }
})
it('bounds individual draft size', () => { expect(() => stage(setup(), { body: 'x'.repeat(1024 * 1024) })).toThrow() })
it('binds a draft to one registered action while preserving its checks through commit', () => {
  const drafts = setup(), result = stage(drafts); let check!: () => void
  expect(drafts.submit(identity, 'task', result.draft_id, (value, valid) => { check = valid; return { action_id: 'original' } })).toEqual({ action_id: 'original' })
  expect(() => drafts.submit(identity, 'task', result.draft_id, () => 'duplicate')).toThrow()
  expect(check).not.toThrow(); drafts.revoke(identity.digest); expect(check).toThrow()
})
it('allows retry only when action registration itself failed', () => {
  const drafts = setup(), result = stage(drafts)
  expect(() => drafts.submit(identity, 'task', result.draft_id, () => { throw Error('capacity') })).toThrow('capacity')
  expect(drafts.submit(identity, 'task', result.draft_id, () => 'registered')).toBe('registered')
})
it('rechecks staged source facts at submit and final validity without rewriting the draft',()=>{
 const drafts=setup();let unchanged=true;const staged=drafts.stage(identity,'task',{resource:'original'},()=>()=>{if(!unchanged)throw Error('source changed')}) as any
 let check!:()=>void;drafts.submit(identity,'task',staged.draft_id,(value,valid)=>{expect(value).toEqual({resource:'original'});check=valid;return 'action'})
 unchanged=false;expect(check).toThrow('source changed')
 const other=setup(),s=other.stage(identity,'task',{},()=>()=>{throw Error('source changed')}) as any
 expect(()=>other.submit(identity,'task',s.draft_id,()=>{throw Error('must not register')})).toThrow('source changed')
})

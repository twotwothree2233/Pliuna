import type { Snapshot } from '../shared/types'
import type { SyncDelta } from '../shared/contracts.generated'
import defaults from '../shared/contracts/development-defaults.json'
export interface SyncCursor { runtime_epoch: string; cache_generation: number; sequence: number }
export interface SyncReply extends SyncCursor { snapshot?: Snapshot; deltas: SyncDelta[] }
interface State { snapshot: Snapshot; generation: number; sequence: number; deltas: { delta: SyncDelta; bytes: number }[]; bytes: number; accessed: number }
export class TaskSync {
  private states = new Map<string, State>()
  private nextGeneration = 1
  clear(): void { this.states.clear() }
  subscribe(snapshot: Snapshot, after?: SyncCursor, viewOffset = 0): SyncReply {
    const task = snapshot.task.id
    const pageKey = JSON.stringify([task, viewOffset])
    let state = this.states.get(pageKey)
    if (!state || state.snapshot.runtime_epoch !== snapshot.runtime_epoch) {
      state = { snapshot, generation: this.nextGeneration++, sequence: 0, deltas: [], bytes: 0, accessed: Date.now() }; this.states.set(pageKey, state)
    } else {
      const changes: SyncDelta['changes'][number][] = []
      const header = (s: Snapshot) => ({ ...s, views: [] })
      if (JSON.stringify(header(snapshot)) !== JSON.stringify(header(state.snapshot))) changes.push({ type: 'upsert', target: { kind: 'task', id: task }, value: header(snapshot) })
      for (const view of snapshot.views) {
        const old = state.snapshot.views.find(v => v.id === view.id)
        if (!old || JSON.stringify(old) !== JSON.stringify(view)) changes.push({ type: 'upsert', target: { kind: 'view', id: view.id }, value: view })
      }
      for (const old of state.snapshot.views) if (!snapshot.views.some(v => v.id === old.id)) changes.push({ type: 'remove', target: { kind: 'view', id: old.id } })
      if (changes.length) {
        let delta: SyncDelta = { runtime_epoch: snapshot.runtime_epoch, task_id: task, sequence: ++state.sequence, changes: changes as SyncDelta['changes'] }
        if (Buffer.byteLength(JSON.stringify(delta)) > 65536) delta = { ...delta, changes: [{ type: 'invalidate', target: { kind: 'task', id: task } }] }
        const bytes = Buffer.byteLength(JSON.stringify(delta)); state.deltas.push({ delta, bytes }); state.bytes += bytes
        while (state.deltas.length > defaults.sync.buffer_events || state.bytes > defaults.sync.buffer_bytes) state.bytes -= state.deltas.shift()!.bytes
        state.snapshot = snapshot
      }
    }
    state.accessed = Date.now()
    for (const [key, item] of this.states) if (key !== pageKey && (this.states.size > 8 || Date.now() - item.accessed > 60000)) this.states.delete(key)
    const oldest = state.deltas[0]?.delta.sequence ?? state.sequence + 1
    const cursor = { runtime_epoch: snapshot.runtime_epoch, cache_generation: state.generation, sequence: state.sequence }
    const valid = after && after.runtime_epoch === cursor.runtime_epoch && after.cache_generation === cursor.cache_generation && after.sequence >= oldest - 1 && after.sequence <= cursor.sequence
    return valid ? { ...cursor, deltas: state.deltas.filter(d => d.delta.sequence > after.sequence).map(d => d.delta) } : { ...cursor, snapshot, deltas: [] }
  }
}

import type { Snapshot } from '../shared/types'
import type { SyncDelta } from '../shared/contracts.generated'
import defaults from '../shared/contracts/development-defaults.json'
export interface SyncReply { runtime_epoch: string; sequence: number; snapshot?: Snapshot; deltas: SyncDelta[] }
interface State { snapshot: Snapshot; sequence: number; deltas: { delta: SyncDelta; bytes: number }[]; bytes: number; accessed: number }
export class TaskSync {
  private states = new Map<string, State>()
  clear(): void { this.states.clear() }
  subscribe(snapshot: Snapshot, after?: { runtime_epoch: string; sequence: number }): SyncReply {
    const task = snapshot.task.id
    let state = this.states.get(task)
    const reset = !state || state.snapshot.runtime_epoch !== snapshot.runtime_epoch
    if (!state || state.snapshot.runtime_epoch !== snapshot.runtime_epoch) {
      state = { snapshot, sequence: 0, deltas: [], bytes: 0, accessed: Date.now() }; this.states.set(task, state)
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
    for (const [id, item] of this.states) if (id !== task && (this.states.size > 8 || Date.now() - item.accessed > 60000)) this.states.delete(id)
    const oldest = state.deltas[0]?.delta.sequence ?? state.sequence + 1
    const valid = !reset && after && after.runtime_epoch === snapshot.runtime_epoch && after.sequence >= oldest - 1 && after.sequence <= state.sequence
    return valid ? { runtime_epoch: snapshot.runtime_epoch, sequence: state.sequence, deltas: state.deltas.filter(d => d.delta.sequence > after.sequence).map(d => d.delta) } : { runtime_epoch: snapshot.runtime_epoch, sequence: state.sequence, snapshot, deltas: [] }
  }
}

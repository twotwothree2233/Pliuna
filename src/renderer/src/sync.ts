import type { Snapshot, View } from '../../shared/types'
import type { SyncReply } from '../../runtime/sync'
export function applySync(previous: Snapshot | null, cursor: { runtime_epoch: string; sequence: number } | null, reply: SyncReply): Snapshot | null {
  if (reply.snapshot) return reply.snapshot
  if (!previous || !cursor || cursor.runtime_epoch !== reply.runtime_epoch) return null
  let next = previous, sequence = cursor.sequence
  for (const delta of reply.deltas) {
    if (delta.sequence <= sequence) continue
    if (delta.runtime_epoch !== cursor.runtime_epoch || delta.task_id !== previous.task.id || delta.sequence !== sequence + 1) return null
    for (const change of delta.changes) {
      if (change.type === 'invalidate') return null
      if (change.target.kind === 'task' && change.type === 'upsert') next = { ...(change.value as Snapshot), views: next.views }
      else if (change.target.kind === 'view') {
        if (change.type === 'remove') next = { ...next, views: next.views.filter(v => v.id !== change.target.id) }
        else { const view = change.value as View, old = next.views.find(v => v.id === view.id); if (old && (old.revision > view.revision || old.state_revision > view.state_revision)) return null; next = { ...next, views: old ? next.views.map(v => v.id === view.id ? view : v) : [...next.views, view] } }
      } else return null
    }
    sequence = delta.sequence
  }
  return sequence === reply.sequence ? next : null
}

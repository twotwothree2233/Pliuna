import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
const [directory, point, taskId] = process.argv.slice(2)
if (!directory || !point || !process.send) throw new Error('Requires isolated directory and IPC')
const hold = () => { process.send!({ point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
const store = new RuntimeStore(directory)
const prepare = Database.prototype.prepare
Database.prototype.prepare = function (this: Database.Database, sql: string) {
  const statement = prepare.call(this, sql)
  if (sql === 'UPDATE control SET manifest=? WHERE id=1') return new Proxy(statement, { get(target, key) {
    if (key === 'run') return (manifest: string) => {
      const value = JSON.parse(manifest)
      const matches = point === 'candidate' ? value.candidates.length > 0 : point === 'switched' ? value.active && value.candidates.length === 0 : point === 'invalidated' && value.invalidated.length > 0
      // Hold after the control transaction commits, not inside its journal transaction.
      if (matches) queueMicrotask(hold)
      return target.run(manifest)
    }
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v
  } })
  // Synchronous hold before the projection/deletion boundary observes committed independent authority.
  if (sql === "UPDATE recovery_points SET state='invalid'") {
    const c = new Database(directory + '/recovery-control.sqlite', { readonly: true })
    const value = JSON.parse((c.prepare('SELECT manifest FROM control').get() as any).manifest); c.close()
    if ((point === 'candidate' && value.candidates.length > 0) || (point === 'switched' && value.retired.length > 0) || (point === 'invalidated' && value.invalidated.length > 0)) hold()
  }
  return statement
} as typeof Database.prototype.prepare
if (point === 'invalidated') {
  const s = store.handle({ type: 'maintenance.status' }) as any
  store.handle({ type: 'task.delete', task_id: taskId, invalidate_recovery_id: s.active.id })
} else {
  const s = store.handle({ type: 'maintenance.begin' }) as any
  void store.handle({ type: 'maintenance.create', token: s.reservation.token, inputs_saved: true, replace_id: s.active.id })
}

import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
const [directory, point, taskId] = process.argv.slice(2)
if (!directory || !point || !process.send) throw new Error('Requires isolated directory and IPC')
const hold = () => { process.send!({ point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
const store = new RuntimeStore(directory)
let stopAfterCommit = false
const transaction = Database.prototype.transaction
Database.prototype.transaction = function (this: Database.Database, callback: (...args: any[]) => any) {
  const run = transaction.call(this, callback)
  const wrapped = (...args: any[]) => { const result = run(...args); if (stopAfterCommit) hold(); return result }
  return wrapped as typeof run
} as typeof Database.prototype.transaction
const prepare = Database.prototype.prepare, backup = Database.prototype.backup
Database.prototype.backup = async function (this: Database.Database, ...args: Parameters<typeof backup>) {
  const result = await backup.apply(this, args)
  if (point === 'rollback_ready' && String(args[0]).endsWith('-rollback.sqlite')) hold()
  return result
}
Database.prototype.prepare = function (this: Database.Database, sql: string) {
  const statement = prepare.call(this, sql)
  if (sql === 'UPDATE restore_control SET manifest=? WHERE id=1') return new Proxy(statement, { get(target, key) {
    if (key === 'run') return (manifest: string) => {
      const result = target.run(manifest), value = JSON.parse(manifest), last = value.operations.at(-1)
      const matches = point === 'registered' ? last?.phase === 'preparing' && !last.target.sha256 : point === 'sealed' ? last?.phase === 'preparing' && last.target.sha256 : point === 'selected' || point === 'selected-corrupt' || point === 'selected-both-corrupt' ? last?.phase === 'switched' : point === 'completed' ? last?.phase === 'completed' : point === 'delete_intent' && value.deleted_tasks.includes(taskId)
      if (matches) stopAfterCommit = true
      return result
    }
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v
  } })
  return statement
} as typeof Database.prototype.prepare
if (point === 'delete_intent') {
  const s = store.handle({ type: 'maintenance.status' }) as any
  store.handle({ type: 'task.delete', task_id: taskId, ...(s.active ? { invalidate_recovery_id: s.active.id } : {}) })
} else {
  const s = store.handle({ type: 'maintenance.begin' }) as any
  void store.handle({ type: 'maintenance.restore', token: s.reservation.token, point_id: s.active.id, database_sha256: s.active.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
}

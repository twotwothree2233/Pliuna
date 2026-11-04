import fs from 'node:fs'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
const [directory, point, task] = process.argv.slice(2)
if (!directory || !point || !task || !process.send) throw new Error('Requires isolated directory and IPC')
const store = new RuntimeStore(directory)
const hold = () => { process.send!({ point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
const prepare = Database.prototype.prepare, transaction = Database.prototype.transaction, unlink = fs.unlinkSync
let stop = false
Database.prototype.transaction = function (this: Database.Database, callback: (...args: any[]) => any) {
  const run = transaction.call(this, callback)
  return ((...args: any[]) => { const result = run(...args); if (stop) hold(); return result }) as typeof run
} as typeof Database.prototype.transaction
Database.prototype.prepare = function (this: Database.Database, sql: string) {
  const statement = prepare.call(this, sql)
  if (sql.startsWith('UPDATE restore_control SET manifest=')) return new Proxy(statement, { get(target, key) {
    if (key === 'run') return (manifest: string) => {
      const result = target.run(manifest), r = JSON.parse(manifest).resource_cleanups.at(-1)
      if (r && ((point === 'source' && r.phase === 'candidate') || (point === 'retired' && r.phase === 'retired' && r.attempt === 0) || (point === 'intent' && r.phase === 'deleting') || (point === 'file_deleted' && r.phase === 'file_deleted') || (point === 'complete' && r.phase === 'complete'))) stop = true
      return result
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  if (sql.startsWith('DELETE FROM resources WHERE id=')) return new Proxy(statement, { get(target, key) {
    if (key === 'run') return (...args: any[]) => { const result = Reflect.apply(target.run, target, args); if (point === 'metadata') stop = true; return result }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  return statement
} as typeof Database.prototype.prepare
fs.unlinkSync = ((path: any) => { unlink(path); if (point === 'unlinked') hold() }) as typeof fs.unlinkSync
store.handle({ type: 'task.delete', task_id: task })
const token = (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
const op = (store.handle({ type: 'maintenance.resource.list' }) as any).items[0]
store.handle({ type: 'maintenance.resource.preview', token, operation_id: op.id, inputs_saved: true })
store.handle({ type: 'maintenance.resource.execute', token, operation_id: op.id, inputs_saved: true, confirm_retire_resource: true })

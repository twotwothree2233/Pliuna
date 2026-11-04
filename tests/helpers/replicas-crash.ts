import fs from 'node:fs'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
import { digest } from '../../src/runtime/resources'
const [directory, point, file] = process.argv.slice(2)
if (!directory || !point || !file || !process.send) throw new Error('Requires isolated directory and IPC')
const store = new RuntimeStore(directory)
const hold = () => { process.send!({ point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
const prepare = Database.prototype.prepare, transaction = Database.prototype.transaction, unlink = fs.unlinkSync
let stop = false, deleted = 0, members = 0
Database.prototype.transaction = function (this: Database.Database, callback: (...args: any[]) => any) {
  const run = transaction.call(this, callback)
  return ((...args: any[]) => { const result = run(...args); if (stop) hold(); return result }) as typeof run
} as typeof Database.prototype.transaction
Database.prototype.prepare = function (this: Database.Database, sql: string) {
  const statement = prepare.call(this, sql)
  if (sql.startsWith('UPDATE restore_control SET manifest=')) return new Proxy(statement, { get(target, key) {
    if (key === 'run') return (manifest: string) => {
      const result = target.run(manifest), r = JSON.parse(manifest).retirements.at(-1)
      if (r && ((point === 'retired' && r.phase === 'retired' && r.attempt === 0) || (point === 'intent' && r.members[0].state === 'deleting') || (point === 'partial' && r.members[0].state === 'deleted' && r.members[1].state === 'pending') || (point === 'group_deleted' && r.phase === 'group_deleted') || (point === 'released' && r.phase === 'released'))) stop = true
      return result
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  return statement
} as typeof Database.prototype.prepare
fs.unlinkSync = ((path: any) => { unlink(path); deleted++; if ((point === 'main_unlinked' && deleted === 1) || (point === 'aux_unlinked' && deleted === 2) || (point === 'all_unlinked' && deleted === members)) hold() }) as typeof fs.unlinkSync
const token = (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
const op = store.handle({ type: 'maintenance.replica.preview', token, replica_id: digest(Buffer.from(file)), inputs_saved: true }) as any
members = op.files.length
store.handle({ type: 'maintenance.replica.execute', token, operation_id: op.id, inputs_saved: true, confirm_retire_replica: true })

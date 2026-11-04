import fs from 'node:fs'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'
const [directory, point] = process.argv.slice(2)
if (!directory || !point || !process.send) throw new Error('Requires isolated directory and IPC')
const store = new RuntimeStore(directory)
const hold = () => { process.send!({ point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
const prepare = Database.prototype.prepare, transaction = Database.prototype.transaction, unlink = fs.unlinkSync
let stop = false, deleted = 0
Database.prototype.transaction = function (this: Database.Database, callback: (...args: any[]) => any) {
  const run = transaction.call(this, callback)
  return ((...args: any[]) => { const result = run(...args); if (stop) hold(); return result }) as typeof run
} as typeof Database.prototype.transaction
Database.prototype.prepare = function (this: Database.Database, sql: string) {
  const statement = prepare.call(this, sql)
  if (sql.startsWith('INSERT INTO gc_operations')) return new Proxy(statement, { get(target, key) {
    if (key === 'run') return (id: string, manifest: string) => {
      const result = target.run([id, manifest]), op = JSON.parse(manifest)
      if ((point === 'preview' && op.phase === 'preview') || (point === 'authorized' && op.phase === 'running' && !op.items.some((i: any) => i.attempt)) || (point === 'intent' && op.items[0]?.state === 'deleting') || (point === 'partial' && op.items[0]?.state === 'deleted') || (point === 'settled' && op.phase === 'settled')) stop = true
      return result
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  return statement
} as typeof Database.prototype.prepare
fs.unlinkSync = ((file: any) => { unlink(file); deleted++; if (point === 'unlinked' && deleted === 1) hold() }) as typeof fs.unlinkSync
const token = (store.handle({ type: 'maintenance.begin' }) as any).reservation.token
const op = store.handle({ type: 'maintenance.gc.preview', token, inputs_saved: true }) as any
store.handle({ type: 'maintenance.gc.execute', token, operation_id: op.id, inputs_saved: true, confirm_delete_orphans: true })

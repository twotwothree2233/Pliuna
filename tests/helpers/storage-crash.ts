import fs from 'node:fs'
import Database from 'better-sqlite3'
import { RuntimeStore } from '../../src/runtime/store'

const [directory, point] = process.argv.slice(2)
if (!directory || !point || !process.send) throw new Error('Isolated crash fixture requires IPC')
const hold = () => { process.send!({ point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
const write = fs.writeFileSync, rename = fs.renameSync
fs.writeFileSync = ((file: any, data: any, options: any) => {
  if (String(file).endsWith('.tmp')) {
    if (point === 'pinned') hold()
    if (point === 'partial') { write(file, Buffer.from('part'), options); hold() }
  }
  return write(file, data, options)
}) as typeof fs.writeFileSync
fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
  rename(...args)
  if (point === 'renamed' && String(args[0]).endsWith('.tmp')) hold()
})
const prepare = Database.prototype.prepare
Database.prototype.prepare = function (this: Database.Database, sql: string) {
  const statement = prepare.call(this, sql)
  if (point === 'before_commit' && sql.startsWith('INSERT INTO resources')) {
    return new Proxy(statement, { get(target, key) { if (key === 'run') return () => hold(); const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value } })
  }
  return statement
} as typeof Database.prototype.prepare
const store = new RuntimeStore(directory)
const task = store.create('中断验收'), run = store.start(task.task.id, 'held', 'fixture', [])
store.modelTool(task.task.id, run, { type: 'write', input: { type: 'resource.create', display_name: '中断材料', content: { type: 'text', text: 'original' } } })
if (point === 'after_commit') hold()
throw new Error('Crash point not reached')

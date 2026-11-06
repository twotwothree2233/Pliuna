import { createRequire } from 'node:module'
import { hostMontyTarget, nativeTargets } from '../src/shared/native-targets.mjs'

// ABI probe only: loading a candidate binding does not start a calculation.
const target = hostMontyTarget()
if (!target) throw Error('No native target for this OS, architecture and libc')
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const db = new Database(':memory:')
try {
  db.exec('CREATE TABLE abi_probe (value INTEGER NOT NULL)')
  db.prepare('INSERT INTO abi_probe (value) VALUES (?)').run(42)
  if (db.prepare('SELECT value FROM abi_probe').get().value !== 42) throw Error('SQLite ABI probe failed')
} finally { db.close() }
const montyRequire = createRequire(require.resolve(nativeTargets.montyPackage))
const binding = montyRequire(target.package + '/' + target.native)
if (typeof binding.NativePool !== 'function') throw Error('Monty N-API probe failed')
console.log(JSON.stringify({ target: target.id, node: process.versions.node, electron: process.versions.electron ?? null,
  abi: process.versions.modules, sqlite: true, monty_binding: true, calculation_started: false }))

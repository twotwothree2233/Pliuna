import assert from 'node:assert/strict'
import { execFileSync, fork, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'win32' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP') throw Error('DESIGNATED_WINDOWS11_HOST_REQUIRED')
const root = fileURLToPath(new URL('../', import.meta.url)), self = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url), binding = require('../out/main/native/trellis_job.node')
const probe = join(root, 'node_modules/.cache/trellis-native/trellis_acl_probe.exe')
const native = join(root, 'out/main/native/trellis_acl.exe')
function dependencies(file) {
  const b = fs.readFileSync(file), pe = b.readUInt32LE(0x3c), optional = pe + 24
  assert.equal(b.toString('ascii', pe, pe + 4), 'PE\0\0')
  assert.equal(b.readUInt16LE(pe + 4), 0x8664)
  assert.equal(b.readUInt16LE(optional), 0x20b)
  const sections = optional + b.readUInt16LE(pe + 20), count = b.readUInt16LE(pe + 6)
  const offset = rva => {
    for (let i = 0; i < count; i++) {
      const s = sections + i * 40, start = b.readUInt32LE(s + 12), size = b.readUInt32LE(s + 16)
      if (rva >= start && rva < start + size) return b.readUInt32LE(s + 20) + rva - start
    }
    throw Error('INVALID_PE_RVA')
  }
  const imports = []
  for (let p = offset(b.readUInt32LE(optional + 120)); b.readUInt32LE(p + 12); p += 20) {
    const start = offset(b.readUInt32LE(p + 12)), dll = b.toString('ascii', start, b.indexOf(0, start))
    assert.match(dll, /^(?:kernel32|advapi32|api-ms-win-[a-z0-9-]+)\.dll$/i)
    imports.push(dll)
  }
  return imports
}
const name = () => 'Local\\Trellis-' + randomUUID()
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }
const args = (operation, job, path, kind = 'file', hidden = false, identity = fs.lstatSync(path, { bigint: true })) =>
  [operation, job, win32.toNamespacedPath(path), String(identity.dev), String(identity.ino), kind, hidden ? '1' : '0']
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e } }
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(25) }
  throw Error('ACL_JOB_EXIT_UNCONFIRMED')
}
function call(path, kind = 'file', hidden = false, operation = 'protect', identity, executable = probe) {
  const jobName = name(), job = binding.create(jobName)
  try {
    const output = execFileSync(executable, args(operation, jobName, path, kind, hidden, identity),
      { env, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16384 })
    assert.equal(binding.active(job), 0)
    return JSON.parse(output)
  } finally { binding.close(job) }
}
function powershell(script, extra) {
  return execFileSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000, windowsHide: true })
}
const source = fs.readFileSync(join(root, 'src/platform/permissions.ts'), 'utf8')
const legacy = source.match(/const windowsPrivateAcl = `([\s\S]*?)`/)[1]
const inspect = (file, kind = 'file') => call(file, kind, false, 'inspect')
if (process.argv[2] === 'owner') {
  const file = process.argv[3], jobName = name(), job = binding.create(jobName)
  const child = spawn(probe, args('wait', jobName, file), { env, stdio: ['ignore', 'pipe', 'inherit'] })
  child.stdout.once('data', () => process.send({ pid: child.pid }))
  setInterval(() => binding.active(job), 1000)
  process.once('disconnect', () => { binding.close(job); process.exit(1) })
} else {
  const directory = fs.mkdtempSync(join(tmpdir(), 'trellis-acl-probe-'))
  const checks = [], identities = []
  try {
    const imports = { production: dependencies(native), diagnostic: dependencies(probe) }
    for (const kind of ['file', 'directory']) {
      const file = join(directory, '学习 用户 $(literal);' + kind)
      if (kind === 'file') fs.writeFileSync(file, 'fixture')
      else fs.mkdirSync(file)
      const before = inspect(file, kind), identity = fs.lstatSync(file, { bigint: true })
      assert.equal(before.dev, String(identity.dev)); assert.equal(before.ino, String(identity.ino))
      assert.equal(before.ctimeNs, String(identity.ctimeNs))
      identities.push({ kind, node: { dev: String(identity.dev), ino: String(identity.ino), ctimeNs: String(identity.ctimeNs) },
        handle: { dev: before.dev, ino: before.ino, ctimeNs: before.ctimeNs } })
      assert.equal(before.securityWrites, 0); assert.equal(before.attributeWrites, 0)
      // Exercise precise mismatch without ever rounding an identity to Number.
      for (const ino of [identity.ino + 1n, 9007199254740992n, 9007199254740993n]) {
        if (ino !== identity.ino) assert.throws(() => call(file, kind, false, 'protect', { ...identity, ino }))
      }
      assert.deepEqual(inspect(file, kind), before)
      const actual = call(file, kind, kind === 'directory')
      assert.equal(actual.verified, true)
      assert.equal(actual.securityWrites, 1)
      assert.equal(actual.attributeWrites, kind === 'directory' ? 1 : 0)
      const protectedStat = fs.lstatSync(file, { bigint: true })
      const unchanged = call(file, kind, kind === 'directory')
      assert.equal(unchanged.changed, false); assert.equal(unchanged.securityWrites, 0); assert.equal(unchanged.attributeWrites, 0)
      assert.equal(unchanged.ctimeNs, String(protectedStat.ctimeNs))
      assert.equal(unchanged.descriptor, actual.descriptor)
      // The original implementation must accept this exact ACL without writes.
      powershell(legacy, { TRELLIS_PRIVATE_PATH: win32.toNamespacedPath(file), TRELLIS_PRIVATE_KIND: kind, TRELLIS_PRIVATE_HIDDEN: kind === 'directory' ? '1' : '0' })
      assert.equal(fs.lstatSync(file, { bigint: true }).ctimeNs, protectedStat.ctimeNs)
      assert.equal(inspect(file, kind).descriptor, actual.descriptor)
      assert.equal(call(file, kind, false, 'protect', undefined, native).verified, true)
      assert.equal(fs.lstatSync(file, { bigint: true }).ctimeNs, protectedStat.ctimeNs)
      checks.push(kind + ':identity-owner-dacl-inheritance-hidden-zero-write')
    }
    // Directory reverification must leave inheriting children and already
    // protected frozen files untouched, including their exact NTFS change time.
    const parent = join(directory, 'parent'); fs.mkdirSync(parent); call(parent, 'directory')
    const child = join(parent, 'inherited.txt'), frozen = join(parent, 'frozen.txt')
    fs.writeFileSync(child, 'inherited'); fs.writeFileSync(frozen, 'frozen'); call(frozen)
    const times = [parent, child, frozen].map(f => fs.lstatSync(f, { bigint: true }).ctimeNs)
    const repeated = call(parent, 'directory')
    assert.equal(repeated.securityWrites, 0)
    assert.deepEqual([parent, child, frozen].map(f => fs.lstatSync(f, { bigint: true }).ctimeNs), times)
    // Extra principals, deny rules and incorrect propagation cannot pass as an
    // equivalent private ACL; both backends must produce identical descriptors.
    for (const variant of ['extra', 'deny', 'propagation', 'inheritance']) {
      const target = join(directory, 'variant-' + variant); fs.mkdirSync(target)
      powershell(`$ErrorActionPreference='Stop'; $p=$env:TARGET; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
        $a=[System.Security.AccessControl.DirectorySecurity]::new();
        $a.SetAccessRuleProtection($true,$false);
        $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($u,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));
        $sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18');
        $everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');
        $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'));
        switch($env:VARIANT) {
          'extra' {$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'Read','Allow'))}
          'deny' {$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'Write','Deny'))}
          'propagation' {$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($u,'Read','ContainerInherit','InheritOnly','Allow'))}
          'inheritance' {$a.SetAccessRuleProtection($false,$false)}
        }; [System.IO.Directory]::SetAccessControl($p,$a)`, { TARGET: target, VARIANT: variant })
      const initial = inspect(target, 'directory')
      const changed = call(target, 'directory')
      assert.equal(changed.securityWrites, 1)
      // SetSecurityInfo only supplies DACL; owner/group SDDL prefix is stable.
      assert.equal(changed.descriptor.split('D:')[0], initial.descriptor.split('D:')[0])
      const stable = fs.lstatSync(target, { bigint: true }).ctimeNs
      powershell(legacy, { TRELLIS_PRIVATE_PATH: win32.toNamespacedPath(target), TRELLIS_PRIVATE_KIND: 'directory', TRELLIS_PRIVATE_HIDDEN: '0' })
      assert.equal(fs.lstatSync(target, { bigint: true }).ctimeNs, stable)
      assert.equal(inspect(target, 'directory').descriptor, changed.descriptor)
    }
    checks.push('descendant-ctime-and-non-equivalent-acl-differential')
    const target = join(directory, 'lifecycle.txt'); fs.writeFileSync(target, 'fixture')
    const original = inspect(target)
    const linked = join(directory, 'hardlink.txt'); fs.linkSync(target, linked)
    assert.throws(() => call(target)); fs.unlinkSync(linked)
    const junction = join(directory, 'junction'); fs.symlinkSync(parent, junction, 'junction')
    assert.throws(() => call(junction, 'directory'))
    for (const operation of ['fail-query', 'fail-write']) assert.throws(() => call(target, 'file', false, operation))
    assert.deepEqual(inspect(target).descriptor, original.descriptor)
    assert.throws(() => execFileSync(probe, args('protect', name(), target), { env, timeout: 15000, stdio: 'pipe' }))
    assert.equal(inspect(target).descriptor, original.descriptor)
    const timeoutName = name(), timeoutJob = binding.create(timeoutName)
    try {
      assert.throws(() => execFileSync(probe, args('wait', timeoutName, target), { env, timeout: 500, stdio: 'pipe' }))
    } finally { binding.close(timeoutJob) }
    const owner = fork(self, ['owner', target], { env: { ...env, ELECTRON_RUN_AS_NODE: '1', RUNNER_NAME: process.env.RUNNER_NAME }, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const pid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { owner.kill('SIGKILL'); reject(Error('OWNER_READY_TIMEOUT')) }, 10000)
      owner.once('message', value => { clearTimeout(timer); resolve(value.pid) }); owner.once('error', reject)
    })
    owner.kill('SIGKILL'); await until(() => !alive(pid))
    assert.equal(inspect(target).descriptor, original.descriptor)
    checks.push('hardlink-junction-query-write-failure-assignment-timeout-owner-crash')
    // A post-write uncertainty remains a failure, never a successful result.
    assert.throws(() => call(target, 'file', false, 'fail-verify'))
    const report = { node: process.versions.node, electron: process.versions.electron ?? null, imports, identities, checks, passed: true }
    console.log('WINDOWS_ACL_ACCEPTANCE ' + JSON.stringify(report))
    if (process.env.TRELLIS_WIN11_EVIDENCE) fs.writeFileSync(join(process.env.TRELLIS_WIN11_EVIDENCE,
      'acl-acceptance-' + (process.versions.electron ? 'electron' : 'node') + '.json'), JSON.stringify(report, null, 2) + '\n')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}

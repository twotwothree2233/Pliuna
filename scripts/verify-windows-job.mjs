import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'win32') {
  console.error('WINDOWS_REQUIRED: this probe requires a native Windows host')
  process.exit(2)
}
const binding = createRequire(import.meta.url)('../out/main/native/pliuna_job.node')
const name = () => 'Local\\Pliuna-' + randomUUID()
const self = fileURLToPath(import.meta.url)
const spawn = (mode, jobName) => fork(self, [mode, jobName ?? ''], { env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
const message = child => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Job probe startup timeout')), 10000)
  child.once('message', value => { clearTimeout(timer); resolve(value) })
  child.once('error', reject)
  child.once('exit', () => { clearTimeout(timer); reject(Error('Job probe exited before readiness')) })
})
async function until(check) {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(25) }
  throw Error('Job probe did not confirm process-tree exit')
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e } }
const mode = process.argv[2]
if (mode === 'leaf') setInterval(() => {}, 1000)
else if (mode === 'attached') {
  // No descendants or user code may start before assignment succeeds.
  binding.attach(process.argv[3])
  const leaf = spawn('leaf')
  leaf.once('spawn', () => process.send({ pids: [process.pid, leaf.pid] }))
  process.once('disconnect', () => process.exit(1))
} else if (mode === 'owner' || mode === 'startup-owner') {
  if (process.argv[3]) binding.attach(process.argv[3])
  const jobName = name(), job = binding.create(jobName), child = spawn('attached', jobName)
  // Keep the sole persistent Job handle alive until owner death.
  const keepAlive = setInterval(() => { binding.active(job) }, 1000)
  if (mode === 'startup-owner') process.send({ pids: [child.pid] })
  else child.once('message', value => process.send(value))
  process.once('disconnect', () => { clearInterval(keepAlive); binding.close(job); process.exit(1) })
} else {
  // Explicit termination, empty-job confirmation and name collision.
  const jobName = name(), job = binding.create(jobName)
  let child
  try {
    assert.throws(() => binding.create(jobName), /PROCESS_JOB_NAME_COLLISION/)
    child = spawn('attached', jobName)
    const { pids } = await message(child)
    assert.equal(binding.active(job), 2)
    binding.terminate(job)
    await until(() => binding.active(job) === 0)
    assert.ok(pids.every(pid => !alive(pid)))
  } finally { binding.close(job); child?.kill() }
  // A failed assignment must never reach the descendant-spawn statement.
  const failed = spawn('attached', name())
  let executed = false; failed.on('message', () => { executed = true })
  await new Promise(resolve => failed.once('exit', resolve)); assert.equal(executed, false)
  // Nested jobs and abrupt owner death (no JavaScript cleanup handlers).
  const outerName = name(), outer = binding.create(outerName)
  let owner
  try {
    owner = spawn('owner', outerName)
    const { pids } = await message(owner)
    assert.equal(binding.active(outer), 3)
    owner.kill('SIGKILL')
    await until(() => binding.active(outer) === 0)
    assert.ok(pids.every(pid => !alive(pid)))
  } finally { binding.close(outer); owner?.kill() }
  // Kill ownership during bootstrap, including the window before self-attach.
  // An unassigned bootstrap must fail to open the destroyed Job, never run a
  // backend outside containment; an assigned one must die with its inner Job.
  for (const milliseconds of [0, 5, 25]) {
    const startupName = name(), startup = binding.create(startupName)
    let owner
    try {
      owner = spawn('startup-owner', startupName)
      const { pids } = await message(owner)
      if (milliseconds) await delay(milliseconds)
      owner.kill('SIGKILL')
      await until(() => binding.active(startup) === 0)
      assert.ok(pids.every(pid => !alive(pid)))
    } finally { binding.close(startup); owner?.kill() }
  }
  console.log(JSON.stringify({ job_object: true, nested_job: true, assignment_before_execution: true, owner_crash_cleanup: true, startup_owner_crash: true, node: process.versions.node, electron: process.versions.electron ?? null }))
}

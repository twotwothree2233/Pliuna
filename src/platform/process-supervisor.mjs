import { fork, spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// This bootstrap executes no backend code until containment has succeeded.
// The Windows owner retains the sole persistent Job handle.
function ownerLost() {
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) }
  } else process.exit(1)
}
process.once('disconnect', ownerLost)
process.on('uncaughtException', ownerLost)
process.on('unhandledRejection', ownerLost)
const send = (message, callback) => {
  if (!process.connected) { ownerLost(); return }
  process.send(message, error => { if (error) ownerLost(); else callback?.() })
}
try {
  if (process.platform === 'win32') {
    createRequire(import.meta.url)(process.env.PLIUNA_JOB_BINDING).attach(process.env.PLIUNA_JOB_NAME)
  }
} catch {
  send({ type: 'tree.error' }, () => process.exit(1))
  // No command is accepted after a failed assignment.
  await new Promise(() => {})
}
let child, started = false
process.on('message', message => {
  if (message?.type === 'tree.start' && !started) {
    started = true
    const { mode, command, args, cwd, env } = message.spec
    const options = { cwd, env, shell: false, windowsHide: true, detached: false, execArgv: [], serialization: 'advanced' }
    child = mode === 'fork'
      ? fork(command, args, { ...options, execPath: message.runtime, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
      : spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    process.stdin.pipe(child.stdin)
    child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false })
    child.stdin.on('error', () => {})
    child.on('message', data => send({ type: 'tree.message', data }))
    child.once('spawn', () => send({ type: 'tree.started' }))
    child.once('error', () => send({ type: 'tree.error' }, () => process.exit(1)))
    let drainTimer, disconnectTimer
    if (mode === 'fork') child.once('disconnect', () => {
      // A completed worker disconnects after flushing its result. Allow normal
      // exit to drain; a disconnected but live worker must not run to deadline.
      disconnectTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) send({ type: 'tree.error' }, () => process.exit(1))
      }, 1000)
    })
    // A descendant may hold the backend's pipes open after the backend exits.
    // Do not wait forever for close; the owner will terminate and confirm the tree.
    child.once('exit', () => { drainTimer = setTimeout(() => send({ type: 'tree.error' }, () => process.exit(1)), 1000) })
    child.once('close', (code, signal) => {
      clearTimeout(drainTimer); clearTimeout(disconnectTimer)
      // Flush the bridged result before announcing normal completion.
      process.stdout.write('', () => process.stderr.write('', () => send({ type: 'tree.complete', code, signal }, () => process.exit(code ?? 1))))
    })
  } else if (message?.type === 'tree.send' && child?.connected) {
    child.send(message.data, error => { if (error) send({ type: 'tree.error' }, () => process.exit(1)) })
  }
})
send({ type: 'tree.ready' })

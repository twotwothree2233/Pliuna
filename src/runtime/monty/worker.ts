import { montyAssets } from './assets'
import { executeMonty } from './execution'

let started = false, completed = false
process.once('disconnect', () => {
  if (completed) return
  // Standalone workers retain the original POSIX self-cleanup. Supervised
  // workers are also contained by their owner's group or Windows Job.
  if (process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) } }
  else process.exit(1)
})
process.once('message', async (message: { binary: string; input: unknown }) => {
  if (started) return
  started = true
  let output
  try {
    const assets = montyAssets(process.argv[1]!)
    if (assets.binary !== message.binary) throw Error('MONTY_RUNTIME_UNAVAILABLE')
    output = await executeMonty(assets, message.input, pid => process.send?.({ worker_pid: pid }))
  } catch { output = { ok: false, execution: 'failure', error: 'MONTY_RUNTIME_UNAVAILABLE' } }
  completed = true
  process.stdout.write(JSON.stringify(output), () => { process.disconnect?.() })
})

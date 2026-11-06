import type { Monty } from '@pydantic/monty'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { montyAssets } from './assets'
import { encodedProgram } from './program'
import { montyLimits, validateMontyInput } from './contract'
import { executionDiagnostic } from './diagnostics'

let started = false, completed = false
process.once('disconnect', () => {
  if (completed) return
  // Parent/runtime death must not leave a native computation running.
  if (process.platform !== 'win32') { try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) } }
  else process.exit(1)
})
process.once('message', async (message: { binary: string; input: unknown; limits: typeof montyLimits }) => {
  if (started) return
  started = true
  let pool: Monty | undefined, session: Awaited<ReturnType<Monty['checkout']>> | undefined
  let stdout = '', stderr = '', printed = 0, output: unknown
  let printExceeded = false
  let diagnose = (_error: unknown): { error: string; message?: string } => ({ error: 'MONTY_EXECUTION_FAILED' })
  try {
    const assets = montyAssets(process.argv[1]!)
    if (assets.binary !== message.binary) throw Error('MONTY_RUNTIME_UNAVAILABLE')
    const native = assets.native
    createRequire(join(__dirname, 'monty-native.cjs'))(native)
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = native
    const { Monty, MontyRuntimeError, MontySyntaxError, MontyCrashedError } = await import('@pydantic/monty')
    const input = validateMontyInput(message.input), limits = message.limits
    diagnose = error => {
      if (printExceeded) return { error: 'MONTY_PRINT_LIMIT', message: 'Published calculation print limit reached' }
      if (error instanceof MontyCrashedError && error.timedOut) return { error: 'MONTY_TIMEOUT', message: 'Calculation runtime deadline elapsed' }
      if (error instanceof MontyRuntimeError) return executionDiagnostic(error.exception, input.code, error.traceback())
      if (error instanceof MontySyntaxError) {
        const line = /File "<python-input-\d+>", line (\d+)/.exec(error.display('traceback'))?.[1]
        return executionDiagnostic(error.exception, input.code, [], line ? Number(line) : undefined)
      }
      return { error: 'MONTY_EXECUTION_FAILED', message: 'Calculation runtime failed without a safe code diagnostic' }
    }
    pool = await Monty.create({ binaryPath: message.binary, minProcesses: 1, maxProcesses: 1, maxCheckoutsPerWorker: 1, requestTimeout: limits.wall_ms / 1000, feedDurationLimitGrace: 1, turnDurationLimitGrace: 1 })
    session = await pool.checkout({ limits: { maxMemory: limits.memory_bytes, maxFeedDurationSecs: limits.execution_ms / 1000, maxTurnDurationSecs: limits.execution_ms / 1000, maxRecursionDepth: limits.recursion, maxSuspensions: limits.suspensions, maxTotalSleepSecs: limits.sleep_seconds } })
    process.send?.({ worker_pid: session.workerPid })
    const value = await session.feedRun(encodedProgram(input.code), { inputs: input.inputs, printCallback: (stream, text) => {
      printed += Buffer.byteLength(text)
      if (printed > limits.print_bytes) { printExceeded = true; throw Error('MONTY_PRINT_LIMIT') }
      if (stream === 'stdout') stdout += text; else stderr += text
    } })
    if (typeof value !== 'string') throw Error('MONTY_OUTPUT_INVALID')
    const parsed = JSON.parse(value)
    const reasons = ['MONTY_NONFAITHFUL_FLOAT', 'MONTY_CYCLIC_VALUE', 'MONTY_VALUE_UNSUPPORTED', 'MONTY_ENCODING_FAILED']
    output = parsed.ok ? { ok: true, value: parsed.value, stdout, stderr } : { ok: false, execution: 'success', error: reasons.includes(parsed.error) ? parsed.error : 'MONTY_ENCODING_FAILED' }
  } catch (error) {
    output = { ok: false, execution: 'failure', ...diagnose(error) }
  } finally {
    try { await session?.close(); await pool?.close() }
    catch { output = { ok: false, execution: 'unknown', error: 'MONTY_CLEANUP_UNCONFIRMED' } }
  }
  completed = true
  process.stdout.write(JSON.stringify(output), () => { process.disconnect?.() })
})

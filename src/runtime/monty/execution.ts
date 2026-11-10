import type { Monty } from '@pydantic/monty'
import { createRequire } from 'node:module'
import type { MontyAssets } from './assets'
import type { MontyOutput } from './runner'
import { encodedProgram } from './program'
import { montyLimits, validateMontyInput } from './contract'
import { executionDiagnostic } from './diagnostics'

// The production bootstrap supplies verified assets. Tests can exercise native
// lifecycle and quotas without recomputing the asset files' integrity metadata.
export async function executeMonty(assets: Pick<MontyAssets, 'binary' | 'native'>, raw: unknown, workerStarted: (pid: number) => void, limits = montyLimits): Promise<MontyOutput> {
  let pool: Monty | undefined, session: Awaited<ReturnType<Monty['checkout']>> | undefined
  let stdout = '', stderr = '', printed = 0, output: MontyOutput
  let printExceeded = false
  let diagnose = (_error: unknown): { error: string; message?: string } => ({ error: 'MONTY_EXECUTION_FAILED' })
  try {
    const native = assets.native
    createRequire(import.meta.url)(native)
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = native
    const { Monty, MontyRuntimeError, MontySyntaxError, MontyCrashedError } = await import('@pydantic/monty')
    const input = validateMontyInput(raw)
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
    pool = await Monty.create({ binaryPath: assets.binary, minProcesses: 1, maxProcesses: 1, maxCheckoutsPerWorker: 1, requestTimeout: limits.wall_ms / 1000, feedDurationLimitGrace: 1, turnDurationLimitGrace: 1 })
    session = await pool.checkout({ limits: { maxMemory: limits.memory_bytes, maxFeedDurationSecs: limits.execution_ms / 1000, maxTurnDurationSecs: limits.execution_ms / 1000, maxRecursionDepth: limits.recursion, maxSuspensions: limits.suspensions, maxTotalSleepSecs: limits.sleep_seconds } })
    if (session.workerPid !== undefined) workerStarted(session.workerPid)
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
  return output
}

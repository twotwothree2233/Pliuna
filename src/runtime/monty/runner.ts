import { StringDecoder } from 'node:string_decoder'
import { fork } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { MontyAssets } from './assets'
import { montyLimits, type MontyInput } from './contract'
import { ContractError } from '../../shared/validation'

export type MontyOutput = { ok: true; value: unknown; stdout: string; stderr: string } | { ok: false; execution: 'failure' | 'success' | 'unknown'; error: string; message?: string }
export interface MontyExecution { result: Promise<MontyOutput>; stop(): Promise<void> }
export type MontyRunner = (assets: MontyAssets, input: MontyInput, signal: AbortSignal, runtime: string, onStart: (pid: number) => void) => MontyExecution
const exists = (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error } }
export const nativeMonty: MontyRunner = (assets, input, signal, runtime, onStart) => {
  const child = fork(assets.runner, [], { execPath: runtime, detached: true, env: { ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], serialization: 'advanced' })
  const decoder = new StringDecoder('utf8')
  let output = '', bytes = 0, reason: string | null = null, worker: number | undefined, started = false
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reason = 'MONTY_CLEANUP_UNCONFIRMED' } } }
  const abort = () => { reason ??= 'MONTY_CANCELLED'; kill() }
  signal.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(() => { reason = 'MONTY_TIMEOUT'; kill() }, montyLimits.wall_ms)
  deadline.unref()
  child.stdout!.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    // Transient bytes use hex; the persisted output still obeys result_bytes.
    if (bytes > montyLimits.result_bytes * 2 + montyLimits.print_bytes * 6 + 1048576) { reason = 'MONTY_RESULT_LIMIT'; kill(); return }
    output += decoder.write(chunk)
  })
  child.stderr!.on('data', () => { /* Never forward native diagnostics or paths to model/logs. */ })
  child.on('message', message => { const pid = (message as { worker_pid?: number })?.worker_pid; if (Number.isSafeInteger(pid) && pid! > 0) worker = pid })
  const result = new Promise<MontyOutput>((resolve, reject) => {
    child.once('spawn', () => {
      try { if (signal.aborted) { abort(); return }; onStart(child.pid!); started = true; child.send({ binary: assets.binary, input, limits: montyLimits }, error => { if (error) { reason = 'MONTY_PROCESS_FAILED'; kill() } }) }
      catch { reason = 'MONTY_SOURCE_INVALID'; kill() }
    })
    child.once('error', () => { reason = 'MONTY_START_FAILED' })
    child.once('close', async code => {
      clearTimeout(deadline); signal.removeEventListener('abort', abort)
      try {
        // Verify the entire detached group, including startup failure before worker PID delivery.
        const remaining = () => !!(child.pid && exists(-child.pid)) || !!(worker && exists(worker))
        if (remaining()) { kill(); for (let n = 0; n < 100 && remaining(); n++) await delay(50); if (remaining()) throw new ContractError('MONTY_CLEANUP_UNCONFIRMED', 'Native calculation cleanup could not be confirmed; maintenance remains blocked') }
        if (reason) throw new ContractError(reason, 'Calculation stopped without publishing results; inspect the original Call, never replay automatically')
        if (code !== 0 || !started) throw new ContractError('MONTY_PROCESS_FAILED', 'Native calculation process failed; no host fallback')
        const value = JSON.parse(output + decoder.end()) as MontyOutput
        if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') throw Error()
        resolve(value)
      } catch (error) { reject(error instanceof ContractError ? error : new ContractError('MONTY_OUTPUT_INVALID', 'Native result is invalid; no automatic replay')) }
    })
  })
  if (signal.aborted) abort()
  return { result, stop: async () => { abort(); try { await result } catch (error) { if (error instanceof ContractError && error.code === 'MONTY_CLEANUP_UNCONFIRMED') throw error } } }
}

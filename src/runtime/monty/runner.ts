import { StringDecoder } from 'node:string_decoder'
import { processEnvironment, startProcessTree, type ManagedProcessTree } from '../../platform/process-tree'
import type { MontyAssets } from './assets'
import { montyLimits, type MontyInput } from './contract'
import { ContractError } from '../../shared/validation'

export type MontyOutput = { ok: true; value: unknown; stdout: string; stderr: string } | { ok: false; execution: 'failure' | 'success' | 'unknown'; error: string; message?: string }
export interface MontyExecution { result: Promise<MontyOutput>; stop(): Promise<void> }
export type MontyRunner = (assets: MontyAssets, input: MontyInput, signal: AbortSignal, runtime: string, onStart: (pid: number) => void) => MontyExecution
export const nativeMonty: MontyRunner = (assets, input, signal, runtime, onStart) => {
  const decoder = new StringDecoder('utf8')
  let output = '', bytes = 0, reason: string | null = null, started = false, finishing = false
  let tree: ManagedProcessTree
  let resolve!: (value: MontyOutput) => void, reject!: (error: Error) => void
  const result = new Promise<MontyOutput>((yes, no) => { resolve = yes; reject = no })
  let closed!: () => void
  const streamsClosed = new Promise<void>(done => { closed = done })
  const finish = async () => {
    if (finishing) return
    finishing = true
    clearTimeout(deadline); signal.removeEventListener('abort', abort)
    try {
      let exit
      try { exit = await tree.confirm() }
      catch { throw new ContractError('MONTY_CLEANUP_UNCONFIRMED', 'Native calculation cleanup could not be confirmed; maintenance remains blocked') }
      if (reason) throw new ContractError(reason, 'Calculation stopped without publishing results; inspect the original Call, never replay automatically')
      if (exit.code !== 0 || !started) throw new ContractError('MONTY_PROCESS_FAILED', 'Native calculation process failed; no host fallback')
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(Error('Result pipe did not close')), 1000)
        void streamsClosed.then(() => { clearTimeout(timer); done() })
      })
      const value = JSON.parse(output + decoder.end()) as MontyOutput
      if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean') throw Error()
      resolve(value)
    } catch (error) { reject(error instanceof ContractError ? error : new ContractError('MONTY_OUTPUT_INVALID', 'Native result is invalid; no automatic replay')) }
  }
  const kill = () => {
    try { tree.terminate() } catch { /* Confirmation, not a signal return value, decides cleanup. */ }
    void finish()
  }
  const abort = () => { reason ??= 'MONTY_CANCELLED'; kill() }
  const deadline = setTimeout(() => { reason ??= 'MONTY_TIMEOUT'; kill() }, montyLimits.wall_ms)
  deadline.unref()
  try {
    tree = startProcessTree({ mode: 'fork', command: assets.runner, args: [], env: processEnvironment() }, {
      runtime,
      beforeStart: () => { if (signal.aborted) throw Error(); onStart(tree.process.pid!); started = true },
      failed: code => {
        reason ??= code === 'PROCESS_TREE_SOURCE_INVALID' ? 'MONTY_SOURCE_INVALID' : code === 'PROCESS_TREE_START_FAILED' ? 'MONTY_START_FAILED' : 'MONTY_PROCESS_FAILED'
        // startProcessTree invokes this asynchronously after returning its handle.
        void finish()
      }
    })
  } catch {
    clearTimeout(deadline)
    reject(new ContractError('MONTY_START_FAILED', 'Managed native calculation could not start; no host fallback'))
    return { result, stop: async () => {} }
  }
  tree.process.stdout!.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > montyLimits.result_bytes * 2 + montyLimits.print_bytes * 6 + 1048576) { reason ??= 'MONTY_RESULT_LIMIT'; kill(); return }
    output += decoder.write(chunk)
  })
  tree.process.stderr!.on('data', () => { /* Never forward native diagnostics or paths. */ })
  tree.process.once('close', closed)
  tree.process.once('exit', () => { void finish() })
  void tree.ready.then(() => {
    if (signal.aborted) { abort(); return }
    try { tree.send({ binary: assets.binary, input, limits: montyLimits }) }
    catch { reason ??= 'MONTY_PROCESS_FAILED'; kill() }
  }).catch(() => { reason ??= 'MONTY_START_FAILED'; kill() })
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return { result, stop: async () => {
    abort()
    try { await tree.confirm() }
    catch { throw new ContractError('MONTY_CLEANUP_UNCONFIRMED', 'Native calculation cleanup remains unresolved') }
    // A second stop can confirm cleanup after the original result was unknown.
    try { await result } catch { /* The original Call result is never rewritten or replayed. */ }
  } }
}

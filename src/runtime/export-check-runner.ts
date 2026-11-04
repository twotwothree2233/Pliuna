import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { ContractError } from '../shared/validation'
import type { CheckRunner, CheckResult } from './export-check'

export const backgroundCheck: CheckRunner = snapshot => {
  const worker = new Worker(join(__dirname, 'export-check-worker.js'), {
    workerData: snapshot, transferList: snapshot.bodies.flatMap(body => body.bytes ? [body.bytes.buffer as ArrayBuffer] : []),
    env: {}, resourceLimits: { maxOldGenerationSizeMb: 256 }
  })
  let output: CheckResult | undefined, error: Error | undefined
  const timeout = setTimeout(() => { error = new ContractError('EXPORT_CHECK_TIMEOUT', 'Offline check timed out'); void worker.terminate() }, 60000)
  timeout.unref()
  const result = new Promise<CheckResult>((resolve, reject) => {
    worker.once('message', message => {
      if (message?.ok && typeof message.result?.complete === 'boolean' && Array.isArray(message.result?.issues) && Array.isArray(message.result?.issue_codes)) output = message.result
      else error = new ContractError(message?.code && /^[A-Z_]+$/.test(message.code) ? message.code : 'EXPORT_CHECK_FAILED', 'Offline check failed; no automatic retry')
    })
    worker.once('error', () => { error = new ContractError('EXPORT_CHECK_FAILED', 'Offline check worker failed') })
    worker.once('exit', code => { clearTimeout(timeout); if (code === 0 && output && !error) resolve(output); else reject(error ?? new ContractError('EXPORT_CHECK_STOPPED', 'Offline check stopped')) })
  })
  return { result, stop: async () => { await worker.terminate() } }
}

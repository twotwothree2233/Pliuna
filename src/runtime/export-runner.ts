import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { ExportRunner, ExportResult } from './export-generation'
import { ContractError } from '../shared/validation'

export const backgroundExport: ExportRunner = input => {
  const worker = new Worker(join(__dirname, 'export-generation-worker.js'), { workerData: input, env: {}, resourceLimits: { maxOldGenerationSizeMb: 256 } })
  let output: ExportResult | undefined, error: Error | undefined
  const timeout = setTimeout(() => { error = new ContractError('EXPORT_GENERATION_TIMEOUT', 'Offline generation timed out'); void worker.terminate() }, 60000)
  timeout.unref()
  const result = new Promise<ExportResult>((resolve, reject) => {
    worker.once('message', message => {
      if (message?.ok && typeof message.result?.html === 'string' && Array.isArray(message.result?.issues)) output = message.result
      else error = new ContractError(message?.code && /^[A-Z_]+$/.test(message.code) ? message.code : 'EXPORT_GENERATION_FAILED', 'Offline generation failed; no automatic retry')
    })
    worker.once('error', () => { error = new ContractError('EXPORT_GENERATION_FAILED', 'Offline generation worker failed') })
    // Never release pins or install a preview until the reader has exited.
    worker.once('exit', code => { clearTimeout(timeout); if (code === 0 && output && !error) resolve(output); else reject(error ?? new ContractError('EXPORT_GENERATION_STOPPED', 'Offline generation stopped')) })
  })
  return { result, stop: async () => { await worker.terminate() } }
}

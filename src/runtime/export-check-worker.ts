import { parentPort, workerData } from 'node:worker_threads'
import { generateCheck } from './export-check'
import { ContractError } from '../shared/validation'
import { performance } from 'node:perf_hooks'
try {
  const start = performance.now(), result = generateCheck(workerData), memory = process.memoryUsage()
  parentPort!.postMessage({ ok: true, result: { ...result, worker_metrics: { elapsed_ms: performance.now() - start, rss_bytes: memory.rss, process_peak_rss_bytes: process.resourceUsage().maxRSS * 1024, heap_used_bytes: memory.heapUsed, external_bytes: memory.external, array_buffer_bytes: memory.arrayBuffers } } })
}
catch (error) { parentPort!.postMessage({ ok: false, code: error instanceof ContractError ? error.code : 'EXPORT_CHECK_FAILED' }) }

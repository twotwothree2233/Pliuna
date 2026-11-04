import { parentPort, workerData } from 'node:worker_threads'
import { generateExport } from './export-generation'
import { ContractError } from '../shared/validation'
try { parentPort!.postMessage({ ok: true, result: generateExport(workerData) }) }
catch (error) { parentPort!.postMessage({ ok: false, code: error instanceof ContractError ? error.code : 'EXPORT_GENERATION_FAILED' }) }

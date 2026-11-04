import { inspectStorage, type InspectionRequest } from './storage-inspection'
const root = process.argv[2]
if (!root || !process.parentPort) throw new Error('Inspection requires a private parent channel')
process.parentPort.on('message', async ({ data }: { data: InspectionRequest }) => {
  try { const result = await inspectStorage(root, data, progress => process.parentPort!.postMessage({ progress })); process.parentPort!.postMessage({ result }) }
  catch { process.parentPort!.postMessage({ result: { complete: false, error: 'INSPECT_UNAVAILABLE', readonly: true, deletion_authority: false } }) }
})

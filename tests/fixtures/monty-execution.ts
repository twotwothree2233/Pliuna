import { executeMonty } from '../../src/runtime/monty/execution'
import { hostMontyTarget } from '../../src/shared/native-targets.mjs'
import { montyPackageAssets } from '../../src/runtime/monty/locations'
import { fileURLToPath } from 'node:url'

// Test-only execution entry: exercise the actual binding without reading files
// for integrity. Production's verified asset bootstrap is never replaced.
const target = hostMontyTarget()
if (!target?.runtimeVerified) throw Error('Native execution acceptance is closed on this host')
const assets = montyPackageAssets(fileURLToPath(import.meta.url), target)
process.once('message', async (message: { input: unknown }) => {
  const output = await executeMonty(assets, message.input, pid => process.send?.({ worker_pid: pid }))
  process.stdout.write(JSON.stringify(output), () => process.disconnect?.())
})

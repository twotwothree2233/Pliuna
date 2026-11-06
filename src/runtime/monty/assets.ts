import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContractError } from '../../shared/validation'
import { hostMontyTarget } from '../../shared/native-targets.mjs'
import { montyPackageAssets } from './locations'

export interface MontyAssets { binary: string; native: string; binary_sha256: string; runner: string }
export function montyAssets(runner: string): MontyAssets {
  const target = hostMontyTarget()
  if (!target?.runtimeVerified || !target.integrity) throw new ContractError('MONTY_PLATFORM_UNVERIFIED', 'Calculation is closed on unverified platforms')
  try {
    const { binary, native } = montyPackageAssets(join(__dirname, 'monty-assets.cjs'), target)
    const hashes: [string,string][] = [[binary, target.integrity.binary], [native, target.integrity.native]]
    if(hashes.some(([file,expected]) => !lstatSync(file).isFile() || createHash('sha256').update(readFileSync(file)).digest('hex') !== expected)) throw Error()
    if (!lstatSync(runner).isFile()) throw Error()
    return { binary, native, binary_sha256: target.integrity.binary, runner }
  } catch { throw new ContractError('MONTY_RUNTIME_UNAVAILABLE', 'Bundled verified native calculation assets are unavailable; no PATH or host runtime fallback') }
}

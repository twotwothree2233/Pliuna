import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ContractError } from '../../shared/validation'

export interface MontyAssets { binary: string; binary_sha256: string; runner: string }
export function montyAssets(runner: string): MontyAssets {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new ContractError('MONTY_PLATFORM_UNVERIFIED', 'Calculation is closed on unverified platforms')
  try {
    const applicationRequire = createRequire(join(__dirname, 'monty-assets.cjs'))
    const require = createRequire(applicationRequire.resolve('@pydantic/monty'))
    const binary = realpathSync(require.resolve('@pydantic/monty-darwin-arm64/monty'))
    const manifest = JSON.parse(readFileSync(join(dirname(binary), 'package.json'), 'utf8'))
    const native = join(dirname(binary), 'monty.darwin-arm64.node')
    const hashes: [string,string][] = [[binary,'d9ffb7f1956df45781400991cbea987fc6466a5c1f5fd4f6fbcdf3d157b0afd0'],[native,'301d4d1b0e4ffec566496220bb71db1350ea4288c08ad426d662c81f24d054f6']]
    if(hashes.some(([file,expected]) => !lstatSync(file).isFile() || createHash('sha256').update(readFileSync(file)).digest('hex') !== expected)) throw Error()
    if (manifest.version !== '1.3.0' || manifest.name !== '@pydantic/monty-darwin-arm64' || !lstatSync(binary).isFile() || !lstatSync(runner).isFile()) throw Error()
    return { binary, binary_sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), runner }
  } catch { throw new ContractError('MONTY_RUNTIME_UNAVAILABLE', 'Bundled verified native calculation assets are unavailable; no PATH or host runtime fallback') }
}

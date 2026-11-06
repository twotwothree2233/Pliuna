import { createRequire } from 'node:module'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { nativeTargets, type MontyTarget } from '../../shared/native-targets.mjs'

// Locates assets only. Finding a candidate package never enables execution.
export function montyPackageAssets(applicationEntry: string, target: MontyTarget): { binary: string; native: string } {
  const applicationRequire = createRequire(applicationEntry)
  const require = createRequire(applicationRequire.resolve(nativeTargets.montyPackage))
  const manifestPath = realpathSync(require.resolve(target.package + '/package.json'))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== target.package || manifest.version !== nativeTargets.montyVersion ||
      !Array.isArray(manifest.os) || !manifest.os.includes(target.platform) ||
      !Array.isArray(manifest.cpu) || !manifest.cpu.includes(target.arch)) throw Error('MONTY_ASSET_PACKAGE_INVALID')
  const binary = realpathSync(require.resolve(target.package + '/' + target.binary))
  const native = realpathSync(require.resolve(target.package + '/' + target.native))
  if ([binary, native].some(file => dirname(file) !== dirname(manifestPath) || !lstatSync(file).isFile())) throw Error('MONTY_ASSET_PACKAGE_INVALID')
  return { binary, native }
}

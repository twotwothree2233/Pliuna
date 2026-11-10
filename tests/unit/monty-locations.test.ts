import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { montyPackageAssets } from '../../src/runtime/monty/locations'
import { nativeTargets, hostMontyTarget, type MontyTarget } from '../../src/shared/native-targets.mjs'

const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(target: MontyTarget, layout = 'development checkout') {
  const root = mkdtempSync(join(tmpdir(), 'trellis-native-location-')); roots.push(root)
  const app = join(root, layout), wrapper = join(app, 'node_modules', nativeTargets.montyPackage)
  const platform = join(wrapper, 'node_modules', target.package), manifest = join(platform, 'package.json')
  mkdirSync(platform, { recursive: true })
  writeFileSync(join(wrapper, 'package.json'), JSON.stringify({ name: nativeTargets.montyPackage, version: nativeTargets.montyVersion, main: 'index.cjs' }))
  writeFileSync(join(wrapper, 'index.cjs'), '')
  const metadata = { name: target.package, version: nativeTargets.montyVersion, os: [target.platform], cpu: [target.arch] }
  writeFileSync(manifest, JSON.stringify(metadata))
  writeFileSync(join(platform, target.binary), 'fixture binary')
  writeFileSync(join(platform, target.native), 'fixture binding')
  return { root, entry: join(app, 'out', 'main', 'monty-assets.cjs'), platform, manifest, metadata }
}

describe('installed Monty package locations', () => {
  it('locates the actually installed host package without running calculation or file digests', () => {
    const target = hostMontyTarget()!
    const assets = montyPackageAssets(resolve('out/main/monty-assets.cjs'), target)
    expect(assets.binary.endsWith(target.binary)).toBe(true)
    expect(assets.native.endsWith(target.native)).toBe(true)
  })
  for (const target of nativeTargets.targets) for (const layout of ['development checkout', 'Trellis app/Contents/Resources/app']) {
    it(`resolves ${target.id} from ${layout} without enabling execution`, () => {
      const f = fixture(target, layout)
      expect(montyPackageAssets(f.entry, target)).toEqual({
        binary: realpathSync(join(f.platform, target.binary)), native: realpathSync(join(f.platform, target.native))
      })
    })
  }
  for (const field of ['name', 'version', 'os', 'cpu'] as const) it(`rejects mismatched package ${field}`, () => {
    const target = nativeTargets.targets[0]!, f = fixture(target)
    writeFileSync(f.manifest, JSON.stringify({ ...f.metadata, [field]: field === 'os' || field === 'cpu' ? ['wrong'] : 'wrong' }))
    expect(() => montyPackageAssets(f.entry, target)).toThrow('MONTY_ASSET_PACKAGE_INVALID')
  })
  for (const field of ['os', 'cpu'] as const) it(`rejects scalar package ${field} instead of substring matching`, () => {
    const target = nativeTargets.targets[0]!, f = fixture(target)
    writeFileSync(f.manifest, JSON.stringify({ ...f.metadata, [field]: f.metadata[field][0] }))
    expect(() => montyPackageAssets(f.entry, target)).toThrow('MONTY_ASSET_PACKAGE_INVALID')
  })
  for (const field of ['binary', 'native'] as const) it(`does not replace missing ${field} with a host executable`, () => {
    const target = nativeTargets.targets[0]!, f = fixture(target)
    rmSync(join(f.platform, target[field]))
    vi.stubEnv('MONTY_BIN', join(f.platform, target[field === 'binary' ? 'native' : 'binary']))
    expect(() => montyPackageAssets(f.entry, target)).toThrow()
  })
  it('rejects a native asset symlink escaping its package', () => {
    const target = nativeTargets.targets[0]!, f = fixture(target), outside = join(f.root, 'outside.node')
    writeFileSync(outside, 'fixture binding'); rmSync(join(f.platform, target.native))
    symlinkSync(outside, join(f.platform, target.native), 'file')
    expect(() => montyPackageAssets(f.entry, target)).toThrow('MONTY_ASSET_PACKAGE_INVALID')
  })
})

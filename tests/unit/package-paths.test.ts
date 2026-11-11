import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error Build tooling is a standalone JavaScript module.
import { parsePackageArgs, productionPackages, packageTarget, nativeHashes } from '../../scripts/package-macos.mjs'
import { nativeTargets, montyTarget } from '../../src/shared/native-targets.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('accepts native absolute paths and rejects relative output or guide arguments', () => {
  const output = join(tmpdir(), 'new candidate'), guide = join(tmpdir(), 'external guide.md')
  expect(parsePackageArgs(['--output', output, '--guide', guide])).toEqual({ output, guide })
  expect(parsePackageArgs(['--output', output])).toEqual({ output, guide: undefined })
  for (const args of [[], ['--output', 'relative'], ['--output', output, '--guide', 'relative'], ['--output', output, '--unknown', guide]]) {
    expect(() => parsePackageArgs(args)).toThrow('Usage')
  }
})
it('shares the legacy macOS packaging target and integrity metadata with the runtime', () => {
  expect(packageTarget).toEqual(montyTarget('darwin', 'arm64'))
  expect(nativeHashes).toEqual({ [packageTarget.binary]: packageTarget.integrity.binary, [packageTarget.native]: packageTarget.integrity.native })
  expect(nativeTargets.montyVersion).toBe('1.3.0')
})
function packageFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-production-packages-')); roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [nativeTargets.montyPackage]: nativeTargets.montyVersion } }))
  const wrapper = { name: nativeTargets.montyPackage, version: nativeTargets.montyVersion,
    optionalDependencies: Object.fromEntries(nativeTargets.targets.map(t => [t.package, nativeTargets.montyVersion])) }
  const manifests = [wrapper, ...nativeTargets.targets.map(t => ({ name: t.package, version: nativeTargets.montyVersion }))]
  for (const manifest of manifests) {
    const folder = join(root, 'node_modules', manifest.name); mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'package.json'), JSON.stringify(manifest))
  }
  return { root, wrapper }
}
it('collects only the approved native package when all optional platform packages are present', () => {
  const { root } = packageFixture()
  expect(productionPackages(root).map((p: { name: string }) => p.name)).toEqual([nativeTargets.montyPackage, packageTarget.package])
})
it('rejects a wrapper whose optional package version differs from the catalog', () => {
  const { root, wrapper } = packageFixture()
  wrapper.optionalDependencies[packageTarget.package] = 'wrong'
  writeFileSync(join(root, 'node_modules', nativeTargets.montyPackage, 'package.json'), JSON.stringify(wrapper))
  expect(() => productionPackages(root)).toThrow('native target catalog')
})
it('rejects a native package whose installed version differs from the catalog', () => {
  const { root } = packageFixture()
  writeFileSync(join(root, 'node_modules', packageTarget.package, 'package.json'), JSON.stringify({ name: packageTarget.package, version: 'wrong' }))
  expect(() => productionPackages(root)).toThrow('native target catalog')
})

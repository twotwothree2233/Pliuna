import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nativeTargets, type MontyTarget } from '../../src/shared/native-targets.mjs'
import * as targets from '../../src/shared/native-targets.mjs'
import { montyPackageAssets } from '../../src/runtime/monty/locations'
import { montyAssets } from '../../src/runtime/monty/assets'

// Synthetic bytes and synthetic digest results: no real file is hashed here.
const fixture = vi.hoisted(() => ({ files: new Map<string, string>(), digests: new Map<string, string>() }))
vi.mock('node:crypto', () => ({ createHash: () => {
  let bytes = ''
  return { update(value: Buffer) { bytes = value.toString(); return this }, digest() { return fixture.digests.get(bytes) ?? 'mismatch' } }
} }))
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(),
  lstatSync(file: string) { if (!fixture.files.has(file)) throw Error('private missing path'); return { isFile: () => true } },
  readFileSync(file: string) { if (!fixture.files.has(file)) throw Error('private missing path'); return Buffer.from(fixture.files.get(file)!) }
}))
vi.mock('../../src/runtime/monty/locations', () => ({ montyPackageAssets: vi.fn() }))

beforeEach(() => {
  const target = nativeTargets.targets[0]!
  vi.spyOn(targets, 'hostMontyTarget').mockReturnValue(target)
  vi.mocked(montyPackageAssets).mockReturnValue({ binary: 'fixture-binary', native: 'fixture-native' })
  fixture.files = new Map([['fixture-binary', 'binary'], ['fixture-native', 'native'], ['fixture-runner', 'runner']])
  fixture.digests = new Map([['binary', target.integrity!.binary], ['native', target.integrity!.native]])
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

it('preserves the macOS ARM64 gate and returns an explicit native path', () => {
  expect(montyAssets('fixture-runner')).toEqual({ binary: 'fixture-binary', native: 'fixture-native', runner: 'fixture-runner', binary_sha256: nativeTargets.targets[0]!.integrity!.binary })
})
for (const target of [...nativeTargets.targets.filter(t => !t.runtimeVerified), null]) {
  it(`refuses ${target?.id ?? 'unknown target'} before resolving or reading assets`, () => {
    vi.mocked(targets.hostMontyTarget).mockReturnValue(target)
    expect(() => montyAssets('fixture-runner')).toThrowError(expect.objectContaining({ code: 'MONTY_PLATFORM_UNVERIFIED' }))
    expect(montyPackageAssets).not.toHaveBeenCalled()
  })
}
it('refuses a verified target without integrity metadata', () => {
  const target: MontyTarget = { ...nativeTargets.targets[0]!, integrity: null }
  vi.mocked(targets.hostMontyTarget).mockReturnValue(target)
  expect(() => montyAssets('fixture-runner')).toThrowError(expect.objectContaining({ code: 'MONTY_PLATFORM_UNVERIFIED' }))
})
for (const file of ['fixture-binary', 'fixture-native', 'fixture-runner']) it(`closes calculation when ${file} is missing`, () => {
  fixture.files.delete(file)
  expect(() => montyAssets('fixture-runner')).toThrowError(expect.objectContaining({ code: 'MONTY_RUNTIME_UNAVAILABLE' }))
})
for (const file of ['fixture-binary', 'fixture-native']) it(`preserves rejection of changed ${file}`, () => {
  fixture.files.set(file, 'changed fixture')
  expect(() => montyAssets('fixture-runner')).toThrow('no PATH or host runtime fallback')
})
it('does not expose resolver errors or private paths', () => {
  vi.mocked(montyPackageAssets).mockImplementation(() => { throw Error('private fixture location') })
  expect(() => montyAssets('fixture-runner')).toThrow('Bundled verified native calculation assets are unavailable')
})

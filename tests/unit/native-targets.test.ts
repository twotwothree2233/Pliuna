import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { nativeTargets, montyTarget, hostMontyTarget } from '../../src/shared/native-targets.mjs'

describe('native target catalog', () => {
  it('describes exactly the pinned Monty optional packages', () => {
    const wrapper = JSON.parse(readFileSync('node_modules/@pydantic/monty/package.json', 'utf8'))
    expect(wrapper.version).toBe(nativeTargets.montyVersion)
    expect(Object.fromEntries(nativeTargets.targets.map(t => [t.package, nativeTargets.montyVersion]))).toEqual(wrapper.optionalDependencies)
    expect(new Set(nativeTargets.targets.map(t => t.id)).size).toBe(nativeTargets.targets.length)
  })
  it.each([
    ['darwin', 'arm64', null, 'darwin-arm64'],
    ['darwin', 'x64', null, 'darwin-x64'],
    ['linux', 'x64', 'glibc', 'linux-x64-gnu'],
    ['linux', 'arm64', 'glibc', 'linux-arm64-gnu'],
    ['win32', 'x64', null, 'win32-x64-msvc']
  ])('selects %s/%s/%s without using the build host', (platform, arch, libc, id) => {
    expect(montyTarget(platform!, arch!, libc)).toMatchObject({ id })
  })
  it.each([
    ['linux', 'x64', null], ['linux', 'x64', 'musl'], ['linux', 'arm64', 'musl'],
    ['win32', 'arm64', null], ['freebsd', 'x64', null], ['darwin', 'ia32', null]
  ])('refuses unknown or unsupported %s/%s/%s', (platform, arch, libc) => {
    expect(montyTarget(platform!, arch!, libc)).toBeNull()
  })
  it('keeps only macOS ARM64 verified, with both existing integrity pins', () => {
    expect(nativeTargets.targets.filter(t => t.runtimeVerified).map(t => t.id)).toEqual(['darwin-arm64'])
    const verified = montyTarget('darwin', 'arm64')!
    expect(verified.integrity?.binary).toMatch(/^[a-f0-9]{64}$/)
    expect(verified.integrity?.native).toMatch(/^[a-f0-9]{64}$/)
    expect(nativeTargets.targets.filter(t => !t.runtimeVerified).every(t => t.integrity === null)).toBe(true)
  })
  it('identifies the actual host independently of runtime permission', () => {
    expect(hostMontyTarget()).toMatchObject({ platform: process.platform, arch: process.arch })
    expect(montyTarget('win32', 'x64')?.binary).toBe('monty.exe')
  })
  it.each(['glibc', 'musl', 'unavailable'])('classifies a Linux %s host without shell probes', libc => {
    let target
    vi.stubGlobal('process', { platform: 'linux', arch: 'x64', report: { getReport() {
      if (libc === 'unavailable') throw Error('report unavailable')
      return { header: libc === 'glibc' ? { glibcVersionRuntime: '2.39' } : {} }
    } } })
    try { target = hostMontyTarget() } finally { vi.unstubAllGlobals() }
    if (libc === 'glibc') expect(target?.id).toBe('linux-x64-gnu')
    else expect(target).toBeNull()
  })
})

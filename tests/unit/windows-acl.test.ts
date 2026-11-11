import { execFileSync } from 'node:child_process'
import { lstatSync, type Stats } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { protectWindowsPath } from '../../src/platform/windows-acl'

const job = vi.hoisted(() => ({ value: {}, name: 'Local\\Pliuna-test',
  binding: { active: vi.fn(() => 0), terminate: vi.fn(), close: vi.fn() } }))
const clock = vi.hoisted(() => ({ now: vi.fn(() => 0) }))
vi.mock('../../src/platform/process-tree', () => ({ createWindowsJob: vi.fn(() => ({ job: job.value, name: job.name, binding: job.binding })) }))
vi.mock('node:perf_hooks', async original => ({ ...await original<typeof import('node:perf_hooks')>(), performance: { now: clock.now } }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn() }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), lstatSync: vi.fn() }))
const path = 'C:\\Users\\学习 用户\\$(literal);file.json', identity = { dev: '1', ino: '9007199254740993' }
const success = JSON.stringify({ version: 1, backend: 'native', verified: true, changed: false })
beforeEach(() => {
  vi.clearAllMocks(); job.binding.active.mockReturnValue(0)
  clock.now.mockReturnValue(0)
  vi.mocked(lstatSync).mockReturnValue({ isFile: () => true, nlink: 1 } as Stats)
  vi.mocked(execFileSync).mockReturnValue(success)
  vi.stubGlobal('process', { ...process, env: { SystemRoot: 'C:\\Windows', PRIVATE_MODEL_SECRET: 'never-forward' } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('uses a fixed helper, exact identities, minimal environment and the original deadline', () => {
  expect(protectWindowsPath(path, 'file', false, identity)).toBe('verified')
  const [command, args, options] = vi.mocked(execFileSync).mock.calls[0]!
  expect(String(command)).toMatch(/[/\\]native[/\\]pliuna_acl\.exe$/)
  expect(args).toEqual(['protect', job.name, '\\\\?\\' + path, '1', '9007199254740993', 'file', '0'])
  expect(options).toMatchObject({ timeout: 15000, windowsHide: true, maxBuffer: 4096 })
  expect(options?.env).not.toHaveProperty('PRIVATE_MODEL_SECRET')
  expect(job.binding.terminate).toHaveBeenCalledWith(job.value)
  expect(job.binding.close).toHaveBeenCalledWith(job.value)
})
it('selects the old backend only for an explicit pre-write unsupported result', () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ version: 1, backend: 'legacy', verified: false, changed: false }))
  expect(protectWindowsPath(path, 'file', false, identity)).toBe('legacy')
})
it('preselects UNC before trying a local helper', () => {
  expect(protectWindowsPath('\\\\server\\share\\file', 'file', false, identity)).toBe('legacy')
  expect(execFileSync).not.toHaveBeenCalled()
})
it.each(['', '{', '{}', '[]', 'null', 'true', success + '\nnoise',
  JSON.stringify({ version: 2, backend: 'native', verified: true, changed: false }),
  JSON.stringify({ version: 1, backend: 'native', verified: false, changed: false }),
  JSON.stringify({ version: 1, backend: 'legacy', verified: true, changed: false }),
  JSON.stringify({ version: 1, backend: 'legacy', verified: false, changed: true }),
  JSON.stringify({ version: 1, backend: 'native', verified: true, changed: false, extra: true })
])('rejects an unknown or uncertain helper result without retrying (%s)', output => {
  vi.mocked(execFileSync).mockReturnValue(output)
  expect(() => protectWindowsPath(path, 'file', false, identity)).toThrow()
  expect(execFileSync).toHaveBeenCalledTimes(1)
  expect(job.binding.terminate).toHaveBeenCalledWith(job.value)
  expect(job.binding.close).toHaveBeenCalledWith(job.value)
})
it.each(['ETIMEDOUT', 'ENOENT', 'EPIPE', 'EACCES'])('cleans its Job and refuses fallback on %s', code => {
  vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(Error(code), { code }) })
  expect(() => protectWindowsPath(path, 'file', false, identity)).toThrow(code)
  expect(execFileSync).toHaveBeenCalledTimes(1)
  expect(job.binding.close).toHaveBeenCalledWith(job.value)
})
it('refuses a helper that left any process running', () => {
  job.binding.active.mockReturnValue(1)
  clock.now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(15001)
  expect(() => protectWindowsPath(path, 'file', false, identity)).toThrow('FILE_PERMISSIONS_UNAVAILABLE')
  expect(job.binding.terminate).toHaveBeenCalledWith(job.value)
})
it('confirms a delayed Job accounting update without re-executing permissions', () => {
  job.binding.active.mockReturnValueOnce(1).mockReturnValue(0)
  expect(protectWindowsPath(path, 'file', false, identity)).toBe('verified')
  expect(job.binding.active).toHaveBeenCalledTimes(2)
  expect(execFileSync).toHaveBeenCalledTimes(1)
  expect(job.binding.close).toHaveBeenCalledWith(job.value)
})
it('fails closed when Job exit cannot be queried', () => {
  job.binding.active.mockImplementationOnce(() => { throw Error('PROCESS_JOB_QUERY_FAILED') })
  expect(() => protectWindowsPath(path, 'file', false, identity)).toThrow('PROCESS_JOB_QUERY_FAILED')
  expect(job.binding.close).toHaveBeenCalledWith(job.value)
})
it('rejects a late helper result even after the Job becomes empty', () => {
  clock.now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(15001)
  expect(() => protectWindowsPath(path, 'file', false, identity)).toThrow('FILE_PERMISSIONS_UNAVAILABLE')
  expect(job.binding.close).toHaveBeenCalledWith(job.value)
})
it('refuses missing, linked or non-regular fixed helper assets', () => {
  for (const stat of [{ isFile: () => false, nlink: 1 }, { isFile: () => true, nlink: 2 }]) {
    vi.mocked(lstatSync).mockReturnValue(stat as Stats)
    expect(() => protectWindowsPath(path, 'file', false, identity)).toThrow('FILE_PERMISSIONS_UNAVAILABLE')
  }
  vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(Error('missing'), { code: 'ENOENT' }) })
  expect(() => protectWindowsPath(path, 'file', false, identity)).toThrow('FILE_PERMISSIONS_UNAVAILABLE')
  expect(execFileSync).not.toHaveBeenCalled()
})

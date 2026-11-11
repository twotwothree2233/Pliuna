import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { afterEach,expect,it,vi } from 'vitest'
import { flushFileSync } from '../../src/platform/files'
import { protectPrivatePath } from '../../src/platform/permissions'
import { protectWindowsPath } from '../../src/platform/windows-acl'

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn() }))
vi.mock('../../src/platform/windows-acl', () => ({ protectWindowsPath: vi.fn(() => 'legacy') }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

function windowsFile() {
  const fixture = new URL('./platform-permissions.test.ts', import.meta.url)
  const stat = fs.statSync(fixture), exact = fs.statSync(fixture, { bigint: true })
  const file = 'C:\\Users\\学习 用户\\private\\$(literal);file.json'
  vi.spyOn(fs, 'lstatSync').mockImplementation(((_path: fs.PathLike, options?: { bigint?: boolean }) => options?.bigint ? exact : stat) as typeof fs.lstatSync)
  vi.stubGlobal('process', { ...process, platform: 'win32', env: { SystemRoot: 'C:\\Windows', PRIVATE_MODEL_SECRET: 'never-forward' } })
  return { stat, exact, file }
}
it('passes Windows paths as environment data to a fixed system executable', () => {
  const { file } = windowsFile()
  try { protectPrivatePath(file, 'file') } finally { vi.unstubAllGlobals() }
  const [command, args, options] = vi.mocked(execFileSync).mock.calls[0]!
  expect(command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  expect(args).not.toContain(file)
  const opts = options as import('node:child_process').ExecFileSyncOptions
  expect(opts.env?.PLIUNA_PRIVATE_PATH).toBe('\\\\?\\' + file)
  expect(opts.env).not.toHaveProperty('PRIVATE_MODEL_SECRET')
  expect(opts.windowsHide).toBe(true)
  const script = Buffer.from((args as string[]).at(-1)!, 'base64').toString('utf16le')
  expect(script).toContain('SetAccessRuleProtection($true, $false)')
  expect(script).toContain('S-1-5-18')
  expect(script).not.toContain(file)
})
it('fails closed when the Windows ACL operation fails', () => {
  const { file } = windowsFile()
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw Error('private native diagnostic') })
  let failure: unknown
  try { protectPrivatePath(file, 'file') } catch (e) { failure = e } finally { vi.unstubAllGlobals() }
  expect(failure).toMatchObject({ message: 'FILE_PERMISSIONS_UNAVAILABLE' })
})
it('accepts a verified native result without launching PowerShell', () => {
  const { file } = windowsFile()
  vi.mocked(protectWindowsPath).mockReturnValueOnce('verified')
  try { protectPrivatePath(file, 'file') } finally { vi.unstubAllGlobals() }
  expect(execFileSync).not.toHaveBeenCalled()
})
it('does not retry an uncertain native operation with PowerShell', () => {
  const { file } = windowsFile()
  vi.mocked(protectWindowsPath).mockImplementationOnce(() => { throw Error('unknown native result') })
  try { expect(() => protectPrivatePath(file, 'file')).toThrow('FILE_PERMISSIONS_UNAVAILABLE') }
  finally { vi.unstubAllGlobals() }
  expect(execFileSync).not.toHaveBeenCalled()
})
it('does not grant a fresh deadline to an unsupported-backend fallback', () => {
  const { file } = windowsFile()
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(15001)
  try { expect(() => protectPrivatePath(file, 'file')).toThrow('FILE_PERMISSIONS_UNAVAILABLE') }
  finally { vi.unstubAllGlobals() }
  expect(execFileSync).not.toHaveBeenCalled()
})
it('uses a writable handle for Windows FlushFileBuffers', () => {
  const parent = fs.statSync(new URL('.', import.meta.url)), parentExact = fs.statSync(new URL('.', import.meta.url), { bigint: true }), { stat, exact, file } = windowsFile()
  vi.spyOn(fs, 'realpathSync').mockReturnValue('C:\\Users\\学习 用户\\private')
  vi.spyOn(fs, 'statSync').mockImplementation(((_path: fs.PathLike, options?: { bigint?: boolean }) => options?.bigint ? parentExact : parent) as typeof fs.statSync)
  const opened = vi.spyOn(fs, 'openSync').mockReturnValue(123)
  vi.spyOn(fs, 'fstatSync').mockImplementation(((_fd: number, options?: { bigint?: boolean }) => options?.bigint ? exact : stat) as typeof fs.fstatSync)
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {})
  vi.spyOn(fs, 'closeSync').mockImplementation(() => {})
  try { flushFileSync(file) } finally { vi.unstubAllGlobals() }
  expect(Number(opened.mock.calls[0]![1]) & fs.constants.O_RDWR).toBe(fs.constants.O_RDWR)
})

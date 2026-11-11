import { expect,it } from 'vitest'
import { absoluteFilePath,pathWithin } from '../../src/platform/paths'

it.each([
  ['C:\\用户\\学习 材料\\file.html', 'C:\\用户\\学习 材料\\file.html'],
  ['c:/data/a/../b.html', 'c:\\data\\b.html'],
  ['\\\\server\\share\\学习\\file.txt', '\\\\server\\share\\学习\\file.txt'],
  ['\\\\?\\C:\\data\\file.txt', 'C:\\data\\file.txt'],
  ['\\\\?\\UNC\\server\\share\\file.txt', '\\\\server\\share\\file.txt'],
  ['C:\\' + '长目录\\'.repeat(80) + 'file.txt', 'C:\\' + '长目录\\'.repeat(80) + 'file.txt']
])('accepts unambiguous Windows path %s', (input, expected) => {
  expect(absoluteFilePath(input, 'win32')).toBe(expected)
})
it.each([
  'C:relative.txt', '\\root-relative.txt', 'relative.txt', 'C:\\data\\file.txt:stream',
  'C:\\data\\CON.txt', 'C:\\data\\aux', 'C:\\data\\name. ', 'C:\\data\\name.',
  'C:\\data\\bad\0name', '\\\\.\\PhysicalDrive0', '\\\\?\\GLOBALROOT\\Device\\Volume',
  'C:\\data\\bad?.txt'
])('rejects ambiguous Windows path %s', input => {
  expect(() => absoluteFilePath(input, 'win32')).toThrow('FILE_PATH_INVALID')
})
it('uses drive, share and path component boundaries for containment', () => {
  expect(pathWithin('C:\\Data', 'c:\\data\\学习.txt', 'win32')).toBe(true)
  for (const file of ['C:\\Database\\a', 'D:\\Data\\a', 'C:\\Data\\..\\outside']) expect(pathWithin('C:\\Data', file, 'win32')).toBe(false)
  expect(pathWithin('\\\\server\\share\\data', '\\\\SERVER\\SHARE\\data\\a', 'win32')).toBe(true)
  expect(pathWithin('\\\\server\\share\\data', '\\\\server\\other\\data\\a', 'win32')).toBe(false)
})
it('preserves valid POSIX filename characters and rejects relative paths', () => {
  expect(absoluteFilePath('/data/学习: one/../a\\b', 'darwin')).toBe('/data/a\\b')
  expect(pathWithin('/data', '/database/a', 'linux')).toBe(false)
  expect(() => absoluteFilePath('relative', 'linux')).toThrow('FILE_PATH_INVALID')
})

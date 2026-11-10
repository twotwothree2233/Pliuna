import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename,join } from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import {
atomicWriteFileSync,entryExistsSync,FilePublicationError,flushDirectory,flushDirectorySync,flushFileSync,
managedFile,openRegularFile,openRegularFileSync,publishPreparedFile,publishPreparedFileSync,
readRegularFileSync,regularFile,removeOwnedFileSync,fileStatSync
} from '../../src/platform/files'
import { protectPrivatePath } from '../../src/platform/permissions'

const roots: string[] = []
function scene() {
  const root = fs.mkdtempSync(join(tmpdir(), 'trellis-files-')); roots.push(root)
  const target = join(root, '学习 材料.json'), source = join(root, 'prepared.tmp')
  return { root, source, target }
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('atomically writes and replaces Unicode paths, then reads through a stable handle', () => {
  const { target } = scene()
  atomicWriteFileSync(target, 'old')
  let published = false
  atomicWriteFileSync(target, 'new 中', () => { published = true; expect(fs.readFileSync(target, 'utf8')).toBe('new 中') })
  expect(published).toBe(true)
  expect(readRegularFileSync(target, 100).toString()).toBe('new 中')
})
it('never overwrites a winner during create-only publication', () => {
  const { source, target } = scene(); fs.writeFileSync(source, 'prepared'); fs.writeFileSync(target, 'winner')
  expect(() => publishPreparedFileSync(source, target)).toThrow(FilePublicationError)
  expect(fs.readFileSync(target, 'utf8')).toBe('winner')
  expect(fs.readFileSync(source, 'utf8')).toBe('prepared')
})
it.each(['sync', 'async'] as const)('keeps a replaced source after %s create-only publication', async mode => {
  const { root, source, target } = scene(); fs.writeFileSync(source, 'prepared')
  const replaceSource = () => { fs.renameSync(source, join(root, 'retained')); fs.writeFileSync(source, 'foreign') }
  if (mode === 'async') await expect(publishPreparedFile(source, target, false, replaceSource)).rejects.toMatchObject({ outcome: 'published' })
  else {
    let failure: unknown
    try { publishPreparedFileSync(source, target, false, replaceSource) } catch (e) { failure = e }
    expect(failure).toMatchObject({ outcome: 'published' })
  }
  expect(fs.readFileSync(source, 'utf8')).toBe('foreign')
  expect(fs.readFileSync(target, 'utf8')).toBe('prepared')
})
it('does not delete the old destination to work around an occupied file', () => {
  const { target, root } = scene(); fs.writeFileSync(target, 'old')
  vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(Error('occupied'), { code: 'EPERM' }) })
  expect(() => atomicWriteFileSync(target, 'new')).toThrow(FilePublicationError)
  expect(fs.readFileSync(target, 'utf8')).toBe('old')
  expect(fs.readdirSync(root)).toEqual([basename(target)])
})
it('reports publication when rename succeeded but its completion was lost', () => {
  const { target } = scene(); fs.writeFileSync(target, 'old')
  const rename = fs.renameSync; let published = false
  vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => { rename(source, destination); throw Object.assign(Error('completion lost'), { code: 'EIO' }) })
  expect(() => atomicWriteFileSync(target, 'new', () => { published = true })).toThrow(FilePublicationError)
  expect(published).toBe(true); expect(fs.readFileSync(target, 'utf8')).toBe('new')
})
it('keeps the old file if flushing the prepared file fails', () => {
  const { target, root } = scene(); fs.writeFileSync(target, 'old')
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw Object.assign(Error('flush failed'), { code: 'EIO' }) })
  expect(() => atomicWriteFileSync(target, 'new')).toThrow('flush failed')
  expect(fs.readFileSync(target, 'utf8')).toBe('old')
  expect(fs.readdirSync(root)).toEqual([basename(target)])
})
it('exposes the actual directory durability capability', () => {
  const { root, target } = scene(); fs.writeFileSync(target, 'flush')
  flushFileSync(target)
  expect(flushDirectorySync(root)).toBe(process.platform === 'win32' ? 'file-sync-only' : 'directory-synced')
})
it('uses the validated normalized path for the complete read and flush', async () => {
  const { root, target } = scene(); fs.writeFileSync(target, 'canonical')
  const prefix = root + '/missing/../'
  expect(readRegularFileSync(prefix + basename(target), 100).toString()).toBe('canonical')
  const expected = process.platform === 'win32' ? 'file-sync-only' : 'directory-synced'
  expect(flushDirectorySync(prefix)).toBe(expected)
  expect(await flushDirectory(prefix)).toBe(expected)
})
it('refuses publication across directories', () => {
  const { root, source } = scene(); fs.writeFileSync(source, 'prepared'); fs.mkdirSync(join(root, 'other'))
  expect(() => publishPreparedFileSync(source, join(root, 'other', 'file'))).toThrow('FILE_CROSS_DIRECTORY_PUBLICATION')
  expect(fs.readFileSync(source, 'utf8')).toBe('prepared')
})
it('rejects leaf symlinks, hard links and directory junctions', () => {
  const { root, target } = scene(); fs.writeFileSync(target, 'private')
  const symbolic = join(root, 'symbolic'), hard = join(root, 'hard'), folder = join(root, 'folder'), alias = join(root, 'alias')
  fs.symlinkSync(target, symbolic, 'file')
  expect(() => openRegularFileSync(symbolic)).toThrow('FILE_UNSAFE')
  fs.linkSync(target, hard)
  expect(() => openRegularFileSync(hard)).toThrow('FILE_UNSAFE')
  fs.mkdirSync(folder); fs.symlinkSync(folder, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => managedFile(root, 'alias', 'file')).toThrow('FILE_DIRECTORY_UNSAFE')
})
it('detects replacement between lstat and open without reading the replacement', () => {
  const { root, target } = scene(); fs.writeFileSync(target, 'old')
  const open = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    if (file === target) { fs.renameSync(target, join(root, 'moved')); fs.writeFileSync(target, 'foreign') }
    return open(file, flags, mode)
  })
  expect(() => openRegularFileSync(target)).toThrow('FILE_CHANGED')
  expect(fs.readFileSync(target, 'utf8')).toBe('foreign')
})
it('checks asynchronous readers through the same file identity contract', async () => {
  const { target } = scene(); fs.writeFileSync(target, 'async')
  const handle = await openRegularFile(target)
  try { expect(await handle.readFile('utf8')).toBe('async') } finally { await handle.close() }
})
it('bounds reads and detects file growth during a read', () => {
  const { target } = scene(); fs.writeFileSync(target, 'old')
  expect(() => readRegularFileSync(target, 2)).toThrow('FILE_SIZE_LIMIT')
  const read = fs.readSync; let changed = false
  vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    if (!changed) { changed = true; fs.appendFileSync(target, 'growth') }
    return Reflect.apply(read, fs, args)
  }) as typeof fs.readSync)
  expect(() => readRegularFileSync(target, 3)).toThrow('FILE_CHANGED')
})
it('refuses lossy numeric file identities without changing journal fields', () => {
  const { target } = scene(); fs.writeFileSync(target, 'file')
  const actual = fs.lstatSync(target), unsafe = Object.assign(Object.create(actual), { ino: Number.MAX_SAFE_INTEGER + 1 })
  expect(() => regularFile(unsafe)).toThrow('FILE_IDENTITY_UNSUPPORTED')
})
function largeIdentities(file: string, pathIno: bigint, handleIno = pathIno): void {
  const lstat = fs.lstatSync, fstat = fs.fstatSync
  const identity = (stat: fs.Stats | fs.BigIntStats, ino: bigint) => Object.assign(Object.create(stat), {
    dev: typeof stat.dev === 'bigint' ? 1234n : 1234,
    ino: typeof stat.ino === 'bigint' ? ino : Number(ino)
  })
  vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
    const stat = Reflect.apply(lstat, fs, [path, options])
    return path === file ? identity(stat, pathIno) : stat
  }) as typeof fs.lstatSync)
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: fs.StatOptions) => identity(Reflect.apply(fstat, fs, [fd, options]), handleIno)) as typeof fs.fstatSync)
}
it('opens a stable handle with an exact inode above the Number safe range', () => {
  const { target } = scene(); fs.writeFileSync(target, 'exact')
  largeIdentities(target, 9007199256376705n)
  const fd = openRegularFileSync(target)
  try { expect(fs.readFileSync(fd, 'utf8')).toBe('exact') } finally { fs.closeSync(fd) }
})
it('rejects adjacent exact inodes even when Number would merge them', () => {
  const { target } = scene(); fs.writeFileSync(target, 'different')
  largeIdentities(target, 9007199254740992n, 9007199254740993n)
  expect(() => { const fd = openRegularFileSync(target); fs.closeSync(fd) }).toThrow('FILE_CHANGED')
})
it('does not remove a replacement temporary file or lock', () => {
  const { target, root } = scene(); fs.writeFileSync(target, 'owned'); const identity = fileStatSync(target)
  fs.renameSync(target, join(root, 'kept')); fs.writeFileSync(target, 'foreign')
  expect(() => removeOwnedFileSync(target, identity)).toThrow('FILE_CHANGED')
  expect(fs.readFileSync(target, 'utf8')).toBe('foreign')
})
it('treats a dangling symlink as an existing authority entry', () => {
  const { target, root } = scene(); fs.symlinkSync(join(root, 'missing'), target, 'file')
  expect(entryExistsSync(target)).toBe(true)
})
it('protects private paths with the actual host permission mechanism', () => {
  const { root, target } = scene(); fs.writeFileSync(target, 'private')
  protectPrivatePath(root, 'directory'); protectPrivatePath(target, 'file')
  expect(fs.readFileSync(target, 'utf8')).toBe('private')
  if (process.platform !== 'win32') { expect(fs.statSync(root).mode & 0o777).toBe(0o700); expect(fs.statSync(target).mode & 0o777).toBe(0o600) }
})

it.runIf(process.platform === 'win32')('keeps frozen metadata stable across repeated private ACL verification', () => {
  const { root, target } = scene(); fs.writeFileSync(target, 'retained')
  protectPrivatePath(root, 'directory', true)
  const inherited = fs.statSync(target, { bigint: true }), directory = fs.statSync(root, { bigint: true })
  protectPrivatePath(root, 'directory', true)
  expect(fs.statSync(target, { bigint: true }).ctimeNs).toBe(inherited.ctimeNs)
  expect(fs.statSync(root, { bigint: true }).ctimeNs).toBe(directory.ctimeNs)
  protectPrivatePath(target, 'file')
  const own = fs.statSync(target, { bigint: true })
  protectPrivatePath(target, 'file')
  expect(fs.statSync(target, { bigint: true }).ctimeNs).toBe(own.ctimeNs)
})

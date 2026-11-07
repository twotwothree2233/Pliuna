import { randomUUID } from 'node:crypto'
import fs,{ constants,type Stats } from 'node:fs'
import { exactFileIdentity,sameFileIdentity,type FileIdentity,type IdentityInput } from './file-identity'
import { fileFstatSync,fileHandleStat,fileLstat,fileLstatSync,fileStat,fileStatSync,type FileStat } from './file-stat'
export { exactFileIdentity,sameFileIdentity,type FileIdentity,type IdentityInput } from './file-identity'
export { fileFstatSync,fileHandleStat,fileLstat,fileLstatSync,fileStat,fileStatSync,type FileStat } from './file-stat'
import { basename,dirname,join,relative } from 'node:path'
import { absoluteFilePath,pathWithin } from './paths'

export type FileSnapshot = FileIdentity & { size: number; mtimeMs: number; ctimeMs: number }
export type DirectoryDurability = 'directory-synced' | 'file-sync-only'
const error = (code: string): never => { throw Object.assign(Error(code), { code }) }
const noFollow = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

export function regularFile<T extends Stats | FileStat>(stat: T, links = 1): T {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || stat.nlink > links) return error('FILE_UNSAFE')
  // Raw numeric Stats remain subject to the original safety check. Exact
  // snapshots have already captured the ID directly from BigInt Stats.
  exactFileIdentity(stat)
  return stat
}
export function entryExistsSync(file: string): boolean {
  try { fileLstatSync(file); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
export function assertDirectorySync(file: string): void {
  file = absoluteFilePath(file)
  const stat = fileLstatSync(file)
  if (!stat.isDirectory() || stat.isSymbolicLink()) error('FILE_DIRECTORY_UNSAFE')
  // Also catches directory reparse aliases whose lstat type is not a symlink.
  if (dirname(file) !== file && relative(join(fs.realpathSync(dirname(file)), basename(file)), fs.realpathSync(file)) !== '') error('FILE_DIRECTORY_UNSAFE')
}
export function managedFile(root: string, ...parts: string[]): string {
  assertDirectorySync(root)
  let file = root
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (!part || part === '.' || part === '..' || /[/\\\0]/.test(part)) error('FILE_PATH_INVALID')
    file = absoluteFilePath(join(file, part))
    if (!pathWithin(root, file)) error('FILE_PATH_INVALID')
    if (i < parts.length - 1) assertDirectorySync(file)
  }
  return file
}
export function managedRegularFile(root: string, ...parts: string[]): string {
  const file = managedFile(root, ...parts)
  if (entryExistsSync(file)) regularFile(fileLstatSync(file))
  return file
}
function parentSync(file: string): { path: string; stat: FileStat } {
  file = absoluteFilePath(file)
  const folder = fs.realpathSync(dirname(file)), stat = fileStatSync(folder)
  if (!stat.isDirectory()) error('FILE_DIRECTORY_UNSAFE')
  return { path: folder, stat }
}
function checkParent(file: string, before: ReturnType<typeof parentSync>): void {
  const after = parentSync(file)
  if (relative(before.path, after.path) !== '' || !sameFileIdentity(before.stat, after.stat)) error('FILE_CHANGED')
}
export function openRegularFileSync(file: string, writable = false): number {
  file = absoluteFilePath(file)
  const parent = parentSync(file), before = regularFile(fileLstatSync(file))
  const fd = fs.openSync(file, (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollow)
  try {
    const actual = regularFile(fileFstatSync(fd)), current = regularFile(fileLstatSync(file))
    if (!sameFileIdentity(before, actual) || !sameFileIdentity(before, current)) error('FILE_CHANGED')
    checkParent(file, parent)
    return fd
  } catch (e) { fs.closeSync(fd); throw e }
}
export async function openRegularFile(file: string, links = 1): Promise<fs.promises.FileHandle> {
  file = absoluteFilePath(file)
  const folder = await fs.promises.realpath(dirname(file)), parent = await fileStat(folder)
  const before = regularFile(await fileLstat(file), links)
  const handle = await fs.promises.open(file, constants.O_RDONLY | noFollow)
  try {
    const actual = regularFile(await fileHandleStat(handle), links), current = regularFile(await fileLstat(file), links)
    const afterFolder = await fs.promises.realpath(dirname(file)), afterParent = await fileStat(afterFolder)
    if (!sameFileIdentity(before, actual) || !sameFileIdentity(before, current) || relative(folder, afterFolder) !== '' || !sameFileIdentity(parent, afterParent)) error('FILE_CHANGED')
    return handle
  } catch (e) { await handle.close(); throw e }
}
export function openExclusiveFileSync(file: string): number {
  file = absoluteFilePath(file)
  const parent = parentSync(file)
  const fd = fs.openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
  try {
    if (!sameFileIdentity(regularFile(fileFstatSync(fd)), regularFile(fileLstatSync(file)))) error('FILE_CHANGED')
    checkParent(file, parent)
    return fd
  } catch (e) { fs.closeSync(fd); throw e }
}
export async function openExclusiveFile(file: string): Promise<fs.promises.FileHandle> {
  file = absoluteFilePath(file)
  const folder = await fs.promises.realpath(dirname(file)), parent = await fileStat(folder)
  const handle = await fs.promises.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
  try {
    if (!sameFileIdentity(regularFile(await fileHandleStat(handle)), regularFile(await fileLstat(file)))) error('FILE_CHANGED')
    const after = await fs.promises.realpath(dirname(file))
    if (relative(folder, after) !== '' || !sameFileIdentity(parent, await fileStat(after))) error('FILE_CHANGED')
    return handle
  } catch (e) { await handle.close(); throw e }
}
export function readRegularFileSync(file: string, maximum: number): Buffer {
  file = absoluteFilePath(file)
  const fd = openRegularFileSync(file)
  try {
    const before = fileFstatSync(fd)
    if (!Number.isSafeInteger(maximum) || maximum < 0 || before.size > maximum) error('FILE_SIZE_LIMIT')
    const body = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < body.length) { const n = fs.readSync(fd, body, length, body.length - length, length); if (!n) break; length += n }
    const end = regularFile(fileFstatSync(fd)), current = regularFile(fileLstatSync(file))
    if (length !== before.size || [end, current].some(s => !sameFileIdentity(s, before) || s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs)) error('FILE_CHANGED')
    return body.subarray(0, length)
  } finally { fs.closeSync(fd) }
}
export function flushFileSync(file: string): void {
  // FlushFileBuffers on Windows needs a handle with write access.
  const fd = openRegularFileSync(file, process.platform === 'win32')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
export function flushDirectorySync(directory: string): DirectoryDurability {
  directory = absoluteFilePath(directory)
  assertDirectorySync(directory)
  // Node does not expose a Windows directory metadata flush. This is explicit.
  if (process.platform === 'win32') return 'file-sync-only'
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd); return 'directory-synced' } finally { fs.closeSync(fd) }
}
export async function flushDirectory(directory: string): Promise<DirectoryDurability> {
  directory = absoluteFilePath(directory)
  assertDirectorySync(directory)
  if (process.platform === 'win32') return 'file-sync-only'
  const handle = await fs.promises.open(directory, 'r')
  try { await handle.sync(); return 'directory-synced' } finally { await handle.close() }
}
function sameParent(source: string, target: string): void {
  absoluteFilePath(source); absoluteFilePath(target)
  if (relative(fs.realpathSync(dirname(source)), fs.realpathSync(dirname(target))) !== '') error('FILE_CROSS_DIRECTORY_PUBLICATION')
}
export class FilePublicationError extends Error {
  constructor(readonly outcome: 'not-published' | 'published' | 'unknown', cause: unknown) { super('FILE_PUBLICATION_FAILED', { cause }) }
}
function publicationOutcome(source: string, target: string, identity: FileIdentity): 'not-published' | 'published' | 'unknown' {
  try {
    if (entryExistsSync(target) && sameFileIdentity(fileLstatSync(target), identity)) return 'published'
    if (entryExistsSync(source) && sameFileIdentity(fileLstatSync(source), identity)) return 'not-published'
  } catch { /* Ambiguous publication retains its caller's protection. */ }
  return 'unknown'
}
// Prepared files are already flushed. Never remove a destination to emulate replace.
export function publishPreparedFileSync(source: string, target: string, replace = false, onPublished: () => void = () => {}): void {
  source = absoluteFilePath(source); target = absoluteFilePath(target)
  sameParent(source, target)
  const identity = regularFile(fileLstatSync(source))
  if (entryExistsSync(target)) regularFile(fileLstatSync(target))
  try {
    if (replace) fs.renameSync(source, target)
    else {
      fs.linkSync(source, target); onPublished()
      if (!sameFileIdentity(regularFile(fileLstatSync(source), 2), identity)) error('FILE_CHANGED')
      fs.unlinkSync(source); return
    }
  } catch (e) { throw new FilePublicationError(publicationOutcome(source, target, identity), e) }
  onPublished()
}
// Private immutable names only; callers hold the runtime's directory writer lock.
// Preserve the existing single-rename staging/recovery protocol (no new link pair).
export function publishManagedFileSync(source: string, target: string): void {
  source = absoluteFilePath(source); target = absoluteFilePath(target)
  if (entryExistsSync(target)) throw new FilePublicationError('not-published', Object.assign(Error('File exists'), { code: 'EEXIST' }))
  publishPreparedFileSync(source, target, true)
}
export async function publishPreparedFile(source: string, target: string, replace: boolean, onPublished: () => void, expected?: FileSnapshot): Promise<void> {
  source = absoluteFilePath(source); target = absoluteFilePath(target)
  sameParent(source, target)
  const identity = regularFile(await fileLstat(source))
  try {
    if (replace) {
      const current = regularFile(await fileLstat(target))
      if (expected && (!sameFileIdentity(current, expected) || current.size !== expected.size || current.mtimeMs !== expected.mtimeMs || current.ctimeMs !== expected.ctimeMs)) error('FILE_CHANGED')
      await fs.promises.rename(source, target)
      onPublished()
    } else {
      await fs.promises.link(source, target); onPublished()
      if (!sameFileIdentity(regularFile(await fileLstat(source), 2), identity)) error('FILE_CHANGED')
      await fs.promises.unlink(source)
    }
  } catch (e) { throw new FilePublicationError(publicationOutcome(source, target, identity), e) }
}
export function atomicWriteFileSync(target: string, body: string | Buffer, onPublished: () => void = () => {}): void {
  target = absoluteFilePath(target)
  const temporary = target + '.' + randomUUID() + '.tmp'
  let identity: FileIdentity | undefined
  try {
    const fd = openExclusiveFileSync(temporary)
    try { identity = fileFstatSync(fd); fs.writeFileSync(fd, body); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    try { publishPreparedFileSync(temporary, target, true, onPublished) }
    catch (e) { if (e instanceof FilePublicationError && e.outcome !== 'not-published') onPublished(); throw e }
    flushDirectorySync(dirname(target))
  } finally {
    // A replaced temporary pathname is not owned by this write.
    try { if (identity && entryExistsSync(temporary) && sameFileIdentity(regularFile(fileLstatSync(temporary)), identity)) fs.unlinkSync(temporary) } catch { /* Keep an uncertain or occupied temporary file. */ }
  }
}
export function removeOwnedFileSync(file: string, expected: IdentityInput): void {
  file = absoluteFilePath(file)
  const current = regularFile(fileLstatSync(file))
  if (!sameFileIdentity(current, expected)) error('FILE_CHANGED')
  fs.unlinkSync(file)
}

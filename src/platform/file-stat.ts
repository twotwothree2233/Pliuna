import fs, { type BigIntStats, type PathLike, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { exactFileIdentity, type FileIdentity } from './file-identity'

export type FileStat = Omit<Stats, 'dev' | 'ino'> & FileIdentity
const changed = (): never => { throw Object.assign(Error('FILE_CHANGED'), { code: 'FILE_CHANGED' }) }
function snapshot(before: BigIntStats, metadata: Stats, after: BigIntStats): FileStat {
  if (typeof before.dev !== 'bigint' || typeof before.ino !== 'bigint' || typeof after.dev !== 'bigint' || typeof after.ino !== 'bigint' || typeof before.mtimeNs !== 'bigint' || typeof before.ctimeNs !== 'bigint') {
    throw Object.assign(Error('FILE_IDENTITY_UNSUPPORTED'), { code: 'FILE_IDENTITY_UNSUPPORTED' })
  }
  const identity = exactFileIdentity(before)
  exactFileIdentity(after)
  if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink', 'mode'].some(key => before[key as keyof BigIntStats] !== after[key as keyof BigIntStats])) return changed()
  // Keep Node's existing numeric metadata and Stats methods. In particular,
  // BigIntStats.mtimeMs truncates fractions and must not replace Stats.mtimeMs.
  return Object.assign(Object.create(Object.getPrototypeOf(metadata)), metadata, identity)
}
export function fileLstatSync(file: PathLike): FileStat {
  const before = fs.lstatSync(file, { bigint: true }), metadata = fs.lstatSync(file), after = fs.lstatSync(file, { bigint: true })
  return snapshot(before, metadata, after)
}
export function fileStatSync(file: PathLike): FileStat {
  const before = fs.statSync(file, { bigint: true }), metadata = fs.statSync(file), after = fs.statSync(file, { bigint: true })
  return snapshot(before, metadata, after)
}
export function fileFstatSync(fd: number): FileStat {
  const before = fs.fstatSync(fd, { bigint: true }), metadata = fs.fstatSync(fd), after = fs.fstatSync(fd, { bigint: true })
  return snapshot(before, metadata, after)
}
export async function fileLstat(file: PathLike): Promise<FileStat> {
  const before = await fs.promises.lstat(file, { bigint: true }), metadata = await fs.promises.lstat(file), after = await fs.promises.lstat(file, { bigint: true })
  return snapshot(before, metadata, after)
}
export async function fileStat(file: PathLike): Promise<FileStat> {
  const before = await fs.promises.stat(file, { bigint: true }), metadata = await fs.promises.stat(file), after = await fs.promises.stat(file, { bigint: true })
  return snapshot(before, metadata, after)
}
export async function fileHandleStat(file: FileHandle): Promise<FileStat> {
  const before = await file.stat({ bigint: true }), metadata = await file.stat(), after = await file.stat({ bigint: true })
  return snapshot(before, metadata, after)
}

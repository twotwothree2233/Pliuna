import { fileHandleStat, fileLstat as lstat, type FileSnapshot, type FileIdentity, FilePublicationError, flushDirectory, openExclusiveFile, openRegularFile, publishPreparedFile, regularFile, sameFileIdentity, exactFileIdentity } from '../platform/files'
import type { StoredFileIdentity } from '../platform/file-identity'
import { createHash,randomUUID } from 'node:crypto'
import {realpath,unlink } from 'node:fs/promises'
import { dirname,join,relative } from 'node:path'
import { absoluteFilePath } from '../platform/paths'

type Identity = FileSnapshot
async function identity(file: string, links = 1): Promise<Identity | null> {
  try { file = absoluteFilePath(file); const s = regularFile(await lstat(file), links); return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw Error('EXPORT_UNSAFE_TARGET') }
}
const same = (a: Identity | null, b: Identity | null) => JSON.stringify(a) === JSON.stringify(b)
export async function saveExport(target: string, expected: Identity | null, hooks: {
  begin(temporary: string): Promise<{ html: string }>;
  created?(identity: FileIdentity): Promise<unknown>;
  valid?(): Promise<unknown>;
  finish(phase: 'saved' | 'failed' | 'unknown', reason: string | null): Promise<unknown>
}): Promise<unknown> {
  const temporary = join(dirname(target), `.trellis-export-${randomUUID()}.tmp`)
  let created: Identity | null = null, published = false, uncertain = false, begun = false
  try {
    if (!same(await identity(target), expected)) throw Error('EXPORT_TARGET_CHANGED')
    const { html } = await hooks.begin(temporary)
    begun = true
    const body = Buffer.from(html), file = await openExclusiveFile(temporary)
    try { const stat = await fileHandleStat(file); created = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; await hooks.created?.({ dev: stat.dev, ino: stat.ino }); await file.writeFile(body); await file.sync(); const end = await fileHandleStat(file); created = { dev: end.dev, ino: end.ino, size: end.size, mtimeMs: end.mtimeMs, ctimeMs: end.ctimeMs } } finally { await file.close() }
    if (!same(await identity(temporary), created) || !same(await identity(target), expected)) throw Error('EXPORT_TARGET_CHANGED')
    await hooks.valid?.()
    if (!same(await identity(temporary), created) || !same(await identity(target), expected)) throw Error('EXPORT_TARGET_CHANGED')
    await publishPreparedFile(temporary, target, !!expected, () => { published = true }, expected ?? undefined)
    const result = await openRegularFile(target)
    try { const stat = await fileHandleStat(result); if (stat.dev !== created!.dev || stat.ino !== created!.ino || stat.size !== body.length || createHash('sha256').update(await result.readFile()).digest('hex') !== createHash('sha256').update(body).digest('hex')) throw Error('EXPORT_PUBLISH_UNKNOWN') } finally { await result.close() }
    await flushDirectory(await realpath(dirname(target)))
    return await hooks.finish('saved', null)
  } catch (error) {
    if (!begun) throw Error('EXPORT_NOT_STARTED')
    uncertain = published || (error instanceof FilePublicationError && error.outcome !== 'not-published')
    if (!published && created) {
      try { if (!same(await identity(temporary), created)) uncertain = true; else await unlink(temporary) } catch { uncertain = true }
    }
    const message = (error as Error).message, reason = /^EXPORT_[A-Z_]+$/.test(message) ? message : 'EXPORT_SAVE_FAILED'
    try { return await hooks.finish(uncertain ? 'unknown' : 'failed', reason) } catch { throw Error('EXPORT_SAVE_UNKNOWN') }
  }
}
export { identity as exportTargetIdentity }

export async function reconcileExport(job: { html: string | null; destination: { target: string; temporary: string; identity: StoredFileIdentity | null } }, acknowledge: boolean): Promise<'saved' | 'failed'> {
  const { destination: d } = job
  if (d.identity) { try { exactFileIdentity(d.identity) } catch { throw Error('EXPORT_TEMP_IDENTITY_UNKNOWN') } }
  let verified = false
  const target = await identity(d.target, 2), temporary = await identity(d.temporary, 2)
  const targetLinks = target ? (await lstat(d.target)).nlink : 0, temporaryLinks = temporary ? (await lstat(d.temporary)).nlink : 0
  const twin = targetLinks === 2 || temporaryLinks === 2
  if (twin && (!target || !temporary || targetLinks !== 2 || temporaryLinks !== 2 || !d.identity ||
      !sameFileIdentity(target, temporary) || !sameFileIdentity(target, d.identity) ||
      relative(await realpath(dirname(d.target)), await realpath(dirname(d.temporary))) !== '')) throw Error('EXPORT_TEMP_IDENTITY_UNKNOWN')
  if (target && d.identity && sameFileIdentity(target, d.identity) && job.html !== null && target.size === Buffer.byteLength(job.html)) {
    const file = await openRegularFile(d.target, twin ? 2 : 1)
    try { const s = await fileHandleStat(file); verified = s.dev === target.dev && s.ino === target.ino && createHash('sha256').update(await file.readFile()).digest('hex') === createHash('sha256').update(job.html).digest('hex') && same(target, await identity(d.target, twin ? 2 : 1)) } finally { await file.close() }
  }
  const currentTemporary = await identity(d.temporary, twin ? 2 : 1)
  if (currentTemporary) {
    if (!temporary || !same(temporary, currentTemporary) || !d.identity || !sameFileIdentity(currentTemporary, d.identity)) throw Error('EXPORT_TEMP_IDENTITY_UNKNOWN')
    if (!verified && !acknowledge) throw Error('EXPORT_ACKNOWLEDGEMENT_REQUIRED')
    await unlink(d.temporary)
    await flushDirectory(await realpath(dirname(d.temporary)))
  }
  if (!verified && !acknowledge) throw Error('EXPORT_ACKNOWLEDGEMENT_REQUIRED')
  return verified ? 'saved' : 'failed'
}

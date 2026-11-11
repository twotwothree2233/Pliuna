export type IdentityEncoding = 1 | 2
export type FileIdentity = { dev: string; ino: string }
export type StoredFileIdentity = FileIdentity | { dev: number; ino: number }
export type IdentityInput = { dev: string | number | bigint; ino: string | number | bigint }
export type JournalFileIdentity = StoredFileIdentity & { size: number; mtime: number; ctime: number; hash: string }
const maximum = (1n << 64n) - 1n
const unsupported = (): never => { throw Object.assign(Error('FILE_IDENTITY_UNSUPPORTED'), { code: 'FILE_IDENTITY_UNSUPPORTED' }) }

function field(value: unknown, positive: boolean): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) return unsupported()
    return String(value)
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > maximum || (positive && value === 0n)) return unsupported()
    return value.toString()
  }
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) return unsupported()
  const integer = BigInt(value)
  if (integer > maximum || (positive && integer === 0n)) return unsupported()
  return value
}
export function exactFileIdentity(value: IdentityInput): FileIdentity {
  if (!value || typeof value.dev !== typeof value.ino) return unsupported()
  return { dev: field(value.dev, false), ino: field(value.ino, true) }
}
export function sameFileIdentity(a: IdentityInput, b: IdentityInput): boolean {
  const left = exactFileIdentity(a), right = exactFileIdentity(b)
  return left.dev === right.dev && left.ino === right.ino
}
export function encodeFileIdentity(value: IdentityInput, encoding: IdentityEncoding): StoredFileIdentity {
  const exact = exactFileIdentity(value)
  if (encoding === 2) return exact
  if (encoding !== 1) return unsupported()
  const numeric = { dev: Number(exact.dev), ino: Number(exact.ino) }
  // A legacy write is permitted only when the exact value is still a safe integer.
  exactFileIdentity(numeric)
  return numeric
}
export function validStoredFileIdentity(value: unknown, encoding: IdentityEncoding): value is StoredFileIdentity {
  if (!value || typeof value !== 'object' || ![1, 2].includes(encoding)) return false
  const identity = value as IdentityInput, type = encoding === 1 ? 'number' : 'string'
  if (typeof identity.dev !== type || typeof identity.ino !== type) return false
  try { exactFileIdentity(identity); return true } catch { return false }
}
export function journalFileIdentity(value: JournalFileIdentity, encoding: IdentityEncoding): JournalFileIdentity {
  return { ...encodeFileIdentity(value, encoding), size: value.size, mtime: value.mtime, ctime: value.ctime, hash: value.hash }
}
export function validJournalFileIdentity(value: unknown, encoding: IdentityEncoding): value is JournalFileIdentity {
  if (!validStoredFileIdentity(value, encoding) || Object.keys(value).sort().join(',') !== 'ctime,dev,hash,ino,mtime,size') return false
  const identity = value as JournalFileIdentity
  return [identity.size, identity.mtime, identity.ctime].every(Number.isFinite) && identity.size >= 0 && /^[a-f0-9]{64}$/.test(identity.hash)
}
export function sameJournalFileIdentity(a: JournalFileIdentity, b: JournalFileIdentity): boolean {
  return sameFileIdentity(a, b) && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime && a.hash === b.hash
}

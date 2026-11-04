import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import defaults from '../shared/contracts/development-defaults.json'
import { ContractError } from '../shared/validation'

type Resource = { id: string; storage_key: string; sha256: string; byte_length: number; media_type: string; display_name: string; created_at: string }
export const digest = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const fail = (code: string, message: string): never => { throw new ContractError(code, message) }
export function resourceBody(root: string, resource: Resource): Buffer {
  if (!/^[a-zA-Z0-9_-]+$/.test(resource.storage_key)) return fail('RESOURCE_CORRUPT', 'Invalid managed resource key')
  const file = join(root, 'resources', resource.storage_key)
  let body: Buffer
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== resource.byte_length || stat.size > defaults.transport.resource_bytes) return fail('RESOURCE_CORRUPT', 'Resource length or managed file type mismatch')
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const same = (value: typeof stat) => value.isFile() && value.nlink === 1 && value.dev === stat.dev && value.ino === stat.ino && value.size === stat.size && value.mtimeMs === stat.mtimeMs && value.ctimeMs === stat.ctimeMs
    try {
      if (!same(fstatSync(fd))) return fail('RESOURCE_CORRUPT', 'Managed resource identity changed')
      body = readFileSync(fd)
      if (!same(fstatSync(fd)) || !same(lstatSync(file))) return fail('RESOURCE_CORRUPT', 'Managed resource identity changed')
    } finally { closeSync(fd) }
  } catch (error) {
    if (error instanceof ContractError) throw error
    return fail('RESOURCE_MISSING', 'Saved resource is unavailable; it was not regenerated')
  }
  if (body.length !== resource.byte_length || digest(body) !== resource.sha256) return fail('RESOURCE_CORRUPT', 'Saved resource checksum mismatch')
  return body
}
export function resourceValue(root: string, resource: Resource): Record<string, unknown> {
  const metadata = { id: resource.id, sha256: resource.sha256, byte_length: resource.byte_length, media_type: resource.media_type, display_name: resource.display_name, created_at: resource.created_at }
  const supported = ['text/plain; charset=utf-8', 'application/json', 'application/vnd.trellis.bundle+json'].includes(resource.media_type)
  if (!supported) return { ...metadata, content_available: false, reason: 'UNSUPPORTED_REPRESENTATION' }
  // The inline slice never materializes an unbounded file into a model response.
  if (resource.byte_length > Math.max(defaults.resource.inline_bytes, defaults.surface.inline_bundle_bytes)) return { ...metadata, content_available: false, reason: 'REPRESENTATION_LIMIT' }
  const body = resourceBody(root, resource)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    return { ...metadata, integrity: 'verified', content: resource.media_type.startsWith('text/') ? { type: 'text', text } : { type: 'json', value: JSON.parse(text) } }
  } catch { return fail('RESOURCE_CORRUPT', 'Resource representation is invalid; it was not repaired') }
}
export function publishResourceFile(root: string, key: string, body: Buffer): void {
  const temporary = join(root, 'resources', key + '.tmp')
  writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 })
  const fd = openSync(temporary, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, join(root, 'resources', key))
  if (process.platform !== 'win32') {
    const directory = openSync(join(root, 'resources'), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}

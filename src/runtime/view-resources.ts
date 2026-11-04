import type Database from 'better-sqlite3'
import type { Bundle } from '../shared/contracts.generated'
import { ContractError } from '../shared/validation'
import { resourceBody } from './resources'
import type { ExportResource } from './export-control'

export function bundleResources(db: Database.Database, task: string, bundle: Bundle): ExportResource[] {
  const names = new Set<string>()
  return bundle.references.map(ref => {
    if (!/^[A-Za-z][\w-]*$/.test(ref.name) || names.has(ref.name) || ref.target.kind !== 'resource' || ref.target.expected_revision !== undefined) throw new ContractError('INVALID_REFERENCE', 'View resources require unique names and same-task immutable resource targets')
    names.add(ref.name)
    const row = db.prepare('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(task, ref.target.id) as ExportResource | undefined
    if (!row) throw new ContractError('RESOURCE_MISSING', 'View resource is unavailable in this task')
    return row
  })
}
export function imageUrl(root: string, resource: ExportResource): string {
  if (!['image/png', 'image/jpeg'].includes(resource.media_type) || resource.byte_length > 4 * 1024 * 1024) throw new ContractError('UNSUPPORTED_IMAGE', 'Only bounded PNG/JPEG images are enabled')
  return imageBodyUrl(resource, resourceBody(root, resource as any))
}
export function imageBodyUrl(resource: ExportResource, body: Buffer): string {
  if (!['image/png', 'image/jpeg'].includes(resource.media_type) || resource.byte_length > 4 * 1024 * 1024) throw new ContractError('UNSUPPORTED_IMAGE', 'Only bounded PNG/JPEG images are enabled')
  const png = resource.media_type === 'image/png' && body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  const jpg = resource.media_type === 'image/jpeg' && body.length > 4 && body[0] === 255 && body[1] === 216 && body[2] === 255
  if (!png && !jpg) throw new ContractError('RESOURCE_CORRUPT', 'Image signature does not match its declared type')
  let width = 0, height = 0
  if (png && body.length >= 24 && body.toString('ascii', 12, 16) === 'IHDR') { width = body.readUInt32BE(16); height = body.readUInt32BE(20) }
  if (jpg) {
    let offset = 2
    while (offset + 4 <= body.length) {
      if (body[offset++] !== 255) break
      while (body[offset] === 255) offset++
      const marker = body[offset++]!
      if (marker === 217 || marker === 218) break
      if (marker === 1 || marker >= 208 && marker <= 215) continue
      if (offset + 2 > body.length) break
      const length = body.readUInt16BE(offset)
      if (length < 2 || offset + length > body.length) break
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length < 8) break
        height = body.readUInt16BE(offset + 3); width = body.readUInt16BE(offset + 5); break
      }
      offset += length
    }
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16777216) throw new ContractError('IMAGE_DIMENSION_LIMIT', 'Image dimensions are invalid or exceed the enabled limit')
  return `data:${resource.media_type};base64,${body.toString('base64')}`
}

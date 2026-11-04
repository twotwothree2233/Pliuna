import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import defaults from '../../shared/contracts/development-defaults.json'
import { ContractError } from '../../shared/validation'
import type { ModelRequest } from '../../shared/contracts.generated'
import type { PluginDirectory } from './directory'
import { modelReadOptions } from '../model/tool-input'
import { RepresentationPager } from '../model/representation'
import { contractRepresentation } from '../model/operation-contracts'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url')
type Query = Extract<ModelRequest, { type: 'list' | 'read' }>
const fail = (): never => { throw new ContractError('INVALID_CURSOR', 'Plugin query changed or cursor belongs to another task, source or target; restart this query') }
export class PluginQueries {
  private secret = randomBytes(32)
  private pager = new RepresentationPager()
  constructor(private directory: PluginDirectory) {}
  private token(binding: string, version: string, offset: number): string {
    const body = Buffer.from(JSON.stringify([binding, version, offset])).toString('base64url')
    return body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url')
  }
  private offset(cursor: string | undefined, binding: string, version: string): number {
    if (!cursor) return 0
    try {
      const [body, signature, extra] = cursor.split('.'), expected = createHmac('sha256', this.secret).update(body!).digest(), actual = Buffer.from(signature!, 'base64url')
      if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail()
      const [b, v, offset] = JSON.parse(Buffer.from(body!, 'base64url').toString())
      if (b !== binding || v !== version || !Number.isSafeInteger(offset) || offset < 0) return fail()
      return offset
    } catch { return fail() }
  }
  async query(task: string, source: string, request: Query): Promise<unknown> {
    const binding = hash([task, source, request.type, request.type === 'list' ? request.input.kind : request.input.target]).slice(0, 22)
    if (request.type === 'list') {
      if (request.input.filters && Object.keys(request.input.filters).length) throw new ContractError('UNSUPPORTED_FILTER', 'Plugin filters are not defined')
      const rows = request.input.kind === 'plugin' ? this.directory.summaries(task) : this.directory.discovery(task), version = hash(rows).slice(0, 22)
      const offset = this.offset(request.input.cursor, binding, version), items: unknown[] = []
      if (offset > rows.length) return fail()
      for (const row of rows.slice(offset, offset + (request.input.limit ?? defaults.list.default_items))) {
        if (Buffer.byteLength(JSON.stringify([...items, row])) > 8192) break
        items.push(row)
      }
      return { items, next_cursor: offset + items.length < rows.length ? this.token(binding, version, offset + items.length) : null, consistency: 'live' }
    }
    if (request.input.range) throw new ContractError('UNSUPPORTED_RANGE', 'Plugin content uses cursor continuation, not line ranges')
    const data = await this.directory.read(task, request.input.target.id)
    const options = modelReadOptions(request)
    if (options) {
      const revision = request.input.target.expected_revision
      if (revision !== undefined && (data as any).revision !== revision) throw new ContractError('READ_VERSION_CHANGED', 'Requested capability/content revision is unavailable')
      return this.pager.page(request.input.target.kind === 'capability' ? contractRepresentation({ ...data as object, id: request.input.target.id, kind: 'capability' }, options.selection) : data, [task, source, request.input.target], options, request.input.cursor, {}, 8192)
    }
    const bytes = Buffer.from(JSON.stringify(data)), version = hash(data).slice(0, 22)
    const start = this.offset(request.input.cursor, binding, version)
    if (start > bytes.length || (start < bytes.length && (bytes[start]! & 0xc0) === 0x80)) return fail()
    if (!request.input.cursor && bytes.length <= 8192) return { data, content_version: version, truncated: false, next_cursor: null }
    let end = Math.min(bytes.length, start + 8192)
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    while (Buffer.byteLength(JSON.stringify({ text: bytes.subarray(start, end).toString('utf8') })) > 8192) {
      end = start + Math.floor((end - start) / 2)
      while (end > start && (bytes[end]! & 0xc0) === 0x80) end--
    }
    return { representation: 'application/json; charset=utf-8', content_version: version, data: { text: bytes.subarray(start, end).toString('utf8') }, truncated: end < bytes.length, next_cursor: end < bytes.length ? this.token(binding, version, end) : null }
  }
}

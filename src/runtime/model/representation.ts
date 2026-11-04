import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import defaults from '../../shared/contracts/development-defaults.json'
import { ContractError } from '../../shared/validation'
import type { ModelReadOptions } from './tool-input'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url')
const fail = (code: string, message: string): never => { throw new ContractError(code, message) }

// Cursor keys are local to the query owner and rotate on database rebind.
export class RepresentationPager {
  private secret = randomBytes(32)
  reset(): void { this.secret = randomBytes(32) }
  page(value: unknown, binding: unknown, options: ModelReadOptions, cursor?: string, metadata: Record<string, unknown> = {}, byteBudget = defaults.read.text_bytes / 2): Record<string, any> {
    const text = JSON.stringify(value, null, 2), version = hash(value), scope = hash([binding, options])
    let start = 0, end = text.length
    if (options.selection.lines) {
      const lines = text.split('\n'), [first, last] = options.selection.lines
      if (first > lines.length) fail('INVALID_RANGE', 'Start line exceeds representation')
      start = lines.slice(0, first - 1).reduce((n, line) => n + line.length + 1, 0)
      end = Math.min(text.length, lines.slice(0, last).reduce((n, line) => n + line.length + 1, 0))
    }
    if (cursor) {
      let position: unknown
      try {
        const [prefix, body, signature, extra] = cursor.split('.')
        if (prefix !== 'm' || !body || !signature || extra !== undefined) throw Error()
        const actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', this.secret).update(body).digest()
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error()
        position = JSON.parse(Buffer.from(body, 'base64url').toString())
      } catch { return fail('INVALID_CURSOR', 'Cursor expired or belongs to another query; restart explicitly') }
      if (!Array.isArray(position) || position.length !== 3 || position[0] !== scope) return fail('INVALID_CURSOR', 'Cursor target, selection or page size changed')
      if (position[1] !== version) fail('READ_VERSION_CHANGED', 'Content changed; restart from current content')
      const offset: unknown = position[2]
      if (!Number.isSafeInteger(offset) || (offset as number) < start || (offset as number) > end) fail('INVALID_CURSOR', 'Invalid representation position')
      start = offset as number
    }
    if (!cursor && !options.selection.lines && [...text].length <= options.max_chars && Buffer.byteLength(text) <= byteBudget) return { ...metadata, content_version: version, data: value, truncated: false, next_cursor: null }
    let stop = start, bytes = 0, chars = 0
    for (const point of text.slice(start, end)) {
      const cost = Buffer.byteLength(JSON.stringify(point)) - 2
      if (chars === options.max_chars || bytes + cost > byteBudget) break
      bytes += cost; chars++; stop += point.length
    }
    const truncated = stop < end
    const body = Buffer.from(JSON.stringify([scope, version, stop])).toString('base64url')
    return { ...metadata, representation: 'application/json; charset=utf-8', content_version: version, data: { text: text.slice(start, stop) }, actual_range: { start_line: text.slice(0, start).split('\n').length, end_line: text.slice(0, Math.max(start, stop - 1)).split('\n').length }, truncated, next_cursor: truncated ? 'm.' + body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url') : null }
  }
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import defaults from '../../shared/contracts/development-defaults.json'
import type { ModelRequest } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { modelReadOptions, setModelReadOptions, type ModelReadOptions } from './tool-input'

type Read = Extract<ModelRequest, { type: 'read' }>
const fail = (): never => { throw new ContractError('INVALID_CURSOR', 'Cursor expired or target, selection or page size changed; restart this read') }
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const left = Object.keys(a).sort(), right = Object.keys(b).sort()
  return JSON.stringify(left) === JSON.stringify(right) && left.every(key => equal((a as any)[key], (b as any)[key]))
}

// The opaque signed cursor restores its runtime-local presentation and position before any query runs.
export class ReadCursors {
  private secret = randomBytes(32)
  private entries = new Map<string, { scope: unknown; options: ModelReadOptions; cursor: string }>()
  private bytes = 0
  reset(): void { this.bytes = 0; this.secret = randomBytes(32); this.entries.clear() }
  async read(task: string, source: string, request: Read, query: (read: Read) => unknown): Promise<any> {
    const supplied = modelReadOptions(request)
    if (!supplied) return query(request)
    const scope = [task, source, request.input.target.kind, request.input.target.id]
    let options: ModelReadOptions = { max_chars: supplied.max_chars, selection: supplied.selection }
    let inner = request.input.cursor
    if (inner) {
      let saved: any
      try {
        const [prefix, body, signature, extra] = inner.split('.')
        if (prefix !== 'r' || !body || !signature || extra !== undefined) return fail()
        const actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', this.secret).update(body).digest()
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail()
        saved = this.entries.get(body)
        if (!saved) return fail()
      } catch { return fail() }
      if (!equal(saved.scope, scope)) return fail()
      const conflicts = [supplied.explicit?.max_chars !== undefined && supplied.explicit.max_chars !== saved.options.max_chars ? 'max_chars' : '', supplied.explicit?.selection !== undefined && !equal(supplied.selection, saved.options.selection) ? 'selection' : ''].filter(Boolean)
      if (conflicts.length) throw new ContractError('INVALID_CURSOR', 'Cursor options conflict: ' + conflicts.join(', ') + '; continue the original selection without these overrides', JSON.stringify({ name: 'read', arguments: { kind: request.input.target.kind, id: request.input.target.id, cursor: request.input.cursor } }))
      options = saved.options; inner = saved.cursor
    }
    const restored: Read = { type: 'read', input: { ...request.input, target: { kind: request.input.target.kind, id: request.input.target.id, ...(options.selection.revision === undefined ? {} : { expected_revision: options.selection.revision }) }, ...(inner ? { cursor: inner } : {}) } }
    setModelReadOptions(restored, options)
    const result: any = await query(restored)
    if (!result || typeof result.next_cursor !== 'string') return result
    const saved = { scope, options, cursor: result.next_cursor }
    const body = createHash('sha256').update(JSON.stringify(saved)).digest('base64url')
    if (!this.entries.has(body)) {
      const size = Buffer.byteLength(JSON.stringify(saved))
      if (size > defaults.transport.rpc_message_bytes) throw new ContractError('TOOL_RESULT_LIMIT', 'Cursor state exceeds transport protection; narrow this selection')
      while (this.bytes + size > defaults.transport.rpc_message_bytes && this.entries.size) {
        const oldest = this.entries.keys().next().value!
        this.bytes -= Buffer.byteLength(JSON.stringify(this.entries.get(oldest)))
        this.entries.delete(oldest)
      }
      this.entries.set(body, saved); this.bytes += size
    }
    return { ...result, next_cursor: 'r.' + body + '.' + createHmac('sha256', this.secret).update(body).digest('base64url') }
  }
}

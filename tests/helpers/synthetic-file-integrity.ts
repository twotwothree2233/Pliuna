import { vi } from 'vitest'

// These suites exercise real files and SQLite, with a digest test double.
// Existing integrity comparisons still run; no file hash is computed.
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const values = new Map<string, Buffer>()
  const blocks = new Map<string, number>()
  const blockSize = 64 * 1024
  function blockId(bytes: Buffer): number {
    const key = bytes.toString('hex')
    if (!blocks.has(key)) blocks.set(key, blocks.size + 1)
    return blocks.get(key)!
  }
  return { ...actual, createHash(algorithm: string) {
    const parts: number[] = []
    let pending = Buffer.alloc(0)
    let ended = false
    return {
      update(value: string | Uint8Array, encoding?: BufferEncoding) {
        if (ended) throw Error('Fixture digest already finalized')
        const bytes = typeof value === 'string' ? Buffer.from(value, encoding) : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        let offset = 0
        if (pending.length) {
          const take = Math.min(blockSize - pending.length, bytes.length)
          pending = Buffer.concat([pending, bytes.subarray(0, take)]); offset = take
          if (pending.length === blockSize) { parts.push(blockId(pending)); pending = Buffer.alloc(0) }
        }
        while (offset + blockSize <= bytes.length) { parts.push(blockId(bytes.subarray(offset, offset + blockSize))); offset += blockSize }
        if (offset < bytes.length) pending = Buffer.from(bytes.subarray(offset))
        return this
      },
      digest(encoding?: BufferEncoding) {
        if (ended) throw Error('Fixture digest already finalized')
        ended = true
        if (pending.length) parts.push(blockId(pending))
        const key = algorithm + ':' + parts.join(',')
        if (!values.has(key)) values.set(key, Buffer.from((values.size + 1).toString(16).padStart(64, '0'), 'hex'))
        const result = values.get(key)!
        return encoding ? result.toString(encoding) : Buffer.from(result)
      }
    }
  } }
})

import { afterEach,vi } from 'vitest'
import { setTimeout as yieldNativeReports } from 'node:timers/promises'

// Observe the real native adapter before its error is intentionally collapsed
// by permission/control boundaries. No path, environment or command is logged.
vi.mock('../../src/platform/windows-acl', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/platform/windows-acl')>()
  return { ...original, protectWindowsPath(...args: Parameters<typeof original.protectWindowsPath>) {
    try { return original.protectWindowsPath(...args) }
    catch (error) {
      if (process.platform === 'win32' && process.env.TRELLIS_WINDOWS11_ACL_DIAGNOSTICS === '1') {
        const value = error as { code?: string; name?: string; stderr?: Buffer; cause?: Error }
        const native = value.stderr?.toString().match(/FILE_PERMISSIONS_UNAVAILABLE:([a-z-]+):([0-9]+)/)
        const cause = value.cause?.message.match(/^WINDOWS_ACL_[A-Z_]+$/)?.[0]
        console.error('WINDOWS_ACL_FAILURE ' + JSON.stringify({ kind: args[1], code: value.code ?? value.name,
          ...(native ? { stage: native[1], win32: native[2] } : {}), ...(cause ? { cause } : {}) }))
      }
      throw error
    }
  } }
})

// Only isolated test directories opt into the new Windows control format.
if (process.platform === 'win32') {
  process.env.TRELLIS_TEST_FILE_IDENTITIES = 'decimal-v2'
  // Synchronous native ACL calls otherwise starve Vitest's queued worker RPCs.
  afterEach(() => yieldNativeReports(0))
}

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
        // Repeated IDs remain distinct when a consumer takes a digest prefix.
        if (!values.has(key)) values.set(key, Buffer.from((values.size + 1).toString(16).padStart(8, '0').repeat(8), 'hex'))
        const result = values.get(key)!
        return encoding ? result.toString(encoding) : Buffer.from(result)
      }
    }
  } }
})

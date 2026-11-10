import { createHash } from 'node:crypto'
import { lstatSync,mkdirSync,unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { assertDirectorySync,atomicWriteFileSync,managedFile,readRegularFileSync } from '../platform/files'
import { directoryCandidate,officialProviders } from '../runtime/model/metadata'

const maximum = 16 * 1024 * 1024
export class ModelDirectory {
  constructor(private root: string, private transport: typeof fetch = fetch) {}
  private file(): string { return managedFile(this.root, 'cache', 'model-directory.json') }
  private cacheDirectory(): void {
    const path = join(this.root, 'cache'); mkdirSync(path, { recursive: true, mode: 0o700 })
    try { assertDirectorySync(path) } catch { throw Error('DIRECTORY_INVALID') }
  }
  async lookup(base: string, provider: string, wire: string, refresh = false): Promise<unknown> {
    if (officialProviders[base.replace(/\/$/, '')] !== provider) return { source: 'models.dev', fetched_at: null, candidate: null, notice: 'Custom proxy or unknown provider cannot inherit directory capacities' }
    this.cacheDirectory()
    let cache: { fetched_at: string; sha256: string; payload: unknown } | undefined
    if (!refresh) try {
      const st = lstatSync(this.file()); if (!st.isFile() || st.isSymbolicLink() || st.size > maximum) throw Error()
      cache = JSON.parse(readRegularFileSync(this.file(), maximum).toString('utf8'))
      if (!cache || !Number.isFinite(Date.parse(cache.fetched_at)) || createHash('sha256').update(JSON.stringify(cache.payload)).digest('hex') !== cache.sha256) cache = undefined
    } catch { /* A missing or invalid public cache does not alter saved settings. */ }
    if (!cache && refresh) {
      const response = await this.transport('https://models.dev/api.json', { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } })
      if (!response.ok || !response.body) throw Error('DIRECTORY_UNAVAILABLE')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maximum - 1024) throw Error('DIRECTORY_LIMIT'); chunks.push(part.value) } }
      finally { await reader.cancel() }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('DIRECTORY_INVALID')
      cache = { fetched_at: new Date().toISOString(), sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload }
      const body = JSON.stringify(cache); if (Buffer.byteLength(body) > maximum) throw Error('DIRECTORY_LIMIT')
      mkdirSync(join(this.root, 'cache'), { recursive: true, mode: 0o700 })
      atomicWriteFileSync(this.file(), body)
    }
    return { source: 'models.dev', fetched_at: cache?.fetched_at ?? null, sha256: cache?.sha256 ?? null, provider_id: provider, candidate: cache ? directoryCandidate(cache.payload, base, provider, wire) : null, notice: 'Public reference only; not account availability or tested capability' }
  }
  clear(): void { this.cacheDirectory(); try { unlinkSync(this.file()) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
}

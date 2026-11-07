import { createHash,randomUUID } from 'node:crypto'
import { lstat,mkdir,readdir,rename } from 'node:fs/promises'
import { join } from 'node:path'
import { assertDirectorySync,entryExistsSync,flushDirectory,openExclusiveFile,openRegularFile } from '../../platform/files'
import { protectPrivatePath } from '../../platform/permissions'
import { assertContract,ContractError } from '../../shared/validation'

export type PluginManifest = {
  manifest_version: '0.1'; protocol_version: '0.1'; id: string; version: string
  access_level: 'task' | 'global'
  contributes: { id: string; kind: 'workflow' | 'skill' | 'tool' | 'presentation' | 'resource' | 'evaluation'; entry: string; description: string }[]
  backend?: { command: string; args: string[]; entry: string } | { runtime: 'app-node'; entry: string }
  dependencies?: { plugin_id: string; version_range: string; required: boolean }[]
  requires?: { capabilities: string[]; render_profiles: string[] }
  extensions?: Record<string, unknown>
}
export type PluginFile = { path: string; bytes: number; sha256: string }
export type PluginCopy = { digest: string; manifest: PluginManifest; files: PluginFile[] }
export const packageLimits = Object.freeze({ files: 256, directories: 128, depth: 12, fileBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, manifestBytes: 64 * 1024 })
const hash = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex')
const bad = (): never => { throw new ContractError('PLUGIN_PACKAGE_INVALID', 'Plugin package is unsafe, changed, unsupported or exceeds its limits') }
const fingerprint = (files: PluginFile[]): string => hash(JSON.stringify(files))
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

export function pluginPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || value.normalize('NFC') !== value || value.split('/').length > packageLimits.depth) return false
  return value.split('/').every(part => part.length > 0 && !/[\x00-\x1f\x7f\\:*?"<>|]/.test(part) && !/[. ]$/.test(part) && !['.', '..'].includes(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}
export function validatePluginManifest(value: unknown, files: PluginFile[]): PluginManifest {
  assertContract<PluginManifest>('manifest', value)
  const manifest = value as PluginManifest, paths = new Set(files.map(f => f.path))
  if (manifest.contributes.length > 64 || new Set(manifest.contributes.map(c => c.id)).size !== manifest.contributes.length || (manifest.dependencies?.length ?? 0) > 64) bad()
  for (const contribution of manifest.contributes) {
    if (!pluginPath(contribution.entry) || !paths.has(contribution.entry) || contribution.description.length > 4000 || (contribution.kind === 'tool' && !manifest.backend)) bad()
  }
  if (manifest.backend && (!pluginPath(manifest.backend.entry) || !paths.has(manifest.backend.entry))) bad()
  if (manifest.backend && 'command' in manifest.backend && (manifest.backend.args.length > 64 || manifest.backend.args.some(arg => arg.length > 2000 || arg.includes('\0')) || /[\x00-\x1f]/.test(manifest.backend.command))) bad()
  if (new Set(manifest.dependencies?.map(d => d.plugin_id)).size !== (manifest.dependencies?.length ?? 0) || manifest.dependencies?.some(d => d.plugin_id === manifest.id || d.version_range.length > 200)) bad()
  if (manifest.requires && (manifest.requires.capabilities.length > 64 || manifest.requires.render_profiles.length > 64)) bad()
  return manifest
}
export function validatePluginCopy(value: unknown): asserts value is PluginCopy {
  const copy = value as PluginCopy
  if (!copy || Object.keys(copy).sort().join(',') !== 'digest,files,manifest' || !/^[a-f0-9]{64}$/.test(copy.digest) || !Array.isArray(copy.files) || !copy.files.length || copy.files.length > packageLimits.files) bad()
  let total = 0, previous = ''
  const names = new Set<string>()
  for (const file of copy.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'bytes,path,sha256' || !pluginPath(file.path) || compare(previous, file.path) >= 0 || names.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > packageLimits.fileBytes || !/^[a-f0-9]{64}$/.test(file.sha256)) bad()
    total += file.bytes; previous = file.path; names.add(file.path.toLowerCase())
  }
  const manifest = copy.files.find(f => f.path === 'manifest.json')
  if (total > packageLimits.totalBytes || !manifest || manifest.bytes > packageLimits.manifestBytes || fingerprint(copy.files) !== copy.digest) bad()
  validatePluginManifest(copy.manifest, copy.files)
}
async function directory(path: string): Promise<void> {
  try { assertDirectorySync(path) } catch { bad() }
}
async function body(path: string): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > packageLimits.fileBytes) bad()
  const handle = await openRegularFile(path)
  try {
    const actual = await handle.stat()
    if (!actual.isFile() || actual.nlink !== 1 || actual.size !== before.size || actual.ino !== before.ino || actual.dev !== before.dev) bad()
    // Bound reads even if another process grows an already-open file.
    const output = Buffer.alloc(actual.size + 1)
    let offset = 0
    while (offset < output.length) { const { bytesRead } = await handle.read(output, offset, output.length - offset, offset); if (!bytesRead) break; offset += bytesRead }
    const after = await handle.stat()
    if (offset !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs) bad()
    return output.subarray(0, offset)
  } finally { await handle.close() }
}
async function scan(root: string, consume?: (path: string, content: Buffer) => Promise<void>): Promise<PluginCopy> {
  await directory(root)
  const files: PluginFile[] = [], names = new Set<string>()
  let bytes = 0, directories = 0, manifestBody: Buffer | undefined
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative)
    await directory(path)
    const entries = await readdir(path)
    if (relative && !entries.length) bad()
    if (entries.length > packageLimits.files + packageLimits.directories) bad()
    for (const entry of entries.sort(compare)) {
      const name = relative ? relative + '/' + entry : entry
      if (!pluginPath(name) || names.has(name.toLowerCase())) bad()
      names.add(name.toLowerCase())
      const stat = await lstat(join(root, name))
      if (stat.isDirectory() && !stat.isSymbolicLink()) { if (++directories > packageLimits.directories) bad(); await visit(name); continue }
      if (files.length >= packageLimits.files || !stat.isFile() || stat.nlink !== 1 || stat.size > packageLimits.fileBytes || bytes + stat.size > packageLimits.totalBytes || (name === 'manifest.json' && stat.size > packageLimits.manifestBytes)) bad()
      const content = await body(join(root, name))
      bytes += content.length
      files.push({ path: name, bytes: content.length, sha256: hash(content) })
      if (name === 'manifest.json') manifestBody = content
      await consume?.(name, content)
    }
  }
  await visit('')
  if (!manifestBody) bad()
  files.sort((a, b) => compare(a.path, b.path))
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBody)) } catch { bad() }
  const copy = { digest: fingerprint(files), files, manifest: validatePluginManifest(parsed, files) }
  validatePluginCopy(copy)
  return copy
}
async function syncDirectory(path: string): Promise<void> {
  await flushDirectory(path)
}
export async function verifyPluginCopy(root: string, expected: PluginCopy): Promise<void> {
  validatePluginCopy(expected)
  await directory(join(root, 'plugins'))
  const actual = await scan(join(root, 'plugins', expected.digest))
  if (actual.digest !== expected.digest || JSON.stringify(actual.manifest) !== JSON.stringify(expected.manifest)) bad()
}
export async function readPluginEntry(root: string, copy: PluginCopy, entry: string): Promise<Buffer> {
  if (!pluginPath(entry) || !copy.files.some(file => file.path === entry)) bad()
  await verifyPluginCopy(root, copy)
  const content = await body(join(root, 'plugins', copy.digest, entry))
  if (hash(content) !== copy.files.find(file => file.path === entry)!.sha256) bad()
  return content
}
export async function copyPluginPackage(root: string, source: string): Promise<PluginCopy> {
  const folder = join(root, 'plugins')
  await mkdir(folder, { recursive: true, mode: 0o700 }); await directory(folder)
  const temporary = join(folder, 'pending-' + randomUUID())
  await mkdir(temporary, { mode: 0o700 })
  const original = await scan(source, async (path, content) => {
    const parts = path.split('/'); parts.pop()
    await mkdir(join(temporary, ...parts), { recursive: true, mode: 0o700 })
    const file = await openExclusiveFile(join(temporary, path))
    try { await file.writeFile(content); await file.sync() } finally { await file.close() }
  })
  const after = await scan(source), copied = await scan(temporary)
  if (original.digest !== after.digest || original.digest !== copied.digest) bad()
  // Flush children before publishing the immutable-name directory; failed copies remain unregistered.
  const directories = new Set(original.files.flatMap(file => { const parts = file.path.split('/'); parts.pop(); return parts.map((_, i) => parts.slice(0, i + 1).join('/')) }))
  for (const path of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(join(temporary, path))
  await syncDirectory(temporary)
  try { await rename(temporary, join(folder, original.digest)) }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') || !entryExistsSync(join(folder, original.digest))) throw error
    await verifyPluginCopy(root, original)
  }
  protectPrivatePath(join(folder, original.digest), 'directory'); await syncDirectory(folder)
  return original
}

import { createHash } from 'node:crypto'
import { closeSync,fstatSync,lstatSync,readdirSync,readSync } from 'node:fs'
import { join } from 'node:path'
import { managedFile,openRegularFileSync } from '../../platform/files'
import { ContractError } from '../../shared/validation'
import { pluginPath,validatePluginCopy,type PluginCopy } from './package'

export function validatePluginProtection(value: unknown): asserts value is PluginCopy[] {
  if (!Array.isArray(value) || value.length > 512) throw new ContractError('PLUGIN_PROTECTION_INVALID', 'Plugin copy protection cannot be verified')
  for (const copy of value) validatePluginCopy(copy)
  if (new Set(value.map(copy => copy.digest)).size !== value.length) throw new ContractError('PLUGIN_PROTECTION_INVALID', 'Duplicate plugin protection')
}

// Startup selection is synchronous: verify only bounded managed copies, never execute or restore trust.
export function verifyPluginProtection(root: string, copies: PluginCopy[]): void {
  validatePluginProtection(copies)
  const fail = (): never => { throw new ContractError('PLUGIN_COPY_UNAVAILABLE', 'A protected plugin copy is missing, unsafe or changed; retained files were not removed') }
  for (const copy of copies) {
    const folder = join(root, 'plugins', copy.digest)
    for (const path of [join(root, 'plugins'), folder]) { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) fail() }
    const expected = new Map(copy.files.map(file => [file.path, file])), seen = new Set<string>(), directories = new Set<string>()
    for (const file of copy.files) { const parts = file.path.split('/'); parts.pop(); parts.forEach((_, i) => directories.add(parts.slice(0, i + 1).join('/'))) }
    function visit(relative: string): void {
      const entries = readdirSync(join(folder, relative))
      if (entries.length > copy.files.length + directories.size) fail()
      for (const name of entries) {
        const path = relative ? relative + '/' + name : name
        if (!pluginPath(path)) fail()
        const file = managedFile(root, 'plugins', copy.digest, ...path.split('/')), stat = lstatSync(file)
        if (stat.isDirectory() && !stat.isSymbolicLink()) { if (!directories.has(path)) fail(); visit(path); continue }
        const wanted = expected.get(path)
        if (!wanted || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== wanted.bytes) fail()
        const fd = openRegularFileSync(file)
        try {
          const opened = fstatSync(fd)
          if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.nlink !== 1) fail()
          const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(256 * 1024, Math.max(1, opened.size))), chunks: Buffer[] = []
          let offset = 0
          while (offset < opened.size) { const count = readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - offset), offset); if (!count) fail(); hash.update(buffer.subarray(0, count)); if (path === 'manifest.json') chunks.push(Buffer.from(buffer.subarray(0, count))); offset += count }
          const end = fstatSync(fd), current = lstatSync(file)
          if ([end, current].some(s => s.dev !== opened.dev || s.ino !== opened.ino || s.size !== opened.size || s.nlink !== 1 || s.mtimeMs !== opened.mtimeMs || s.ctimeMs !== opened.ctimeMs) || hash.digest('hex') !== wanted!.sha256) fail()
          if (path === 'manifest.json' && JSON.stringify(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))) !== JSON.stringify(copy.manifest)) fail()
          seen.add(path)
        } finally { closeSync(fd) }
      }
    }
    visit('')
    if (seen.size !== copy.files.length) fail()
  }
}

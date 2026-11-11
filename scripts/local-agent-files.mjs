import { cpSync } from 'node:fs'
import { basename, relative } from 'node:path'

// Match local coding-assistant metadata by path component, never by the word
// "agent": application modules and model role prompts are runtime assets.
const directories = new Set(['.agents', '.codex', '.claude', '.ao', '.cursor', '.opencode', '.gemini', '.continue', '.windsurf'])
const configurations = new Set(['.claude.json', '.mcp.json', '.cursorrules', '.windsurfrules', 'opencode.json', 'opencode.jsonc'])
const guidance = /^(?:agents(?:\.(?:local|override))?|claude(?:\.local)?|gemini|context)\.md$/i

export function assertNoLocalAgentPath(path) {
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (directories.has(part.toLowerCase()) || configurations.has(part.toLowerCase()) || guidance.test(part)) {
      throw Error('Local agent file rejected: ' + path)
    }
  }
}

export function copyPackageTree(source, destination, options = {}) {
  const { filter, ...rest } = options
  cpSync(source, destination, { ...rest, filter(file, target) {
    if (filter && !filter(file, target)) return false
    // The workspace itself lives under .ao; only inspect the copied subtree.
    assertNoLocalAgentPath(relative(source, file) || basename(file))
    return true
  } })
}

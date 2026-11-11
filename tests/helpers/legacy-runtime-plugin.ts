import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { normalizePath, type Plugin } from 'vite'

// Loading through Vite keeps the existing no-file-hashing test double in use.
// Each platform creates its own real legacy files and native file identities.
export function legacyRuntimePlugin(): Plugin {
  const moduleId = '\0legacy-trellis-runtime'
  return {
    name: 'legacy-trellis-runtime',
    resolveId(source) {
      if (source === 'legacy-trellis-runtime') return moduleId
      if (source === 'legacy-trellis-windows-acl') return normalizePath(fileURLToPath(new URL('../../src/platform/windows-acl.ts', import.meta.url)))
    },
    load(id) {
      if (id === moduleId) return gunzipSync(readFileSync(new URL('../fixtures/legacy-trellis/runtime.mjs.gz', import.meta.url))).toString('utf8')
    }
  }
}

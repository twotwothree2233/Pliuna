import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build, normalizePath } from 'vite'

// The last commit before the Pliuna rename. Never substitute current sources.
const revision = '8d33ce6fc124c32ee9977d455831d8d70e763391'
const repository = fileURLToPath(new URL('../', import.meta.url))
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'pliuna-legacy-source-')))
try {
  const archive = execFileSync('git', ['archive', revision, 'src', 'package.json'], { cwd: repository, maxBuffer: 32 * 1024 * 1024 })
  execFileSync('tar', ['-xf', '-', '-C', temporary], { input: archive })
  const previous = JSON.parse(readFileSync(join(temporary, 'package.json'), 'utf8'))
  const current = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
  if (previous.name !== 'trellis' || JSON.stringify(previous.dependencies) !== JSON.stringify(current.dependencies)) throw Error('LEGACY_FIXTURE_DEPENDENCIES_CHANGED')
  symlinkSync(join(repository, 'node_modules'), join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const entry = join(temporary, 'fixture.ts')
  writeFileSync(entry, "export { RuntimeStore } from './src/runtime/store'\n")
  const result = await build({
    configFile: false, root: temporary, logLevel: 'warn',
    plugins: [{ name: 'legacy-native-adapter', enforce: 'pre', resolveId(source, importer) {
      if (importer && normalizePath(importer).startsWith(normalizePath(temporary) + '/') && /(?:^|\/)windows-acl(?:\.ts)?$/.test(source)) {
        return { id: 'legacy-trellis-windows-acl', external: true }
      }
    } }],
    build: { ssr: entry, write: false, minify: false, target: 'node22', rollupOptions: { output: { inlineDynamicImports: true } } }
  })
  if (Array.isArray(result) || !('output' in result) || result.output.length !== 1 || result.output[0]?.type !== 'chunk') throw Error('LEGACY_FIXTURE_SINGLE_MODULE_REQUIRED')
  const source = `// Frozen Trellis runtime from ${revision}. See README.md.\n${result.output[0].code}`
  if (!source.includes('from "legacy-trellis-windows-acl"') || source.includes(temporary)) throw Error('LEGACY_FIXTURE_HOST_ADAPTER_REQUIRED')
  writeFileSync(new URL('../tests/fixtures/legacy-trellis/runtime.mjs.gz', import.meta.url), gzipSync(source, { level: 9 }))
  console.log(`Generated frozen legacy runtime from ${revision}`)
} finally { rmSync(temporary, { recursive: true, force: true }) }

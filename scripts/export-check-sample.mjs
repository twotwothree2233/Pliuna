import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('vite'))('esbuild')
const work = mkdtempSync(join(tmpdir(), 'pliuna-export-sample-builder-')), entry = join(work, 'entry.ts'), output = join(work, 'sample.cjs')
writeFileSync(entry, `import {exportCheckSample} from ${JSON.stringify(resolve('tests/helpers/export-check-sample.ts'))}; console.log(JSON.stringify(exportCheckSample()));`)
await esbuild.build({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external', plugins: [{ name: 'raw', setup(build) {
  build.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'raw' }))
  build.onLoad({ filter: /.*/, namespace: 'raw' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }))
} }], logLevel: 'silent' })
// Use the existing Electron ABI without rebuilding a dependency shared with desktop tests.
process.stdout.write(execFileSync(require('electron'), [output], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(process.cwd(), 'node_modules') }, timeout: 30000, encoding: 'utf8' }))

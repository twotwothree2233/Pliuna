import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const req = createRequire(import.meta.url), esbuild = createRequire(req.resolve('vite'))('esbuild')
const working = mkdtempSync(join(tmpdir(), 'trellis-plugin-runner-')), executable = join(working, 'benchmark.cjs')
try {
  await esbuild.build({ entryPoints: ['tests/helpers/plugin-benchmark.ts'], outfile: executable, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.txt': 'text', '.sql': 'text' } })
  for (const scale of process.argv.slice(2).length ? process.argv.slice(2) : ['1', '20', '100']) {
    try { console.log(execFileSync(process.execPath, [executable, scale], { env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules') }, timeout: 120000, maxBuffer: 1024 * 1024 }).toString().trim()) }
    catch { console.log(JSON.stringify({ packages: scale, complete: false, error: 'PROCESS_FAILED_OR_120S_LIMIT', metrics_not_inferred: true })) }
  }
} finally { rmSync(working, { recursive: true, force: true }) }

import { build } from 'vite'
import { cpSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

export async function processFixtures(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'pliuna-process-fixtures-'))
  await build({ configFile: false, logLevel: 'error', build: {
    ssr: true, outDir: directory, emptyOutDir: false,
    rollupOptions: { input: { owner: resolve('tests/fixtures/process-owner.ts'), monty: resolve('tests/fixtures/monty-execution.ts') },
      external: id => !id.startsWith('.') && !id.startsWith('/') && !/^[a-z]:/i.test(id),
      output: { entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name].mjs' } }
  } })
  const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('vite'))('esbuild')
  await esbuild.build({ entryPoints: ['tests/fixtures/process-owner.ts'], outfile: join(directory, 'owner.cjs'), bundle: true,
    platform: 'node', format: 'cjs', packages: 'external', logLevel: 'error' })
  cpSync('src/platform/process-supervisor.mjs', join(directory, 'process-supervisor.mjs'))
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  // Node keeps a loaded .node library mapped until the host exits. Point the
  // temporary bundle at the app-owned helper so teardown removes only a junction.
  if (process.platform === 'win32') symlinkSync(resolve('out/main/native'), join(directory, 'native'), 'junction')
  return directory
}

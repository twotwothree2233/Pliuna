import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { nativeTargets } from '../../src/shared/native-targets.mjs'
// @ts-expect-error Standalone build tool.
import { assertCleanPayload, fileManifest, packageMacos, sourceManifest } from '../../scripts/package-macos.mjs'

// Exercise actual legacy copying and traversal with synthetic digest results.
// No real file is hashed, and no signing, archive or application process runs.
vi.mock('node:crypto', () => ({ createHash: () => ({
  update() { return this }, digest() { return 'synthetic-digest' }
}) }))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => { throw Error('Unexpected external command') }) }))

const roots: string[] = []
afterEach(() => { vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-package-agent-files-')); roots.push(root); return root
}
function put(root: string, path: string, body = 'synthetic fixture') {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); return file
}

it.each([
  'Pliuna.app/Contents/Resources/app/out/.agents/notes/audit.md',
  'app/out/.codex/config.toml',
  'app/node_modules/bindings/.claude/settings.local.json',
  'PDF Text Plugin/.ao/session.json',
  'app/AGENTS.md',
  'app/AGENTS.override.md',
  'app/AGENTS.local.md',
  'app/CLAUDE.md',
  'app/CLAUDE.local.md',
  'app/CONTEXT.md',
  'app/.cursor/rules/local.mdc',
  'app/.windsurf/rules/local.md',
  'app/.opencode/skills/local.md',
  'app/.gemini/settings.json',
  'app/.continue/config.yaml',
  'app/GEMINI.md',
  'app/.claude.json',
  'app/.mcp.json',
  'app/.cursorrules',
  'app/.windsurfrules',
  'app/opencode.json',
  'app/opencode.jsonc',
  'app/out/.github/copilot-instructions.md',
  'PDF Text Plugin/.github/instructions/review.instructions.md',
  'app/out/.github/agents/review.agent.md',
  'app/out/.github/prompts/review.prompt.md',
  'app/out/.GiThUb/CoPiLoT-Instructions.MD',
  'app\\out\\.GITHUB\\Instructions\\review.instructions.md',
  'app/out/aGeNtS.Md',
  'APP/OUT/.CoDeX/config.toml',
  'Pliuna.app\\Contents\\Resources\\app\\out\\.agents\\notes\\audit.md'
])('rejects local agent metadata in the legacy payload: %s', path => {
  expect(() => assertCleanPayload([{ path }])).toThrow('Local agent file rejected')
})
it('rejects a manifest link targeting local agent metadata', () => {
  expect(() => assertCleanPayload([{ path: 'app/guide', link: '.codex/config.toml' }])).toThrow('Local agent file rejected')
})
it.each(['.agents/notes/audit.md', '.codex/config.toml', 'AGENTS.md', 'CLAUDE.local.md', '.github/copilot-instructions.md', '.github/instructions/review.instructions.md'])('rejects legacy file traversal through %s', path => {
  const root = temporaryRoot(); put(root, path)
  expect(() => fileManifest(root)).toThrow('Local agent file rejected')
})
it.each(['.agents', '.github/instructions', '.github/agents', '.github/prompts'])('rejects empty agent directory %s during legacy traversal', path => {
  const root = temporaryRoot(); mkdirSync(join(root, path), { recursive: true })
  expect(() => fileManifest(root)).toThrow('Local agent file rejected')
})
it('keeps application agent modules and original role prompts in legacy manifests', () => {
  const root = temporaryRoot(), assets = new Map([
    ['app/out/main/agent.js', 'application agent'],
    ['app/out/renderer/AgentPanel.js', 'application UI'],
    ['PDF Text Plugin/agent-tools.mjs', 'application plugin'],
    ['app/out/.github/workflows/build.yml', 'unrelated GitHub configuration'],
    ['app/out/.github/ISSUE_TEMPLATE/bug.md', 'unrelated GitHub template']
  ])
  for (const name of ['agent', 'approval', 'summary']) {
    assets.set(`app/out/main/prompts/${name}-v0.1.txt`, readFileSync(`src/runtime/model/prompts/${name}-v0.1.txt`, 'utf8'))
  }
  for (const [path, body] of assets) put(root, path, body)
  const entries = fileManifest(root)
  expect(() => assertCleanPayload(entries)).not.toThrow()
  expect(entries.map((entry: { path: string }) => entry.path).sort()).toEqual([...assets.keys()].sort())
  for (const [path, body] of assets) expect(readFileSync(join(root, path), 'utf8')).toBe(body)
})
it.each(['app/auth.json', 'settings.json', 'app/.env', 'data/runtime.sqlite-wal', 'app/synthetic-sample/file', 'app/acceptance.mjs'])('preserves legacy private-payload rejection: %s', path => {
  expect(() => assertCleanPayload([{ path }])).toThrow('payload rejected')
})

function legacyWorkspace() {
  const root = temporaryRoot(), workspace = join(root, '.ao/workspace'), output = join(root, 'release')
  const target = nativeTargets.targets[0]!
  put(workspace, 'package.json', JSON.stringify({ name: 'pliuna', version: '0.1.0', type: 'module', main: 'out/main/index.js', dependencies: { '@pydantic/monty': '1.3.0', 'better-sqlite3': '12.4.1' }, devDependencies: { electron: '38.2.2' } }))
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'tsconfig.json', 'src/runtime/model/agent.ts', 'src/runtime/model/prompts/agent-v0.1.txt', 'scripts/build.mjs', 'reference-plugins/pdf-text/manifest.json']) put(workspace, path)
  const manifests = [
    { name: '@pydantic/monty', version: '1.3.0', optionalDependencies: { [target.package]: '1.3.0' } },
    { name: target.package, version: '1.3.0' },
    { name: 'better-sqlite3', version: '12.4.1', dependencies: { bindings: '1.0.0' } },
    { name: 'bindings', version: '1.0.0' },
    { name: 'electron', version: '38.2.2' }
  ]
  for (const manifest of manifests) put(workspace, `node_modules/${manifest.name}/package.json`, JSON.stringify(manifest))
  for (const file of [target.binary, target.native]) put(workspace, `node_modules/${target.package}/${file}`)
  for (const file of ['LICENSE', 'lib/index.js', 'build/Release/better_sqlite3.node']) put(workspace, 'node_modules/better-sqlite3/' + file)
  for (const file of ['index.js', 'runtime.js', 'monty-worker.js', 'inspection.js', 'export-check-worker.js', 'export-generation-worker.js']) put(workspace, 'out/main/' + file)
  for (const file of ['Contents/MacOS/Electron', 'Contents/Info.plist']) put(workspace, 'node_modules/electron/dist/Electron.app/' + file)
  return { workspace, output }
}

it.runIf(process.platform === 'darwin' && process.arch === 'arm64').each([
  'out/main/AGENTS.md',
  'out/.agents/notes/audit.md',
  'node_modules/bindings/.claude/settings.local.json',
  'node_modules/better-sqlite3/lib/CLAUDE.local.md',
  'node_modules/electron/dist/Electron.app/Contents/Resources/.ao/session.json',
  'reference-plugins/pdf-text/.codex/config.toml',
  'out/.github/copilot-instructions.md',
  'reference-plugins/pdf-text/.github/instructions/review.instructions.md'
])('stops the legacy macOS workflow before signing or archiving %s', path => {
  const { workspace, output } = legacyWorkspace(); put(workspace, path)
  expect(() => packageMacos(output, workspace)).toThrow('Local agent file rejected')
  expect(execFileSync).not.toHaveBeenCalled()
  expect(existsSync(output + '.zip')).toBe(false)
})
it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('copies application agents, original prompts and framework links in the legacy workflow', () => {
  const { workspace, output } = legacyWorkspace()
  const assets = new Map([['out/main/agent.js', 'application agent']])
  for (const name of ['agent', 'approval', 'summary']) {
    assets.set(`out/main/prompts/${name}-v0.1.txt`, readFileSync(`src/runtime/model/prompts/${name}-v0.1.txt`, 'utf8'))
  }
  for (const [path, body] of assets) put(workspace, path, body)
  const framework = 'node_modules/electron/dist/Electron.app/Contents/Frameworks/Fixture.framework'
  put(workspace, framework + '/Versions/A/Resources/asset')
  symlinkSync('A', join(workspace, framework, 'Versions/Current'))
  symlinkSync('Versions/Current/Resources', join(workspace, framework, 'Resources'))
  // Stop at the first external command, after the actual payload copies.
  expect(() => packageMacos(output, workspace)).toThrow('Unexpected external command')
  for (const [path, body] of assets) expect(readFileSync(join(output, 'Pliuna.app/Contents/Resources/app', path), 'utf8')).toBe(body)
  const copied = join(output, 'Pliuna.app/Contents/Frameworks/Fixture.framework')
  expect(lstatSync(join(copied, 'Versions/Current')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(copied, 'Versions/Current'))).toBe('A')
  expect(readlinkSync(join(copied, 'Resources'))).toBe('Versions/Current/Resources')
})
it('excludes root guidance but rejects agent metadata nested in recorded source trees', () => {
  const { workspace } = legacyWorkspace()
  put(workspace, 'AGENTS.md'); put(workspace, '.codex/config.toml')
  const paths = sourceManifest(workspace).map((entry: { path: string }) => entry.path)
  expect(paths).toContain('src/runtime/model/agent.ts')
  expect(paths).toContain('src/runtime/model/prompts/agent-v0.1.txt')
  expect(paths).not.toContain('AGENTS.md')
  expect(paths.some((path: string) => path.startsWith('.codex/'))).toBe(false)
  put(workspace, 'scripts/.agents/notes/audit.md')
  expect(() => sourceManifest(workspace)).toThrow('Local agent file rejected')
})

import { afterEach, expect, it } from 'vitest'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { nativeTargets } from '../../src/shared/native-targets.mjs'
// @ts-expect-error Standalone build tool.
import { desktopConfig, desktopPaths } from '../../scripts/desktop-config.mjs'
// @ts-expect-error Standalone build tool.
import { mainEntries, stageDesktop, verifyDesktopPayload } from '../../scripts/desktop-payload.mjs'
// @ts-expect-error Standalone build tool.
import { parseDesktopArgs, packageDesktop, localCandidateBuild } from '../../scripts/package-desktop.mjs'
// @ts-expect-error Standalone build tool.
import { productionPackages } from '../../scripts/production-packages.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function put(root: string, path: string, body = 'fixture') {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); return file
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'trellis-desktop-payload-')); roots.push(root)
  put(root, 'package.json', JSON.stringify({ name: 'trellis', version: '0.1.0', main: 'out/main/index.js', type: 'module', dependencies: { '@pydantic/monty': '1.3.0', 'better-sqlite3': '12.4.1' } }))
  const manifests = [
    { name: '@pydantic/monty', version: '1.3.0', optionalDependencies: Object.fromEntries(nativeTargets.targets.map(t => [t.package, '1.3.0'])) },
    { name: 'better-sqlite3', version: '12.4.1', dependencies: { bindings: '1.0.0', 'prebuild-install': 'unused' } },
    { name: 'bindings', version: '1.0.0' }, ...nativeTargets.targets.map(t => ({ name: t.package, version: '1.3.0' }))
  ]
  for (const manifest of manifests) put(root, `node_modules/${manifest.name}/package.json`, JSON.stringify(manifest))
  for (const target of nativeTargets.targets) {
    const binary = put(root, `node_modules/${target.package}/${target.binary}`); chmodSync(binary, 0o755)
    put(root, `node_modules/${target.package}/${target.native}`)
  }
  for (const entry of mainEntries) put(root, 'out/main/' + entry)
  for (const file of ['out/main/native/trellis_job.node', 'out/preload/index.cjs', 'out/renderer/index.html', 'node_modules/better-sqlite3/LICENSE', 'node_modules/better-sqlite3/lib/index.js', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node']) put(root, file)
  const executable = Buffer.alloc(512)
  executable.writeUInt16LE(0x5a4d, 0); executable.writeUInt32LE(0x80, 0x3c)
  executable.write('PE\0\0', 0x80); executable.writeUInt16LE(0x8664, 0x84); executable.writeUInt16LE(0x20b, 0x98)
  writeFileSync(put(root, 'out/main/native/trellis_acl.exe'), executable)
  for (const file of ['manifest.json', 'backend.mjs', 'parser-worker.mjs', 'network-guard.mjs', 'extract.json', 'vendor/legacy/build/pdf.mjs', 'vendor/legacy/build/pdf.worker.mjs', 'vendor/cmaps/LICENSE', 'vendor/standard_fonts/LiberationSans-Regular.ttf']) put(root, 'reference-plugins/pdf-text/' + file)
  put(root, 'reference-plugins/pdf-text/vendor-source.json', JSON.stringify({ files: [{ path: 'vendor/cmaps/LICENSE' }] }))
  const stage = join(root, 'stage'); mkdirSync(stage)
  return { root, stage }
}

for (const target of nativeTargets.targets) it.skipIf(process.platform === 'win32' && target.platform !== 'win32')(`stages only the ${target.id} production closure with workers and offline assets`, () => {
  const { root, stage } = fixture()
  put(root, 'auth.json', 'private'); put(root, '.env', 'private'); put(root, 'runtime.sqlite', 'private')
  put(root, 'node_modules/bindings/tests/fixture.js'); put(root, 'node_modules/bindings/node_modules/dev/package.json')
  const { app, plugin } = stageDesktop(root, stage, target)
  expect(verifyDesktopPayload(app, target, plugin)).toMatchObject({ target: target.id, dependencies: 4, asar: false })
  for (const file of ['auth.json', '.env', 'runtime.sqlite', 'node_modules/prebuild-install', 'node_modules/bindings/tests', 'node_modules/bindings/node_modules']) expect(existsSync(join(app, file))).toBe(false)
  expect(productionPackages(root, target).map((p: { name: string }) => p.name)).toContain(target.package)
  if (process.platform !== 'win32') expect(lstatSync(join(app, 'node_modules', target.package, target.binary)).mode & 0o111).toBeTruthy()
  expect(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))).not.toHaveProperty('scripts')
  expect(JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8')).packages).toEqual({ '': { name: 'trellis', version: '0.1.0' } })
})
it.each(['out/main/auth.json', 'out/runtime.sqlite-wal', 'reference-plugins/pdf-text/.env.local'])('rejects private payload %s', path => {
  const { root, stage } = fixture(); put(root, path)
  expect(() => stageDesktop(root, stage, nativeTargets.targets[0])).toThrow('Private payload')
})
it('rejects source symlinks even when they point to existing workspace files', () => {
  const { root, stage } = fixture()
  const target = put(root, 'secret.txt'); symlinkSync(target, join(root, 'out', 'escape.txt'))
  expect(() => stageDesktop(root, stage, nativeTargets.targets[0])).toThrow('symlink')
})
it('rejects missing workers and Windows native helpers', () => {
  for (const file of ['out/main/runtime.js', 'out/main/process-supervisor.mjs', 'out/main/native/trellis_job.node', 'out/main/native/trellis_acl.exe']) {
    const { root, stage } = fixture(); rmSync(join(root, file))
    const target = nativeTargets.targets.find(t => t.platform === 'win32')!
    expect(() => stageDesktop(root, stage, target)).toThrow()
  }
})
it('rejects an ACL helper built for another architecture', () => {
  const { root, stage } = fixture(), target = nativeTargets.targets.find(t => t.platform === 'win32')!
  const file = join(root, 'out/main/native/trellis_acl.exe'), body = readFileSync(file)
  body.writeUInt16LE(0x014c, 0x84); writeFileSync(file, body)
  expect(() => stageDesktop(root, stage, target)).toThrow('Invalid Windows ACL executable')
})
it('rejects diagnostic ACL executables in the production payload', () => {
  const { root, stage } = fixture(), target = nativeTargets.targets.find(t => t.platform === 'win32')!
  put(root, 'out/main/native/trellis_acl_probe.exe')
  expect(() => stageDesktop(root, stage, target)).toThrow('Diagnostic ACL helper')
})
it('rejects a changed native package and unaudited optional dependencies', () => {
  const { root, stage } = fixture(), target = nativeTargets.targets[0]!
  put(root, 'node_modules/bindings/package.json', JSON.stringify({ name: 'bindings', version: '1.0.0', optionalDependencies: { surprise: '1' } }))
  expect(() => stageDesktop(root, stage, target)).toThrow('Unaudited optional')
  put(root, 'node_modules/bindings/package.json', JSON.stringify({ name: 'bindings', version: '1.0.0' }))
  put(root, `node_modules/${target.package}/package.json`, JSON.stringify({ name: target.package, version: 'wrong' }))
  expect(() => stageDesktop(root, stage, target)).toThrow('native target catalog')
})
it('checks packaged permissions and rejects a second native target', () => {
  const { root, stage } = fixture(), target = nativeTargets.targets.find(t => t.platform === process.platform && t.arch === process.arch)!
  const { app, plugin } = stageDesktop(root, stage, target)
  if (process.platform !== 'win32') {
    const file = join(app, 'node_modules', target.package, target.binary); chmodSync(file, 0o644)
    expect(() => verifyDesktopPayload(app, target, plugin)).toThrow('not executable'); chmodSync(file, 0o755)
  }
  mkdirSync(join(app, 'node_modules', nativeTargets.targets.find(t => t.id !== target.id)!.package))
  expect(() => verifyDesktopPayload(app, target, plugin)).toThrow('Wrong target')
})
it.runIf(process.platform === 'win32')('rejects POSIX fixture payloads whose executable permissions Windows cannot preserve', () => {
  for (const target of nativeTargets.targets.filter(t => t.platform !== 'win32')) {
    const { root, stage } = fixture()
    expect(() => stageDesktop(root, stage, target)).toThrow('Native binary is not executable')
  }
})
it('configures local platform artifacts and current-user Windows installation', () => {
  for (const target of nativeTargets.targets) {
    const config = desktopConfig({ target, app: '/stage/app', plugin: '/stage/plugin', output: '/output', electronDist: '/electron', electronVersion: '38.2.2' })
    expect(config).toMatchObject({ asar: false, npmRebuild: false, publish: null, mac: { target: ['zip'] }, win: { target: ['nsis'] }, linux: { target: ['AppImage'] }, nsis: { perMachine: false, allowElevation: false, selectPerMachineByDefault: false, deleteAppDataOnUninstall: false } })
    expect(config.mac.signIgnore).toContain('/node_modules/@pydantic/')
    expect(config.mac.notarize).toBe(false)
    expect(desktopPaths(join(tmpdir(), 'output'), target).app).toContain('app')
  }
})
it('requires a fresh absolute output and rejects unsupported formats or targets', async () => {
  const output = join(tmpdir(), 'candidate')
  expect(parseDesktopArgs(['--output', output, '--format', 'dir'])).toEqual({ output, format: 'dir' })
  for (const args of [[], ['--output', 'relative'], ['--output', output, '--format', 'exe'], ['--output', output, '--publish', 'always']]) expect(() => parseDesktopArgs(args)).toThrow('Usage')
  await expect(packageDesktop({ output, target: 'unsupported' })).rejects.toThrow('native target host')
})
it('never publishes or consumes signing credentials and restores the environment on failure', async () => {
  const previous = process.env.CSC_TEST_FIXTURE
  process.env.CSC_TEST_FIXTURE = 'synthetic credential'
  try {
    await expect(localCandidateBuild(async (options: { publish: string }) => {
      expect(options.publish).toBe('never')
      expect(process.env.CSC_TEST_FIXTURE).toBeUndefined()
      expect(process.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
      throw Error('fixture build failed')
    }, { publish: 'always' })).rejects.toThrow('fixture build failed')
    expect(process.env.CSC_TEST_FIXTURE).toBe('synthetic credential')
  } finally { if (previous === undefined) delete process.env.CSC_TEST_FIXTURE; else process.env.CSC_TEST_FIXTURE = previous }
})

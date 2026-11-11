import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { montyTarget } from '../src/shared/native-targets.mjs'

import { productionPackages as collectProductionPackages } from './production-packages.mjs'
import { assertNoLocalAgentPath, copyPackageTree } from './local-agent-files.mjs'

export const packageTarget = montyTarget('darwin', 'arm64')
export const nativeHashes = {
  [packageTarget.binary]: packageTarget.integrity.binary,
  [packageTarget.native]: packageTarget.integrity.native
}
export const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

export function assertNewOutput(output, workspace) {
  const target = resolve(output), root = realpathSync(workspace)
  const parent = realpathSync(dirname(target))
  if (isInside(root, parent) || target === root) throw Error('Output must be outside the workspace')
  for (const file of [target, target + '.zip']) {
    // lstat also detects a dangling symlink: never replace any existing path.
    try { lstatSync(file) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    throw Error('Output already exists')
  }
  return target
}
const isInside = (root, file) => file === root || file.startsWith(root + sep)

export function productionPackages(workspace) { return collectProductionPackages(workspace, packageTarget) }

export function fileManifest(root) {
  const entries = [], base = realpathSync(root)
  function visit(folder) {
    for (const name of readdirSync(folder).sort()) {
      const file = join(folder, name), path = relative(base, file).split(sep).join('/')
      assertNoLocalAgentPath(path)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) {
        if (!isInside(base, realpathSync(file))) throw Error('Escaping package symlink: ' + path)
        entries.push({ path, link: readlinkSync(file) })
      } else if (stat.isDirectory()) visit(file)
      else if (stat.isFile()) entries.push({ path, bytes: stat.size, mode: stat.mode & 0o777, sha256: sha256(file) })
      else throw Error('Unsupported package entry: ' + path)
    }
  }
  visit(base)
  return entries
}

export function assertCleanPayload(entries) {
  for (const entry of entries) {
    assertNoLocalAgentPath(entry.path)
    if (entry.link) assertNoLocalAgentPath(entry.link)
  }
  const forbidden = /(^|\/)(auth\.json|settings\.json|[^/]*\.sqlite(?:-(?:wal|shm))?|synthetic-sample|acceptance\.mjs|\.env(?:\.[^/]*)?)(\/|$)/i
  if (entries.some(entry => forbidden.test(entry.path))) throw Error('Private or acceptance-only payload rejected')
}

function command(file, args, options = {}) { return execFileSync(file, args, { stdio: 'inherit', ...options }) }

export function readGuide(file) {
  if (file === undefined) return undefined
  if (typeof file !== 'string' || !isAbsolute(file) || !lstatSync(file).isFile()) throw Error('Guide must be an absolute regular file')
  return readFileSync(file)
}

export function copyGuide(base, bytes) {
  if (bytes !== undefined) writeFileSync(join(base, '使用指南.md'), bytes, { flag: 'wx' })
}

export function sourceManifest(workspace) {
  const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'tsconfig.json']
  for (const folder of ['src', 'scripts', 'reference-plugins/pdf-text']) {
    for (const entry of fileManifest(join(workspace, folder))) {
      if (entry.sha256 && !entry.path.endsWith('.md')) files.push(folder + '/' + entry.path)
    }
  }
  return files.sort().map(path => ({ path, sha256: sha256(join(workspace, path)) }))
}

export function parsePackageArgs(args) {
  if (![2, 4].includes(args.length) || args[0] !== '--output' || !isAbsolute(args[1]) || (args.length === 4 && (args[2] !== '--guide' || !isAbsolute(args[3])))) {
    throw Error('Usage: node scripts/package-macos.mjs --output /absolute/new/output-directory [--guide /absolute/guide-file]')
  }
  return { output: args[1], guide: args[3] }
}

export function packageMacos(output, workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..'), guide) {
  if (process.platform !== packageTarget.platform || process.arch !== packageTarget.arch) throw Error('Only macOS arm64 packaging is verified')
  // Capture an explicitly supplied guide before creating any output; no repository document is implicit.
  const guideBytes = readGuide(guide), sources = sourceManifest(workspace)
  const base = assertNewOutput(output, workspace), require = createRequire(join(workspace, 'package.json'))
  const electron = require.resolve('electron/package.json'), electronPkg = JSON.parse(readFileSync(electron, 'utf8'))
  const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'))
  if (electronPkg.version !== pkg.devDependencies.electron) throw Error('Installed Electron differs from the pinned version')
  const sourceApp = join(dirname(electron), 'dist/Electron.app'), dependencies = productionPackages(workspace)
  for (const name of ['index.js', 'runtime.js', 'monty-worker.js', 'inspection.js', 'export-check-worker.js', 'export-generation-worker.js']) {
    if (!existsSync(join(workspace, 'out/main', name))) throw Error('Build first: missing ' + name)
  }
  mkdirSync(base, { mode: 0o700 })
  const app = join(base, 'Pliuna.app'), payload = join(app, 'Contents/Resources/app')
  // Preserve framework symlinks rather than resolving links back into the checkout.
  copyPackageTree(sourceApp, app, { recursive: true, verbatimSymlinks: true })
  mkdirSync(payload, { recursive: true })
  copyPackageTree(join(workspace, 'out'), join(payload, 'out'), { recursive: true })
  writeFileSync(join(payload, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', main: pkg.main }, null, 2) + '\n')
  for (const dependency of dependencies) {
    const dest = join(payload, 'node_modules', dependency.name)
    mkdirSync(dirname(dest), { recursive: true })
    if (dependency.name === 'better-sqlite3') {
      mkdirSync(join(dest, 'build/Release'), { recursive: true })
      for (const name of ['package.json', 'LICENSE', 'lib', 'build/Release/better_sqlite3.node']) copyPackageTree(join(dependency.folder, name), join(dest, name), { recursive: true })
    } else copyPackageTree(dependency.folder, dest, { recursive: true, filter: path => !['node_modules', '.git', 'test', 'tests', 'benchmark'].includes(path.split(sep).at(-1)) })
  }
  const executable = join(app, 'Contents/MacOS/Pliuna')
  renameSync(join(app, 'Contents/MacOS/Electron'), executable)
  const plist = join(app, 'Contents/Info.plist')
  for (const [key, value] of Object.entries({ CFBundleIdentifier: 'local.pliuna.desktop', CFBundleName: 'Pliuna', CFBundleDisplayName: 'Pliuna', CFBundleExecutable: 'Pliuna', CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version })) {
    command('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
  }
  function verifyMonty() {
    for (const [name, hash] of Object.entries(nativeHashes)) {
      const file = join(payload, 'node_modules', packageTarget.package, name)
      if (sha256(file) !== hash) throw Error('Native asset hash mismatch: ' + name)
      command('/usr/bin/codesign', ['--verify', '--strict', file])
    }
  }
  verifyMonty()
  command(executable, ['-e', `const r=require('module').createRequire(${JSON.stringify(join(payload, 'package.json'))});const D=r('better-sqlite3');const d=new D(':memory:');if(d.prepare('SELECT 42 AS v').get().v!==42)throw Error('SQLite ABI');d.close();console.log('Packaged SQLite ABI '+process.versions.modules)`], { env: { ELECTRON_RUN_AS_NODE: '1', PATH: '' } })
  const frameworks = join(app, 'Contents/Frameworks'), helpers = []
  function findHelpers(folder) { for (const name of readdirSync(folder)) { const file = join(folder, name); if (lstatSync(file).isDirectory()) { if (name.endsWith('.app')) helpers.push(file); findHelpers(file) } } }
  findHelpers(frameworks)
  for (const file of helpers.sort((a, b) => b.length - a.length)) command('/usr/bin/codesign', ['--force', '--sign', '-', file])
  for (const name of readdirSync(frameworks).filter(name => name.endsWith('.framework'))) command('/usr/bin/codesign', ['--force', '--sign', '-', join(frameworks, name)])
  command('/usr/bin/codesign', ['--force', '--sign', '-', app])
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  verifyMonty()
  copyGuide(base, guideBytes)
  const plugin = join(workspace, 'reference-plugins/pdf-text')
  if (existsSync(plugin)) copyPackageTree(plugin, join(base, 'PDF Text Plugin'), { recursive: true })
  writeFileSync(join(base, 'BUILD.json'), JSON.stringify({ version: pkg.version, platform: packageTarget.id, electron: electronPkg.version, built_at: new Date().toISOString(), direct_entry: pkg.main, sources, ...(guideBytes === undefined ? {} : { guide: { path: '使用指南.md', sha256: createHash('sha256').update(guideBytes).digest('hex') } }), dependencies: dependencies.map(({ name, version }) => ({ name, version })), signing: { ad_hoc: true, developer_id: false, notarized: false }, native_hashes: nativeHashes, credentials_included: false, bit_identical_zip_claimed: false }, null, 2) + '\n')
  const entries = fileManifest(base)
  assertCleanPayload(entries)
  writeFileSync(join(base, 'FILES.json'), JSON.stringify(entries, null, 2) + '\n')
  command('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', base, base + '.zip'])
  const hash = sha256(base + '.zip')
  console.log(JSON.stringify({ output: base, zip: base + '.zip', sha256: hash, files: entries.length }))
  return { base, hash }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { output, guide } = parsePackageArgs(process.argv.slice(2))
  packageMacos(output, undefined, guide)
}

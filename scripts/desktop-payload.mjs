import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { productionPackages } from './production-packages.mjs'
import { nativeTargets } from '../src/shared/native-targets.mjs'

export const mainEntries = ['index.js', 'runtime.js', 'inspection.js', 'export-check-worker.js', 'export-generation-worker.js', 'monty-worker.js', 'process-control.js', 'process-supervisor.mjs']
const privateEntry = /(^|\/)(?:\.git|\.trellis|\.env(?:\.[^/]*)?|auth\.json|settings\.json|credentials?(?:\.[^/]*)?|[^/]*\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?)(\/|$)/i
const json = file => JSON.parse(readFileSync(file, 'utf8'))
function regular(file) {
  if (!lstatSync(file).isFile()) throw Error('Expected regular payload file: ' + file)
}
function windowsAclExecutable(file, target) {
  regular(file)
  const body = readFileSync(file)
  const invalid = () => { throw Error('Invalid Windows ACL executable') }
  if (body.length < 64 || body.readUInt16LE(0) !== 0x5a4d) invalid()
  const pe = body.readUInt32LE(0x3c)
  if (pe > body.length - 26 || body.toString('ascii', pe, pe + 4) !== 'PE\0\0' ||
      body.readUInt16LE(pe + 4) !== ({ x64: 0x8664, arm64: 0xaa64 })[target.arch] ||
      (body.readUInt16LE(pe + 22) & 0x2000) || body.readUInt16LE(pe + 24) !== 0x20b) invalid()
}

// The stage contains only the build output, the resolved production closure,
// and this explicit offline reference plugin. Never copy the workspace root.
function copyTree(source, destination, dependency = false) {
  cpSync(source, destination, { recursive: true, filter(file) {
    const path = relative(source, file).split(sep).join('/')
    if (dependency && /(^|\/)(?:node_modules|test|tests|\.github)(\/|$)/.test(path)) return false
    if (privateEntry.test(path)) throw Error('Private payload rejected: ' + path)
    if (lstatSync(file).isSymbolicLink()) throw Error('Payload symlink rejected: ' + path)
    return true
  } })
}

export function stageDesktop(workspace, stage, target) {
  const app = join(stage, 'app'), plugin = join(stage, 'pdf-text')
  const pkg = json(join(workspace, 'package.json'))
  if (pkg.main !== 'out/main/index.js') throw Error('Unexpected application entry')
  const packages = productionPackages(workspace, target)
  mkdirSync(app)
  copyTree(join(workspace, 'out'), join(app, 'out'))
  for (const { name, folder } of packages) {
    const destination = join(app, 'node_modules', name), source = realpathSync(folder)
    mkdirSync(dirname(destination), { recursive: true })
    if (name === 'better-sqlite3') {
      mkdirSync(destination)
      for (const entry of ['package.json', 'LICENSE', 'lib', 'build/Release/better_sqlite3.node']) {
        mkdirSync(dirname(join(destination, entry)), { recursive: true })
        copyTree(join(source, entry), join(destination, entry))
      }
    } else copyTree(source, destination, true)
  }
  // No scripts, dev dependencies, local pnpm links or user config enter the app.
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, description: pkg.description, type: pkg.type, main: pkg.main }, null, 2) + '\n', { flag: 'wx' })
  // Fix builder's package-manager probe to this empty npm project. Ambient
  // pnpm/corepack settings must not select or download a new package manager.
  // This stage-only lockfile is excluded from the packaged files whitelist.
  writeFileSync(join(app, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } }, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(join(app, 'DESKTOP-BUILD.json'), JSON.stringify({ target: target.id, dependencies: packages.map(({ name, version }) => ({ name, version })), asar: false, calculationVerified: target.runtimeVerified }, null, 2) + '\n', { flag: 'wx' })
  copyTree(join(workspace, 'reference-plugins/pdf-text'), plugin)
  verifyDesktopPayload(app, target, plugin)
  return { app, plugin }
}

export function verifyDesktopPayload(app, target, plugin) {
  let files = 0
  function visit(folder, root) {
    for (const name of readdirSync(folder)) {
      const file = join(folder, name), path = relative(root, file).split(sep).join('/'), stat = lstatSync(file)
      if (privateEntry.test(path)) throw Error('Private payload rejected: ' + path)
      if (name === 'trellis_acl_probe.exe') throw Error('Diagnostic ACL helper rejected from payload')
      if (stat.isSymbolicLink()) throw Error('Payload symlink rejected: ' + path)
      if (stat.isDirectory()) visit(file, root)
      else if (stat.isFile()) files++
      else throw Error('Unsupported payload entry: ' + path)
    }
  }
  visit(app, app); visit(plugin, plugin)
  const pkg = json(join(app, 'package.json'))
  if (pkg.main !== 'out/main/index.js' || pkg.devDependencies || pkg.scripts) throw Error('Unexpected packaged manifest')
  for (const file of [...mainEntries.map(name => 'out/main/' + name), 'out/preload/index.cjs', 'out/renderer/index.html', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node']) regular(join(app, file))
  if (target.platform === 'win32') {
    regular(join(app, 'out/main/native/trellis_job.node'))
    windowsAclExecutable(join(app, 'out/main/native/trellis_acl.exe'), target)
  }
  else if ((lstatSync(join(app, 'node_modules', target.package, target.binary)).mode & 0o111) === 0) throw Error('Native binary is not executable')
  for (const file of [target.binary, target.native]) regular(join(app, 'node_modules', target.package, file))
  for (const candidate of nativeTargets.targets) {
    if (candidate.id === target.id) continue
    try { lstatSync(join(app, 'node_modules', candidate.package)) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    throw Error('Wrong target package included: ' + candidate.id)
  }
  const metadata = json(join(app, 'DESKTOP-BUILD.json'))
  if (metadata.target !== target.id || metadata.asar !== false) throw Error('Unexpected build target')
  for (const { name, version } of metadata.dependencies) {
    const actual = json(join(app, 'node_modules', name, 'package.json'))
    if (actual.name !== name || actual.version !== version) throw Error('Packaged dependency differs: ' + name)
  }
  for (const name of [nativeTargets.montyPackage, target.package]) {
    if (json(join(app, 'node_modules', name, 'package.json')).version !== nativeTargets.montyVersion) throw Error('Monty differs from the native target catalog')
  }
  for (const file of ['manifest.json', 'backend.mjs', 'parser-worker.mjs', 'network-guard.mjs', 'extract.json', 'vendor-source.json', 'vendor/legacy/build/pdf.mjs', 'vendor/legacy/build/pdf.worker.mjs', 'vendor/cmaps/LICENSE', 'vendor/standard_fonts/LiberationSans-Regular.ttf']) regular(join(plugin, file))
  // Structural validation only. The existing plugin installation path retains
  // its separate integrity checks; this command never calculates file digests.
  for (const entry of json(join(plugin, 'vendor-source.json')).files) {
    if (!/^vendor\/[A-Za-z0-9_./-]+$/.test(entry.path) || entry.path.split('/').some(part => part === '..' || part === '.')) throw Error('Invalid offline asset path')
    regular(join(plugin, entry.path))
  }
  return { target: target.id, files, dependencies: metadata.dependencies.length, asar: false }
}

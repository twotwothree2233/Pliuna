import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { hostMontyTarget, nativeTargets } from '../src/shared/native-targets.mjs'
import { assertNewOutput } from './package-macos.mjs'
import { desktopConfig, desktopPaths } from './desktop-config.mjs'
import { stageDesktop, verifyDesktopPayload } from './desktop-payload.mjs'
import { productionPackages } from './production-packages.mjs'

const desktopUsage = 'Usage: --output /absolute/new/directory [--format dir] [--target catalog-id] [--electron-dist /absolute/distribution]'
export function parseDesktopArgs(args) {
  const options = { format: 'default' }, seen = new Set()
  const flags = new Map([['--output', 'output'], ['--format', 'format'], ['--target', 'target'], ['--electron-dist', 'electronDist']])
  for (let i = 0; i < args.length; i += 2) {
    const key = flags.get(args[i])
    if (!key || !args[i + 1] || seen.has(key)) throw Error(desktopUsage)
    seen.add(key); options[key] = args[i + 1]
  }
  if (!options.output || !isAbsolute(options.output) || !['default', 'dir'].includes(options.format)) throw Error(desktopUsage)
  if (options.electronDist && !isAbsolute(options.electronDist)) throw Error('Electron distribution must be absolute')
  return options
}

export async function localCandidateBuild(build, options) {
  const credentials = Object.entries(process.env).filter(([name]) => /^(?:CSC_|WIN_CSC_|APPLE_)/i.test(name))
  for (const [name] of credentials) delete process.env[name]
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  try { return await build({ ...options, publish: 'never' }) }
  finally {
    delete process.env.CSC_IDENTITY_AUTO_DISCOVERY
    for (const [name, value] of credentials) process.env[name] = value
  }
}

export async function packageDesktop(options, workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const host = hostMontyTarget(), target = options.target ? nativeTargets.targets.find(t => t.id === options.target) : host
  if (!target || target.id !== host?.id) throw Error('Packaging requires the native target host and its production dependencies')
  const output = assertNewOutput(options.output, workspace), require = createRequire(join(workspace, 'package.json'))
  const electronManifest = require.resolve('electron/package.json'), electron = JSON.parse(readFileSync(electronManifest, 'utf8'))
  const pkg = JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8'))
  if (electron.version !== pkg.devDependencies.electron) throw Error('Installed Electron differs from the pinned version')
  const electronDist = options.electronDist ?? join(dirname(electronManifest), 'dist')
  if (readFileSync(join(electronDist, 'version'), 'utf8').trim().replace(/^v/, '') !== electron.version) throw Error('Electron distribution differs from the pinned version')
  const stage = mkdtempSync(join(tmpdir(), 'pliuna-desktop-stage-'))
  try {
    const native = productionPackages(workspace, target).find(pkg => pkg.name === target.package)
    const originalAssets = [target.binary, target.native].map(name => ({ name, bytes: readFileSync(join(native.folder, name)) }))
    const payload = stageDesktop(workspace, stage, target)
    const { build, Platform, Arch } = await import('electron-builder')
    const platform = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX }[target.platform]
    const format = options.format ?? 'default'
    const config = desktopConfig({ target, ...payload, output, electronDist, electronVersion: electron.version, format })
    // Candidate packages are local only, including when CI provides credentials.
    await localCandidateBuild(build, { projectDir: payload.app, targets: platform.createTarget(format === 'dir' ? 'dir' : undefined, Arch[target.arch]), config })
    const paths = desktopPaths(output, target)
    const result = verifyDesktopPayload(paths.app, target, join(dirname(paths.app), 'reference-plugins/pdf-text'))
    for (const { name, bytes } of originalAssets) {
      if (!readFileSync(join(paths.app, 'node_modules', target.package, name)).equals(bytes)) throw Error('Packaging changed an upstream Monty asset: ' + name)
    }
    console.log(JSON.stringify({ ...result, ...paths, output, format, published: false }))
    return paths
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageDesktop(parseDesktopArgs(process.argv.slice(2)))

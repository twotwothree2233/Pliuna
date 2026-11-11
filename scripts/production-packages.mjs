import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { nativeTargets } from '../src/shared/native-targets.mjs'

// Resolve through pnpm's installed graph before flattening the runtime closure.
function packageManifest(name, from) {
  const require = createRequire(join(from, 'package.json'))
  try { return require.resolve(name + '/package.json') } catch {
    let folder = dirname(require.resolve(name))
    for (;;) {
      const file = join(folder, 'package.json')
      if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).name === name) return file
      const parent = dirname(folder)
      if (parent === folder) throw Error('Package manifest unavailable: ' + name)
      folder = parent
    }
  }
}

export function productionPackages(workspace, packageTarget) {
  if (!nativeTargets.targets.some(target => target.id === packageTarget?.id && target.package === packageTarget.package)) throw Error('Unknown native target')
  const packages = new Map()
  function collect(name, from) {
    const manifest = packageManifest(name, from), folder = dirname(manifest)
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (name === packageTarget.package && pkg.version !== nativeTargets.montyVersion) throw Error('Native package differs from the native target catalog')
    if (packages.has(name)) {
      if (packages.get(name).version !== pkg.version) throw Error('Dependency version conflict: ' + name)
      return
    }
    packages.set(name, { name, version: pkg.version, folder })
    // SQLite's prebuild installer is not used after its verified native build.
    const dependencies = name === 'better-sqlite3' ? ['bindings'] : Object.keys(pkg.dependencies ?? {})
    for (const dependency of dependencies) collect(dependency, folder)
    if (name === nativeTargets.montyPackage) {
      if (pkg.version !== nativeTargets.montyVersion || pkg.optionalDependencies?.[packageTarget.package] !== nativeTargets.montyVersion) throw Error('Monty differs from the native target catalog')
      collect(packageTarget.package, folder)
    }
    else if (Object.keys(pkg.optionalDependencies ?? {}).length) throw Error('Unaudited optional runtime dependency: ' + name)
  }
  for (const name of Object.keys(JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')).dependencies)) collect(name, workspace)
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP') {
  throw Error('DESIGNATED_WINDOWS_X64_RUNNER_REQUIRED')
}
const evidence = process.env.TRELLIS_WIN11_EVIDENCE
if (!evidence || !path.isAbsolute(evidence)) throw Error('WINDOWS11_EVIDENCE_REQUIRED')

// Use the same locked node-gyp as the existing Node/Electron rebuild entry.
// Only choose the entry; never patch installed packages or suppress tar errors.
const rebuildRequire = createRequire(require.resolve('@electron/rebuild'))
const gyp = rebuildRequire.resolve('node-gyp/bin/node-gyp.js')
const gypRequire = createRequire(gyp)
const tar = gypRequire.resolve('tar')
const report = {
  node: process.version,
  node_gyp: { entry: gyp, version: gypRequire('../package.json').version },
  tar: { entry: tar, version: gypRequire('tar/package.json').version },
  lifecycle_packages: ['better-sqlite3', 'electron', 'esbuild']
}
fs.writeFileSync(path.join(evidence, 'dependency-toolchain.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
fs.appendFileSync(process.env.GITHUB_ENV, 'npm_config_node_gyp=' + gyp + '\n')

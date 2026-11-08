const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP') {
  throw Error('DESIGNATED_WINDOWS_X64_RUNNER_REQUIRED')
}
const evidence = process.env.TRELLIS_WIN11_EVIDENCE
if (!evidence || !path.isAbsolute(evidence)) throw Error('WINDOWS11_EVIDENCE_REQUIRED')
const report = { status: 'started' }
const save = () => fs.writeFileSync(path.join(evidence, 'electron-download.json'), JSON.stringify(report, null, 2) + '\n')

async function main() {
  const electronRequire = createRequire(require.resolve('electron/package.json'))
  const version = electronRequire('./package.json').version
  const file = `electron-v${version}-win32-x64.zip`
  const canonical = `https://github.com/electron/electron/releases/download/v${version}/${file}`
  // @electron/get is locked with Electron. Populate its normal cache only;
  // the original install.js retains its own validation and extraction.
  const { Cache } = require(path.join(path.dirname(electronRequire.resolve('@electron/get')), 'Cache.js'))
  const cache = new Cache(process.env.electron_config_cache)
  const headers = { 'User-Agent': 'Trellis-Windows11-dependencies', Accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN
  const metadata = await fetch(`https://api.github.com/repos/electron/electron/releases/tags/v${version}`, {
    headers, signal: AbortSignal.timeout(60000)
  })
  if (!metadata.ok) throw Error('ELECTRON_RELEASE_HTTP_' + metadata.status)
  const release = await metadata.json()
  const asset = release.assets?.find(item => item.name === file)
  if (release.tag_name !== 'v' + version || !asset || asset.browser_download_url !== canonical ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
      asset.url !== 'https://api.github.com/repos/electron/electron/releases/assets/' + asset.id) {
    throw Error('OFFICIAL_ELECTRON_ASSET_REQUIRED')
  }
  Object.assign(report, { version, file, source: asset.url, canonical, size: asset.size })
  save()
  const cached = await cache.getPathForFileInCache(canonical, file)
  if (cached && fs.statSync(cached).size === asset.size) {
    report.status = 'cached'; save(); console.log(JSON.stringify(report)); return
  }
  const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'trellis-electron-'))
  const heartbeat = setInterval(() => console.log(JSON.stringify({ phase: 'electron_download_in_progress', file })), 30000)
  try {
    const destination = path.join(work, file)
    const response = await fetch(asset.url, {
      headers: { ...headers, Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(600000)
    })
    if (!response.ok) throw Error('ELECTRON_ASSET_HTTP_' + response.status)
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }))
    if (fs.statSync(destination).size !== asset.size) throw Error('ELECTRON_ASSET_SIZE_MISMATCH')
    const descriptor = fs.openSync(destination, 'r'), magic = Buffer.alloc(2)
    try { fs.readSync(descriptor, magic, 0, 2, 0) } finally { fs.closeSync(descriptor) }
    if (magic.toString('ascii') !== 'PK') throw Error('ELECTRON_ZIP_REQUIRED')
    report.cache = await cache.putFileInCache(canonical, destination, file)
    report.status = 'downloaded'; save(); console.log(JSON.stringify(report))
  } finally {
    clearInterval(heartbeat)
    fs.rmSync(work, { recursive: true, force: true })
  }
}
main().catch(error => { report.status = 'failed'; report.error = String(error.message); save(); console.error(error); process.exitCode = 1 })

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')
const { spawn } = require('node:child_process')
const data = require('./windows11-default-data.cjs')
const fail = code => { throw Object.assign(Error(code), { code }) }
const clean = error => /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'CANDIDATE_OPERATION_FAILED'
const identity = file => { const s = fs.lstatSync(file, { bigint: true }); if (s.isSymbolicLink() || !s.isDirectory()) fail('CANDIDATE_DIRECTORY_UNSAFE'); return { dev: String(s.dev), ino: String(s.ino) } }
const same = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino
const absent = file => { try { fs.lstatSync(file); fail('CANDIDATE_TARGET_EXISTS') } catch (e) { if (e.code !== 'ENOENT') throw e } }
const evidence = () => process.env.TRELLIS_WIN11_EVIDENCE
const stateFile = () => path.join(evidence(), 'candidate.json')
const read = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
const save = value => fs.writeFileSync(stateFile(), JSON.stringify(value, null, 2) + '\n')
function environment() {
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'RUNNER_TRACKING_ID'])
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())))
}
function approved() {
  data.standardHost()
  if (process.env.TRELLIS_WINDOWS11_CANDIDATE !== '1') fail('CANDIDATE_EXPLICIT_APPROVAL_REQUIRED')
}
async function preflight(core) {
  const report = { stage: 'preflight', passed: false, application_tests: 0, mutations: false }
  try {
    approved()
    report.default = await data.inventory()
    report.default_target_present = !report.default.absent
    report.stage = 'ready_for_candidate'; report.passed = true
  } catch (error) { report.error = clean(error); core.setFailed(report.error) }
  fs.writeFileSync(path.join(evidence(), 'candidate-preflight.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ stage: report.stage, passed: report.passed, default_target_present: report.default_target_present, application_tests: 0, error: report.error }))
}
async function managed(command, args, timeout = 180000) {
  const { startProcessTree } = await import(pathToFileURL(path.resolve('out/main/process-control.js')))
  const errors = []
  const env = { ...environment(), RUNNER_NAME: process.env.RUNNER_NAME, TRELLIS_WIN11_EVIDENCE: evidence(), TRELLIS_WINDOWS11_CANDIDATE: '1' }
  const tree = startProcessTree({ mode: 'spawn', command, args, cwd: process.cwd(), env }, { runtime: process.execPath, failed: code => errors.push(code) })
  let output = '', bytes = 0
  tree.process.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 16384) output += chunk; else { errors.push('CANDIDATE_OUTPUT_LIMIT'); tree.terminate() } })
  tree.process.stderr.resume()
  try {
    await tree.ready
    const exit = await tree.confirm(timeout)
    if (exit.code !== 0 || exit.signal || errors.length) {
      const error = Object.assign(Error('CANDIDATE_CHILD_FAILED'), { code: 'CANDIDATE_CHILD_FAILED', output, exit, errors })
      throw error
    }
    return { output, job_empty: true, exit: exit.code }
  } finally { tree.terminate(); await tree.confirm(10000) }
}
async function registry() {
  // Same fixed UUID-v5 namespace as electron-builder 26.4.0, not an app scan.
  const { createRequire } = require('node:module')
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const libRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  const { UUID } = libRequire('builder-util-runtime')
  const guid = UUID.v5('app.trellis.desktop', UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const command = `$ErrorActionPreference='Stop'; $keys=@('Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}','Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}','Registry::HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}'); $present=@($keys|Where-Object { Test-Path -LiteralPath $_ }); [Console]::Write($present.Count)`
  const result = await managed(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], 10000)
  if (!/^[0-3]$/.test(result.output.trim())) fail('CANDIDATE_REGISTRY_UNKNOWN')
  return Number(result.output.trim())
}
async function install() {
  approved()
  const preflight = JSON.parse(fs.readFileSync(path.join(evidence(), 'candidate-preflight.json'), 'utf8'))
  if (!preflight.passed) fail('CANDIDATE_PREFLIGHT_REQUIRED')
  const current = await data.inventory(preflight.default)
  if (await registry() !== 0) fail('CANDIDATE_EXISTING_INSTALLATION')
  const suffix = process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT
  if (!/^[0-9]+-[0-9]+$/.test(suffix)) fail('CANDIDATE_BATCH_INVALID')
  const local = process.env.LOCALAPPDATA
  const parents = []
  let cursor = path.parse(local).root
  for (const part of local.slice(cursor.length).split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); parents.push({ path: cursor, identity: identity(cursor) }) }
  const installDir = path.join(local, 'Trellis 验收 ' + suffix)
  absent(installDir)
  for (const shortcut of [path.join(os.homedir(), 'Desktop/Trellis.lnk'), path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Trellis.lnk')]) absent(shortcut)
  const output = process.env.TRELLIS_DESKTOP_OUTPUT
  const installers = fs.readdirSync(output).filter(name => /^Trellis-.*\.exe$/.test(name))
  if (installers.length !== 1) fail('CANDIDATE_INSTALLER_UNCONFIRMED')
  const installer = path.join(output, installers[0])
  const stat = fs.lstatSync(installer)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('CANDIDATE_INSTALLER_UNSAFE')
  const report = { stage: 'native_preservation_probe', passed: false, default: current, install_dir: installDir, installer, parents, published: false, signed: false }
  save(report)
  try {
    const helper = path.resolve('node_modules/.cache/trellis-native/trellis_preserve.exe')
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-preserve-probe-'))
    const probe = await managed(helper, ['probe', fixture], 10000)
    report.preservation_probe = JSON.parse(probe.output.trim())
    if (!['probe', 'no_overwrite', 'identity_refusal', 'same_identity', 'security_preserved'].every(key => report.preservation_probe[key] === true)) fail('CANDIDATE_PRESERVATION_PROBE_FAILED')
    report.stage = 'preserve_default'; save(report)
    if (!current.absent) {
      const leaf = '.trellis.ao-preserved-' + suffix
      const backup = path.join(os.homedir(), leaf)
      absent(backup)
      await data.inventory(current)
      report.backup = { path: backup, identity: current.rootIdentity, performed: false }; save(report)
      let result
      try { result = await managed(helper, ['preserve', leaf, current.homeIdentity.dev, current.homeIdentity.ino, current.rootIdentity.dev, current.rootIdentity.ino], 10000) }
      catch (error) { try { report.preservation_failure = JSON.parse(error.output.trim()); report.backup.performed = report.preservation_failure.renamed === true } catch {}; throw error }
      report.preservation = JSON.parse(result.output.trim())
      report.backup.performed = report.preservation.renamed === true
      save(report)
      if (!report.backup.performed || report.preservation.security_preserved !== true || !same(identity(backup), current.rootIdentity)) fail('CANDIDATE_PRESERVATION_UNCONFIRMED')
    }
    await data.beforeFirstLaunch()
    report.stage = 'installing'; save(report)
    const result = await managed(process.execPath, [__filename, 'child-install'])
    report.install = JSON.parse(result.output.trim()); report.install.job_empty = result.job_empty
    report.install_identity = identity(installDir)
    if (await registry() !== 1) fail('CANDIDATE_INSTALL_REGISTRATION_UNCONFIRMED')
    report.stage = 'installed'; save(report)
    await installed()
    await data.beforeFirstLaunch()
    report.passed = true; save(report)
    console.log(JSON.stringify({ stage: report.stage, passed: true, prior_default_preserved: Boolean(report.backup?.performed), install_exit: report.install.exit, job_empty: report.install.job_empty }))
  } catch (error) {
    report.failed_stage = report.stage; report.stage = 'failed'; report.error = clean(error)
    try { report.child_failure = JSON.parse(error.output.trim()) } catch {}
    save(report); throw error
  }
}
async function installed() {
  approved()
  const state = read()
  if (!['installed', 'uninstalled', 'reinstalled'].includes(state.stage) || !same(identity(state.install_dir), state.install_identity)) fail('CANDIDATE_INSTALLED_IDENTITY_CHANGED')
  for (const value of state.parents) if (!same(identity(value.path), value.identity)) fail('CANDIDATE_INSTALL_PARENT_CHANGED')
  const { verifyDesktopPayload } = await import('./desktop-payload.mjs')
  const { hostMontyTarget } = await import('../src/shared/native-targets.mjs')
  verifyDesktopPayload(path.join(state.install_dir, 'resources/app'), hostMontyTarget(), path.join(state.install_dir, 'resources/reference-plugins/pdf-text'))
  const executable = path.join(state.install_dir, 'Trellis.exe')
  const stat = fs.lstatSync(executable)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('CANDIDATE_EXECUTABLE_UNSAFE')
  return { executable, app: path.join(state.install_dir, 'resources/app'), root: state.default.root, plugin: path.join(state.install_dir, 'resources/reference-plugins/pdf-text') }
}
async function reinstall() {
  approved()
  const state = read()
  if (state.stage !== 'installed' || !state.passed) fail('CANDIDATE_INSTALLED_REQUIRED')
  const profile = await data.inventory()
  const defaultProof = require('./verify-default-startup-result.cjs')
  if (profile.absent || !same(profile.rootIdentity, defaultProof.identity.directory)) fail('CANDIDATE_TEST_PROFILE_REQUIRED')
  state.test_profile_identity = profile.rootIdentity; save(state)
  const result = await managed(process.execPath, [__filename, 'child-uninstall'])
  state.uninstall = JSON.parse(result.output.trim()); state.uninstall.job_empty = result.job_empty
  if (await registry() !== 0) fail('CANDIDATE_UNINSTALL_REGISTRATION_REMAINS')
  if (!same((await data.inventory(profile)).rootIdentity, state.test_profile_identity)) fail('CANDIDATE_UNINSTALL_DATA_CHANGED')
  absent(path.join(state.install_dir, 'Trellis.exe'))
  state.stage = 'uninstalled'; save(state)
  const installResult = await managed(process.execPath, [__filename, 'child-install'])
  state.reinstall = JSON.parse(installResult.output.trim()); state.reinstall.job_empty = installResult.job_empty
  state.install_identity = identity(state.install_dir); state.stage = 'reinstalled'; save(state)
  await installed()
  if (await registry() !== 1 || !same((await data.inventory(profile)).rootIdentity, state.test_profile_identity)) fail('CANDIDATE_REINSTALL_DATA_CHANGED')
  state.data_preserved = true; save(state)
  console.log('CANDIDATE_REINSTALL ' + JSON.stringify({ uninstall: state.uninstall, reinstall: state.reinstall, data_preserved: true, same_version: true }))
}
async function uninstallAfterFailure() {
  approved()
  const state = read()
  if (state.stage !== 'installed' || !state.passed) fail('CANDIDATE_INSTALLED_REQUIRED')
  await installed()
  const profile = await data.inventory()
  const result = await managed(process.execPath, [__filename, 'child-uninstall'])
  state.failure_uninstall = { ...JSON.parse(result.output.trim()), job_empty: result.job_empty }
  if (await registry() !== 0) fail('CANDIDATE_UNINSTALL_REGISTRATION_REMAINS')
  await data.inventory(profile)
  absent(path.join(state.install_dir, 'Trellis.exe'))
  state.stage = 'uninstalled_after_failure'; state.passed = false; state.default_data_retained = true
  save(state)
  console.log('CANDIDATE_FAILED_SCENARIO_INSTALL_REMOVED_DATA_RETAINED')
}
async function child(operation) {
  approved()
  const state = read(), installing = operation === 'child-install'
  const executable = installing ? state.installer : path.join(state.install_dir, 'Uninstall Trellis.exe')
  const args = installing ? ['/S', '/currentuser', '/D=' + state.install_dir] : ['/S', '/currentuser']
  const result = await new Promise((resolve, reject) => {
    const process = spawn(executable, args, { env: environment(), windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' })
    process.once('error', reject); process.once('close', (exit, signal) => resolve({ started: true, exit, signal }))
  })
  console.log(JSON.stringify(result))
  if (result.exit !== 0 || result.signal) fail('CANDIDATE_INSTALLER_FAILED')
}
module.exports = { preflight, installed, environment }
if (require.main === module) (async () => {
  const action = process.argv[2]
  if (action === 'install') await install()
  else if (action === 'reinstall') await reinstall()
  else if (action === 'uninstall-after-failure') await uninstallAfterFailure()
  else if (['child-install', 'child-uninstall'].includes(action)) await child(action)
  else fail('CANDIDATE_ACTION_INVALID')
})().catch(error => { console.error(clean(error)); process.exitCode = 1 })

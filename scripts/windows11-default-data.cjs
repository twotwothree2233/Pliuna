const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const code = error => /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'DEFAULT_DATA_CHECK_FAILED'
const fail = value => { throw Object.assign(new Error(), { code: value }) }

// Runs in a bounded leaf process. Never creates the default data directory,
// enumerates its contents, or changes any permission/attribute.
function inspectDefaultData(config) {
  const fs = require('node:fs'), path = require('node:path').win32, os = require('node:os')
  const fail = code => { throw Object.assign(new Error(), { code }) }
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino
  const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })
  const home = os.homedir(), profile = process.env.USERPROFILE ?? ''
  if (!/^[a-z]:\\/i.test(home) || !path.isAbsolute(profile) || path.resolve(home).toLowerCase() !== path.resolve(profile).toLowerCase()) fail('DEFAULT_HOME_UNCONFIRMED')
  let current = path.parse(home).root, stat = fs.lstatSync(current, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('DEFAULT_ANCESTOR_REPARSE')
  for (const part of home.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); stat = fs.lstatSync(current, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('DEFAULT_ANCESTOR_REPARSE')
    fs.accessSync(current, fs.constants.R_OK)
  }
  fs.accessSync(home, fs.constants.R_OK | fs.constants.W_OK)
  const homeIdentity = identity(stat), root = path.join(home, '.trellis')
  if (config.previous && (config.previous.root !== root || !same(config.previous.homeIdentity, homeIdentity))) fail('DEFAULT_HOME_CHANGED')
  let target
  try { target = fs.lstatSync(root, { bigint: true }) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (config.operation === 'inventory' && config.previous && config.previous.absent !== !target) fail('DEFAULT_DIRECTORY_CHANGED')
  if (config.operation === 'absent') {
    if (target) fail(target.isSymbolicLink() ? 'DEFAULT_DIRECTORY_REPARSE' : 'DEFAULT_DIRECTORY_EXISTS')
    return { root, homeIdentity, absent: true }
  }
  if (!target) {
    if (config.operation === 'inventory') return { root, homeIdentity, absent: true }
    fail('DEFAULT_DIRECTORY_MISSING')
  }
  if (!target.isDirectory() || target.isSymbolicLink()) fail('DEFAULT_DIRECTORY_REPARSE')
  const rootIdentity = identity(target)
  if ((config.operation === 'owned' && !config.previous?.rootIdentity) ||
      (config.previous?.rootIdentity && !same(config.previous.rootIdentity, rootIdentity))) fail('DEFAULT_DIRECTORY_CHANGED')
  if (!['observe', 'owned', 'inventory'].includes(config.operation)) fail('DEFAULT_OPERATION_INVALID')
  return { root, homeIdentity, rootIdentity, absent: false }
}

function standardHost() {
  const host = JSON.parse(fs.readFileSync(path.join(process.env.TRELLIS_WIN11_EVIDENCE, 'host.json'), 'utf8'))
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP' ||
      host.runner !== 'DESKTOP-SFE95TP' || host.standard_user_required !== true || host.elevated !== false ||
      host.administrators_group_present !== false || host.system_account !== false || host.user_interactive !== true ||
      !Number.isInteger(host.session_id) || host.session_id <= 0 || host.product_type !== 1 ||
      !Number.isInteger(host.build) || host.build < 22000 || host.architecture !== 'X64' || !host.caption?.includes('Windows 11')) fail('STANDARD_WINDOWS11_HOST_REQUIRED')
}

function childEnvironment() {
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'RUNNER_TRACKING_ID'])
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())))
}

function execute(executable, args, ipc = false) {
  return new Promise(resolve => {
    let child, timer, done = false, output = '', message
    const result = { started: false, exit: null, timeout: false, error: null }
    const finish = () => {
      if (done) return
      done = true; clearTimeout(timer); resolve({ ...result, output, message })
    }
    const stop = (error, timeout = false) => {
      result.error = error; result.timeout = timeout
      try { child?.kill() } catch {}
      finish()
    }
    try {
      child = spawn(executable, args, { env: childEnvironment(), windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore', ...(ipc ? ['ipc'] : [])] })
      result.started = Boolean(child.pid)
      timer = setTimeout(() => stop('DEFAULT_QUERY_TIMEOUT', true), 5000)
      child.once('error', error => { result.error = code(error); finish() })
      child.on('message', value => { message = value })
      child.stdout.on('data', bytes => {
        output += bytes.toString('utf8')
        if (Buffer.byteLength(output) > 8192) { output = ''; stop('DEFAULT_QUERY_OUTPUT_LIMIT') }
      })
      child.once('close', value => { result.exit = value; finish() })
    } catch (error) { result.error = code(error); finish() }
  })
}

async function metadata(operation, previous) {
  const config = JSON.stringify({ operation, previous })
  const worker = `try { const result=(${inspectDefaultData.toString()})(${config}); process.send({result},()=>process.disconnect()); } catch(error) { process.send({error:/^[A-Z0-9_]{1,64}$/.test(error.code||'')?error.code:'DEFAULT_METADATA_FAILED'},()=>process.disconnect()); process.exitCode=1; }`
  const result = await execute(process.execPath, ['-e', worker], true)
  if (result.error || result.exit !== 0 || !result.message?.result) fail(result.error ?? result.message?.error ?? 'DEFAULT_METADATA_FAILED')
  return result.message.result
}

async function processes(appPid) {
  const command = `
    $ErrorActionPreference='Stop';
    [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false;
    $items=@(Get-CimInstance Win32_Process -Filter "Name='Trellis.exe' OR Name='electron.exe'" |
      Select-Object @{Name='pid';Expression={[int]$_.ProcessId}},@{Name='parent';Expression={[int]$_.ParentProcessId}});
    ConvertTo-Json -InputObject $items -Compress
  `
  const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const query = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', command])
  if (query.error || query.exit !== 0) fail(query.error ?? 'DEFAULT_PROCESS_QUERY_FAILED')
  let values
  try { values = JSON.parse(query.output.replace(/^\uFEFF/, '')) } catch { fail('DEFAULT_PROCESS_QUERY_INVALID') }
  if (!Array.isArray(values) || values.length > 64 || values.some(v => !Number.isInteger(v.pid) || v.pid <= 0 || !Number.isInteger(v.parent) || v.parent < 0) || new Set(values.map(v => v.pid)).size !== values.length) fail('DEFAULT_PROCESS_QUERY_INVALID')
  if (!appPid && values.length) fail('DEFAULT_INSTANCE_ALREADY_RUNNING')
  if (appPid) {
    if (!Number.isInteger(appPid) || appPid <= 0 || !values.some(v => v.pid === appPid)) fail('DEFAULT_INSTANCE_UNCONFIRMED')
    const parents = new Map(values.map(v => [v.pid, v.parent]))
    for (const value of values) {
      let pid = value.pid, attempts = 0
      while (pid !== appPid && parents.has(pid) && attempts++ <= values.length) pid = parents.get(pid)
      if (pid !== appPid) fail('DEFAULT_INSTANCE_CONFLICT')
    }
  }
  return values.length
}

// Single runner job + named-process exclusion + a final metadata read form the
// test's exclusivity check. Any observed conflict fails; no root is reserved.
async function check(operation, previous, appPid) {
  standardHost()
  const first = await metadata(operation, previous)
  const processCount = await processes(appPid)
  const result = await metadata(operation === 'observe' ? 'owned' : operation, first)
  return { ...result, processCount }
}

module.exports = async function preflightDefaultData(core) {
  const report = { stage: 'checking', application_tests: 0, read_only: true, directory_created: false, passed: false }
  try {
    const result = await check('absent')
    report.passed = true; report.stage = 'ready'; report.default_directory_absent = result.absent
    report.named_processes = result.processCount; report.ancestors_local_accessible = true
  } catch (error) { report.stage = 'blocked_environment'; report.error = code(error) }
  fs.writeFileSync(path.join(process.env.TRELLIS_WIN11_EVIDENCE, 'default-data-preflight.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (!report.passed) core.setFailed('DEFAULT_DATA_PREFLIGHT_' + report.error)
  return report
}

module.exports.beforeFirstLaunch = () => check('absent')
module.exports.observeCreated = (previous, appPid) => check('observe', previous, appPid)
module.exports.beforeRestart = previous => check('owned', previous)
module.exports.verifyIdentity = previous => { standardHost(); return metadata('owned', previous) }
module.exports.inventory = previous => check('inventory', previous)
module.exports.standardHost = standardHost

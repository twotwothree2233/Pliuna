const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFile, execFileSync } = require('node:child_process')
const verifyTools = require('./windows11-standard-toolchain.cjs')
const { performance } = require('node:perf_hooks')
const source = 'https://github.com/actions/python-versions/releases/download/3.12.10-14343898437/python-3.12.10-win32-x64.zip'

function installationBlocker(report) {
  if (report?.stage !== 'blocked_environment' || report.error !== 'TOOLCHAIN_INCOMPLETE' ||
      report.registry?.exit !== 0 || report.registry?.error || report.missing?.length !== 1 || report.missing[0] !== 'python') return 'PRECHECK_INCOMPLETE'
  const candidates = report.python?.candidates ?? []
  for (const key of ['registry_current_user_python', 'registry_machine_python']) {
    if (candidates.find(value => value.category === key)?.error !== 'NOT_CONFIGURED') return 'PYTHON_REGISTRATION_CONFLICT'
  }
  for (const value of candidates.filter(value => value.category !== 'path')) {
    if (value.accessible || !['ENOENT', 'ENOTDIR', 'NOT_CONFIGURED'].includes(value.error)) return 'PYTHON_CANDIDATE_UNKNOWN'
  }
  return null
}

function installerEnvironment() {
  const env = {}
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
    'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
    'PUBLIC', 'RUNNER_NAME', 'RUNNER_TRACKING_ID', 'TRELLIS_PREPARE_PYTHON_APPROVED']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.PATH = path.join(env.SystemRoot, 'System32') + ';' + env.SystemRoot
  env.ComSpec = path.join(env.SystemRoot, 'System32', 'cmd.exe')
  return env
}

// The worker owns only this run's temporary directory and the absent current-user
// target. It never executes setup.ps1 or inherits GitHub/runner credentials.
async function installPython(config) {
  const fs = require('node:fs'), path = require('node:path').win32
  const { execFileSync, execFile, spawn } = require('node:child_process')
  const { Readable, Transform } = require('node:stream')
  const { pipeline } = require('node:stream/promises')
  const state = { stage: 'inspect', exit_code: null, timeout: false, restart_required: false }
  const fail = code => { throw Object.assign(new Error(), { code }) }
  const safeCode = error => /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'PREPARATION_FAILED'
  const send = stage => { state.stage = stage; process.send(state) }
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP' || process.env.TRELLIS_PREPARE_PYTHON_APPROVED !== '1') fail('PYTHON_PREPARATION_NOT_APPROVED')
    const profile = process.env.USERPROFILE ?? '', local = process.env.LOCALAPPDATA ?? ''
    const boot = path.parse(process.env.SystemRoot ?? '').root.toLowerCase()
    function metadata(file, kind, roots, absent = false) {
      if (!path.isAbsolute(file) || path.parse(file).root.toLowerCase() !== boot || !/^[a-z]:\\$/.test(boot)) fail('NONLOCAL_PATH')
      if (!roots.some(root => { const relative = path.relative(path.resolve(root), path.resolve(file)); return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative) })) fail('OUTSIDE_ALLOWED_ROOTS')
      const absolute = path.resolve(file), root = path.parse(absolute).root
      let current = root, stat = fs.lstatSync(root)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('REPARSE_PATH')
      const parts = absolute.slice(root.length).split(path.sep).filter(Boolean)
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index])
        try { stat = fs.lstatSync(current) }
        catch (error) { if (absent && error.code === 'ENOENT') return null; throw error }
        if (stat.isSymbolicLink()) fail('REPARSE_PATH')
        if (index < parts.length - 1 && !stat.isDirectory()) fail('INVALID_PATH')
      }
      if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) fail('INVALID_PATH')
      fs.accessSync(absolute, fs.constants.R_OK)
      return absolute
    }
    const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    function registrationsAbsent() {
      const command = `
        $ErrorActionPreference = 'Stop';
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false;
        $present = $false;
        foreach ($key in @('HKCU:\\Software\\Python\\PythonCore\\3.12\\InstallPath', 'HKLM:\\Software\\Python\\PythonCore\\3.12\\InstallPath')) {
          if (Test-Path -LiteralPath $key) { $present = $true }
        };
        [ordered]@{ absent = -not $present } | ConvertTo-Json -Compress
      `
      const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true, env: process.env, timeout: 5000, maxBuffer: 512, stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/^\uFEFF/, '').trim()
      if (JSON.parse(output).absent !== true) fail('PYTHON_REGISTRATION_CONFLICT')
    }
    send('inspect')
    metadata(profile, 'directory', [profile]); metadata(local, 'directory', [profile])
    const target = path.join(local, 'Programs', 'Trellis-Toolchain', 'Python312')
    if (metadata(target, 'directory', [profile], true)) fail('PYTHON_TARGET_ALREADY_EXISTS')
    registrationsAbsent()
    const temp = metadata(config.temp, 'directory', [config.temp])
    if (!/^[0-9]+-[0-9]+$/.test(config.suffix)) fail('WORK_PATH_INVALID')
    const work = path.join(temp, 'trellis-python-' + config.suffix)
    if (metadata(work, 'directory', [temp], true)) fail('WORK_ALREADY_EXISTS')
    fs.mkdirSync(work)
    const archive = path.join(work, 'python-3.12.10-win32-x64.zip')
    const installer = path.join(work, 'python-3.12.10-amd64.exe')
    send('download')
    const response = await fetch(source, { credentials: 'omit', headers: { 'User-Agent': 'Trellis-Windows11-Python-preparation', Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(180000) })
    if (!response.ok) fail('DOWNLOAD_HTTP_' + response.status)
    if (new URL(response.url).protocol !== 'https:' || !['github.com', 'release-assets.githubusercontent.com'].includes(new URL(response.url).hostname)) fail('DOWNLOAD_SOURCE_INVALID')
    const expected = 26672655
    if (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== expected) fail('ARCHIVE_SIZE_INVALID')
    let size = 0
    const limit = new Transform({ transform(chunk, encoding, callback) { size += chunk.length; callback(size > expected ? Object.assign(new Error(), { code: 'ARCHIVE_SIZE_INVALID' }) : null, chunk) } })
    await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(archive, { flags: 'wx' }))
    if (size !== expected) fail('ARCHIVE_SIZE_INVALID')
    function magic(file, expected) {
      const descriptor = fs.openSync(file, 'r'), bytes = Buffer.alloc(2)
      try { if (fs.readSync(descriptor, bytes, 0, 2, 0) !== 2 || bytes.toString('ascii') !== expected) fail('INSTALLER_FORMAT_INVALID') }
      finally { fs.closeSync(descriptor) }
    }
    magic(archive, 'PK')
    send('extract')
    const extract = `
      $ErrorActionPreference = 'Stop';
      Add-Type -AssemblyName System.IO.Compression.FileSystem;
      $archive = [System.IO.Compression.ZipFile]::OpenRead($env:TRELLIS_PYTHON_ARCHIVE);
      try {
        $entry = $archive.GetEntry('python-3.12.10-amd64.exe');
        if ($null -eq $entry -or $entry.Length -le 0 -or $entry.Length -gt 67108864) { throw 'PYTHON_INSTALLER_ENTRY_INVALID' };
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $env:TRELLIS_PYTHON_INSTALLER, $false)
      } finally { $archive.Dispose() }
    `
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', extract], {
      windowsHide: true, env: { ...process.env, TRELLIS_PYTHON_ARCHIVE: archive, TRELLIS_PYTHON_INSTALLER: installer },
      timeout: 15000, maxBuffer: 512, stdio: ['ignore', 'pipe', 'ignore'] })
    metadata(installer, 'file', [work]); magic(installer, 'MZ')
    send('recheck')
    if (metadata(target, 'directory', [profile], true)) fail('PYTHON_TARGET_ALREADY_EXISTS')
    registrationsAbsent()
    fs.mkdirSync(path.dirname(target), { recursive: true }); metadata(path.dirname(target), 'directory', [profile])
    send('install')
    const args = ['/quiet', '/norestart', 'InstallAllUsers=0', 'TargetDir=' + target, 'PrependPath=0', 'AppendPath=0',
      'Include_launcher=0', 'InstallLauncherAllUsers=0', 'AssociateFiles=0', 'Shortcuts=0', 'CompileAll=0',
      'Include_exe=1', 'Include_lib=1', 'Include_pip=1', 'Include_test=0', 'Include_doc=0', 'Include_tcltk=0',
      'Include_tools=0', 'Include_dev=0', 'Include_symbols=0', '/log', path.join(work, 'installer-raw.log')]
    state.exit_code = await new Promise((resolve, reject) => {
      const child = spawn(installer, args, { cwd: work, env: process.env, windowsHide: true, stdio: 'ignore' })
      let timer, timedOut = false
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', value => { clearTimeout(timer); if (!timedOut) resolve(value) })
      timer = setTimeout(() => {
        timedOut = true; state.timeout = true
        execFile(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
          { env: process.env, timeout: 3000, windowsHide: true }, error => reject(Object.assign(new Error(), { code: error ? 'INSTALL_TIMEOUT_TERMINATION_UNKNOWN' : 'INSTALL_TIMEOUT' })))
      }, 300000)
    })
    state.restart_required = state.exit_code === 3010
    if (state.restart_required) fail('RESTART_REQUIRED')
    if (state.exit_code !== 0) fail('INSTALLER_EXIT_FAILED')
    send('installed')
  } catch (error) {
    state.failure_phase = state.stage; state.error = safeCode(error)
    state.timeout ||= error?.code === 'ETIMEDOUT' || ['TimeoutError', 'AbortError'].includes(error?.name)
    send('failed'); process.exitCode = 1
  } finally { if (process.connected) process.disconnect() }
}

module.exports = async function preparePython(core) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP' || process.env.TRELLIS_PREPARE_PYTHON_APPROVED !== '1') throw Error('PYTHON_PREPARATION_NOT_APPROVED')
  const file = path.join(process.env.TRELLIS_WIN11_EVIDENCE, 'python-preparation.json')
  const report = { approved_installation: true, application_tests: 0, source, asset_id: 244701309,
    stage: 'precheck', exit_code: null, timeout: false, restart_required: false }
  const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  // The expected missing-Python result is inspected, not converted to success.
  // All unknown/non-Python errors still fail this preparation step.
  const inspectionCore = { setFailed() {}, addPath() {}, exportVariable() {}, setOutput() {}, setSecret: core.setSecret }
  try {
    save()
    const before = await verifyTools(inspectionCore, { expose: false })
    report.before = before.report; save()
    let selected = before.python
    if (before.report.stage !== 'ready') {
      const blocker = installationBlocker(before.report)
      if (blocker) throw Object.assign(new Error(), { code: blocker })
      const env = installerEnvironment()
      await new Promise((resolve, reject) => {
        const config = { temp: process.env.RUNNER_TEMP, suffix: process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT }
        const child = spawn(process.execPath, [__filename, '--prepare', JSON.stringify(config)], {
          cwd: process.env.RUNNER_TEMP, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
        let timer, finished = false, lastStage = 'inspect'
        const deadline = performance.now() + 535000
        const limits = { inspect: 15000, download: 185000, extract: 20000, recheck: 10000, install: 310000, installed: 1000, failed: 1000 }
        const finish = error => {
          if (finished) return; finished = true; clearTimeout(timer)
          if (child.connected) child.disconnect()
          child.unref(); error ? reject(Object.assign(new Error(), { code: error })) : resolve()
        }
        const terminate = () => {
          report.timeout = true
          execFile(path.join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
            { env, windowsHide: true, timeout: 3000 }, error => finish(error ? 'PREPARATION_TIMEOUT_TERMINATION_UNKNOWN' : 'PREPARATION_TIMEOUT'))
        }
        child.once('error', () => finish('WORKER_START_FAILED'))
        child.on('message', message => {
          if (!Object.hasOwn(limits, message?.stage)) return
          Object.assign(report, message); lastStage = message.stage; save(); console.log(JSON.stringify(report))
          clearTimeout(timer); timer = setTimeout(terminate, Math.max(1, Math.min(limits[lastStage], deadline - performance.now())))
        })
        child.once('close', exit => finish(exit === 0 && lastStage === 'installed' ? null : report.error ?? 'WORKER_INCOMPLETE'))
        timer = setTimeout(terminate, 15000)
      })
      report.stage = 'verify'; save()
      const after = await verifyTools(inspectionCore, { expose: false })
      report.after = after.report; selected = after.python
      const target = path.join(process.env.LOCALAPPDATA, 'Programs', 'Trellis-Toolchain', 'Python312', 'python.exe')
      if (after.report.stage !== 'ready' || after.report.python.version !== '3.12.10' || typeof selected !== 'string' || path.resolve(selected).toLowerCase() !== path.resolve(target).toLowerCase()) throw Object.assign(new Error(), { code: 'INSTALLED_PYTHON_UNCONFIRMED' })
      report.result = 'installed'; report.version = after.report.python.version
    } else {
      report.result = 'reused'; report.version = before.report.python.version
    }
    const pip = execFileSync(selected, ['-I', '-B', '-m', 'pip', '--version'], { windowsHide: true, timeout: 3000, maxBuffer: 512,
      env: { ...installerEnvironment(), PIP_CONFIG_FILE: 'NUL' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const match = pip.match(/^pip ([0-9]+(?:\.[0-9]+){1,2}) from [^\r\n]+ \(python 3\.12\)$/)
    if (!match) throw Object.assign(new Error(), { code: 'PIP_VERSION_UNCONFIRMED' })
    core.setSecret(selected); core.setSecret(path.dirname(selected))
    core.addPath(path.dirname(selected)); core.exportVariable('PYTHON', selected)
    report.pip_version = match[1]; report.job_python_selected = true; report.stage = 'ready'; save()
    console.log(JSON.stringify(report))
  } catch (error) {
    report.failure_phase ??= report.stage; report.stage = 'failed'
    report.timeout ||= error?.code === 'ETIMEDOUT'
    report.error = /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'PREPARATION_FAILED'
    save(); core.setFailed('PYTHON_PREPARATION_' + report.error)
  }
}

if (require.main === module) {
  if (process.argv[2] !== '--prepare') throw Error('PYTHON_PREPARATION_MODE_REQUIRED')
  installPython(JSON.parse(process.argv[3]))
}

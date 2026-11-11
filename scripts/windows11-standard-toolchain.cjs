const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')

// This gate has no installation or download branch. All tool queries run in a
// separate process so synchronous filesystem/registry calls share one deadline.
function inspectTools() {
  const fs = require('node:fs'), path = require('node:path').win32
  const { execFileSync } = require('node:child_process')
  const report = { stage: 'registry', approved_installation: false, application_tests: 0,
    python: { valid: false, candidates: [] }, visual_cpp: { valid: false }, windows_sdk: { valid: false } }
  const code = error => /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'QUERY_FAILED'
  const fail = value => { throw Object.assign(new Error(), { code: value }) }
  const send = extra => process.send({ report, ...extra })
  const profile = process.env.USERPROFILE ?? '', local = process.env.LOCALAPPDATA ?? ''
  const machine = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
  const boot = path.parse(process.env.SystemRoot ?? '').root.toLowerCase()
  const machinePython = path.join(boot, 'Python312')
  const allowed = [profile, ...machine, machinePython].filter(Boolean)
  function within(root, file) {
    const relative = path.relative(path.resolve(root), path.resolve(file))
    return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative)
  }
  function metadata(file, kind, roots = allowed) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.parse(file).root.toLowerCase() !== boot || !/^[a-z]:\\$/.test(boot)) fail('NONLOCAL_PATH')
    if (!roots.some(root => within(root, file))) fail('OUTSIDE_ALLOWED_ROOTS')
    const absolute = path.resolve(file), root = path.parse(absolute).root
    let current = root, stat = fs.lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('REPARSE_PATH')
    const parts = absolute.slice(root.length).split(path.sep).filter(Boolean)
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]); stat = fs.lstatSync(current)
      if (stat.isSymbolicLink()) fail('REPARSE_PATH')
      if (index < parts.length - 1 && !stat.isDirectory()) fail('INVALID_PATH')
    }
    if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) fail('INVALID_PATH')
    fs.accessSync(absolute, fs.constants.R_OK)
    return absolute
  }
  function capture(file, args, timeout, maxBuffer = 16384) {
    const result = { started: false, exit: null, timeout: false, error: null }
    try {
      const output = execFileSync(file, args, { env: process.env, cwd: process.env.TEMP,
        windowsHide: true, timeout, maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/^\uFEFF/, '').trim()
      return { ...result, started: true, exit: 0, output }
    } catch (error) {
      return { ...result, started: Boolean(error.pid), exit: Number.isInteger(error.status) ? error.status : null,
        timeout: error.code === 'ETIMEDOUT', error: code(error), output: '' }
    }
  }
  function candidate(category, file) {
    const value = { category, accessible: false, started: false, exit: null, timeout: false, version: null, error: null }
    if (!file) { value.error = 'NOT_CONFIGURED'; return value }
    try { value.file = metadata(file, 'file'); value.accessible = true }
    catch (error) { value.error = code(error) }
    return value
  }
  function publicCandidates(values) { return values.map(({ file, ...value }) => value) }
  let selected
  try {
    metadata(profile, 'directory', [profile])
    metadata(local, 'directory', [profile])
    send()
    const command = `
      $ErrorActionPreference = 'Stop';
      [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false;
      $read = { param($key, $name)
        if (Test-Path -LiteralPath $key) {
          $item = Get-Item -LiteralPath $key;
          try { $item.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
          finally { $item.Close() }
        } else { $null }
      };
      [ordered]@{
        current_user_python = & $read 'HKCU:\\Software\\Python\\PythonCore\\3.12\\InstallPath' '';
        machine_python = & $read 'HKLM:\\Software\\Python\\PythonCore\\3.12\\InstallPath' '';
        sdk = & $read 'HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots' 'KitsRoot10'
      } | ConvertTo-Json -Compress
    `
    const registry = capture(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', command], 5000)
    const { output, ...registryStatus } = registry
    report.registry = registryStatus
    let values = {}
    if (registry.exit === 0 && !registry.error) {
      try { values = JSON.parse(output); if (!values || Array.isArray(values) || typeof values !== 'object') fail('REGISTRY_INVALID') }
      catch { report.registry.error = 'REGISTRY_INVALID'; values = {} }
    }
    report.stage = 'python'; send()
    function fromPath() {
      const directories = (process.env.PATH ?? '').split(';').filter(Boolean)
      if (directories.length > 64) return { category: 'path', accessible: false, error: 'PATH_LIMIT' }
      for (const directory of directories) {
        const value = candidate('path', path.join(directory.replace(/^"|"$/g, ''), 'python.exe'))
        if (value.accessible) return value
        if (!['ENOENT', 'ENOTDIR', 'OUTSIDE_ALLOWED_ROOTS', 'NONLOCAL_PATH'].includes(value.error)) return value
      }
      return { category: 'path', accessible: false, error: 'NOT_FOUND' }
    }
    const python = [fromPath(),
      candidate('current_user_toolchain', path.join(local, 'Programs', 'Trellis-Toolchain', 'Python312', 'python.exe')),
      candidate('current_user_python', path.join(local, 'Programs', 'Python', 'Python312', 'python.exe')),
      candidate('program_files', path.join(process.env.ProgramFiles, 'Python312', 'python.exe')),
      candidate('machine_root', path.join(machinePython, 'python.exe')),
      ...['current_user_python', 'machine_python'].map(key => candidate('registry_' + key,
        typeof values[key] === 'string' ? path.join(values[key], 'python.exe') : ''))]
    for (const value of python) {
      if (!value.accessible) continue
      const execution = capture(value.file, ['-I', '-S', '-B', '-c',
        'import json,sys,struct,venv,ensurepip,ssl; print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"executable":sys.executable,"valid":sys.version_info[:2]==(3,12) and struct.calcsize("P")==8}))'], 3000, 512)
      const { output, ...status } = execution; Object.assign(value, status)
      if (execution.error || execution.exit !== 0) continue
      try {
        const result = JSON.parse(output)
        if (result.valid !== true || !/^3\.12\.[0-9]+$/.test(result.version) ||
            typeof result.executable !== 'string' || path.resolve(result.executable).toLowerCase() !== value.file.toLowerCase()) fail('PYTHON_VERSION_INVALID')
        value.version = result.version
        selected ??= value.file
        report.python.valid = true; report.python.version ??= result.version
      } catch (error) { value.error = code(error) }
    }
    report.python.candidates = publicCandidates(python)
    if (!report.python.valid) report.python.error = 'PYTHON_312_X64_UNAVAILABLE'
    report.stage = 'visual_cpp'; send()
    try {
      const vswhere = metadata(path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'), 'file', machine)
      const execution = capture(vswhere, ['-latest', '-products', '*', '-version', '[17.0,18.0)', '-requires',
        'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json', '-utf8', '-nologo'], 5000)
      const { output, ...status } = execution; report.visual_cpp.query = status
      if (execution.error || execution.exit !== 0) fail('VS_QUERY_UNAVAILABLE')
      const instances = JSON.parse(output)
      if (!Array.isArray(instances) || instances.length !== 1) fail('VS2022_CPP_UNAVAILABLE')
      const instance = instances[0]
      if (!/^17\.[0-9]+\.[0-9]+\.[0-9]+$/.test(instance.installationVersion) || instance.isComplete !== true || instance.isLaunchable !== true) fail('VS2022_CPP_INCOMPLETE')
      const root = metadata(instance.installationPath, 'directory', machine)
      for (const file of ['VC/Auxiliary/Build/vcvarsall.bat', 'MSBuild/Current/Bin/MSBuild.exe']) metadata(path.join(root, file), 'file', machine)
      const versionFile = metadata(path.join(root, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'file', machine)
      if (fs.statSync(versionFile).size > 128) fail('VC_VERSION_INVALID')
      const version = fs.readFileSync(versionFile, 'utf8').trim()
      if (!/^14\.[0-9]+\.[0-9]+$/.test(version)) fail('VC_VERSION_INVALID')
      for (const file of ['bin/Hostx64/x64/cl.exe', 'bin/Hostx64/x64/link.exe', 'bin/Hostx64/x64/lib.exe', 'include/vcruntime.h', 'lib/x64/libcmt.lib']) metadata(path.join(root, 'VC/Tools/MSVC', version, file), 'file', machine)
      Object.assign(report.visual_cpp, { valid: true, version: instance.installationVersion, msvc: version, target: 'x64' })
    } catch (error) { report.visual_cpp.error = code(error) }
    report.stage = 'windows_sdk'; send()
    try {
      if (report.registry.error || typeof values.sdk !== 'string') fail('SDK_REGISTRATION_UNAVAILABLE')
      const root = metadata(values.sdk, 'directory', machine)
      const include = metadata(path.join(root, 'Include'), 'directory', machine)
      const names = fs.readdirSync(include)
      if (names.length > 32) fail('SDK_DISCOVERY_LIMIT')
      const versions = names.filter(name => /^10\.0\.[0-9]+\.[0-9]+$/.test(name))
        .sort((a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return y[2] - x[2] || y[3] - x[3] })
      report.windows_sdk.candidates = []
      for (const version of versions) {
        try {
          for (const file of ['Include/' + version + '/um/Windows.h', 'Include/' + version + '/shared/sdkddkver.h',
            'Include/' + version + '/ucrt/stdio.h', 'Lib/' + version + '/um/x64/kernel32.lib',
            'Lib/' + version + '/ucrt/x64/ucrt.lib', 'bin/' + version + '/x64/rc.exe']) metadata(path.join(root, file), 'file', machine)
          report.windows_sdk.candidates.push({ version, valid: true })
          Object.assign(report.windows_sdk, { valid: true, version, target: 'x64' }); break
        } catch (error) { report.windows_sdk.candidates.push({ version, valid: false, error: code(error) }) }
      }
      if (!report.windows_sdk.valid) fail('SDK_X64_INCOMPLETE')
    } catch (error) { report.windows_sdk.error = code(error) }
    report.missing = ['python', 'visual_cpp', 'windows_sdk'].filter(key => !report[key].valid)
    report.stage = report.missing.length ? 'blocked_environment' : 'ready'
    send(report.missing.length ? {} : { selected_python: selected })
    if (report.missing.length) process.exitCode = 1
  } catch (error) {
    report.stage = 'blocked_environment'; report.error = code(error); send(); process.exitCode = 1
  } finally { if (process.connected) process.disconnect() }
}

module.exports = async function verifyStandardToolchain(core, { expose = true } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP') throw Error('DESIGNATED_WINDOWS_X64_RUNNER_REQUIRED')
  const evidence = process.env.TRELLIS_WIN11_EVIDENCE
  const host = JSON.parse(fs.readFileSync(path.join(evidence, 'host.json'), 'utf8'))
  if (host.standard_user_required !== true || host.elevated !== false || host.administrators_group_present !== false ||
      host.system_account !== false || host.user_interactive !== true || !Number.isInteger(host.session_id) || host.session_id <= 0) throw Error('STANDARD_USER_INTERACTIVE_SESSION_REQUIRED')
  const file = path.join(evidence, 'standard-toolchain.json')
  const report = { stage: 'starting', approved_installation: false, application_tests: 0 }
  const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  const env = {}
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PATH', 'RUNNER_TRACKING_ID']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  save()
  const selected = await new Promise(resolve => {
    let finished = false, timer, python
    const child = spawn(process.execPath, [__filename, '--inspect'], { env, cwd: process.env.RUNNER_TEMP,
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const finish = error => {
      if (finished) return; finished = true; clearTimeout(timer)
      if (error) { report.error = error; report.stage = 'blocked_environment' }
      if (child.connected) child.disconnect()
      child.unref(); save(); resolve(python)
    }
    child.once('error', () => finish('TOOLCHAIN_WORKER_START_FAILED'))
    child.on('message', message => {
      if (!message?.report || typeof message.report.stage !== 'string') return
      Object.assign(report, message.report); python = message.selected_python
      save(); console.log(JSON.stringify(report))
    })
    child.once('close', exit => finish(exit === 0 && report.stage === 'ready' && python ? null : report.error ?? 'TOOLCHAIN_INCOMPLETE'))
    timer = setTimeout(() => {
      report.timeout = true
      execFile(path.join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
        { env, windowsHide: true, timeout: 3000 }, error => finish(error ? 'TOOLCHAIN_TIMEOUT_TERMINATION_UNKNOWN' : 'TOOLCHAIN_TIMEOUT'))
    }, 50000)
  })
  if (report.stage !== 'ready' || report.error || !selected) {
    core.setFailed('WINDOWS11_STANDARD_TOOLCHAIN_' + (report.missing?.join('_') || report.error || 'UNCONFIRMED'))
    return { report, python: selected }
  }
  core.setSecret(selected); core.setSecret(path.dirname(selected))
  if (expose) {
    core.addPath(path.dirname(selected)); core.exportVariable('PYTHON', selected)
    core.setOutput('ready', 'true')
    report.job_python_selected = true
  }
  save()
  return { report, python: selected }
}

if (require.main === module) {
  if (process.argv[2] !== '--inspect') throw Error('TOOLCHAIN_INSPECTION_MODE_REQUIRED')
  inspectTools()
}

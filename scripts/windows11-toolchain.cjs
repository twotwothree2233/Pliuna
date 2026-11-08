const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn } = require('node:child_process')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

// This installer is only reachable through the explicitly authorized manual
// Windows 11 job. Ordinary dispatches only discover and reuse existing tools.
if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP') {
  throw Error('DESIGNATED_WINDOWS_X64_RUNNER_REQUIRED')
}
const evidence = process.env.TRELLIS_WIN11_EVIDENCE
if (!evidence || !path.isAbsolute(evidence)) throw Error('WINDOWS11_EVIDENCE_REQUIRED')
const approved = process.env.TRELLIS_INSTALL_WINDOWS11_TOOLS === '1'
const work = path.join(process.env.RUNNER_TEMP, 'trellis-tools-' + process.env.GITHUB_RUN_ID + '-' + process.env.GITHUB_RUN_ATTEMPT)
const localPrograms = path.join(process.env.LOCALAPPDATA, 'Programs')
const gitTarget = path.join(localPrograms, 'Trellis-Toolchain', 'Git')
const pythonTarget = path.join(localPrograms, 'Trellis-Toolchain', 'Python312')
const report = { approved_installation: approved, installations: [], restart_required: false }
fs.mkdirSync(evidence, { recursive: true })

function capture(command, args) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim() }
  catch { return '' }
}
function powershell(command) {
  return capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
}
function save() { fs.writeFileSync(path.join(evidence, 'toolchain-setup.json'), JSON.stringify(report, null, 2) + '\n') }
function candidates(values) { return [...new Set(values.filter(Boolean))] }
function findGit() {
  const files = candidates(['git',
    path.join(gitTarget, 'cmd/git.exe'),
    path.join(process.env.ProgramFiles, 'Git/cmd/git.exe'),
    path.join(process.env['ProgramFiles(x86)'], 'Git/cmd/git.exe'),
    path.join(localPrograms, 'Git/cmd/git.exe'),
    path.join(process.env.USERPROFILE, 'scoop/apps/git/current/cmd/git.exe')])
  for (const file of files) {
    const version = capture(file, ['--version'])
    if (!version.startsWith('git version ')) continue
    const executable = file === 'git' ? capture('where.exe', ['git']).split(/\r?\n/)[0] : file
    if (path.isAbsolute(executable)) return { executable, version }
  }
  return null
}
function findPython() {
  const registry = powershell(`
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false;
    $paths = @('HKCU:\\Software\\Python\\PythonCore\\3.12\\InstallPath', 'HKLM:\\Software\\Python\\PythonCore\\3.12\\InstallPath');
    @($paths | ForEach-Object { if (Test-Path -LiteralPath $_) { (Get-Item -LiteralPath $_).GetValue('') } }) | ConvertTo-Json -Compress
  `)
  let registered = []
  try { const value = JSON.parse(registry); registered = Array.isArray(value) ? value : [value] } catch {}
  const launcher = capture('py', ['-3.12', '-c', 'import sys; print(sys.executable)'])
  const files = candidates([launcher, path.join(pythonTarget, 'python.exe'),
    path.join(localPrograms, 'Python/Python312/python.exe'),
    path.join(process.env.ProgramFiles, 'Python312/python.exe'),
    ...registered.filter(value => typeof value === 'string').map(value => path.join(value, 'python.exe')), 'python'])
  for (const file of files) {
    const output = capture(file, ['-c', 'import json,sys; print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"valid":sys.version_info[:2]==(3,12) and sys.maxsize>2**32}))'])
    try { const value = JSON.parse(output); if (value.valid && path.isAbsolute(value.executable)) return value } catch {}
  }
  return null
}
function inspect() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe')
  const visualCpp = fs.existsSync(vswhere) ? capture(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']) : ''
  const include = path.join(process.env['ProgramFiles(x86)'], 'Windows Kits/10/Include')
  const sdk = fs.existsSync(include) ? fs.readdirSync(include).filter(version => fs.existsSync(path.join(include, version, 'um/Windows.h'))).sort().pop() ?? null : null
  return { git: findGit(), python: findPython(), visual_cpp: visualCpp || null, windows_sdk: sdk, node: process.version }
}
async function download(url, name) {
  fs.mkdirSync(work, { recursive: true })
  const destination = path.join(work, name)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(JSON.stringify({ phase: 'download', name, attempt, source: url }))
      const headers = { 'User-Agent': 'Trellis-Windows11-toolchain', Accept: 'application/octet-stream' }
      if (new URL(url).hostname === 'api.github.com' && process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(180000) })
      if (!response.ok) throw Error('HTTP_' + response.status)
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination))
      const descriptor = fs.openSync(destination, 'r'), magic = Buffer.alloc(2)
      try { fs.readSync(descriptor, magic, 0, 2, 0) } finally { fs.closeSync(descriptor) }
      if (magic.toString('ascii') !== 'MZ') throw Error('INSTALLER_FORMAT_INVALID')
      return destination
    } catch (error) {
      if (attempt === 2) throw error
      console.log(JSON.stringify({ phase: 'download_retry', name, error: String(error.message) }))
      await new Promise(resolve => setTimeout(resolve, 4000))
    }
  }
}
async function install(name, url, filename, args) {
  const record = { name, source: url, status: 'started' }
  report.installations.push(record); save()
  try {
    const file = await download(url, filename)
    console.log(JSON.stringify({ phase: 'install', name }))
    const log = fs.openSync(path.join(evidence, filename + '.log'), 'a')
    let code
    try {
      code = await new Promise((resolve, reject) => {
        const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', log, log] })
        const progress = setInterval(() => console.log(JSON.stringify({ phase: 'install_in_progress', name })), 30000)
        child.once('error', error => { clearInterval(progress); reject(error) })
        child.once('exit', value => { clearInterval(progress); resolve(value) })
      })
    } finally { fs.closeSync(log) }
    record.exit_code = code
    if (code !== 0 && code !== 3010) throw Error('INSTALLER_EXIT_' + code)
    record.status = 'completed'
    if (code === 3010) report.restart_required = true
  } catch (error) {
    record.status = 'failed'; record.error = String(error.message)
    console.error(JSON.stringify(record))
  } finally { save() }
}
function expose(tools) {
  for (const directory of candidates([tools.git && path.dirname(tools.git.executable), tools.python && path.dirname(tools.python.executable)])) {
    fs.appendFileSync(process.env.GITHUB_PATH, directory + '\n')
  }
  if (tools.python) fs.appendFileSync(process.env.GITHUB_ENV, 'PYTHON=' + tools.python.executable + '\n')
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'python_312_available=' + Boolean(tools.python) + '\n')
  fs.appendFileSync(process.env.GITHUB_OUTPUT, 'checkout_required=' + !fs.existsSync(path.join(process.env.GITHUB_WORKSPACE, '.git')) + '\n')
}
async function main() {
  report.before = inspect(); save()
  console.log(JSON.stringify({ phase: 'tools_before', ...report.before }))
  if (approved) {
    if (!report.before.git) await install('Git for Windows 2.56.0.4',
      'https://api.github.com/repos/git-for-windows/git/releases/assets/677312539', 'Git-2.56.0.4-64-bit.exe',
      ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/CURRENTUSER', '/DIR=' + gitTarget, '/o:PathOption=BashOnly'])
    if (!report.before.python) await install('Python 3.12.10 x64',
      'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe', 'python-3.12.10-amd64.exe',
      ['/quiet', '/norestart', 'InstallAllUsers=0', 'TargetDir=' + pythonTarget, 'PrependPath=0', 'Include_launcher=0', 'Include_test=0', 'Include_doc=0', 'Include_pip=1', 'Shortcuts=0', '/log', path.join(evidence, 'python-install.log')])
    if (!report.before.visual_cpp || !report.before.windows_sdk) await install('Visual Studio 2022 C++ Build Tools and Windows SDK',
      'https://aka.ms/vs/17/release/vs_BuildTools.exe', 'vs_BuildTools.exe',
      ['--quiet', '--wait', '--norestart', '--nocache', '--add', 'Microsoft.VisualStudio.Workload.VCTools', '--includeRecommended'])
  }
  report.after = inspect(); save()
  console.log(JSON.stringify({ phase: 'tools_after', ...report.after, restart_required: report.restart_required }))
  expose(report.after)
  const missing = ['git', 'python', 'visual_cpp', 'windows_sdk'].filter(name => !report.after[name])
  if (missing.length) throw Error('WINDOWS11_TOOLCHAIN_INCOMPLETE: ' + missing.join(', '))
  if (report.installations.some(item => item.status === 'failed')) throw Error('WINDOWS11_TOOLCHAIN_INSTALLATION_FAILED')
}
main().catch(error => { report.error = String(error.message); save(); console.error(error); process.exitCode = 1 })

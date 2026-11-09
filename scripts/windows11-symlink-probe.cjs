const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { performance } = require('node:perf_hooks')

// Metadata reads are isolated too: an inaccessible cache/source must not stall
// the action thread. Only the known cache version and fresh checkout are read.
function discoverExistingNode() {
  const fs = require('node:fs'), path = require('node:path').win32
  const fail = code => { throw Object.assign(new Error(), { code }) }
  const boot = path.parse(process.env.SystemRoot ?? '').root.toLowerCase()
  function metadata(file, kind) {
    if (!/^[a-z]:\\$/.test(boot) || !path.isAbsolute(file) || path.parse(file).root.toLowerCase() !== boot) fail('NONLOCAL_PATH')
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
  const workspace = metadata(process.env.GITHUB_WORKSPACE ?? '', 'directory')
  const relative = process.env.TRELLIS_WIN11_SOURCE ?? ''
  if (!/^trellis-standard-[0-9]+-[0-9]+$/.test(relative)) fail('SOURCE_PATH_INVALID')
  const source = path.resolve(workspace, relative)
  if (path.dirname(source).toLowerCase() !== workspace.toLowerCase() || path.relative(workspace, source) !== relative) fail('SOURCE_PATH_INVALID')
  metadata(source, 'directory')
  const versionFile = metadata(path.join(source, '.node-version'), 'file')
  if (fs.statSync(versionFile).size > 32 || fs.readFileSync(versionFile, 'utf8').trim() !== '22.23.1') fail('SOURCE_NODE_VERSION_UNEXPECTED')
  const script = metadata(path.join(source, 'scripts', 'check-test-environment.mjs'), 'file')
  const cache = metadata(process.env.RUNNER_TOOL_CACHE ?? '', 'directory')
  const executable = metadata(path.join(cache, 'node', '22.23.1', 'x64', 'node.exe'), 'file')
  process.send({ accessible: true, executable, script, source }, () => process.disconnect())
}

module.exports = async function probeFileSymlink(core) {
  const startedAt = performance.now(), deadline = startedAt + 25000
  const report = { application_tests: 0, stage: 'host', passed: false, temp_environment_preserved: true,
    node_source: 'existing_runner_tool_cache', budgets_ms: { discovery: 5000, version: 3000, probe: 10000, total: 25000 } }
  const cleanCode = error => /^[A-Z0-9_]{1,64}$/.test(error?.code ?? '') ? error.code : 'PROBE_FAILED'
  const fail = code => { throw Object.assign(new Error(), { code }) }
  const env = {}
  // Preserve original TEMP/TMP, without forwarding GitHub credentials, PATH,
  // NODE_OPTIONS or user Node configuration. These children never spawn tools.
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'RUNNER_TRACKING_ID']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  function run(executable, args, budget, { discovery = false, cwd } = {}) {
    return new Promise(resolve => {
      const result = { started: false, exit: null, timeout: false, error: null, cause_code: null }
      let child, timer, done = false, stdout = '', stderr = '', message
      function finish() {
        if (done) return
        done = true; clearTimeout(timer)
        const cause = stderr.match(/code:\s*['"]([A-Z0-9_]{2,48})['"]/)
        resolve({ ...result, cause_code: cause?.[1] ?? null, stdout, message })
      }
      function stop(code, timeout = false) {
        result.error = code; result.timeout = timeout
        try { child?.kill() } catch {}
        // All three children are known Node leaves. Do not wait indefinitely
        // for close after terminating a timed-out metadata or symlink process.
        finish()
      }
      const remaining = Math.min(budget, deadline - performance.now())
      if (remaining <= 0) { stop('TOTAL_DEADLINE', true); return }
      try {
        child = spawn(executable, args, { cwd, env: discovery ? { ...env,
          GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE, TRELLIS_WIN11_SOURCE: process.env.TRELLIS_WIN11_SOURCE,
          RUNNER_TOOL_CACHE: process.env.RUNNER_TOOL_CACHE } : env,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...(discovery ? ['ipc'] : [])] })
        result.started = Boolean(child.pid)
        timer = setTimeout(() => stop('PROCESS_TIMEOUT', true), remaining)
        child.once('error', error => { result.error = cleanCode(error); finish() })
        child.on('message', value => { message = value })
        child.stdout.on('data', bytes => {
          stdout += bytes.toString('utf8')
          if (Buffer.byteLength(stdout) > 8192) { stdout = ''; stop('OUTPUT_LIMIT') }
        })
        child.stderr.on('data', bytes => {
          stderr += bytes.toString('utf8')
          if (Buffer.byteLength(stderr) > 8192) { stderr = ''; stop('OUTPUT_LIMIT') }
        })
        child.once('close', code => { result.exit = code; finish() })
      } catch (error) { result.error = cleanCode(error); finish() }
    })
  }
  function status({ stdout, message, ...value }) { return value }
  try {
    const host = JSON.parse(fs.readFileSync(path.join(process.env.TRELLIS_WIN11_EVIDENCE, 'host.json'), 'utf8'))
    if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP' ||
        host.runner !== 'DESKTOP-SFE95TP' || host.standard_user_required !== true || host.elevated !== false ||
        host.administrators_group_present !== false || host.system_account !== false || host.user_interactive !== true ||
        !Number.isInteger(host.session_id) || host.session_id <= 0 || host.product_type !== 1 || !Number.isInteger(host.build) || host.build < 22000 ||
        !host.caption?.includes('Windows 11') || host.architecture !== 'X64') fail('STANDARD_WINDOWS11_HOST_REQUIRED')
    report.stage = 'discovery'
    const worker = `try { (${discoverExistingNode.toString()})(); } catch (error) { process.send({error:/^[A-Z0-9_]{1,64}$/.test(error.code||'')?error.code:'DISCOVERY_FAILED'},()=>process.disconnect()); process.exitCode=1; }`
    const discovery = await run(process.execPath, ['-e', worker], 5000, { discovery: true })
    report.discovery = { ...status(discovery), accessible: discovery.message?.accessible === true }
    if (discovery.error || discovery.exit !== 0 || discovery.message?.accessible !== true) {
      fail(discovery.error ?? discovery.message?.error ?? 'EXISTING_NODE_UNAVAILABLE')
    }
    const { executable, script, source } = discovery.message
    report.stage = 'node_version'
    const version = await run(executable, ['-p', 'JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch})'], 3000, { cwd: source })
    report.node_check = status(version)
    if (version.error || version.exit !== 0) fail(version.error ?? 'EXISTING_NODE_VERSION_UNCONFIRMED')
    let identity
    try { identity = JSON.parse(version.stdout) } catch { fail('EXISTING_NODE_VERSION_UNCONFIRMED') }
    if (identity?.node !== '22.23.1' || identity.platform !== 'win32' || identity.arch !== 'x64') fail('EXISTING_NODE_VERSION_UNCONFIRMED')
    report.node = identity.node; report.architecture = identity.arch
    report.stage = 'original_file_symlink_check'
    const probe = await run(executable, [script], 10000, { cwd: source })
    report.probe = status(probe)
    const expected = 'Test host: win32/x64; Node 22.23.1; file symlinks available'
    if (probe.error || probe.exit !== 0) fail(probe.cause_code ?? probe.error ?? 'FILE_SYMLINK_CHECK_FAILED')
    if (probe.stdout.trim() !== expected) fail('FILE_SYMLINK_RESULT_UNCONFIRMED')
    if (performance.now() > deadline) fail('TOTAL_DEADLINE')
    report.passed = true; report.stage = 'ready'
  } catch (error) {
    report.failed_stage = report.stage
    report.stage = 'blocked_environment'; report.error = cleanCode(error)
  }
  report.duration_ms = Math.round(performance.now() - startedAt)
  fs.writeFileSync(path.join(process.env.TRELLIS_WIN11_EVIDENCE, 'file-symlink-probe.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (!report.passed) core.setFailed('FILE_SYMLINK_PROBE_' + report.error)
  return report
}

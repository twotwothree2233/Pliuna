import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RESULT_MARKER = '__MONTY_SMOKE_RESULT__'
const CASE_TIMEOUT_MS = 12_000
const MAX_CHILD_STDOUT_BYTES = 256 * 1024
const MAX_CHILD_STDERR_BYTES = 64 * 1024
const root = path.dirname(fileURLToPath(import.meta.url))
const caseRunner = path.join(root, 'case-runner.mjs')
const resultsPath = path.join(root, 'run-results.json')
const runtimeDir = path.join(root, '.runtime')
const canaryPath = path.join(runtimeDir, 'host-canary.txt')

const caseIds = [
  'arithmetic_data_input',
  'fresh_execution_isolation',
  'host_file_canary',
  'host_env_canary',
  'import_denials',
  'feed_time_limit',
  'allocation_limit',
  'stdout_limit',
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function capText(text, maxBytes) {
  const buffer = Buffer.from(text)
  if (buffer.length <= maxBytes) {
    return { text, truncated: false }
  }
  return {
    text: buffer.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

async function runCase(caseId, childEnv) {
  const started = performance.now()
  let timedOut = false
  let stdout = ''
  let stderr = ''
  let stdoutTruncated = false
  let stderrTruncated = false

  const child = spawn(process.execPath, [caseRunner, caseId], {
    cwd: root,
    detached: true,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    const capped = capText(stdout + chunk, MAX_CHILD_STDOUT_BYTES)
    stdout = capped.text
    stdoutTruncated ||= capped.truncated
  })
  child.stderr.on('data', (chunk) => {
    const capped = capText(stderr + chunk, MAX_CHILD_STDERR_BYTES)
    stderr = capped.text
    stderrTruncated ||= capped.truncated
  })

  const deadline = setTimeout(() => {
    timedOut = true
    try {
      killProcessGroup(child.pid, 'SIGKILL')
    } catch (error) {
      stderr += `\nprocess-group kill failed: ${error.message}`
    }
  }, CASE_TIMEOUT_MS)

  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ spawnError: error }))
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  clearTimeout(deadline)

  let cleanupKilledLingeringGroup = false
  if (processGroupExists(child.pid)) {
    cleanupKilledLingeringGroup = killProcessGroup(child.pid, 'SIGKILL')
  }

  const durationMs = Math.round(performance.now() - started)
  const markerLine = stdout
    .split('\n')
    .find((line) => line.startsWith(RESULT_MARKER))
  let childResult = null
  let parseError = null
  if (markerLine) {
    try {
      childResult = JSON.parse(markerLine.slice(RESULT_MARKER.length))
    } catch (error) {
      parseError = error.message
    }
  }

  const pass =
    !outcome.spawnError &&
    !timedOut &&
    outcome.exitCode === 0 &&
    outcome.signal === null &&
    childResult?.ok === true

  return {
    caseId,
    pass,
    durationMs,
    outerDeadlineMs: CASE_TIMEOUT_MS,
    timedOut,
    exitCode: outcome.exitCode ?? null,
    signal: outcome.signal ?? null,
    spawnError: outcome.spawnError?.message ?? null,
    cleanupKilledLingeringGroup,
    childResult,
    parseError,
    childStdout: stdout,
    childStderr: stderr,
    outputTruncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
  }
}

const packageMeta = JSON.parse(
  await readFile(path.join(root, 'node_modules/@pydantic/monty/package.json'), 'utf8'),
)
const platformPackageName = `@pydantic/monty-${process.platform}-${
  process.arch === 'arm64'
    ? 'arm64'
    : process.platform === 'linux'
      ? `${process.arch}-gnu`
      : `${process.arch}${process.platform === 'win32' ? '-msvc' : ''}`
}`
const platformPackagePath = path.join(
  root,
  'node_modules',
  platformPackageName.replace('/', path.sep),
)
const platformMeta = JSON.parse(
  await readFile(path.join(platformPackagePath, 'package.json'), 'utf8'),
)
const montyBinary = path.join(platformPackagePath, 'monty')
const runtimeVersion = execFileSync(montyBinary, ['--version'], {
  encoding: 'utf8',
}).trim()
const lockText = await readFile(path.join(root, 'package-lock.json'), 'utf8')
const lock = JSON.parse(lockText)
const lockPackage = lock.packages['node_modules/@pydantic/monty']
const lockPlatform = lock.packages[`node_modules/${platformPackageName}`]

await mkdir(runtimeDir, { recursive: true })
const runId = randomUUID()
const canaryContent = `TRELLIS_MONTY_HOST_FILE_CANARY_${runId}_DO_NOT_EXPOSE`
const envCanaryValue = `TRELLIS_MONTY_HOST_ENV_CANARY_${runId}_DO_NOT_EXPOSE`
await writeFile(canaryPath, canaryContent, { encoding: 'utf8', mode: 0o600 })

const childEnv = {
  ...process.env,
  TRELLIS_MONTY_SMOKE_CANARY_PATH: canaryPath,
  TRELLIS_MONTY_SMOKE_CANARY_CONTENT: canaryContent,
  TRELLIS_MONTY_SMOKE_ENV_CANARY: envCanaryValue,
}

const startedAt = new Date().toISOString()
const started = performance.now()
const cases = []
for (const caseId of caseIds) {
  const result = await runCase(caseId, childEnv)
  cases.push(result)
  process.stdout.write(
    `${result.pass ? 'PASS' : 'FAIL'} ${caseId} (${result.durationMs} ms)\n`,
  )
}
const durationMs = Math.round(performance.now() - started)

const passed = cases.filter((result) => result.pass).length
const report = {
  kind: 'bounded-smoke-evidence',
  warning:
    'This is functional smoke evidence, not a security audit or proof of sandbox isolation.',
  runId,
  startedAt,
  finishedAt: new Date().toISOString(),
  durationMs,
  result: passed === cases.length ? 'pass' : 'fail',
  summary: { passed, total: cases.length },
  runtime: {
    package: '@pydantic/monty',
    packageVersion: packageMeta.version,
    platformPackage: platformPackageName,
    platformPackageVersion: platformMeta.version,
    montyRuntimeVersion: runtimeVersion,
    nodeVersion: process.version,
    npmVersion: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      version: os.version(),
      type: os.type(),
    },
  },
  pinning: {
    dependency: `@pydantic/monty@${packageMeta.version}`,
    packageIntegrity: lockPackage.integrity,
    platformPackageIntegrity: lockPlatform.integrity,
    lockfileSha256: sha256(lockText),
  },
  canaries: {
    hostFilePath: canaryPath,
    hostFileContentSha256: sha256(canaryContent),
    hostFileByteLength: Buffer.byteLength(canaryContent),
    envName: 'TRELLIS_MONTY_SMOKE_ENV_CANARY',
    envValueSha256: sha256(envCanaryValue),
  },
  safetyControls: {
    oneFeedPerCheckedOutSession: true,
    maxCheckoutsPerWorker: 1,
    mounts: [],
    externalLookup: null,
    osCallback: null,
    externalModules: null,
    printCapture: 'CollectString',
    outerCaseDeadlineMs: CASE_TIMEOUT_MS,
    outerDeadlineKillsProcessGroup: true,
    memoryTest:
      'One 20 MB allocation under an 8 MB enforcement limit; no unbounded OOM test',
  },
  limitations: [
    'No Electron GUI or packaging verification.',
    'No mount, host callback, external module, or file/network bridge was enabled.',
    'Import denial is a language capability check, not a packet-level network audit.',
    'maxMemory is a worker allocator limit, not an OS RSS cap.',
    'The external child deadline protects the host from hangs but is not itself the sandbox.',
  ],
  cases,
}

await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(
  `\n${report.result.toUpperCase()}: ${passed}/${cases.length} cases; evidence: ${resultsPath}\n`,
)

if (report.result !== 'pass') {
  process.exitCode = 1
}

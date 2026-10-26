import { readFile } from 'node:fs/promises'
import {
  CollectString,
  Monty,
  MontyRuntimeError,
} from '@pydantic/monty'

const RESULT_MARKER = '__MONTY_SMOKE_RESULT__'
const CASE_TIMEOUT_MS = 12_000
const MEMORY_LIMIT_BYTES = 8_000_000

const canaryPath = process.env.TRELLIS_MONTY_SMOKE_CANARY_PATH
const canaryContent = process.env.TRELLIS_MONTY_SMOKE_CANARY_CONTENT
const envCanaryName = 'TRELLIS_MONTY_SMOKE_ENV_CANARY'
const envCanaryValue = process.env[envCanaryName]

const baseLimits = Object.freeze({
  maxMemory: MEMORY_LIMIT_BYTES,
  maxFeedDurationSecs: 1,
  maxTurnDurationSecs: 1,
  maxRecursionDepth: 100,
  maxSuspensions: 10,
  maxTotalSleepSecs: 0,
})

function poolOptions(overrides = {}) {
  return {
    minProcesses: 1,
    maxProcesses: 1,
    maxCheckoutsPerWorker: 1,
    requestTimeout: 2,
    feedDurationLimitGrace: 0.2,
    turnDurationLimitGrace: 0.2,
    ...overrides,
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION_FAILED: ${message}`)
  }
}

function assertEqual(actual, expected, label) {
  assert(
    Object.is(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )
}

function assertRuntimeError(error, typeName, message, label) {
  assert(error instanceof MontyRuntimeError, `${label}: expected MontyRuntimeError`)
  assertEqual(error.exception.typeName, typeName, `${label} type`)
  if (message instanceof RegExp) {
    assert(message.test(error.exception.message), `${label} message did not match ${message}`)
  } else {
    assertEqual(error.exception.message, message, `${label} message`)
  }
}

function errorEvidence(error) {
  if (!(error instanceof Error)) {
    return { name: typeof error, message: String(error) }
  }
  return {
    name: error.constructor?.name ?? null,
    message: error.message,
    exception: error.exception ?? null,
    displayTypeMsg:
      typeof error.display === 'function' ? error.display('type-msg') : null,
    timedOut: typeof error.timedOut === 'boolean' ? error.timedOut : null,
    exitStatus: error.exitStatus ?? null,
  }
}

async function closeQuietly(resource) {
  if (resource && typeof resource.close === 'function') {
    try {
      await resource.close()
    } catch {
      // The primary result or error is more useful than a secondary close failure.
    }
  }
}

async function createPool(overrides = {}) {
  return Monty.create(poolOptions(overrides))
}

async function checkout(pool, limitOverrides = {}, printMaxBytes = 1024) {
  const limits = { ...baseLimits, ...limitOverrides }
  const session = await pool.checkout({ limits })
  const print = new CollectString(printMaxBytes)
  return { session, print, limits }
}

async function arithmeticDataInput() {
  const pool = await createPool()
  const { session, print, limits } = await checkout(pool)
  let result
  let error
  try {
    try {
      result = await session.feedRun(
        [
          'total = sum(values) + offset',
          'print(f"total={total}")',
          'total',
        ].join('\n'),
        {
          inputs: { values: [2, 3, 5], offset: 7 },
          printCallback: print,
        },
      )
    } catch (caught) {
      error = caught
    }
  } finally {
    await closeQuietly(session)
    await closeQuietly(pool)
  }

  assert(!error, `unexpected execution error: ${errorEvidence(error).message}`)
  assertEqual(result, 17, 'result')
  assertEqual(print.output, 'total=17\n', 'captured stdout')
  return {
    config: { limits, feedOptions: ['inputs', 'printCallback'] },
    result,
    stdout: print.output,
  }
}

async function freshExecutionIsolation() {
  const pool = await createPool()
  const first = await checkout(pool)
  let firstResult
  let firstWorkerId
  try {
    firstWorkerId = first.session.workerId
    firstResult = await first.session.feedRun('retained_probe = 41', {
      printCallback: first.print,
    })
  } finally {
    await closeQuietly(first.session)
  }

  const second = await checkout(pool)
  let secondWorkerId
  let secondError
  try {
    secondWorkerId = second.session.workerId
    try {
      await second.session.feedRun('retained_probe', {
        printCallback: second.print,
      })
    } catch (caught) {
      secondError = caught
    }
  } finally {
    await closeQuietly(second.session)
    await closeQuietly(pool)
  }

  assertEqual(firstResult, null, 'first feed result')
  assertRuntimeError(
    secondError,
    'NameError',
    "name 'retained_probe' is not defined",
    'fresh session lookup',
  )
  assert(firstWorkerId !== secondWorkerId, 'worker should be retired between executions')
  return {
    policy: {
      maxCheckoutsPerWorker: 1,
      sessionsPerFeed: 1,
      workerIds: [firstWorkerId, secondWorkerId],
    },
    firstFeedResult: firstResult,
    secondFeedError: errorEvidence(secondError),
    variableRetained: false,
  }
}

async function hostFileCanary() {
  assert(canaryPath, 'canary path was not supplied')
  assert(canaryContent, 'canary content was not supplied')
  const hostBytes = await readFile(canaryPath, 'utf8')
  assertEqual(hostBytes, canaryContent, 'host canary read')

  const pool = await createPool()
  const { session, print, limits } = await checkout(pool)
  let guestResult
  let guestError
  try {
    try {
      guestResult = await session.feedRun(
        `open(${JSON.stringify(canaryPath)}).read()`,
        { printCallback: print },
      )
    } catch (caught) {
      guestError = caught
    }
  } finally {
    await closeQuietly(session)
    await closeQuietly(pool)
  }

  const expectedMessage = `Permission denied: '${canaryPath}'`
  assertRuntimeError(
    guestError,
    'PermissionError',
    expectedMessage,
    'existing host file read',
  )
  const guestObservable = JSON.stringify({
    guestResult,
    guestError: errorEvidence(guestError),
    stdout: print.output,
  })
  assert(
    !guestObservable.includes(canaryContent),
    'host canary content crossed into guest-observable data',
  )
  return {
    config: {
      limits,
      feedOptions: ['printCallback'],
      mounts: [],
      externalLookup: null,
      osCallback: null,
      externalModules: null,
    },
    hostCanaryReadableByHost: true,
    hostCanaryExactMatch: true,
    guestResult: guestResult ?? null,
    guestError: errorEvidence(guestError),
    canaryContentObservedByGuest: false,
  }
}

async function hostEnvCanary() {
  assert(envCanaryValue, 'environment canary was not supplied')
  assert(envCanaryValue === process.env[envCanaryName], 'host env canary mismatch')

  const pool = await createPool()
  const { session, print, limits } = await checkout(pool)
  let guestResult
  let guestError
  try {
    try {
      guestResult = await session.feedRun(
        `import os\nos.getenv(${JSON.stringify(envCanaryName)})`,
        { printCallback: print },
      )
    } catch (caught) {
      guestError = caught
    }
  } finally {
    await closeQuietly(session)
    await closeQuietly(pool)
  }

  assertRuntimeError(
    guestError,
    'RuntimeError',
    "'os.getenv' is not supported in this environment",
    'host env lookup',
  )
  const guestObservable = JSON.stringify({
    guestResult,
    guestError: errorEvidence(guestError),
    stdout: print.output,
  })
  assert(
    !guestObservable.includes(envCanaryValue),
    'host env canary crossed into guest-observable data',
  )
  return {
    config: {
      limits,
      feedOptions: ['printCallback'],
      osCallback: null,
    },
    hostProcessSawEnvCanary: true,
    guestResult: guestResult ?? null,
    guestError: errorEvidence(guestError),
    envCanaryObservedByGuest: false,
  }
}

async function importDenials() {
  const pool = await createPool()
  const attempts = []
  try {
    for (const moduleName of ['socket', 'subprocess']) {
      const { session, print } = await checkout(pool)
      let error
      try {
        try {
          await session.feedRun(`import ${moduleName}`, { printCallback: print })
        } catch (caught) {
          error = caught
        }
      } finally {
        await closeQuietly(session)
      }
      assertRuntimeError(
        error,
        'ModuleNotFoundError',
        `No module named '${moduleName}'`,
        `${moduleName} import`,
      )
      attempts.push({ moduleName, error: errorEvidence(error) })
    }
  } finally {
    await closeQuietly(pool)
  }
  return {
    attempts,
    interpretation: 'Python import capability denial; not a packet-level network audit',
  }
}

async function feedTimeLimit() {
  const pool = await createPool()
  const { session, print, limits } = await checkout(
    pool,
    {
      maxFeedDurationSecs: 0.2,
      maxTurnDurationSecs: 0.2,
    },
  )
  const started = performance.now()
  let error
  try {
    try {
      await session.feedRun('while True:\n    pass', { printCallback: print })
    } catch (caught) {
      error = caught
    }
  } finally {
    await closeQuietly(session)
    await closeQuietly(pool)
  }
  const elapsedMs = performance.now() - started
  assertRuntimeError(
    error,
    'TimeoutError',
    /^feed time limit exceeded: \d+(?:\.\d+)?ms > 200ms$/,
    'infinite loop',
  )
  assert(elapsedMs < 5_000, `infinite loop exceeded conservative outer check: ${elapsedMs}ms`)
  return {
    config: { limits, poolRequestTimeoutSecs: 2 },
    elapsedMs: Math.round(elapsedMs),
    error: errorEvidence(error),
    childProcessDeadlineMs: CASE_TIMEOUT_MS,
  }
}

async function allocationLimit() {
  const pool = await createPool()
  const { session, print, limits } = await checkout(pool)
  const started = performance.now()
  let result
  let error
  try {
    try {
      result = await session.feedRun("'x' * 20_000_000", {
        printCallback: print,
      })
    } catch (caught) {
      error = caught
    }
  } finally {
    await closeQuietly(session)
    await closeQuietly(pool)
  }
  const elapsedMs = performance.now() - started
  assertEqual(result, undefined, 'allocation result')
  assertRuntimeError(
    error,
    'MemoryError',
    /^memory limit exceeded: \d+ bytes > 8000000 bytes$/,
    'bounded allocation',
  )
  return {
    config: {
      limits,
      requestedAllocationBytes: 20_000_000,
      enforcedAllocationLimitBytes: MEMORY_LIMIT_BYTES,
    },
    elapsedMs: Math.round(elapsedMs),
    error: errorEvidence(error),
    childProcessDeadlineMs: CASE_TIMEOUT_MS,
    scope: 'Bounded allocation only; no unbounded OOM test',
  }
}

async function stdoutLimit() {
  const pool = await createPool()
  const { session, print, limits } = await checkout(pool, {}, 64)
  let error
  try {
    try {
      await session.feedRun("print('x' * 200)", { printCallback: print })
    } catch (caught) {
      error = caught
    }
  } finally {
    await closeQuietly(session)
    await closeQuietly(pool)
  }
  assertRuntimeError(
    error,
    'MemoryError',
    /^memory limit exceeded: 201 bytes > 64 bytes$/,
    'stdout collector cap',
  )
  assertEqual(print.output, '', 'retained stdout')
  return {
    config: {
      limits,
      collector: 'CollectString',
      collectorMaxBytes: 64,
      attemptedPrintBytesIncludingNewline: 201,
    },
    stdoutAfterFailure: print.output,
    error: errorEvidence(error),
    origin: 'Host-side CollectString cap, outside sandbox maxMemory',
  }
}

const cases = {
  arithmetic_data_input: arithmeticDataInput,
  fresh_execution_isolation: freshExecutionIsolation,
  host_file_canary: hostFileCanary,
  host_env_canary: hostEnvCanary,
  import_denials: importDenials,
  feed_time_limit: feedTimeLimit,
  allocation_limit: allocationLimit,
  stdout_limit: stdoutLimit,
}

const caseId = process.argv[2]
const run = cases[caseId]

if (!run) {
  process.stderr.write(`Unknown case: ${caseId}\n`)
  process.exitCode = 2
} else {
  try {
    const evidence = await run()
    process.stdout.write(
      `${RESULT_MARKER}${JSON.stringify({ caseId, ok: true, evidence })}\n`,
    )
  } catch (error) {
    process.stdout.write(
      `${RESULT_MARKER}${JSON.stringify({
        caseId,
        ok: false,
        error: errorEvidence(error),
      })}\n`,
    )
    process.exitCode = 1
  }
}

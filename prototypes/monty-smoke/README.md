# Monty Smoke Prototype

Throwaway verification of the published `@pydantic/monty` JavaScript package.
It is deliberately not wired into the Trellis root package or Electron app.

Status: 8/8 cases passed on 2026-10-25 (Darwin arm64, Node 22.23.1).
See [run-results.json](run-results.json) for exact messages and configuration,
and [the research result](../../docs/research/monty-smoke-results.md) for the
evidence write-up and unverified scope.

## Scope

This prototype checks the package API and a small set of language/runtime
boundaries. It is functional evidence, not a security audit or a claim that
Monty is a complete OS sandbox.

- Installed package: `@pydantic/monty@1.3.0` (exact pin, lockfile saved; no Git commit).
- Backend: native worker subprocesses; WASM and Electron packaging are not tested.
- Each sandbox execution uses a new checked-out session, one feed, and
  `maxCheckoutsPerWorker: 1`.
- No mounts, `externalLookup`, `os` callback, or `externalModules` are enabled.
- The only host-side feed sink is `CollectString`, used to capture `print()`.
- Each case runs in its own Node child process. The parent process enforces a
  12-second deadline and kills the whole child process group on timeout.
- The separate child process is a host-protection boundary and a test harness
  control. It is not what makes guest Python safe.

The shipped README and TypeScript declarations were inspected to use the actual
API: `Monty.create`, `pool.checkout`, `session.feedRun`, `CollectString`, and the
`ResourceLimits` and pool timeout fields in v1.3.0.

## Run

From this directory:

```sh
npm ci --no-audit --no-fund
npm run smoke
```

The run writes `run-results.json`. The synthetic canary file is created under
`.runtime/`; it contains no user data.

## Cases

| Case | Assertion |
| --- | --- |
| `arithmetic_data_input` | Explicit structured input yields exactly `17` and captured stdout is exactly `total=17\n`. |
| `fresh_execution_isolation` | A variable from the first one-feed session raises exactly `NameError` in a fresh session, and the pool recycles the worker. |
| `host_file_canary` | The host process can read its synthetic canary, while guest `open(...).read()` raises exactly `PermissionError` and the canary content never appears in guest-observable data. |
| `host_env_canary` | The child host process sees the synthetic environment value, while guest `os.getenv(...)` raises the package's exact unsupported-operation error and the value never appears in guest-observable data. |
| `import_denials` | Fresh sessions importing `socket` and `subprocess` each raise exactly `ModuleNotFoundError`. |
| `feed_time_limit` | An infinite loop is stopped by the configured 200 ms native feed/turn limit with `TimeoutError`. |
| `allocation_limit` | One bounded 20 MB string allocation under an 8 MB `maxMemory` limit raises `MemoryError`; no unbounded OOM probe is attempted. |
| `stdout_limit` | `CollectString(64)` rejects a 201-byte print with `MemoryError` and retains no text. |

`maxMemory` is the worker's allocator accounting, not an OS resident-memory
limit. The wall-clock child deadline protects the host from a wedged case but
does not cap memory. The allocation test is intentionally small and relies on
the known enforcement limit before allocating.

## Interpretation Limits

- The import checks prove Python module import denial only. They are not a
  packet-level network audit.
- The file/env checks cover one synthetic canary each, not every possible host
  information leak.
- Timeout and allocation checks cover one case each, not every interpreter
  operation or resource shape.
- Native crash isolation is not equivalent to a container, VM, or seccomp
  boundary.
- Sessions retain state across multiple feeds by design. Isolation above comes
  from using a fresh session and recycling the native worker after one checkout.
- WASM behavior, cancellation races, crash recovery, return-value edge cases,
  output/result aggregate budgets, and performance were not tested.
- Electron native-addon packaging, ASAR/unpack behavior, signing, notarization,
  and target-platform distribution remain unverified.

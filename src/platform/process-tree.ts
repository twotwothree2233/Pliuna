import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null }
export type ProcessSpec = { mode: 'fork' | 'spawn'; command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv }
export type ManagedProcessTree = {
  process: ChildProcess
  ready: Promise<void>
  exited: Promise<ProcessExit>
  send(message: unknown): void
  terminate(): boolean
  confirm(timeout?: number): Promise<ProcessExit>
}
type JobBinding = { create(name: string): object; active(job: object): number; terminate(job: object): void; close(job: object): void }
const failure = (code: string) => Object.assign(Error(code), { code })
const moduleURL = typeof __filename === 'string' ? pathToFileURL(__filename) : new URL(import.meta.url)
function installedFile(candidates: URL[], code: string): string {
  for (const url of candidates) {
    try { if (lstatSync(url).isFile()) return fileURLToPath(url) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
  throw failure(code)
}
// Source execution and bundled shared chunks use only these application-owned
// locations. No cwd, PATH or environment override can supply supervisor code.
function supervisorFile(): string {
  return installedFile([new URL('./process-supervisor.mjs', moduleURL), new URL('../process-supervisor.mjs', moduleURL)], 'PROCESS_SUPERVISOR_UNAVAILABLE')
}
export function createWindowsJob(): { binding: JobBinding; file: string; job: object; name: string } {
  const file = installedFile([
    new URL('./native/pliuna_job.node', moduleURL), new URL('../native/pliuna_job.node', moduleURL),
    new URL('../../out/main/native/pliuna_job.node', moduleURL)
  ], 'PROCESS_JOB_UNAVAILABLE')
  const binding = createRequire(moduleURL)(file) as JobBinding, name = 'Local\\Pliuna-' + randomUUID()
  return { binding, file, name, job: binding.create(name) }
}
export function processEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of ['SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) if (process.env[name]) env[name] = process.env[name]
  return env
}
const groupExists = (pid: number) => {
  try { process.kill(-pid, 0); return true }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw e }
}

export function startProcessTree(spec: ProcessSpec, options: {
  runtime: string
  beforeStart?(): void
  message?(value: unknown): void
  failed?(code: string): void
}): ManagedProcessTree {
  const supervisor = supervisorFile(), job = process.platform === 'win32' ? createWindowsJob() : undefined
  let child: ChildProcess
  try {
    child = fork(supervisor, [], { execPath: options.runtime, execArgv: [], serialization: 'advanced', detached: process.platform !== 'win32', ...{ windowsHide: true },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...processEnvironment(), ...(job ? { PLIUNA_JOB_BINDING: job.file, PLIUNA_JOB_NAME: job.name } : {}) } })
  } catch (e) { if (job) job.binding.close(job.job); throw e }
  let rootExited = false, finished = false, stopping = false, started = false, complete = false
  let exit: ProcessExit = { code: null, signal: null }, polling: ReturnType<typeof setTimeout> | undefined
  let resolveReady!: () => void, rejectReady!: (e: Error) => void, resolveExit!: (exit: ProcessExit) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  const exited = new Promise<ProcessExit>(resolve => { resolveExit = resolve })
  const fault = (code: string) => { rejectReady(failure(code)); options.failed?.(code) }
  const terminate = (): boolean => {
    stopping = true
    if (finished) return true
    if (job) {
      job.binding.terminate(job.job)
      // The supervisor can still be in bootstrap, before attaching to the Job.
      if (!rootExited && !started && child.pid) return child.kill('SIGKILL')
      return true
    }
    if (!child.pid) return true
    try { process.kill(-child.pid, 'SIGKILL'); return true }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true; throw e }
  }
  const stopAfterFailure = (code: string) => { fault(code); try { terminate() } catch { options.failed?.('PROCESS_TREE_CLEANUP_UNCONFIRMED') } }
  const inspect = () => {
    if (finished || !rootExited) return
    try {
      const remaining = job ? job.binding.active(job.job) > 0 : !!child.pid && groupExists(child.pid)
      if (!remaining) {
        if (job) job.binding.close(job.job)
        finished = true; clearTimeout(polling); clearTimeout(startup)
        if (!started) rejectReady(failure('PROCESS_TREE_START_FAILED'))
        resolveExit(exit); return
      }
    } catch { options.failed?.('PROCESS_TREE_CLEANUP_UNCONFIRMED') }
    polling = setTimeout(inspect, 25)
  }
  const startup = setTimeout(() => { if (!started) stopAfterFailure('PROCESS_TREE_START_FAILED') }, 10000)
  startup.unref()
  child.on('message', (value: any) => {
    if (value?.type === 'tree.ready' && !started && !stopping) {
      try {
        options.beforeStart?.()
        if (!child.connected || stopping) throw failure('PROCESS_TREE_IPC_LOST')
        child.send({ type: 'tree.start', spec, runtime: options.runtime }, error => { if (error) stopAfterFailure('PROCESS_TREE_IPC_LOST') })
      } catch { stopAfterFailure('PROCESS_TREE_SOURCE_INVALID') }
    } else if (value?.type === 'tree.started' && !stopping) {
      started = true; clearTimeout(startup); resolveReady()
    } else if (value?.type === 'tree.message' && !stopping) options.message?.(value.data)
    else if (value?.type === 'tree.complete') { complete = true; exit = { code: value.code, signal: value.signal } }
    else if (value?.type === 'tree.error') stopAfterFailure(started ? 'PROCESS_TREE_FAILED' : 'PROCESS_TREE_START_FAILED')
  })
  child.once('disconnect', () => { if (!complete && !stopping) stopAfterFailure('PROCESS_TREE_IPC_LOST') })
  child.once('error', () => {
    stopAfterFailure('PROCESS_TREE_START_FAILED')
    if (!child.pid) { rootExited = true; inspect() }
  })
  child.once('exit', (code, signal) => {
    rootExited = true; clearTimeout(startup)
    if (!complete) exit = { code, signal }
    try { terminate() } catch { options.failed?.('PROCESS_TREE_CLEANUP_UNCONFIRMED') }
    inspect()
  })
  return { process: child, ready, exited, terminate,
    send(data) { if (!started || stopping || !child.connected) throw failure('PROCESS_TREE_IPC_LOST'); child.send({ type: 'tree.send', data }, error => { if (error) stopAfterFailure('PROCESS_TREE_IPC_LOST') }) },
    confirm(timeout = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(failure('PROCESS_TREE_CLEANUP_UNCONFIRMED')), timeout)
        void exited.then(value => { clearTimeout(timer); resolve(value) })
      })
    }
  }
}

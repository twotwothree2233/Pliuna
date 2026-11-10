import { afterEach, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'

const workflow = readFileSync('.github/workflows/cross-platform.yml', 'utf8')
const checkout = workflow.split('        id: source_checkout\n')[1]?.split('      - name:')[0]
if (!checkout) throw Error('CHECKOUT_STEP_REQUIRED')
const expression = checkout.match(/^        env: \$\{\{ (.*) \}\}$/m)?.[1]
if (!expression) throw Error('CHECKOUT_ENV_OBJECT_REQUIRED')
const environment = (candidate: boolean, owned: string) => runInNewContext(expression, {
  inputs: { windows11_candidate_acceptance: candidate },
  steps: { precheckout: { outputs: { owned } } }, fromJSON: JSON.parse
}) as Record<string, string>
const temporary: string[] = []
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('leaves normal Git global/system reads intact and isolates only the owned candidate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-git-config-')); temporary.push(directory)
  const system = join(directory, 'system.config')
  writeFileSync(system, '[trellisfixture]\n system = system-sentinel\n')
  writeFileSync(join(directory, '.gitconfig'), '[trellisfixture]\n global = global-sentinel\n')
  // Synthetic configuration only; never open the real user/system Git config.
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GIT_|HOME$|XDG_CONFIG_HOME$)/i.test(key)))
  const fixture = { ...base, HOME: directory, XDG_CONFIG_HOME: directory, GIT_CONFIG_SYSTEM: system }
  for (const [candidate, owned] of [[false, 'true'], [false, ''], [true, '']] as const) {
    const selected = environment(candidate, owned)
    expect(Object.keys(selected)).toEqual([]) // No empty-string isolation keys.
    const output = execFileSync('git', ['config', '--get-regexp', '^trellisfixture\\.'], { cwd: directory, env: { ...fixture, ...selected }, encoding: 'utf8', timeout: 3000 })
    expect(output).toContain('system-sentinel'); expect(output).toContain('global-sentinel')
  }
  const isolated = environment(true, 'true')
  expect(isolated).toEqual({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' })
  const result = spawnSync('git', ['config', '--get-regexp', '^trellisfixture\\.'], { cwd: directory, env: { ...fixture, ...isolated }, encoding: 'utf8', timeout: 3000 })
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.error).toBeUndefined()
  expect(checkout).toContain("set-safe-directory: ${{ !(inputs.windows11_candidate_acceptance && steps.precheckout.outputs.owned == 'true') }}")
  expect(checkout).toContain("(!inputs.windows11_candidate_acceptance || steps.precheckout.outputs.owned == 'true')")
})

it('creates only a previously absent candidate source, refusing reuse and reparses', () => {
  const preparation = workflow.split('        id: precheckout\n')[1]?.split('      - name:')[0]
  const discover = preparation?.match(/            function discover\(\) \{[\s\S]*?\n            \}/)?.[0]
  if (!discover) throw Error('DISCOVERY_REQUIRED')
  function run(candidate: boolean, exists = false, reparse = false) {
    let created = false, message: any
    const source = 'C:\\workspace\\trellis-standard-123-1'
    const fs = {
      constants: { R_OK: 4 }, accessSync() {},
      lstatSync(file: string) {
        if (file === source && !exists && !created) throw Object.assign(Error(), { code: 'ENOENT' })
        if (/git/i.test(file)) throw Object.assign(Error(), { code: 'ENOENT' })
        return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => reparse && file === 'C:\\workspace', dev: 3n, ino: 7n }
      },
      mkdirSync(file: string, options: unknown) { expect(file).toBe(source); expect(options).toBeUndefined(); created = true }
    }
    const process = { env: { SystemRoot: 'C:\\Windows', GITHUB_WORKSPACE: 'C:\\workspace', TRELLIS_WIN11_SOURCE: 'trellis-standard-123-1', TRELLIS_CREATE_CANDIDATE_SOURCE: candidate ? '1' : '0' },
      send(value: unknown, callback: () => void) { message = value; callback() }, disconnect() {} }
    runInNewContext(discover + '\ndiscover()', { require: (name: string) => name === 'node:fs' ? fs : { win32 }, process })
    return { created, message }
  }
  expect(run(false).created).toBe(false)
  expect(run(true)).toMatchObject({ created: true, message: { source_identity: { dev: '3', ino: '7' } } })
  expect(() => run(true, true)).toThrow()
  expect(() => run(true, false, true)).toThrow()
  expect(preparation).toContain("owner.output !== 'True'")
  expect(preparation).toContain('SOURCE_IDENTITY_UNCONFIRMED')
})

it('binds the finite reviewed chain to actual single first-parent edges', () => {
  const require = createRequire(import.meta.url)
  const { fixedParents } = require('../../scripts/windows11-candidate-evidence.cjs') as { fixedParents: string[] }
  expect(Object.isFrozen(fixedParents)).toBe(true)
  expect(fixedParents).toHaveLength(14)
  for (let index = 0; index < fixedParents.length - 1; index++) {
    const child = fixedParents[index]
    if (!child) throw Error('FIXED_CHILD_REQUIRED')
    expect(execFileSync('git', ['show', '-s', '--format=%P', child], { encoding: 'utf8', timeout: 3000 }).trim()).toBe(fixedParents[index + 1])
  }
})

it('withholds candidate ownership output on owner, identity or deadline failure', async () => {
  const preparation = workflow.split('        id: precheckout\n')[1]?.split('      - name:')[0]
  const owner = preparation?.match(/                  if \(context\.payload\.inputs\?\.windows11_candidate_acceptance === 'true'\) \{[\s\S]*?\n                  \}/)?.[0]
  if (!owner) throw Error('OWNER_GATE_REQUIRED')
  async function verify(options: { owner?: string; ownerExit?: number; timeout?: boolean; changed?: boolean; late?: boolean } = {}) {
    const outputs: string[] = [], report = {}, calls: number[] = []
    const context = {
      context: { payload: { inputs: { windows11_candidate_acceptance: 'true' } } }, report,
      discovery: { message: { source_identity: { dev: '3', ino: '7' } } }, path: win32,
      process: { env: { GITHUB_WORKSPACE: 'C:\\workspace', TRELLIS_WIN11_SOURCE: 'trellis-standard-123-1', SystemRoot: 'C:\\Windows' }, execPath: 'fixture-node' },
      deadline: 20000, performance: { now: () => options.late ? 20001 : 100 },
      core: { setOutput: (key: string) => outputs.push(key) },
      run: async (_file: string, _args: string[], budget: number) => {
        calls.push(budget)
        return calls.length === 1
          ? { started: true, output: options.owner ?? 'True', exit: options.ownerExit ?? 0, error: null, timeout: options.timeout ?? false }
          : { started: true, exit: options.changed ? 1 : 0, error: null }
      }
    }
    await runInNewContext('(async () => {' + owner + '})()', context)
    return { outputs, report, calls }
  }
  expect((await verify()).outputs).toEqual(['owned'])
  for (const options of [{ owner: 'False' }, { owner: 'true' }, { owner: '' }, { ownerExit: 1 }, { timeout: true }, { changed: true }, { late: true }]) {
    await expect(verify(options)).rejects.toThrow()
  }
})

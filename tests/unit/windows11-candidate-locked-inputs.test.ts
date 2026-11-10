import { afterEach, expect, it } from 'vitest'
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const { fixedParents, verifyLockedInputs } = require('../../scripts/windows11-candidate-evidence.cjs') as {
  fixedParents: string[]; verifyLockedInputs: (source: string, previous: string, record: (value: any) => void) => void
}
const workflow = readFileSync('.github/workflows/cross-platform.yml', 'utf8')
const script = workflow.split('        id: candidate_dependencies\n')[1]?.split('      - name:')[0]?.split('          script: |\n')[1]?.split('\n').map(line => line.replace(/^ {12}/, '')).join('\n')
if (!script) throw Error('CANDIDATE_PRODUCTION_CALL_REQUIRED')
const local = script.slice(script.indexOf("if (!/^[1-9][0-9]{0,19}$/"), script.indexOf('const repoRoute ='))
if (!local.includes('verifyLockedInputs(source, previous')) throw Error('REAL_LOCKED_INPUT_CALL_REQUIRED')
const temporary: string[] = []
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const workspace = mkdtempSync(path.join(tmpdir(), 'trellis-version-contract-')); temporary.push(workspace)
  const sourceName = 'trellis-standard-42780000000-1', prior = '42649802869'
  const source = path.join(workspace, sourceName), previous = path.join(workspace, 'trellis-standard-' + prior + '-1')
  const git = (cwd: string, args: string[], input?: string) => execFileSync('git', args, { cwd, input, encoding: 'utf8', timeout: 3000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim()
  const objects = path.resolve(git(process.cwd(), ['rev-parse', '--git-common-dir']), 'objects')
  for (const directory of [source, previous]) {
    mkdirSync(directory); git(directory, ['init', '--quiet'])
    writeFileSync(path.join(directory, '.git/objects/info/alternates'), objects + '\n')
    for (const name of ['package.json', 'pnpm-lock.yaml', '.node-version']) {
      const text = readFileSync(name, 'utf8').replace(/\r\n/g, '\n')
      writeFileSync(path.join(directory, name), directory === source ? text.replace(/\n/g, '\r\n') : text)
    }
  }
  const parent = fixedParents[0]
  if (!parent) throw Error('PARENT_REQUIRED')
  const tree = git(process.cwd(), ['rev-parse', parent + '^{tree}'])
  const head = git(source, ['commit-tree', tree, '-p', parent], 'temporary fixture only\n')
  writeFileSync(path.join(source, '.git/HEAD'), head + '\n')
  writeFileSync(path.join(previous, '.git/HEAD'), '01039e72cab284491fcd1a812add0ec79c8e2488\n')
  function preflight() {
    const report: any = { requests: [] }; let requestBoundary = false, calls = 0
    runInNewContext(local + '\nglobalThis.completed = true', {
      prior, previousInput: prior, reuseInput: '', fs, path, report, fixedParents, resumeHead: parent,
      ownerHead: '01039e72cab284491fcd1a812add0ec79c8e2488', verifyLockedInputs,
      process: { env: { GITHUB_RUN_ID: '42780000000', GITHUB_SHA: head, GITHUB_WORKSPACE: workspace, TRELLIS_WIN11_SOURCE: sourceName } },
      fail: (code: string) => { throw Error(code) }, save() {},
      systemHttpsClient() { requestBoundary = true },
      cp: { execFileSync(file: string, args: string[], options: ExecFileSyncOptions) {
        expect(file).toBe('git.exe'); expect(options.timeout).toBe(3000); expect(options.encoding).toBe('utf8')
        calls++
        // Substitute only the platform executable; use the production args/options.
        return execFileSync('git', args, options)
      } }
    })
    return { report, requestBoundary, calls }
  }
  return { source, previous, preflight }
}

it('reaches the request boundary using real Git and the workflow call with CRLF/LF pinned inputs', () => {
  const result = fixture().preflight()
  expect(result.requestBoundary).toBe(true); expect(result.calls).toBe(3)
  expect(result.report.requests).toEqual([]); expect(result.report.locked_inputs_equal).toBe(true)
  expect(result.report.locked_inputs).toHaveLength(3)
  expect(result.report.locked_inputs.every((value: any) => value.byte_equal === false && value.canonical_equal === true)).toBe(true)
  expect(result.report.locked_inputs[0]).toMatchObject({ expected: { eol: 'lf', versions: { application: '0.1.0', package_manager: 'pnpm@10.20.0', electron: '38.2.2' } }, actual: { eol: 'crlf' } })
})

it.each(['package.json', 'pnpm-lock.yaml', '.node-version'])('rejects actual pinned content changes in %s', name => {
  const setup = fixture()
  const file = path.join(setup.source, name), text = readFileSync(file, 'utf8')
  writeFileSync(file, name === '.node-version' ? '22.23.2\r\n' : text + '\r\n')
  expect(setup.preflight).toThrow('CANDIDATE_REUSE_VERSION_CHANGED')
})

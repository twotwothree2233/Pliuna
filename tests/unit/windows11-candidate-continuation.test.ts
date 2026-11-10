import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { win32 as path } from 'node:path'
import { runInNewContext } from 'node:vm'
const require = createRequire(import.meta.url)
const evidence = require('../../scripts/windows11-candidate-evidence.cjs')
const id = (ino: number) => ({ dev: '1', ino: String(ino) })
const home = 'C:\\Users\\fixture', root = home + '\\.trellis', local = home + '\\AppData\\Local'
function fixture() {
  const host = { runner: 'DESKTOP-SFE95TP', standard_user_required: true, elevated: false, administrators_group_present: false, system_account: false,
    user_interactive: true, session_id: 1, product_type: 1, architecture: 'X64', caption: 'Windows 11', build: 26300 }
  const exit = { started: true, exit: 0, signal: null, job_empty: true }
  const preservation = { renamed: true, same_identity: true, security_preserved: true, source_absent: true }
  const probe = { probe: true, no_overwrite: true, identity_refusal: true, same_identity: true, security_preserved: true }
  const parents = ['C:\\Users', home, home + '\\AppData', local].map((path, index) => ({ path, identity: id(10 + index) }))
  const originalCandidate = { stage: 'installed', passed: true, install: exit, install_identity: id(20), install_dir: local + '\\Trellis 验收 42649802869-1',
    default: { root, homeIdentity: id(1), rootIdentity: id(2), absent: false }, backup: { path: home + '\\.trellis.ao-preserved-42649802869-1', identity: id(2), performed: true },
    preservation, preservation_probe: probe, parents }
  function defaults(ino: number) {
    return { stage: 'ready', passed: true, installed_candidate: true, application_launches: 2, task_created: true, task_and_settings_restored: true,
      first_exit_confirmed: true, final_exit_confirmed: true, identity: { home: id(1), directory: id(ino) }, formats: { restore: 'restore-v5', gc: 'gc-v1' },
      maintenance: { ok: true, data: { phase: 'idle', error: null, restore: { error: null }, gc: { enabled: true, error: null } } },
      exits: [1, 2].map(() => ({ wrapper_exit_code: 0, main_exit_confirmed: true, utility_exit_confirmed: true, observed_utility_count: 1 })),
      actual_environment: { default_user_data: true, actual_home_preserved: true, home_environment_preserved: true, userprofile_environment_preserved: true,
        all_trellis_keys_absent: true, test_data_present: false, identity_override_present: false, electron_node_present: false, renderer_url_present: false, node_options_present: false, path_state: 'absent', path_key_count: 0 } }
  }
  const original = { 'host.json': host, 'candidate.json': originalCandidate, 'default-startup.json': defaults(3) }
  const parentsAtAttempt = evidence.fixedParents.slice(evidence.fixedParents.indexOf(evidence.continuation.head) + 1)
  const operations = ['getWorkflowRun', ...parentsAtAttempt.slice(0, -1).map(() => 'getCommit'), 'listJobsForWorkflowRun', 'getArtifact', 'getArtifactRedirect', 'downloadArtifact']
  const values = { 'host.json': host, 'candidate.json': { stage: 'uninstalled_after_failure', passed: false, default_data_retained: true,
    install: exit, failure_uninstall: exit, install_identity: id(21), install_dir: local + '\\Trellis 验收 42779040248-2',
    default: { root, homeIdentity: id(1), rootIdentity: id(3), absent: false }, backup: { path: home + '\\.trellis.ao-preserved-42779040248-2', identity: id(3), performed: true },
    preservation, preservation_probe: probe, parents, previous_cleanup: { prior_run: '42649802869', prior_backup: originalCandidate.backup.path,
      test_root_identity: id(3), stage: 'removed_data_retained', passed: true, uninstall: exit } },
    'default-startup.json': defaults(4), 'candidate-provenance.json': { stage: 'ready', passed: true, prior_run: '42649802869', source_head: evidence.continuation.head,
      prior_head: '01039e72cab284491fcd1a812add0ec79c8e2488', fixed_parent_chain_verified: true, native_stages_verified: true, locked_inputs_equal: true, dependencies_reused: false,
      original_evidence: { id: 13691230073, run_id: 42649802869, head: '01039e72cab284491fcd1a812add0ec79c8e2488', facts_verified: true, source: 'fixed_original_run_artifact', archive_bytes: 98036 },
      parent_chain: parentsAtAttempt.map((parent: string, index: number) => ({ child: index ? parentsAtAttempt[index - 1] : evidence.continuation.head, parent })),
      requests: operations.map(stage => ({ stage, transport: 'windows_system_curl', status: stage === 'getArtifactRedirect' ? 302 : 200,
        exit_code: 0, completed: true, timeout: false, status_source: 'http_response' })) } }
  return { original, values }
}
it('accepts only the proven uninstalled attempt and retains its link to the original backup', () => {
  const { original, values } = fixture(); expect(() => evidence.validateContinuationFacts(values, original)).not.toThrow()
})
it.each([
  (x: any) => { x['candidate.json'].failure_uninstall.exit = 1 },
  (x: any) => { x['candidate.json'].failure_uninstall.job_empty = false },
  (x: any) => { x['candidate.json'].stage = 'installed' },
  (x: any) => { x['candidate.json'].default_data_retained = false },
  (x: any) => { x['candidate.json'].previous_cleanup.prior_backup = 'C:\\unrelated' },
  (x: any) => { x['candidate.json'].backup.identity = id(99) },
  (x: any) => { x['default-startup.json'].identity.directory = id(3) },
  (x: any) => { x['candidate-provenance.json'].source_head = 'a'.repeat(40) },
  (x: any) => { x['candidate-provenance.json'].requests[0].status = 403 },
  (x: any) => { x['candidate-provenance.json'].parent_chain[0].parent = 'b'.repeat(40) },
  (x: any) => { x['host.json'].administrators_group_present = true }
])('rejects changed source, status, permission or backup proof %#', mutate => {
  const { original, values } = fixture(); mutate(values); expect(() => evidence.validateContinuationFacts(values, original)).toThrow()
})
it('refuses an attempt1 artifact and unknown current sources', () => {
  const base = { id: 13749679230, name: evidence.continuation.name, expired: false, size_in_bytes: 97812,
    workflow_run: { id: 42779040248, head_sha: evidence.continuation.head, head_branch: 'branch', repository_id: 1434252659, head_repository_id: 1434252659 } }
  expect(() => evidence.validateContinuationMetadata(base, 'branch')).not.toThrow()
  expect(() => evidence.validateContinuationMetadata({ ...base, id: 13745865245 }, 'branch')).toThrow()
  expect(() => evidence.validateContinuationMetadata({ ...base, name: 'windows11-evidence-42779040248-1' }, 'branch')).toThrow()
})

it('continues without another uninstall or root rename, and rejects native ownership/identity conflicts', async () => {
  async function run(options: { registered?: boolean; executable?: boolean; owner?: boolean; changedBackup?: boolean; changedRoot?: boolean } = {}) {
    const { original, values } = fixture(), folder = 'C:\\temp\\trellis-continuation-42779040248-2-fixture', originalFolder = 'C:\\temp\\original'
    const files = new Map<string, unknown>()
    for (const [key, value] of Object.entries(original)) files.set(path.join(originalFolder, key), value)
    for (const [key, value] of Object.entries(values)) files.set(path.join(folder, key), value)
    const directories = new Map<string, {dev: string; ino: string}>([[folder, id(30)], [root, options.changedRoot ? id(99) : id(4)],
      [original['candidate.json'].backup.path, options.changedBackup ? id(99) : id(2)], [values['candidate.json'].backup.path, id(3)],
      ...values['candidate.json'].parents.map(parent => [parent.path, parent.identity] as const)])
    const writes: unknown[] = [], commands: string[][] = []
    const fakeFs = { lstatSync(file: string) {
      if (files.has(file) || options.executable && file.endsWith('Trellis.exe')) return { size: 1000, isFile: () => true, isSymbolicLink: () => false }
      const value = directories.get(file)
      if (value) return { ...value, isDirectory: () => true, isSymbolicLink: () => false }
      throw Object.assign(Error(), { code: 'ENOENT' })
    }, readFileSync: (file: string) => JSON.stringify(files.get(file)), writeFileSync: (_file: string, value: string) => writes.push(JSON.parse(value)) }
    const box: any = { __filename: 'C:\\source\\candidate.cjs', module: { exports: {} }, Buffer, console: { log() {} },
      require: (name: string) => name === 'node:fs' ? fakeFs : name === 'node:path' ? path : name === 'node:os' ? { homedir: () => home } :
        name === './windows11-candidate-evidence.cjs' ? evidence : name === './windows11-default-data.cjs' ? { inventory: async () => current } : require(name),
      process: { env: { LOCALAPPDATA: local, RUNNER_TEMP: 'C:\\temp', SystemRoot: 'C:\\Windows', TRELLIS_WIN11_EVIDENCE: 'C:\\evidence' }, argv: [] } }
    const current = { root, homeIdentity: id(1), rootIdentity: id(4), absent: false }
    runInNewContext(readFileSync('scripts/windows11-candidate.cjs', 'utf8') + '\nglobalThis.continueCheck=continueUninstalled;globalThis.setNative=(m,r)=>{managed=m;registry=r}', box)
    box.setNative(async (_file: string, args: string[]) => { commands.push(args); expect(args.at(-1)).toContain('Get-Acl'); expect(args.at(-1)).not.toContain('Set-Acl'); return { output: JSON.stringify({ owned: options.owner ?? true }), job_empty: true } }, async () => options.registered ? 1 : 0)
    const proof = { continuation_evidence: { id: 13749679230, name: evidence.continuation.name, run_id: 42779040248, attempt: 2, head: evidence.continuation.head,
      archive_bytes: 97812, branch: 'ao/trellis-12/cross-platform-ci', directory: folder, identity: id(30), source: 'fixed_uninstalled_attempt_artifact', facts_verified: true,
      files: ['host.json', 'candidate.json', 'default-startup.json', 'candidate-provenance.json'] } }
    const result = await box.continueCheck(current, proof, originalFolder)
    return { result, writes, commands }
  }
  const good = await run(); expect(good.result.continued_uninstalled).toBe(true); expect(good.commands).toHaveLength(1); expect(good.writes).toHaveLength(1)
  for (const options of [{ registered: true }, { executable: true }, { owner: false }, { changedBackup: true }, { changedRoot: true }]) await expect(run(options)).rejects.toThrow()
})

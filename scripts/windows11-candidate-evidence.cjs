// Fixed original and authorized continuation evidence only. No general archive extraction or fallback
// to vanished RUNNER_TEMP records may authorize an installation cleanup.
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const fail = code => { throw Object.assign(Error(code), { code }) }
// Only these reviewed first-parent edges can authorize this fixed original run.
const fixedParents = Object.freeze([
  '25f69a64ca64abbd9f291fedcac7d1b29101b893',
  'a0c6ad87b5ee4fe8a00b46344d0e371388ac269a',
  '3c56ebceb257d60cf5c44d7d2aca0a8e251c7eaa',
  '0f39ff15140fb663c679a5995ec9efaf5d4a9994',
  'ef06b7aca370a1d92dbfd9d79c0e8dc9b37cfa68',
  'aa096628052e5cdfd15b924785856dccdee42f7b',
  '19bacd1576fe0dfcf4f75e5a33b407245add0443',
  '40d29f9bbe9148d02054ca74ca58c836949cfe09',
  'c9c91917ceb704eedf37a83f7c4b1173cbcb8ec3',
  'ef0286f179790e83acd70b147fc8dd99b3278246',
  '73e906cb3ec752653242ddf5e004ab4b625217fa',
  '2a62afb20223fc850d22c625a905d0f2bd4ece2f',
  '2bed119f8df96ec81992d755bf81769cdfd27c4f',
  '01039e72cab284491fcd1a812add0ec79c8e2488',
])
const prior = 42649802869
const head = '01039e72cab284491fcd1a812add0ec79c8e2488'
const name = 'windows11-evidence-42649802869-1'
const defaultEntry = 'default-desktop/default-startup-uses-the-r-dbf2e-cal-settings-across-restart/default-startup.json'
const required = ['host.json', 'candidate.json', defaultEntry]
const entries = [
  'candidate-business/candidate-business-install-025f7-across-restart-or-reinstall/candidate-business.json',
  'candidate-business/candidate-business-install-025f7-across-restart-or-reinstall/candidate-failure.png',
  'candidate-preflight.json', 'candidate.json', 'checkout-preparation.json', defaultEntry,
  'default-desktop/default-startup-uses-the-r-dbf2e-cal-settings-across-restart/default-startup.png',
  'dependency-toolchain.json', 'electron-download.json', 'file-symlink-probe.json',
  'git-preparation.json', 'host.json', 'installed-runtime.json', 'standard-toolchain.json'
]
// Check the entire pinned text, permitting only Git's CRLF checkout transform.
// Never loosen this into a selected-version or parsed-manifest comparison.
function verifyLockedInputs(source, previous, record) {
  const version = value => typeof value === 'string' && value.length <= 80 && /^(?:pnpm@)?[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value) ? value : null
  function read(directory, name) {
    const file = path.join(directory, name), stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2097152) fail('CANDIDATE_REUSE_INPUT_UNSAFE')
    const bytes = fs.readFileSync(file), text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('CANDIDATE_REUSE_INPUT_ENCODING_INVALID')
    const canonical = text.replace(/\r\n/g, '\n')
    let versions
    if (name === 'package.json') {
      let value
      try { value = JSON.parse(text) } catch { fail('CANDIDATE_REUSE_MANIFEST_INVALID') }
      versions = { application: version(value.version), package_manager: version(value.packageManager), electron: version(value.devDependencies?.electron) }
    } else if (name === '.node-version') versions = { node: version(text.trim()) }
    else versions = { lockfile: version(canonical.match(/^lockfileVersion: ['"]?([0-9]+\.[0-9]+)['"]?$/m)?.[1]) }
    return { bytes, canonical, versions, eol: /\r(?!\n)/.test(text) ? 'lone_cr' : /\r\n/.test(text) ? /(?<!\r)\n/.test(text) ? 'mixed' : 'crlf' : 'lf' }
  }
  for (const name of ['package.json', 'pnpm-lock.yaml', '.node-version']) {
    const expected = read(previous, name), actual = read(source, name)
    const result = { file: name, byte_equal: expected.bytes.equals(actual.bytes), canonical_equal: expected.canonical === actual.canonical,
      expected: { eol: expected.eol, versions: expected.versions }, actual: { eol: actual.eol, versions: actual.versions } }
    record(result) // Only fixed filenames, newline categories and public versions.
    if (!result.canonical_equal) fail('CANDIDATE_REUSE_VERSION_CHANGED')
  }
}
function validateMetadata(value, branch) {
  if (value?.id !== 13691230073 || value.name !== name || value.expired !== false || value.size_in_bytes !== 98036 ||
      value.workflow_run?.id !== prior || value.workflow_run.head_sha !== head || value.workflow_run.head_branch !== branch ||
      value.workflow_run.repository_id !== 1434252659 || value.workflow_run.head_repository_id !== 1434252659) fail('CANDIDATE_ARTIFACT_SOURCE_UNCONFIRMED')
}
const exactIdentity = value => typeof value?.dev === 'string' && /^[0-9]+$/.test(value.dev) && typeof value.ino === 'string' && /^[1-9][0-9]*$/.test(value.ino)
const same = (a, b) => exactIdentity(a) && exactIdentity(b) && a.dev === b.dev && a.ino === b.ino
function validateFacts(values) {
  const host = values['host.json'], candidate = values['candidate.json'], defaults = values['default-startup.json']
  validateDesktopFacts(host, candidate?.default?.homeIdentity, defaults)
  if (candidate?.stage !== 'installed' || candidate.passed !== true || candidate.install?.started !== true || candidate.install.exit !== 0 || candidate.install.signal !== null ||
      candidate.install.job_empty !== true || !exactIdentity(candidate.install_identity) || candidate.backup?.performed !== true || candidate.default?.absent !== false ||
      !same(candidate.backup.identity, candidate.default.rootIdentity) || candidate.preservation?.renamed !== true || candidate.preservation.same_identity !== true ||
      candidate.preservation.security_preserved !== true || candidate.preservation.source_absent !== true || !Array.isArray(candidate.parents) || !candidate.parents.length ||
      !candidate.parents.every(parent => typeof parent.path === 'string' && same(parent.identity, parent.identity)) ||
      !['probe', 'no_overwrite', 'identity_refusal', 'same_identity', 'security_preserved'].every(key => candidate.preservation_probe?.[key] === true)) fail('CANDIDATE_PREVIOUS_INSTALL_UNCONFIRMED')
}
function validateDesktopFacts(host, homeIdentity, defaults) {
  if (host?.runner !== 'DESKTOP-SFE95TP' || host.standard_user_required !== true || host.elevated !== false || host.administrators_group_present !== false ||
      host.system_account !== false || host.user_interactive !== true || !Number.isInteger(host.session_id) || host.session_id <= 0 ||
      host.product_type !== 1 || host.architecture !== 'X64' || !host.caption?.includes('Windows 11') || !Number.isInteger(host.build) || host.build < 22000) fail('CANDIDATE_PREVIOUS_HOST_UNCONFIRMED')
  if (defaults?.passed !== true || defaults.stage !== 'ready' || defaults.installed_candidate !== true || defaults.application_launches !== 2 ||
      defaults.task_created !== true || defaults.task_and_settings_restored !== true || defaults.first_exit_confirmed !== true || defaults.final_exit_confirmed !== true ||
      !same(defaults.identity?.home, homeIdentity) || !exactIdentity(defaults.identity?.directory) || defaults.formats?.restore !== 'restore-v5' || defaults.formats.gc !== 'gc-v1' ||
      defaults.maintenance?.ok !== true || defaults.maintenance.data?.phase !== 'idle' || defaults.maintenance.data.error !== null ||
      defaults.maintenance.data.restore?.error !== null || defaults.maintenance.data.gc?.enabled !== true || defaults.maintenance.data.gc.error !== null ||
      defaults.exits?.length !== 2 || !defaults.exits.every(exit => exit.wrapper_exit_code === 0 && exit.main_exit_confirmed === true && exit.utility_exit_confirmed === true && exit.observed_utility_count > 0)) fail('CANDIDATE_PREVIOUS_DEFAULT_UNCONFIRMED')
  const env = defaults.actual_environment
  if (!env || !['default_user_data', 'actual_home_preserved', 'home_environment_preserved', 'userprofile_environment_preserved', 'all_trellis_keys_absent'].every(key => env[key] === true) ||
      !['test_data_present', 'identity_override_present', 'electron_node_present', 'renderer_url_present', 'node_options_present'].every(key => env[key] === false) ||
      env.path_state !== 'absent' || env.path_key_count !== 0) fail('CANDIDATE_PREVIOUS_ENVIRONMENT_UNCONFIRMED')
}
function readFixedArchive(archive, artifact, environment, allowedEntries, requiredEntries) {
  if (!Buffer.isBuffer(archive) || archive.length !== artifact.size_in_bytes) fail('CANDIDATE_ARTIFACT_SIZE_UNCONFIRMED')
  // ZipArchive reads only the fixed required JSON entries. Never extract paths or
  // open other entry contents, including old business data and screenshots.
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression; ` +
    `$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $stream=[IO.MemoryStream]::new($bytes,$false); ` +
    `$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read); ` +
    `$allowed=@(${allowedEntries.map(value => "'" + value + "'").join(',')}); $required=@(${requiredEntries.map(value => "'" + value + "'").join(',')}); ` +
    `$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal); $result=[ordered]@{}; ` +
    `try { if($zip.Entries.Count -ne $allowed.Count){throw 'ENTRY_COUNT'}; foreach($entry in $zip.Entries){ ` +
    `if(-not ($allowed -ccontains $entry.FullName) -or -not $seen.Add($entry.FullName) -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'ENTRY_UNSAFE'}; ` +
    `if($required -ccontains $entry.FullName){if($entry.Length -le 0 -or $entry.Length -gt 32768){throw 'ENTRY_SIZE'}; ` +
    `$reader=[IO.StreamReader]::new($entry.Open(),[Text.UTF8Encoding]::new($false,$true),$false); try{$text=$reader.ReadToEnd()}finally{$reader.Dispose()}; ` +
    `if([Text.Encoding]::UTF8.GetByteCount($text) -gt 32768){throw 'ENTRY_SIZE'}; $result[$entry.FullName]=$text} }; ` +
    `if($result.Count -ne ${requiredEntries.length}){throw 'ENTRY_MISSING'}; $result|ConvertTo-Json -Compress } finally{$zip.Dispose();$stream.Dispose()}`
  let extracted
  try {
    const output = cp.execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { input: archive.toString('base64'), env: environment,
        encoding: 'utf8', timeout: 10000, maxBuffer: 262144, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    extracted = JSON.parse(output)
  } catch { fail('CANDIDATE_ARTIFACT_JSON_EXTRACTION_FAILED') }
  if (!extracted || Object.keys(extracted).length !== requiredEntries.length || !requiredEntries.every(key => typeof extracted[key] === 'string' && Buffer.byteLength(extracted[key]) <= 32768)) fail('CANDIDATE_ARTIFACT_JSON_UNCONFIRMED')
  const values = {}
  for (const key of requiredEntries) {
    try { values[path.basename(key)] = JSON.parse(extracted[key]) } catch { fail('CANDIDATE_ARTIFACT_JSON_INVALID') }
  }
  return { values, extracted }
}
function persistFixedEvidence(extracted, requiredEntries, prefix) {
  const temp = fs.lstatSync(process.env.RUNNER_TEMP)
  if (!temp.isDirectory() || temp.isSymbolicLink()) fail('CANDIDATE_ARTIFACT_TEMP_UNSAFE')
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, prefix))
  for (const key of requiredEntries) fs.writeFileSync(path.join(directory, path.basename(key)), extracted[key], { flag: 'wx', encoding: 'utf8' })
  const stat = fs.lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CANDIDATE_ARTIFACT_TEMP_UNSAFE')
  return { directory, identity: { dev: String(stat.dev), ino: String(stat.ino) } }
}
function restore(archive, artifact, branch, environment) {
  validateMetadata(artifact, branch)
  const { values, extracted } = readFixedArchive(archive, artifact, environment, entries, required)
  validateFacts(values)
  return { id: artifact.id, name, run_id: prior, head, branch, ...persistFixedEvidence(extracted, required, 'trellis-prior-42649802869-'),
    archive_bytes: archive.length, files: ['host.json', 'candidate.json', 'default-startup.json'], source: 'fixed_original_run_artifact', facts_verified: true }
}

const defaultOrigin = Object.freeze({ id: 13749679230, run: 42779040248, attempt: 2, head: '3c56ebceb257d60cf5c44d7d2aca0a8e251c7eaa' })
const continuation = Object.freeze({ id: 13752368936, run: 42793967624, attempt: 1,
  head: '25f69a64ca64abbd9f291fedcac7d1b29101b893', name: 'windows11-evidence-42793967624-1', bytes: 70232 })
const continuationRequired = ['host.json', 'candidate.json', 'default-desktop/verified-42779040248-2/default-startup.json', 'candidate-provenance.json']
const continuationEntries = ["candidate-business/candidate-business-install-025f7-across-restart-or-reinstall/candidate-business.json", "candidate-business/candidate-business-install-025f7-across-restart-or-reinstall/candidate-failure.png", "candidate-continuation.json", "candidate-preflight.json", "candidate-provenance.json", "candidate.json", "checkout-preparation.json", "default-desktop/verified-42779040248-2/default-startup.json", "dependency-toolchain.json", "electron-download.json", "file-symlink-probe.json", "git-preparation.json", "host.json", "installed-runtime.json", "standard-toolchain.json"]
function validateContinuationMetadata(value, branch) {
  if (value?.id !== continuation.id || value.name !== continuation.name || value.expired !== false || value.size_in_bytes !== continuation.bytes ||
      value.workflow_run?.id !== continuation.run || value.workflow_run.head_sha !== continuation.head || value.workflow_run.head_branch !== branch ||
      value.workflow_run.repository_id !== 1434252659 || value.workflow_run.head_repository_id !== 1434252659) fail('CANDIDATE_CONTINUATION_SOURCE_UNCONFIRMED')
}
function validateContinuationRun(run, jobs, branch) {
  if (run?.id !== continuation.run || run.head_sha !== continuation.head || run.head_branch !== branch || run.run_attempt !== continuation.attempt ||
      run.status !== 'completed' || run.conclusion !== 'failure' || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/cross-platform.yml' ||
      run.display_title !== 'Windows 11 local candidate acceptance') fail('CANDIDATE_CONTINUATION_RUN_UNCONFIRMED')
  const matches = jobs?.jobs?.filter(job => job.runner_name === 'DESKTOP-SFE95TP')
  const success = ['Require the designated Windows 11 x64 host', 'Verify the isolated checkout commit',
    'Verify prior candidate ownership and optionally reuse pinned dependencies', 'Prepare the existing Electron ABI for default-startup acceptance',
    'Build local directory package', 'Preserve prior default data and install the current-user NSIS candidate',
    'Verify installed ACL, Job, RPC, descendant cleanup and PDF', 'Require the actual default-startup result and all exit confirmations',
    'Remove only this candidate installation after a failed application scenario']
  if (matches?.length !== 1 || matches[0].runner_id !== 23 || matches[0].run_id !== continuation.run || matches[0].head_sha !== continuation.head || matches[0].run_attempt !== continuation.attempt || matches[0].status !== 'completed' || matches[0].conclusion !== 'failure' ||
      !success.every(name => matches[0].steps.some(step => step.name === name && step.conclusion === 'success')) ||
      !matches[0].steps.some(step => step.name === 'Installed candidate synthetic materials, plugin, export and recovery' && step.conclusion === 'failure')) fail('CANDIDATE_CONTINUATION_STAGES_UNCONFIRMED')
}
function validateContinuationFacts(values, original) {
  validateFacts(original)
  const c = values['candidate.json'], d = values['default-startup.json'], p = values['candidate-provenance.json'], o = original['candidate.json']
  validateDesktopFacts(values['host.json'], c?.default?.homeIdentity, d)
  const exited = value => value?.started === true && value.exit === 0 && value.signal === null && value.job_empty === true
  const parents = fixedParents.slice(fixedParents.indexOf(continuation.head) + 1)
  const operations = ['getWorkflowRun', ...parents.slice(0, -1).map(() => 'getCommit'), 'listJobsForWorkflowRun', 'getArtifact', 'getArtifactRedirect', 'downloadArtifact', 'getContinuationRun', 'getContinuationJobs', 'getContinuationArtifact', 'getContinuationRedirect', 'downloadContinuationArtifact']
  if (!parents.length || p?.passed !== true || p.stage !== 'ready' || p.prior_run !== String(prior) || p.source_head !== continuation.head || p.prior_head !== head ||
      p.fixed_parent_chain_verified !== true || p.native_stages_verified !== true || p.locked_inputs_equal !== true || p.dependencies_reused !== false ||
      p.original_evidence?.id !== 13691230073 || p.original_evidence.run_id !== prior || p.original_evidence.head !== head || p.original_evidence.facts_verified !== true ||
      p.original_evidence.source !== 'fixed_original_run_artifact' || p.original_evidence.archive_bytes !== 98036 ||
      p.parent_chain?.length !== parents.length || p.parent_chain.some((edge, index) => edge.child !== (index ? parents[index - 1] : continuation.head) || edge.parent !== parents[index]) ||
      p.requests?.length !== operations.length || p.requests.some((request, index) => request.stage !== operations[index] || request.transport !== 'windows_system_curl' ||
        request.status !== (operations[index].endsWith('Redirect') ? 302 : 200) || request.exit_code !== 0 || request.completed !== true || request.timeout !== false || request.status_source !== 'http_response')) fail('CANDIDATE_CONTINUATION_PROVENANCE_UNCONFIRMED')
  const kept = c?.continuation
  if (p.continuation_evidence?.id !== defaultOrigin.id || p.continuation_evidence.run_id !== defaultOrigin.run || p.continuation_evidence.attempt !== defaultOrigin.attempt ||
      p.continuation_evidence.head !== defaultOrigin.head || p.continuation_evidence.facts_verified !== true ||
      p.default_proof_reused?.run_id !== defaultOrigin.run || p.default_proof_reused.attempt !== defaultOrigin.attempt || p.default_proof_reused.head !== defaultOrigin.head || p.default_proof_reused.artifact_id !== defaultOrigin.id ||
      c?.stage !== 'uninstalled_after_failure' || c.passed !== false || c.default_data_retained !== true || !exited(c.install) || !exited(c.failure_uninstall) ||
      c.default?.absent !== false || c.default.root !== o.default.root || !same(c.default.homeIdentity, o.default.homeIdentity) || !same(c.default.rootIdentity, d.identity.directory) ||
      kept?.stage !== 'continued_uninstalled_data_retained' || kept.passed !== true || kept.continued_uninstalled !== true ||
      kept.run_id !== defaultOrigin.run || kept.attempt !== defaultOrigin.attempt || kept.artifact_id !== defaultOrigin.id || kept.head !== defaultOrigin.head ||
      kept.prior_backup !== o.backup.path || !same(kept.prior_backup_identity, o.backup.identity) ||
      kept.synthetic_backup !== path.win32.join(path.win32.dirname(c.default.root), '.trellis.ao-preserved-42779040248-2') || !same(kept.synthetic_backup_identity, original['default-startup.json'].identity.directory) ||
      !same(kept.current_root_identity, d.identity.directory) || kept.registration_absent !== true || kept.candidate_executables_absent !== true || kept.owners_current_user !== true || kept.owner_job_empty !== true ||
      JSON.stringify(c.previous_cleanup) !== JSON.stringify(kept) || c.backup !== undefined ||
      c.install_dir !== path.win32.join(path.win32.dirname(o.install_dir), 'Trellis 验收 42793967624-1') || !exactIdentity(c.install_identity) ||
      c.parents?.length !== o.parents.length || c.parents.some((parent, index) => parent.path !== o.parents[index].path || !same(parent.identity, o.parents[index].identity)) ||
      !['probe', 'no_overwrite', 'identity_refusal', 'same_identity', 'security_preserved'].every(key => c.preservation_probe?.[key] === true) ||
      !same(d.identity.home, c.default.homeIdentity)) fail('CANDIDATE_CONTINUATION_UNINSTALLED_UNCONFIRMED')
}
function restoreContinuation(archive, artifact, branch, environment, original) {
  validateContinuationMetadata(artifact, branch)
  const { values, extracted } = readFixedArchive(archive, artifact, environment, continuationEntries, continuationRequired)
  validateContinuationFacts(values, original)
  return { id: artifact.id, name: continuation.name, run_id: continuation.run, attempt: continuation.attempt, head: continuation.head, branch,
    ...persistFixedEvidence(extracted, continuationRequired, 'trellis-continuation-42793967624-1-'), archive_bytes: archive.length,
    files: ['host.json', 'candidate.json', 'default-startup.json', 'candidate-provenance.json'], source: 'fixed_uninstalled_attempt_artifact', facts_verified: true }
}

module.exports = { fixedParents, verifyLockedInputs, validateMetadata, validateFacts, restore, defaultOrigin, continuation, validateContinuationMetadata, validateContinuationRun, validateContinuationFacts, restoreContinuation }

// Fixed original-run evidence only. No general archive extraction or fallback
// to vanished RUNNER_TEMP records may authorize an installation cleanup.
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const fail = code => { throw Object.assign(Error(code), { code }) }
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
function validateMetadata(value, branch) {
  if (value?.id !== 13691230073 || value.name !== name || value.expired !== false || value.size_in_bytes !== 98036 ||
      value.workflow_run?.id !== prior || value.workflow_run.head_sha !== head || value.workflow_run.head_branch !== branch ||
      value.workflow_run.repository_id !== 1434252659 || value.workflow_run.head_repository_id !== 1434252659) fail('CANDIDATE_ARTIFACT_SOURCE_UNCONFIRMED')
}
const exactIdentity = value => typeof value?.dev === 'string' && /^[0-9]+$/.test(value.dev) && typeof value.ino === 'string' && /^[1-9][0-9]*$/.test(value.ino)
const same = (a, b) => exactIdentity(a) && exactIdentity(b) && a.dev === b.dev && a.ino === b.ino
function validateFacts(values) {
  const host = values['host.json'], candidate = values['candidate.json'], defaults = values['default-startup.json']
  if (host?.runner !== 'DESKTOP-SFE95TP' || host.standard_user_required !== true || host.elevated !== false || host.administrators_group_present !== false ||
      host.system_account !== false || host.user_interactive !== true || !Number.isInteger(host.session_id) || host.session_id <= 0 ||
      host.product_type !== 1 || host.architecture !== 'X64' || !host.caption?.includes('Windows 11') || !Number.isInteger(host.build) || host.build < 22000) fail('CANDIDATE_PREVIOUS_HOST_UNCONFIRMED')
  if (candidate?.stage !== 'installed' || candidate.passed !== true || candidate.install?.started !== true || candidate.install.exit !== 0 || candidate.install.signal !== null ||
      candidate.install.job_empty !== true || !exactIdentity(candidate.install_identity) || candidate.backup?.performed !== true || candidate.default?.absent !== false ||
      !same(candidate.backup.identity, candidate.default.rootIdentity) || candidate.preservation?.renamed !== true || candidate.preservation.same_identity !== true ||
      candidate.preservation.security_preserved !== true || candidate.preservation.source_absent !== true || !Array.isArray(candidate.parents) || !candidate.parents.length ||
      !candidate.parents.every(parent => typeof parent.path === 'string' && same(parent.identity, parent.identity)) ||
      !['probe', 'no_overwrite', 'identity_refusal', 'same_identity', 'security_preserved'].every(key => candidate.preservation_probe?.[key] === true)) fail('CANDIDATE_PREVIOUS_INSTALL_UNCONFIRMED')
  if (defaults?.passed !== true || defaults.stage !== 'ready' || defaults.installed_candidate !== true || defaults.application_launches !== 2 ||
      defaults.task_created !== true || defaults.task_and_settings_restored !== true || defaults.first_exit_confirmed !== true || defaults.final_exit_confirmed !== true ||
      !same(defaults.identity?.home, candidate.default.homeIdentity) || !exactIdentity(defaults.identity?.directory) || defaults.formats?.restore !== 'restore-v5' || defaults.formats.gc !== 'gc-v1' ||
      defaults.maintenance?.ok !== true || defaults.maintenance.data?.phase !== 'idle' || defaults.maintenance.data.error !== null ||
      defaults.maintenance.data.restore?.error !== null || defaults.maintenance.data.gc?.enabled !== true || defaults.maintenance.data.gc.error !== null ||
      defaults.exits?.length !== 2 || !defaults.exits.every(exit => exit.wrapper_exit_code === 0 && exit.main_exit_confirmed === true && exit.utility_exit_confirmed === true && exit.observed_utility_count > 0)) fail('CANDIDATE_PREVIOUS_DEFAULT_UNCONFIRMED')
  const env = defaults.actual_environment
  if (!env || !['default_user_data', 'actual_home_preserved', 'home_environment_preserved', 'userprofile_environment_preserved', 'all_trellis_keys_absent'].every(key => env[key] === true) ||
      !['test_data_present', 'identity_override_present', 'electron_node_present', 'renderer_url_present', 'node_options_present'].every(key => env[key] === false) ||
      env.path_state !== 'absent' || env.path_key_count !== 0) fail('CANDIDATE_PREVIOUS_ENVIRONMENT_UNCONFIRMED')
}
function restore(archive, artifact, branch, environment) {
  validateMetadata(artifact, branch)
  if (!Buffer.isBuffer(archive) || archive.length !== artifact.size_in_bytes) fail('CANDIDATE_ARTIFACT_SIZE_UNCONFIRMED')
  // ZipArchive reads only the three named JSON entries. Never extract paths or
  // open other entry contents, including old business data and screenshots.
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression; ` +
    `$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $stream=[IO.MemoryStream]::new($bytes,$false); ` +
    `$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Read); ` +
    `$allowed=@(${entries.map(value => "'" + value + "'").join(',')}); $required=@(${required.map(value => "'" + value + "'").join(',')}); ` +
    `$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal); $result=[ordered]@{}; ` +
    `try { if($zip.Entries.Count -ne $allowed.Count){throw 'ENTRY_COUNT'}; foreach($entry in $zip.Entries){ ` +
    `if(-not ($allowed -ccontains $entry.FullName) -or -not $seen.Add($entry.FullName) -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'ENTRY_UNSAFE'}; ` +
    `if($required -ccontains $entry.FullName){if($entry.Length -le 0 -or $entry.Length -gt 32768){throw 'ENTRY_SIZE'}; ` +
    `$reader=[IO.StreamReader]::new($entry.Open(),[Text.UTF8Encoding]::new($false,$true),$false); try{$text=$reader.ReadToEnd()}finally{$reader.Dispose()}; ` +
    `if([Text.Encoding]::UTF8.GetByteCount($text) -gt 32768){throw 'ENTRY_SIZE'}; $result[$entry.FullName]=$text} }; ` +
    `if($result.Count -ne 3){throw 'ENTRY_MISSING'}; $result|ConvertTo-Json -Compress } finally{$zip.Dispose();$stream.Dispose()}`
  let extracted
  try {
    const output = cp.execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { input: archive.toString('base64'), env: environment,
        encoding: 'utf8', timeout: 10000, maxBuffer: 262144, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    extracted = JSON.parse(output)
  } catch { fail('CANDIDATE_ARTIFACT_JSON_EXTRACTION_FAILED') }
  if (!extracted || Object.keys(extracted).length !== 3 || !required.every(key => typeof extracted[key] === 'string' && Buffer.byteLength(extracted[key]) <= 32768)) fail('CANDIDATE_ARTIFACT_JSON_UNCONFIRMED')
  const values = {}
  for (const key of required) {
    try { values[path.basename(key)] = JSON.parse(extracted[key]) } catch { fail('CANDIDATE_ARTIFACT_JSON_INVALID') }
  }
  validateFacts(values)
  const temp = fs.lstatSync(process.env.RUNNER_TEMP)
  if (!temp.isDirectory() || temp.isSymbolicLink()) fail('CANDIDATE_ARTIFACT_TEMP_UNSAFE')
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'trellis-prior-42649802869-'))
  for (const key of required) fs.writeFileSync(path.join(directory, path.basename(key)), extracted[key], { flag: 'wx', encoding: 'utf8' })
  const stat = fs.lstatSync(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CANDIDATE_ARTIFACT_TEMP_UNSAFE')
  return { id: artifact.id, name, run_id: prior, head, branch, directory, identity: { dev: String(stat.dev), ino: String(stat.ino) },
    archive_bytes: archive.length, files: ['host.json', 'candidate.json', 'default-startup.json'], source: 'fixed_original_run_artifact', facts_verified: true }
}
module.exports = { validateMetadata, validateFacts, restore }

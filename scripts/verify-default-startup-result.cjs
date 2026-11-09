const fs = require('node:fs')
const path = require('node:path')

// A missing/skipped test or a caught application error must keep the job red.
const root = path.join(process.env.TRELLIS_WIN11_EVIDENCE, 'default-desktop')
const rootStat = fs.lstatSync(root)
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('DEFAULT_STARTUP_EVIDENCE_REPARSE')
const files = []
function find(directory, depth) {
  if (depth > 2) throw Error('DEFAULT_STARTUP_EVIDENCE_DEPTH')
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  if (entries.length > 32) throw Error('DEFAULT_STARTUP_EVIDENCE_LIMIT')
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw Error('DEFAULT_STARTUP_EVIDENCE_REPARSE')
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) find(file, depth + 1)
    else if (entry.name === 'default-startup.json') files.push(file)
  }
}
find(root, 0)
if (files.length !== 1 || fs.statSync(files[0]).size > 16384) throw Error('DEFAULT_STARTUP_RESULT_UNCONFIRMED')
const report = JSON.parse(fs.readFileSync(files[0], 'utf8'))
const expected = { default_user_data: true, actual_home_preserved: true, home_environment_preserved: true,
  userprofile_environment_preserved: true, path_has_no_entries: true, path_entry_count: 0, test_data_present: false, identity_override_present: false,
  electron_node_present: false, renderer_url_present: false, all_trellis_keys_absent: true, node_options_present: false }
const identities = [report.identity?.home, report.identity?.directory]
const validEnvironment = value => Object.entries(expected).every(([key, required]) => value?.[key] === required) &&
  (value.path_state === 'absent' && value.path_key_count === 0 || value.path_state === 'empty' && value.path_key_count === 1) &&
  value.empty_path === (value.path_state === 'empty')
if (report.passed !== true || report.stage !== 'ready' || report.error || report.cleanup_error ||
    report.application_tests !== 1 || report.application_launch_attempts !== 2 || report.application_launches !== 2 ||
    report.default_directory_absent_before_launch !== true || report.named_processes_before_launch !== 0 ||
    report.default_directory_created !== true || report.directory_cleanup_performed !== false ||
    report.task_created !== true || report.task_and_settings_restored !== true ||
    report.first_exit_confirmed !== true || report.final_exit_confirmed !== true ||
    report.foreign_instances_observed !== false ||
    identities.some(value => typeof value?.dev !== 'string' || typeof value?.ino !== 'string' ||
      !/^(0|[1-9][0-9]{0,19})$/.test(value.dev) || !/^[1-9][0-9]{0,19}$/.test(value.ino)) ||
    !validEnvironment(report.actual_environment) ||
    !Array.isArray(report.launch_environments) || report.launch_environments.length !== 2 ||
    report.launch_environments.some(environment => !validEnvironment(environment)) ||
    !Number.isInteger(report.process_identity?.main_pid) || report.process_identity.main_pid <= 0 ||
    !Array.isArray(report.exits) || report.exits.length !== 2 || report.exits.some(value =>
      value.main_exit_confirmed !== true || value.utility_exit_confirmed !== true || value.wrapper_exit_code !== 0 ||
      !Number.isInteger(value.main_pid) || value.main_pid <= 0 || !Number.isInteger(value.observed_utility_count) || value.observed_utility_count <= 0) ||
    report.formats?.restore !== 'restore-v5' || report.formats?.gc !== 'gc-v1' ||
    report.maintenance?.ok !== true || report.maintenance.data?.phase !== 'idle' || report.maintenance.data.error !== null ||
    report.maintenance.data.restore?.error !== null || report.maintenance.data.gc?.enabled !== true || report.maintenance.data.gc.error !== null) {
  throw Error('DEFAULT_STARTUP_ACCEPTANCE_INCOMPLETE')
}
console.log('DEFAULT_STARTUP_ACCEPTANCE ' + JSON.stringify({ passed: true, application_tests: 1, launches: 2, directory_preserved: true }))
module.exports = report

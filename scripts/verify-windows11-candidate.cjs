const fs = require('node:fs'), path = require('node:path')
const root = process.env.TRELLIS_WIN11_EVIDENCE
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
function result(folder, filename = 'candidate-business.json') {
  const found = []
  function visit(directory, depth = 0) {
    if (depth > 2) throw Error('CANDIDATE_RESULT_DEPTH')
    const entries = fs.readdirSync(directory, { withFileTypes: true })
    if (entries.length > 32) throw Error('CANDIDATE_RESULT_LIMIT')
    for (const item of entries) {
      if (item.isSymbolicLink()) throw Error('CANDIDATE_RESULT_REPARSE')
      const file = path.join(directory, item.name)
      if (item.isDirectory()) visit(file, depth + 1)
      else if (item.name === filename) found.push(file)
    }
  }
  visit(path.join(root, folder))
  if (found.length !== 1 || fs.statSync(found[0]).size > 32768) throw Error('CANDIDATE_RESULT_MISSING')
  return read(found[0])
}
const state = read(path.join(root, 'candidate.json'))
require('./verify-default-startup-result.cjs')
if (result('default-desktop', 'default-startup.json').installed_candidate !== true) throw Error('CANDIDATE_DEFAULT_NOT_INSTALLED')
const runtime = read(path.join(root, 'installed-runtime.json'))
const business = result('candidate-business'), reinstalled = result('candidate-reinstalled')
if (state.passed !== true || state.stage !== 'reinstalled' || state.data_preserved !== true ||
    !['probe', 'no_overwrite', 'identity_refusal', 'same_identity', 'security_preserved'].every(key => state.preservation_probe?.[key] === true) ||
    !['install', 'uninstall', 'reinstall'].every(key => state[key]?.exit === 0 && state[key]?.job_empty === true) ||
    (state.backup && (state.backup.performed !== true || state.preservation?.security_preserved !== true || state.preservation?.same_identity !== true)) ||
    runtime.installed !== true || runtime.passed !== true ||
    !['sqlite', 'montyBinding', 'privateAcl', 'appNodeRpc', 'descendantsReaped', 'pdfBackend', 'offlinePdf'].every(key => runtime[key] === true) ||
    !['material_imported', 'plugin_called', 'pdf_extracted', 'export_saved', 'recovery_restored'].every(key => business[key] === true)) throw Error('CANDIDATE_ACCEPTANCE_INCOMPLETE')
for (const [index, report] of [business, reinstalled].entries()) {
  if (report.passed !== true || report.stage !== 'ready' || report.installed !== true || report.error || report.cleanup_error ||
      report.reinstalled !== (index === 1) ||
      report.state_restored !== true || report.no_replay !== true || report.real_api_requests !== 0 || report.environment_confirmed !== true ||
      !Array.isArray(report.acl_errors) || report.acl_errors.length || report.application_launches !== (index === 0 ? 2 : 1) ||
      !Array.isArray(report.exits) || report.exits.length !== report.application_launches ||
      report.exits.some(exit => exit.main_exit_confirmed !== true || exit.utility_exit_confirmed !== true || exit.utility_count < 1 || exit.wrapper_exit_code !== 0)) throw Error('CANDIDATE_BUSINESS_OR_EXIT_INCOMPLETE')
}
if (process.env.TRELLIS_CANDIDATE_DEFAULT_REUSED === '1') {
  const kept = state.continuation
  for (const [file, expected] of [[kept.prior_backup, kept.prior_backup_identity], [kept.synthetic_backup, kept.synthetic_backup_identity], [state.default.root, kept.current_root_identity]]) {
    const stat = fs.lstatSync(file, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino) throw Error('CANDIDATE_PRESERVED_DIRECTORY_CHANGED')
  }
}
console.log(JSON.stringify({ passed: true, installed_runtime: true, default_startup: true, default_startup_source: process.env.TRELLIS_CANDIDATE_DEFAULT_REUSED === '1' ? '42779040248-attempt2' : 'current_run', synthetic_business: true, uninstall_data_retained: true, same_version_reinstall: true, published: false }))

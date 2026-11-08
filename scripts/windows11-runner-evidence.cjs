const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.RUNNER_NAME !== 'DESKTOP-SFE95TP') {
  throw Error('DESIGNATED_WINDOWS_X64_RUNNER_REQUIRED')
}
const evidence = process.env.TRELLIS_WIN11_EVIDENCE
const incident = Date.parse(process.env.TRELLIS_RUNNER_INCIDENT_UTC)
if (!evidence || !path.isAbsolute(evidence) || !Number.isFinite(incident)) throw Error('RUNNER_INCIDENT_REQUIRED')
const start = new Date(incident - 120000), end = new Date(incident + 120000)
const report = { start: start.toISOString(), end: end.toISOString(), cause: 'unknown', runner_events: [], system: null }
const patterns = [
  ['ctrl_c', /ctrl[ -]?c|control[ -]?c/i],
  ['termination_signal', /SIGTERM|termination signal/i],
  ['shutdown', /shutdown|shut down/i],
  ['runner_update_related', /self.?updat|runner updat|updat.{0,20}runner/i],
  ['service_stop', /service.{0,40}stop|stop.{0,40}service/i],
  ['listener_exit', /listener.{0,30}exit|exit.{0,30}return code/i]
]

// Only bounded tails of Runner_*.log are inspected. No Worker logs, credential
// files, command lines, raw diagnostic messages, or full environment are saved.
try {
  const directory = path.resolve(process.env.RUNNER_TEMP, '../../_diag')
  const files = fs.readdirSync(directory).filter(name => /^Runner_\d{8}-\d{6}.*\.log$/.test(name)).sort().slice(-4)
  for (const name of files) {
    const file = path.join(directory, name), stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < start.getTime()) continue
    const length = Math.min(stat.size, 2 * 1024 * 1024), buffer = Buffer.alloc(length)
    const descriptor = fs.openSync(file, 'r')
    try { fs.readSync(descriptor, buffer, 0, length, stat.size - length) } finally { fs.closeSync(descriptor) }
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      const match = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/.exec(line)
      if (!match) continue
      const time = Date.parse(match[1].replace(' ', 'T'))
      if (time < start.getTime() || time > end.getTime()) continue
      const event = patterns.find(([, pattern]) => pattern.test(line))?.[0]
      if (event) report.runner_events.push({ file: name, time: new Date(time).toISOString(), event })
    }
  }
} catch (error) { report.runner_log_error = error.code || 'UNAVAILABLE' }

try {
  const command = `
    $ErrorActionPreference = 'Stop';
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false;
    $services = @(Get-CimInstance Win32_Service | Where-Object { $_.Name -like 'actions.runner.*' } | ForEach-Object { [ordered]@{ name=$_.Name; state=$_.State } });
    $events = @(); $eventQuery = 'ok';
    try {
      $events = @(Get-WinEvent -FilterHashtable @{ LogName='System'; ProviderName='Service Control Manager'; StartTime=[datetime]'${start.toISOString()}'; EndTime=[datetime]'${end.toISOString()}' } -ErrorAction Stop |
        Where-Object { $_.Message -match 'actions\\.runner|GitHub Actions Runner' } |
        ForEach-Object { [ordered]@{ time=$_.TimeCreated.ToUniversalTime().ToString('o'); event_id=$_.Id; category='runner_service_event' } });
    } catch { $eventQuery = if ($_.FullyQualifiedErrorId -match 'NoMatchingEventsFound') { 'no_matching_events' } else { 'unavailable' } }
    [ordered]@{ services=$services; events=$events; event_query=$eventQuery } | ConvertTo-Json -Depth 4 -Compress
  `
  report.system = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }).replace(/^\uFEFF/, ''))
} catch (error) { report.system_error = error.code || 'UNAVAILABLE' }

fs.writeFileSync(path.join(evidence, 'runner-shutdown-evidence.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))

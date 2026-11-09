import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createRequire } from 'node:module'
// @ts-expect-error Standalone package structure verifier.
import { verifyDesktop } from '../../scripts/verify-desktop.mjs'

const defaultData = createRequire(import.meta.url)('../../scripts/windows11-default-data.cjs')
const safeCode = (error: unknown): string => {
  const value = error as { code?: string; message?: string; name?: string } | null | undefined
  return value?.code?.match(/^[A-Z0-9_]{1,64}$/)?.[0] ??
    value?.message?.match(/\b(?:DEFAULT|RESTORE|GC|SETTINGS|FILE|RUNTIME)_[A-Z0-9_]{1,56}\b/)?.[0] ??
    (value?.name === 'TimeoutError' ? 'TIMEOUT' : 'ASSERTION_OR_STARTUP_FAILED')
}
const healthy = { ok: true, data: { phase: 'idle', error: null, restore: { error: null }, gc: { enabled: true, error: null } } }

test('uses the real fresh default directory and preserves a task and local settings across restart', async () => {
  test.skip(process.env.TRELLIS_WINDOWS11_DEFAULT_STARTUP !== '1', 'Requires the explicit designated-host default-startup workflow')
  if (process.env.TRELLIS_WINDOWS11_DEFAULT_STARTUP !== '1' || process.platform !== 'win32' || !process.env.TRELLIS_PACKAGED_OUTPUT) throw Error('DEFAULT_STARTUP_EXPLICIT_WINDOWS_MODE_REQUIRED')
  const candidateMode = process.env.TRELLIS_WINDOWS11_CANDIDATE === '1'
  const { executable } = candidateMode ? await createRequire(import.meta.url)('../../scripts/windows11-candidate.cjs').installed() : verifyDesktop(process.env.TRELLIS_PACKAGED_OUTPUT)
  if (basename(executable).toLowerCase() !== 'trellis.exe') throw Error('DEFAULT_STARTUP_FINAL_EXECUTABLE_REQUIRED')
  const report: Record<string, any> = { stage: 'prelaunch', passed: false, application_tests: 0,
    application_launch_attempts: 0, application_launches: 0, default_directory_created: null,
    directory_cleanup_performed: false, isolated_working_directory: true, installed_candidate: candidateMode }
  const output = test.info().outputPath('default-startup.json')
  const cwd = await mkdtemp(join(tmpdir(), 'trellis-default-startup-cwd-'))
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'RUNNER_TRACKING_ID'])
  // Case folding is required on Windows. The GUI environment contains no
  // data/format override, renderer URL, Electron node flag, or credentials.
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase()) && value !== undefined) environment[key] = value
  environment.PATH = ''
  let app: ElectronApplication | undefined, page: Page | undefined, previous: any, owned: any
  let failure: string | undefined, mainPid: number | undefined
  let utilityPids: number[] = []
  const absent = (pid: number | undefined): boolean | null => {
    if (!Number.isInteger(pid) || !pid) return null
    try { process.kill(pid, 0); return false }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? true : null }
  }
  const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
  async function maintenance(): Promise<any> {
    const value = await page!.evaluate(() => window.trellis.request({ type: 'maintenance.status' }))
    const result = value as any
    report.maintenance = result.ok ? { ok: true, data: { phase: result.data.phase, error: result.data.error,
      restore: { error: result.data.restore?.error }, gc: { enabled: result.data.gc?.enabled, error: result.data.gc?.error } } } :
      { ok: false, error: { code: result.error?.code ?? 'MAINTENANCE_QUERY_FAILED' } }
    return value
  }
  async function marker(name: string): Promise<string> {
    await defaultData.verifyIdentity(owned)
    const file = join(owned.root, name), before = await lstat(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n) throw Error('DEFAULT_FORMAT_MARKER_UNCONFIRMED')
    const handle = await open(file, 'r')
    try {
      const actual = await handle.stat({ bigint: true })
      if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) throw Error('DEFAULT_FORMAT_MARKER_CHANGED')
      const buffer = Buffer.alloc(Number(actual.size)), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead !== buffer.length) throw Error('DEFAULT_FORMAT_MARKER_CHANGED')
      return buffer.toString('utf8').trim()
    } finally { await handle.close() }
  }
  async function launch(): Promise<void> {
    mainPid = undefined; utilityPids = []
    delete report.process_identity; delete report.actual_environment
    delete report.maintenance; delete report.maintenance_capture
    report.stage = 'launch'; report.application_tests = 1; report.application_launch_attempts++
    app = await electron.launch({ executablePath: executable, args: [], cwd, env: environment })
    report.application_launches++
    page = await app.firstWindow()
    report.stage = 'environment'
    const facts = await app.evaluate(({ app }, expected) => {
      const keys = new Set(Object.keys(process.env).map(key => key.toUpperCase()))
      const inherited = (key: string) => Object.entries(process.env).find(([name]) => name.toUpperCase() === key)?.[1]
      const pathKeys = Object.keys(process.env).filter(key => key.toUpperCase() === 'PATH')
      const pathValue = pathKeys.length === 1 ? process.env[pathKeys[0]!] : undefined
      const pathState = pathKeys.length === 0 ? 'absent' : pathKeys.length !== 1 ? 'ambiguous' :
        pathValue === '' ? 'empty' : typeof pathValue === 'string' ? 'nonempty' : 'unknown'
      return { main_pid: process.pid, utility_pids: app.getAppMetrics().filter(m => m.type === 'Utility').map(m => m.pid), environment: {
        default_user_data: app.getPath('userData').toLowerCase() === expected.root.toLowerCase(),
        actual_home_preserved: app.getPath('home').toLowerCase() === expected.home.toLowerCase(),
        home_environment_preserved: inherited('HOME') === expected.homeEnv,
        userprofile_environment_preserved: inherited('USERPROFILE') === expected.profileEnv,
        empty_path: pathState === 'empty', path_state: pathState, path_key_count: pathKeys.length,
        path_entry_count: typeof pathValue === 'string' ? pathValue.split(';').filter(entry => entry !== '').length : 0,
        path_has_no_entries: pathState === 'absent' || pathState === 'empty',
        test_data_present: keys.has('TRELLIS_TEST_DATA'), identity_override_present: keys.has('TRELLIS_TEST_FILE_IDENTITIES'),
        electron_node_present: keys.has('ELECTRON_RUN_AS_NODE'), renderer_url_present: keys.has('ELECTRON_RENDERER_URL'),
        all_trellis_keys_absent: ![...keys].some(key => key.startsWith('TRELLIS_')), node_options_present: keys.has('NODE_OPTIONS')
      } }
    }, { root: previous.root, home: previous.root.slice(0, -'\\.trellis'.length),
      homeEnv: Object.entries(process.env).find(([name]) => name.toUpperCase() === 'HOME')?.[1],
      profileEnv: Object.entries(process.env).find(([name]) => name.toUpperCase() === 'USERPROFILE')?.[1] })
    const actual = facts.environment
    mainPid = facts.main_pid; utilityPids = facts.utility_pids
    report.process_identity = { main_pid: mainPid, wrapper_pid: app.process().pid }
    report.actual_environment = actual
    report.launch_environments ??= []; report.launch_environments.push(actual)
    report.stage = 'observe_directory'
    // On Windows Playwright uses a cmd wrapper. Ownership must use Electron's
    // own process.pid, never app.process().pid.
    owned = await defaultData.observeCreated(previous, mainPid)
    report.default_directory_created = true
    report.identity = { home: owned.homeIdentity, directory: owned.rootIdentity }
    report.foreign_instances_observed = false
    report.stage = 'environment'
    expect(actual).toMatchObject({ default_user_data: true, actual_home_preserved: true, home_environment_preserved: true,
      userprofile_environment_preserved: true, path_has_no_entries: true, path_entry_count: 0,
      test_data_present: false, identity_override_present: false, electron_node_present: false, renderer_url_present: false,
      all_trellis_keys_absent: true, node_options_present: false })
    expect(page.url().startsWith('file:')).toBe(true)
    report.stage = 'maintenance'
    await expect.poll(maintenance, { timeout: 15000, intervals: [100, 250, 500] }).toMatchObject(healthy)
    report.formats = { restore: await marker('restore-established'), gc: await marker('gc-established') }
    expect(report.formats).toEqual({ restore: 'restore-v5', gc: 'gc-v1' })
  }
  async function closeWindow(): Promise<void> {
    const wrapper = app!.process()
    utilityPids = await app!.evaluate(({ app }) => app.getAppMetrics().filter(m => m.type === 'Utility').map(m => m.pid))
    expect(utilityPids.length).toBeGreaterThan(0)
    await page!.close()
    await expect.poll(() => wrapper.exitCode).toBe(0)
    await expect.poll(() => absent(mainPid)).toBe(true)
    await expect.poll(() => utilityPids.map(pid => absent(pid))).toEqual(utilityPids.map(() => true))
    report.exits ??= []
    report.exits.push({ main_pid: mainPid, wrapper_exit_code: wrapper.exitCode, main_exit_confirmed: true,
      observed_utility_count: utilityPids.length, utility_exit_confirmed: true })
    await app!.close(); app = undefined; page = undefined
  }
  try {
    // Recheck immediately before launch. The application alone creates .trellis.
    previous = await defaultData.beforeFirstLaunch()
    report.default_directory_absent_before_launch = true; report.named_processes_before_launch = previous.processCount
    await launch()
    report.stage = 'task'
    await page!.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page!.getByLabel('任务名称').fill('默认启动验收')
    await page!.getByRole('button', { name: '创建任务', exact: true }).click()
    await expect(page!.getByRole('button', { name: /默认启动验收/ })).toBeVisible()
    report.task_created = true; report.stage = 'settings'
    await page!.keyboard.press('ControlOrMeta+,')
    await page!.getByRole('button', { name: '外观', exact: true }).click()
    await page!.getByRole('radio', { name: '110%', exact: true }).check()
    await page!.keyboard.press('Escape')
    await closeWindow()
    report.first_exit_confirmed = true; report.stage = 'restart'
    previous = await defaultData.beforeRestart(owned)
    await launch()
    await expect(page!.getByRole('button', { name: /默认启动验收/ })).toBeVisible()
    expect(await page!.evaluate(() => document.documentElement.style.getPropertyValue('--text-scale'))).toBe('1.1')
    report.task_and_settings_restored = true
    await page!.screenshot({ path: test.info().outputPath('default-startup.png') })
    report.stage = 'exit'
    await closeWindow()
    await defaultData.beforeRestart(owned)
    report.final_exit_confirmed = true; report.passed = true; report.stage = 'ready'
  } catch (error) {
    failure = safeCode(error); report.error = failure; report.failed_stage = report.stage
    report.stage = report.application_tests === 0 ? 'blocked_environment' : 'failed_application'
    if (page && !page.isClosed()) {
      await page.screenshot({ path: test.info().outputPath('default-startup-failure.png') }).catch(() => {})
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([maintenance(), new Promise(resolve => { timer = setTimeout(() => {
          report.maintenance_capture = { timeout: true }; resolve(undefined)
        }, 1500) })])
      } catch (error) { report.maintenance_capture = { error: safeCode(error) } }
      finally { clearTimeout(timer) }
    }
    if (owned) {
      // Only the new root created in this test is inspected. No prior user
      // content is read. Exact metadata helps distinguish legacy precision
      // rejection from unrelated generic maintenance errors.
      report.created_file_identities = {}
      for (const name of ['', 'restore-control.sqlite', 'export-control.sqlite', 'gc-control.sqlite']) {
        try {
          const stat = await lstat(join(owned.root, name), { bigint: true })
          report.created_file_identities[name || 'root'] = { dev: String(stat.dev), ino: String(stat.ino),
            legacy_safe: stat.dev <= BigInt(Number.MAX_SAFE_INTEGER) && stat.ino <= BigInt(Number.MAX_SAFE_INTEGER) }
        } catch (error) { report.created_file_identities[name || 'root'] = { error: safeCode(error) } }
      }
      report.formats_observed_after_failure = {}
      for (const name of ['restore-established', 'gc-established']) {
        try { report.formats_observed_after_failure[name] = await marker(name) }
        catch (error) { report.formats_observed_after_failure[name] = { error: safeCode(error) } }
      }
    }
  } finally {
    if (app) {
      const wrapper = app.process()
      let currentUtilitySnapshot = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const metrics = await Promise.race([app.evaluate(({ app }) => app.getAppMetrics().filter(m => m.type === 'Utility').map(m => m.pid)),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1000) })])
        if (metrics) { utilityPids = metrics; currentUtilitySnapshot = true }
      } catch (error) { report.exit_capture_error = safeCode(error) }
      finally { clearTimeout(timer) }
      try { await app.close() }
      catch (error) { report.cleanup_error = safeCode(error); failure ??= report.cleanup_error; report.passed = false }
      report.failure_exit = { main_pid: mainPid ?? null, wrapper_exit_code: wrapper.exitCode,
        main_exit_confirmed: absent(mainPid), observed_utility_count: utilityPids.length,
        utility_snapshot_current: currentUtilitySnapshot,
        utility_exit_confirmed: currentUtilitySnapshot && utilityPids.length ? utilityPids.every(pid => absent(pid) === true) : null }
    }
    // Only the unrelated test cwd is removed. Real default data is preserved.
    await rm(cwd, { recursive: true, force: true })
    await save()
  }
  if (failure) throw Error('DEFAULT_STARTUP_' + failure)
})

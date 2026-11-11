import Database from 'better-sqlite3'
import { lstatSync,mkdirSync,readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync,entryExistsSync as existsSync,flushDirectorySync,flushFileSync,managedFile,managedRegularFile,readRegularFileSync } from '../../platform/files'
import { protectPrivatePath } from '../../platform/permissions'
import { ContractError } from '../../shared/validation'
import { copyPluginPackage,validatePluginCopy,verifyPluginCopy,type PluginCopy } from './package'
import { pluginCapabilities } from './process'
import { buildEnablePlan,unavailableDependencies,type Enablement,type EnablePlan,type Workflow } from './selection'

type Trust = { digest: string; granted_at: string; revoked_at: string | null }
export type PluginControlState = { version: 1; packages: PluginCopy[]; trusts: Trust[]; enabled: Enablement[]; workflows: Workflow[] }
const fail = (): never => { throw new ContractError('PLUGIN_CONTROL_INVALID', 'Plugin authority is unavailable; no package may be loaded or executed') }
const digestPattern = /^[a-f0-9]{64}$/
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
export function validatePluginControl(value: unknown): asserts value is PluginControlState {
  const state = value as PluginControlState
  if (!state || Object.keys(state).sort().join(',') !== 'enabled,packages,trusts,version,workflows' || state.version !== 1 || !Array.isArray(state.packages) || !Array.isArray(state.trusts) || !Array.isArray(state.enabled) || !Array.isArray(state.workflows) || state.packages.length > 512 || state.trusts.length > 10000 || state.enabled.length > 10000 || state.workflows.length > 10000) fail()
  for (const copy of state.packages) validatePluginCopy(copy)
  const packages = new Set(state.packages.map(copy => copy.digest))
  if (packages.size !== state.packages.length) fail()
  for (const trust of state.trusts) if (!trust || Object.keys(trust).sort().join(',') !== 'digest,granted_at,revoked_at' || !digestPattern.test(trust.digest) || !packages.has(trust.digest) || !time(trust.granted_at) || (trust.revoked_at !== null && !time(trust.revoked_at))) fail()
  if (new Set(state.trusts.filter(t => t.revoked_at === null).map(t => t.digest)).size !== state.trusts.filter(t => t.revoked_at === null).length) fail()
  const tasks = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
  const scopes = new Set<string>()
  for (const e of state.enabled) {
    const copy = state.packages.find(p => p.digest === e?.digest)
    if (!e || Object.keys(e).sort().join(',') !== 'digest,task_id' || !copy || (copy.manifest.access_level === 'global' ? e.task_id !== null : typeof e.task_id !== 'string' || !tasks.test(e.task_id))) fail()
    if (!copy) return fail()
    const key = `${e.task_id}:${copy.manifest.id}`
    if (scopes.has(key)) fail(); scopes.add(key)
    if (copy.manifest.backend && !state.trusts.some(t => t.digest === e.digest && t.revoked_at === null)) fail()
  }
  for (const w of state.workflows) {
    if (!w || Object.keys(w).sort().join(',') !== 'contribution_id,digest,task_id' || typeof w.task_id !== 'string' || !tasks.test(w.task_id) || !state.enabled.some(e => e.digest === w.digest && (e.task_id === null || e.task_id === w.task_id)) || !state.packages.find(p => p.digest === w.digest)?.manifest.contributes.some(c => c.kind === 'workflow' && c.id === w.contribution_id)) fail()
  }
  if (new Set(state.workflows.map(w => w.task_id)).size !== state.workflows.length) fail()
}

function regular(file: string): void {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail()
}
function flush(root: string, name: string): void {
  flushFileSync(managedFile(root, name))
  flushDirectorySync(root)
}

// This authority lives outside the restorable business database. Callers hold the directory owner lock.
export class PluginControl {
  private db?: Database.Database
  private state: PluginControlState = { version: 1, packages: [], trusts: [], enabled: [], workflows: [] }
  private blocked = false
  private revision = 0
  readonly error: string | null
  constructor(private root: string) {
    let error: string | null = null
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 })
      if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail()
      const file = managedRegularFile(root, 'plugin-control.sqlite'), marker = join(root, 'plugin-established'), folder = join(root, 'plugins')
      const present = existsSync(file)
      if (existsSync(marker)) { regular(marker); if (readRegularFileSync(marker, 32).toString('utf8') !== 'plugin-v1\n' || !present) fail() }
      if (existsSync(folder)) { if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) fail(); if (!present && readdirSync(folder).some(name => !/^pending-[a-f0-9-]{36}$/.test(name))) fail() }
      if (present) regular(file)
      this.db = new Database(file)
      this.db.pragma('busy_timeout=0'); this.db.pragma('journal_mode=DELETE'); this.db.pragma('synchronous=FULL'); protectPrivatePath(file, 'file')
      if (!present) {
        this.db.exec('CREATE TABLE plugin_control (id INTEGER PRIMARY KEY CHECK(id=1), manifest TEXT NOT NULL)')
        this.db.prepare('INSERT INTO plugin_control VALUES (1,?)').run(JSON.stringify(this.state))
      }
      const size = this.db.prepare('SELECT length(CAST(manifest AS BLOB)) bytes FROM plugin_control WHERE id=1').get() as { bytes: number } | undefined
      if (!size || !Number.isSafeInteger(size.bytes) || size.bytes > 64 * 1024 * 1024) fail()
      const row = this.db.prepare('SELECT manifest FROM plugin_control WHERE id=1').get() as { manifest: string } | undefined
      const parsed: unknown = row && JSON.parse(row.manifest)
      validatePluginControl(parsed); this.state = parsed
      flush(root, 'plugin-control.sqlite')
      if (!existsSync(marker)) { atomicWriteFileSync(marker, 'plugin-v1\n') }
    } catch { error = 'PLUGIN_CONTROL_INVALID'; this.blocked = true }
    this.error = error
  }
  private assertOpen(): void { if (this.blocked || !this.db?.open) fail() }
  private save(next: PluginControlState): void {
    this.assertOpen(); validatePluginControl(next)
    const body = JSON.stringify(next)
    if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new ContractError('PLUGIN_CONTROL_LIMIT', 'Plugin control limit reached; existing records were retained')
    try { this.db!.transaction(() => this.db!.prepare('UPDATE plugin_control SET manifest=? WHERE id=1').run(body))() }
    catch { this.blocked = true; fail() }
    this.state = next; this.revision++
  }
  list(): PluginCopy[] { this.assertOpen(); return structuredClone(this.state.packages) }
  get(digest: string): PluginCopy {
    this.assertOpen()
    const copy = this.state.packages.find(p => p.digest === digest)
    if (!copy) throw new ContractError('PLUGIN_NOT_INSTALLED', 'Select an installed package version')
    return structuredClone(copy)
  }
  async install(source: string): Promise<PluginCopy> {
    this.assertOpen()
    const copy = await copyPluginPackage(this.root, source)
    await pluginCapabilities(this.root, copy)
    this.assertOpen()
    if (!this.state.packages.some(p => p.digest === copy.digest)) this.save({ ...this.state, packages: [...this.state.packages, copy] })
    return structuredClone(copy)
  }
  trusted(digest: string): boolean { this.assertOpen(); this.get(digest); return this.state.trusts.some(t => t.digest === digest && t.revoked_at === null) }
  async grant(digest: string, confirmation: { local_code: boolean; cross_task: boolean }): Promise<void> {
    const copy = this.get(digest), revision = this.revision
    if (!copy.manifest.backend || !confirmation.local_code || (copy.manifest.access_level === 'global' && !confirmation.cross_task)) throw new ContractError('PLUGIN_TRUST_REQUIRED', 'A person must confirm local executable code and its declared access scope')
    await verifyPluginCopy(this.root, copy)
    this.assertOpen()
    if (revision !== this.revision) throw new ContractError('PLUGIN_CONFIGURATION_CHANGED', 'Plugin authority changed during verification; confirm again')
    if (!this.trusted(digest)) this.save({ ...this.state, trusts: [...this.state.trusts, { digest, granted_at: new Date().toISOString(), revoked_at: null }] })
  }
  revoke(digest: string): void {
    this.get(digest)
    const now = new Date().toISOString()
    const enabled = this.state.enabled.filter(e => e.digest !== digest)
    const next = { ...this.state, enabled, trusts: this.state.trusts.map(t => t.digest === digest && t.revoked_at === null ? { ...t, revoked_at: now } : t) }
    this.save({ ...next, workflows: next.workflows.filter(w => this.availableIn(next, w.task_id, w.digest)) })
  }
  configuration(task: string): { enabled: Enablement[]; workflow: Workflow | null } {
    this.assertOpen()
    return structuredClone({ enabled: this.state.enabled.filter(e => e.task_id === null || e.task_id === task), workflow: this.state.workflows.find(w => w.task_id === task) ?? null })
  }
  available(task: string, digest: string): boolean {
    this.assertOpen()
    return this.availableIn(this.state, task, digest)
  }
  private availableIn(state: PluginControlState, task: string, digest: string): boolean {
    const packages = new Map(state.packages.map(p => [p.digest, p]))
    const enabled = state.enabled.filter(e => e.task_id === null || e.task_id === task)
    const visiting = new Set<string>()
    const check = (candidate: PluginCopy): boolean => {
      if (!enabled.some(e => e.digest === candidate.digest) || (candidate.manifest.backend && !state.trusts.some(t => t.digest === candidate.digest && t.revoked_at === null)) || this.unsupported(candidate.digest).length) return false
      if (visiting.has(candidate.digest)) return false
      visiting.add(candidate.digest)
      const missing = unavailableDependencies(candidate, state.packages, state.enabled, task)
      if (missing.length) return false
      for (const dependency of candidate.manifest.dependencies?.filter(d => d.required) ?? []) {
        const target = enabled.map(e => packages.get(e.digest)!).find(p => p.manifest.id === dependency.plugin_id)
        if (!target || !check(target)) return false
      }
      visiting.delete(candidate.digest); return true
    }
    const copy = packages.get(digest)
    return !!copy && check(copy)
  }
  unsupported(digest: string): string[] {
    const requires = this.get(digest).manifest.requires
    // These are actual reverse-host interfaces, not permissions granted by a manifest.
    const capabilities = new Set(['host.describe', 'objects.list', 'objects.read', 'tools.call', 'tools.get', 'tools.cancel', 'actions.submit', 'actions.get', 'surface.stage', 'surface.commit', 'upload.begin', 'upload.chunk', 'upload.finish', 'upload.abort', 'execution.wait'])
    return [...(requires?.capabilities ?? []).filter(name => !capabilities.has(name)).map(name => 'capability:' + name), ...(requires?.render_profiles ?? []).filter(name => name !== 'managed-v1').map(name => 'render_profile:' + name)]
  }
  plan(task: string, digest: string, choices: string[] = []): EnablePlan {
    this.assertOpen()
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(task)) throw new ContractError('PLUGIN_TASK_INVALID', 'Select a current task')
    return buildEnablePlan(this.state.packages, this.state.enabled, task, digest, choices)
  }
  async enable(task: string, digest: string, choices: string[], fingerprint: string, confirmGlobal: boolean, idle: (task: string | null) => void): Promise<void> {
    const plan = this.plan(task, digest, choices), revision = this.revision
    if (fingerprint !== plan.fingerprint) throw new ContractError('PLUGIN_CONFIGURATION_CHANGED', 'Review the current dependency plan before confirming')
    for (const item of plan.packages) {
      if (this.unsupported(item.digest).length) throw new ContractError('PLUGIN_HOST_REQUIREMENT_UNAVAILABLE', 'The package requires host capabilities or render profiles that are not implemented')
      if (item.access_level === 'global' && !item.already_enabled && !confirmGlobal) throw new ContractError('PLUGIN_SCOPE_CONFIRMATION_REQUIRED', 'Confirm application-wide reading before enabling')
      const copy = this.get(item.digest)
      if (copy.manifest.backend && !this.trusted(item.digest)) throw new ContractError('PLUGIN_TRUST_REQUIRED', 'Confirm executable code before enabling')
      await verifyPluginCopy(this.root, copy)
    }
    this.assertOpen()
    if (revision !== this.revision) throw new ContractError('PLUGIN_CONFIGURATION_CHANGED', 'Plugin configuration changed during verification')
    const next = [...this.state.enabled]
    for (const item of plan.packages) {
      const scope = item.access_level === 'global' ? null : task
      idle(scope)
      const existing = next.find(e => e.task_id === scope && this.get(e.digest).manifest.id === item.plugin_id)
      if (existing && existing.digest !== item.digest) throw new ContractError('PLUGIN_VERSION_ENABLED', 'Disable the previous version explicitly before selecting another')
      if (!existing) next.push({ digest: item.digest, task_id: scope })
    }
    this.save({ ...this.state, enabled: next })
  }
  disable(digest: string, task: string | null): void {
    const copy = this.get(digest)
    if ((copy.manifest.access_level === 'global') !== (task === null)) throw new ContractError('PLUGIN_SCOPE_INVALID', 'Disable the plugin at its registered scope')
    const enabled = this.state.enabled.filter(e => !(e.digest === digest && e.task_id === task))
    const next = { ...this.state, enabled }
    this.save({ ...next, workflows: next.workflows.filter(w => this.availableIn(next, w.task_id, w.digest)) })
  }
  selectWorkflow(task: string, selection: { digest: string; contribution_id: string } | null, idle: (task: string | null) => void): void {
    this.assertOpen(); idle(task)
    if (selection) {
      const copy = this.get(selection.digest)
      if (!this.available(task, selection.digest) || !copy.manifest.contributes.some(c => c.kind === 'workflow' && c.id === selection.contribution_id)) throw new ContractError('PLUGIN_WORKFLOW_UNAVAILABLE', 'Choose an enabled workflow whose dependencies are ready')
    }
    this.save({ ...this.state, workflows: [...this.state.workflows.filter(w => w.task_id !== task), ...(selection ? [{ task_id: task, ...selection }] : [])] })
  }
  async executable(digest: string): Promise<PluginCopy> {
    const copy = this.get(digest), revision = this.revision
    if (!copy.manifest.backend || !this.trusted(digest)) throw new ContractError('PLUGIN_TRUST_REQUIRED', 'Executable code requires current user trust')
    await verifyPluginCopy(this.root, copy)
    this.assertOpen()
    if (revision !== this.revision || !this.trusted(digest)) throw new ContractError('PLUGIN_CONFIGURATION_CHANGED', 'Plugin authority changed; execution was not started')
    return copy
  }
  close(): void { this.blocked = true; this.revision++; this.db?.close() }
}

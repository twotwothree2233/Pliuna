import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PluginControl } from '../../src/runtime/plugins/control'
import type { PluginCopy } from '../../src/runtime/plugins/package'

let root: string, control: PluginControl, task: string
const idle = (): void => {}
async function install(id: string, options: { version?: string; dependencies?: { plugin_id: string; version_range: string; required: boolean }[]; global?: boolean; backend?: boolean; content?: string } = {}): Promise<PluginCopy> {
  const source = join(root, randomUUID()); await mkdir(source)
  await writeFile(join(source, 'entry.md'), options.content ?? 'isolated fixture')
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: '0.1', protocol_version: '0.1', id, version: options.version ?? '1.0.0', access_level: options.global ? 'global' : 'task', contributes: [{ id: 'flow', kind: 'workflow', entry: 'entry.md', description: 'fixture' }], ...(options.dependencies ? { dependencies: options.dependencies } : {}), ...(options.backend ? { backend: { command: 'node', args: [], entry: 'entry.md' } } : {}) }))
  return control.install(source)
}
const dep = (id: string, range = '^1.0.0', required = true) => ({ plugin_id: id, version_range: range, required })
async function enable(copy: PluginCopy, choices: string[] = [], global = false): Promise<void> {
  const plan = control.plan(task, copy.digest, choices)
  await control.enable(task, copy.digest, choices, plan.fingerprint, global, idle)
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'trellis-plugin-selection-')); control = new PluginControl(root); task = randomUUID() })
afterEach(async () => { control.close(); await rm(root, { recursive: true, force: true }) })
it('plans dependencies without enabling and persists explicit workflow independently', async () => {
  const dependency = await install('dependency'), main = await install('main', { dependencies: [dep('dependency')] })
  const plan = control.plan(task, main.digest)
  expect(plan.packages.map(p => p.plugin_id)).toEqual(['dependency', 'main']); expect(control.configuration(task).enabled).toEqual([])
  await enable(main); expect(control.configuration(task).workflow).toBeNull()
  control.selectWorkflow(task, { digest: main.digest, contribution_id: 'flow' }, idle)
  control.close(); control = new PluginControl(root)
  expect(control.configuration(task)).toMatchObject({ enabled: [{ digest: dependency.digest }, { digest: main.digest }], workflow: { digest: main.digest } })
  expect(control.configuration(randomUUID()).enabled).toEqual([])
})
it('rejects missing, nonmatching and cyclic required dependencies', async () => {
  const main = await install('main', { dependencies: [dep('dependency')] })
  expect(() => control.plan(task, main.digest)).toThrowError(expect.objectContaining({ code: 'PLUGIN_DEPENDENCY_MISSING' }))
  await install('dependency', { version: '2.0.0' })
  expect(() => control.plan(task, main.digest)).toThrow()
  const cycle = await install('dependency', { dependencies: [dep('main')] })
  expect(() => control.plan(task, main.digest, [cycle.digest])).toThrowError(expect.objectContaining({ code: 'PLUGIN_DEPENDENCY_CYCLE' }))
})
it('requires an exact choice for ambiguous copies without auto-upgrading', async () => {
  const a = await install('dependency'), b = await install('dependency', { version: '1.1.0' }), main = await install('main', { dependencies: [dep('dependency')] })
  expect(() => control.plan(task, main.digest)).toThrowError(expect.objectContaining({ code: 'PLUGIN_DEPENDENCY_AMBIGUOUS' }))
  await enable(main, [a.digest]); expect(control.configuration(task).enabled.some(e => e.digest === a.digest)).toBe(true)
  await expect(enable(main, [b.digest])).rejects.toMatchObject({ code: 'PLUGIN_VERSION_ENABLED' })
})
it('does not automatically enable optional dependencies', async () => {
  await install('optional'); const main = await install('main', { dependencies: [dep('optional', '*', false)] })
  await enable(main); expect(control.configuration(task).enabled).toHaveLength(1)
  control.selectWorkflow(task, { digest: main.digest, contribution_id: 'flow' }, idle)
  expect(control.configuration(task).workflow?.digest).toBe(main.digest)
})
it('requires global scope confirmation even for content-only packages', async () => {
  const copy = await install('global', { global: true })
  await expect(enable(copy)).rejects.toMatchObject({ code: 'PLUGIN_SCOPE_CONFIRMATION_REQUIRED' })
  await enable(copy, [], true); expect(control.configuration(randomUUID()).enabled).toEqual([{ digest: copy.digest, task_id: null }])
})
it('requires code trust and checks busy before committing any enablement', async () => {
  const copy = await install('code', { backend: true })
  await expect(enable(copy)).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED' })
  await control.grant(copy.digest, { local_code: true, cross_task: false })
  const plan = control.plan(task, copy.digest)
  await expect(control.enable(task, copy.digest, [], plan.fingerprint, false, () => { throw new Error('busy') })).rejects.toThrow('busy')
  expect(control.configuration(task).enabled).toEqual([])
})
it('clears dependent workflow when a required dependency is disabled', async () => {
  const dependency = await install('dependency'), main = await install('main', { dependencies: [dep('dependency')] })
  await enable(main); control.selectWorkflow(task, { digest: main.digest, contribution_id: 'flow' }, idle)
  control.disable(dependency.digest, task)
  expect(control.configuration(task).workflow).toBeNull()
  expect(() => control.selectWorkflow(task, { digest: main.digest, contribution_id: 'flow' }, idle)).toThrow()
})
it('propagates indirect dependency disablement without affecting another task selection', async () => {
  const leaf=await install('leaf'),middle=await install('middle',{dependencies:[dep('leaf')]}),main=await install('main',{dependencies:[dep('middle')]}),other=randomUUID()
  await enable(main); const plan=control.plan(other,main.digest);await control.enable(other,main.digest,[],plan.fingerprint,false,idle)
  control.selectWorkflow(task,{digest:main.digest,contribution_id:'flow'},idle);control.selectWorkflow(other,{digest:main.digest,contribution_id:'flow'},idle)
  control.disable(leaf.digest,task)
  expect(control.available(task,middle.digest)).toBe(false);expect(control.available(task,main.digest)).toBe(false);expect(control.configuration(task).workflow).toBeNull()
  expect(control.available(other,main.digest)).toBe(true);expect(control.configuration(other).workflow?.digest).toBe(main.digest)
})
it('revocation removes code enablement and workflow but keeps package bytes', async () => {
  const copy = await install('code', { backend: true }); await control.grant(copy.digest, { local_code: true, cross_task: false }); await enable(copy)
  control.selectWorkflow(task, { digest: copy.digest, contribution_id: 'flow' }, idle); control.revoke(copy.digest)
  expect(control.configuration(task)).toEqual({ enabled: [], workflow: null }); expect(control.list()).toHaveLength(1)
})
it('rejects stale plans and source corruption without partial enablement', async () => {
  const copy = await install('main'), plan = control.plan(task, copy.digest)
  await expect(control.enable(task, copy.digest, [], 'stale', false, idle)).rejects.toMatchObject({ code: 'PLUGIN_CONFIGURATION_CHANGED' })
  await writeFile(join(root, 'plugins', copy.digest, 'entry.md'), 'changed')
  await expect(control.enable(task, copy.digest, [], plan.fingerprint, false, idle)).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID' })
  expect(control.configuration(task).enabled).toEqual([])
})

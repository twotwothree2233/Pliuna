import Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PluginControl } from '../../src/runtime/plugins/control'
import { copyPluginPackage, pluginPath, readPluginEntry, verifyPluginCopy, packageLimits } from '../../src/runtime/plugins/package'

let root: string, source: string, control: PluginControl | undefined
const manifest = (backend = false, global = false): any => ({ manifest_version: '0.1', protocol_version: '0.1', id: 'fixture.plugin', version: '0.1.0', access_level: global ? 'global' : 'task', contributes: [{ id: 'skill', kind: 'skill', entry: 'skill.md', description: 'isolated test fixture' }], ...(backend ? { backend: { command: 'node', args: ['backend.cjs'], entry: 'backend.cjs' } } : {}) })
async function fixture(backend = false, global = false): Promise<void> {
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest(backend, global)))
  await writeFile(join(source, 'skill.md'), 'fixture content')
  if (backend) await writeFile(join(source, 'backend.cjs'), 'throw new Error("must not execute at import")')
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pliuna-plugin-')); source = join(root, 'source'); await mkdir(source); await fixture() })
afterEach(async () => { control?.close(); control = undefined; await rm(root, { recursive: true, force: true }) })
it('imports only fixed package content, not the source path, and never executes', async () => {
  await fixture(true); control = new PluginControl(root)
  const copy = await control.install(source)
  expect(copy.files).toHaveLength(3); expect(control.trusted(copy.digest)).toBe(false)
  expect(JSON.stringify(control.list())).not.toContain(root)
  await writeFile(join(source, 'skill.md'), 'changed source')
  expect((await readPluginEntry(root, copy, 'skill.md')).toString()).toBe('fixture content')
  expect(await readdir(join(root, 'plugins'))).toContain(copy.digest)
})
it('round-trips content packages without executable trust', async () => {
  control = new PluginControl(root); const copy = await control.install(source)
  await expect(control.grant(copy.digest, { local_code: true, cross_task: true })).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED' })
  control.close(); control = new PluginControl(root)
  expect(control.list()).toEqual([copy]); await verifyPluginCopy(root, copy)
})
it('binds trust to the full digest and retains revocation across restart', async () => {
  await fixture(true); control = new PluginControl(root); const copy = await control.install(source)
  await control.grant(copy.digest, { local_code: true, cross_task: false }); expect((await control.executable(copy.digest)).digest).toBe(copy.digest)
  control.revoke(copy.digest); control.close(); control = new PluginControl(root)
  await expect(control.executable(copy.digest)).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED' })
  await writeFile(join(source, 'skill.md'), 'new version of same declaration')
  const changed = await control.install(source); expect(changed.digest).not.toBe(copy.digest); expect(control.trusted(changed.digest)).toBe(false)
})
it('requires explicit global local-code risk confirmation', async () => {
  await fixture(true, true); control = new PluginControl(root); const copy = await control.install(source)
  await expect(control.grant(copy.digest, { local_code: true, cross_task: false })).rejects.toMatchObject({ code: 'PLUGIN_TRUST_REQUIRED' })
  await control.grant(copy.digest, { local_code: true, cross_task: true }); expect(control.trusted(copy.digest)).toBe(true)
})
it('rejects changed managed bytes even after trust', async () => {
  await fixture(true); control = new PluginControl(root); const copy = await control.install(source)
  await control.grant(copy.digest, { local_code: true, cross_task: false })
  await writeFile(join(root, 'plugins', copy.digest, 'skill.md'), 'tampered')
  await expect(control.executable(copy.digest)).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID' })
  await expect(readPluginEntry(root, copy, 'skill.md')).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID' })
})
it('rejects late executable qualification after synchronous revoke', async () => {
  await fixture(true); control = new PluginControl(root); const copy = await control.install(source)
  await control.grant(copy.digest, { local_code: true, cross_task: false })
  const pending = control.executable(copy.digest); control.revoke(copy.digest)
  await expect(pending).rejects.toMatchObject({ code: 'PLUGIN_CONFIGURATION_CHANGED' })
})
it.each(['../outside', '/absolute', 'a\\b', 'a:stream', 'CON.txt', 'a/../b', 'a.', 'a//b'])('rejects nonportable package paths %s', async path => {
  expect(pluginPath(path)).toBe(false)
  const m = manifest(); m.contributes[0].entry = path
  await writeFile(join(source, 'manifest.json'), JSON.stringify(m))
  await expect(copyPluginPackage(root, source)).rejects.toBeDefined()
})
it('rejects symlinks and hard links before registration', async () => {
  control = new PluginControl(root)
  await symlink(join(source, 'skill.md'), join(source, 'alias.md'))
  await expect(control.install(source)).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID' }); expect(control.list()).toEqual([])
  await unlink(join(source, 'alias.md')); await link(join(source, 'skill.md'), join(source, 'alias.md'))
  await expect(control.install(source)).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID' }); expect(control.list()).toEqual([])
})
it('rejects case-colliding paths on a case-sensitive filesystem too', async () => {
  const m = manifest(); m.contributes.push({ ...m.contributes[0], id: 'again' })
  await writeFile(join(source, 'manifest.json'), JSON.stringify(m)); control = new PluginControl(root)
  const copy = await control.install(source)
  const invalid = { ...copy, files: [...copy.files, { ...copy.files[0]!, path: 'MANIFEST.JSON' }] }
  await expect(verifyPluginCopy(root, invalid)).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID' })
})
it('bounds manifest and file allocation', async () => {
  await writeFile(join(source, 'huge'), Buffer.alloc(packageLimits.fileBytes + 1))
  await expect(copyPluginPackage(root, source)).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID' })
  await unlink(join(source, 'huge')); await writeFile(join(source, 'manifest.json'), ' '.repeat(packageLimits.manifestBytes + 1))
  await expect(copyPluginPackage(root, source)).rejects.toMatchObject({ code: 'PLUGIN_PACKAGE_INVALID' })
})
it('does not rebuild a missing authority when its durable marker remains', async () => {
  control = new PluginControl(root); await control.install(source); control.close(); control = undefined
  await unlink(join(root, 'plugin-control.sqlite')); control = new PluginControl(root)
  expect(control.error).toBe('PLUGIN_CONTROL_INVALID'); expect(() => control!.list()).toThrowError(expect.objectContaining({ code: 'PLUGIN_CONTROL_INVALID' }))
})
it.each([2, 'corrupt'])('fails closed on unknown or corrupt control %s', async version => {
  control = new PluginControl(root); const copy = await control.install(source); control.close(); control = undefined
  const db = new Database(join(root, 'plugin-control.sqlite'))
  db.prepare('UPDATE plugin_control SET manifest=?').run(version === 'corrupt' ? '{' : JSON.stringify({ version, packages: [copy], trusts: [] })); db.close()
  control = new PluginControl(root); expect(control.error).toBe('PLUGIN_CONTROL_INVALID')
  expect((await readFile(join(root, 'plugins', copy.digest, 'skill.md'))).toString()).toBe('fixture content')
})
it('deduplicates identical fixed bytes but does not trust a reimport', async () => {
  await fixture(true); control = new PluginControl(root); const first = await control.install(source), second = await control.install(source)
  expect(second).toEqual(first); expect(control.list()).toHaveLength(1); expect(control.trusted(first.digest)).toBe(false)
})

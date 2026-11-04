import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, symlink, link } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exportTargetIdentity, reconcileExport, saveExport } from '../../src/main/export-save'
const roots: string[] = []
const setup = async () => { const root = await mkdtemp(join(tmpdir(), 'trellis-export-save-')); roots.push(root); return { root, target: join(root, 'output.html') } }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('host-only export publication', () => {
  it('publishes verified bytes and finalizes only afterwards', async () => {
    const { target } = await setup(), phases: string[] = []
    await saveExport(target, null, { begin: async () => ({ html: '<p>fixed</p>' }), finish: async phase => { phases.push(phase); expect(await readFile(target, 'utf8')).toBe('<p>fixed</p>') } })
    expect(phases).toEqual(['saved'])
  })
  it('does not finalize a job when registration fails', async () => {
    const { target } = await setup(); let finished = false
    await expect(saveExport(target, null, { begin: async () => { throw Error('source revoked') }, finish: async () => { finished = true } })).rejects.toThrow('NOT_STARTED')
    expect(finished).toBe(false); await expect(readFile(target)).rejects.toThrow()
  })
  it('preserves an existing file if its identity changes before save', async () => {
    const { target } = await setup(); await writeFile(target, 'original'); const expected = await exportTargetIdentity(target); await writeFile(target, 'changed')
    await expect(saveExport(target, expected, { begin: async () => ({ html: 'new' }), finish: async () => {} })).rejects.toThrow('NOT_STARTED')
    expect(await readFile(target, 'utf8')).toBe('changed')
  })
  it('rejects symbolic and multiply linked destinations', async () => {
    const { root, target } = await setup(), other = join(root, 'other'); await writeFile(other, 'private'); await symlink(other, target)
    await expect(exportTargetIdentity(target)).rejects.toThrow('UNSAFE')
    await rm(target); await link(other, target); await expect(exportTargetIdentity(target)).rejects.toThrow('UNSAFE')
  })
  it('verifies a published result after lost completion without republishing', async () => {
    const { root, target } = await setup(); let temporary = '', identity: any
    await expect(saveExport(target, null, { begin: async path => { temporary = path; return { html: 'fixed' } }, created: async value => { identity = value }, finish: async () => { throw Error('lost') } })).rejects.toThrow('UNKNOWN')
    expect(await reconcileExport({ html: 'fixed', destination: { target, temporary, identity } }, false)).toBe('saved')
    expect(await readFile(target, 'utf8')).toBe('fixed')
  })
  it('keeps a replaced temporary file and refuses to release the unknown protection', async () => {
    const { root, target } = await setup(), temporary = join(root, 'registered.tmp'); await writeFile(temporary, 'foreign')
    await expect(reconcileExport({ html: 'fixed', destination: { target, temporary, identity: { dev: -1, ino: -1 } } }, true)).rejects.toThrow('IDENTITY_UNKNOWN')
    expect(await readFile(temporary, 'utf8')).toBe('foreign')
  })
  it('requires explicit acknowledgement when no result can be proven and never removes final files', async () => {
    const { root, target } = await setup(), temporary = join(root, 'missing.tmp'); await writeFile(target, 'unrelated')
    const job = { html: 'fixed', destination: { target, temporary, identity: null } }
    await expect(reconcileExport(job, false)).rejects.toThrow('ACKNOWLEDGEMENT')
    expect(await reconcileExport(job, true)).toBe('failed'); expect(await readFile(target, 'utf8')).toBe('unrelated')
  })
})
it('revoked final permission preserves the old destination and cleans only its temporary file', async () => {
 const { root,target }=await setup();await writeFile(target,'original');const expected=await exportTargetIdentity(target);let temporary='',phase=''
 await saveExport(target,expected,{begin:async path=>{temporary=path;return {html:'new'}},valid:async()=>{throw Error('EXPORT_SOURCE_REVOKED')},finish:async value=>{phase=value}})
 expect(phase).toBe('failed');expect(await readFile(target,'utf8')).toBe('original');await expect(readFile(temporary)).rejects.toThrow()
})

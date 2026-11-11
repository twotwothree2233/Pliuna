import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applicationEnvironment, legacyDatabaseFile } from '../../src/shared/branding'
import type { Bundle } from '../../src/shared/contracts.generated'
import { RuntimeStore } from '../../src/runtime/store'
import { RestoreJournal } from '../../src/runtime/restore-journal'
import { checkBundle } from '../../src/runtime/managed'
import { generateExportBody } from '../../src/runtime/export-generation'
import { readTextSize } from '../../src/renderer/src/text-size'

const roots: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scene() { const root = mkdtempSync(join(tmpdir(), 'pliuna-branding-')); roots.push(root); return root }
function bundle(): Bundle {
  return { profile: 'managed-v1', html: '<section id="lesson">Saved content</section>', css: '', state: { schema: { type: 'object', additionalProperties: false, properties: {} }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [{ id: 'learning', category: 'learning', source: { type: 'element', element_id: 'lesson' } }] }
}

it('reopens an established legacy task database without moving it or creating a second base database', () => {
  const root = scene(), original = new RuntimeStore(root)
  const task = original.create('Saved before renaming').task.id
  original.close()
  renameSync(join(root, 'pliuna.sqlite'), join(root, legacyDatabaseFile))
  const control = new Database(join(root, 'restore-control.sqlite'))
  try {
    const row = control.prepare('SELECT manifest FROM restore_control WHERE id=1').get() as { manifest: string }
    const journal = JSON.parse(row.manifest); journal.selected = legacyDatabaseFile
    control.prepare('UPDATE restore_control SET manifest=? WHERE id=1').run(JSON.stringify(journal))
  } finally { control.close() }

  const reopened = new RuntimeStore(root)
  try {
    expect(reopened.snapshot(task).task.title).toBe('Saved before renaming')
    expect(reopened.create('Created after renaming').task.title).toBe('Created after renaming')
    expect(existsSync(join(root, 'pliuna.sqlite'))).toBe(false)
  } finally { reopened.close() }
  const journal = new RestoreJournal(root)
  try {
    expect(journal.selected()).toBe(legacyDatabaseFile)
    expect(journal.replicaFiles()).toEqual([legacyDatabaseFile])
    expect(journal.retainedDatabases()).toEqual([legacyDatabaseFile])
  } finally { journal.close() }
})

it('uses an existing legacy base file on its first selector initialization', () => {
  const root = scene(); writeFileSync(join(root, legacyDatabaseFile), '')
  const store = new RuntimeStore(root)
  try {
    expect(store.create('Existing profile').task.title).toBe('Existing profile')
    expect(existsSync(join(root, 'pliuna.sqlite'))).toBe(false)
  } finally { store.close() }
})

it('closes business access when both base names exist instead of guessing or rewriting either database', () => {
  const root = scene(), store = new RuntimeStore(root)
  store.create('Retain this task'); store.close()
  copyFileSync(join(root, 'pliuna.sqlite'), join(root, legacyDatabaseFile))
  const before = readFileSync(join(root, legacyDatabaseFile))
  expect(() => new RuntimeStore(root)).toThrow(expect.objectContaining({ code: 'RESTORE_JOURNAL_INVALID' }))
  expect(readFileSync(join(root, legacyDatabaseFile))).toEqual(before)
  expect(readFileSync(join(root, 'pliuna.sqlite'))).toEqual(before)
})

it.each(['pliuna-resource:', 'trellis-resource:'])('renders declared images using the saved %s URL scheme', scheme => {
  const saved = bundle()
  saved.html = `<section id="lesson"><img src="${scheme}picture" alt="Saved image"></section>`
  saved.references = [{ name: 'picture', target: { kind: 'resource', id: '11111111-1111-4111-8111-111111111111' } }]
  const checked = checkBundle(saved, 'saved', name => {
    expect(name).toBe('picture')
    return 'data:image/png;base64,AA=='
  })
  expect(checked.html).toContain('src="data:image/png;base64,AA=="')
  expect(checked.html).toContain('alt="Saved image"')
})

it.each(['application/vnd.pliuna.bundle+json', 'application/vnd.trellis.bundle+json'])('exports saved content using %s without rewriting its immutable bundle', media_type => {
  const body = Buffer.from(JSON.stringify(bundle())), id = '11111111-1111-4111-8111-111111111111'
  const result = generateExportBody({ title: 'Saved lesson', resources: [{ id, storage_key: id, sha256: '0'.repeat(64), byte_length: body.length, media_type, display_name: 'Saved bundle' }], views: [{ bundle_id: id, resource_ids: [] }], answers: [] }, () => body)
  expect(result.html).toContain('Saved content')
  expect(result.issues).toEqual([])
})

it('keeps the saved text size and stores its current key without deleting the old preference', () => {
  const values = new Map([['trellis-text-size', '125']])
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  expect(readTextSize()).toBe(125)
  expect(values.get('pliuna-text-size')).toBe('125')
  expect(values.get('trellis-text-size')).toBe('125')
  values.set('pliuna-text-size', '110')
  expect(readTextSize()).toBe(110)
})

it('preserves explicit profile selection and gives the current environment variable priority', () => {
  expect(applicationEnvironment({ TRELLIS_TEST_DATA: 'previous' }, 'TEST_DATA')).toBe('previous')
  expect(applicationEnvironment({ PLIUNA_TEST_DATA: 'current', TRELLIS_TEST_DATA: 'previous' }, 'TEST_DATA')).toBe('current')
})

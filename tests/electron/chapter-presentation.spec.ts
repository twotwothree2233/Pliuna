import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformWithEsbuild } from 'vite'
import type { Bundle, ChapterManifest, ChapterUpdate } from '../../src/shared/contracts.generated'
import type { ChapterPresentation } from '../../src/renderer/src/chapter-presentation'

const electronPath: string = createRequire(import.meta.url)('electron')
interface BrowserFixture {
  host: HTMLElement
  manifest: ChapterManifest
  bundle: Bundle
  controller: ChapterPresentation
  bodies: HTMLElement[]
  saved: string[][]
  calls: string[]
  mode: 'immediate' | 'pending' | 'reject'
  release?: () => void
  rebuild(replacements: [string, string][], updates: ChapterUpdate[]): void
}
declare global {
  interface Window {
    ChapterUI: typeof import('../../src/renderer/src/chapter-presentation')
    chapterFixture: BrowserFixture
  }
}

function manifest(structural = false): ChapterManifest {
  const region = (name: string, index: number) => ({
    region_id: name, revision: 1, title: name,
    title_selector: structural ? `:scope > section:nth-child(${index}) > h2:nth-child(1)` : `#${name}-title`,
    body_selector: structural ? `:scope > section:nth-child(${index}) > div:nth-child(2)` : `#${name}-body`,
    dependencies: [], ownership: { form_ids: [], behavior_ids: [], reference_ids: [], export_ids: [], css_selectors: [] }
  })
  return { task_id: 'task', view_id: 'view', view_revision: 1, state_revision: 1, bundle_resource_id: 'source', manifest_revision: 1, shared_revision: 1, request_id: 'request', intent_revision: 1, chapters: [region('a', 1), region('b', 2)] }
}
function update(name: string, state: ChapterUpdate['state'] = 'generating', intent = 1, id = name + '-' + intent): ChapterUpdate {
  return { task_id: 'task', update_id: id, input_event_id: 'input-' + id, record_id: 'record-' + id, request_id: 'request', intent_revision: 1, view_id: 'view', base_manifest: manifest(), region_ids: [name], region_intents: [{ region_id: name, intent_revision: intent }], dependencies: [], state, text: 'Revise this chapter', previous_update_ids: [] }
}

let app: ElectronApplication
let page: Page
let directory: string
let source: string
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pliuna-chapter-ui-'))
  const entry = join(directory, 'chapter-browser.cjs')
  await writeFile(entry, "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({width:1000,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false}});window.loadURL('about:blank')})")
  source = (await transformWithEsbuild(await readFile('src/renderer/src/chapter-presentation.ts', 'utf8'), 'chapter-presentation.ts', { loader: 'ts', format: 'iife', globalName: 'ChapterUI' })).code
  app = await electron.launch({ executablePath: electronPath, args: [entry], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '' } })
  page = await app.firstWindow()
})
test.afterAll(async () => {
  await app?.close()
  await rm(directory, { recursive: true, force: true })
})

async function fixture(options: { structural?: boolean; long?: boolean } = {}) {
  await page.evaluate(() => window.chapterFixture?.controller.dispose())
  await page.setContent('<style>:root{--fg:#171a20;--bg:#fff;--block:#f3f4f6;--line:#d7dbe1;--line-strong:#b1b8c1;--muted:#626b78;--accent:#375dd4;--hover:#e9edf4;--font-ui:system-ui;--warn:#a43b20}body{margin:0;padding:24px}.workspace-scroll{height:580px;overflow:auto;overflow-anchor:none;border:1px solid #ddd}</style><div class="workspace-scroll"><div id="view"></div></div><button id="outside">Agent</button>')
  await page.addScriptTag({ content: source })
  await page.evaluate(({ manifest, long }) => {
    const shadow = document.querySelector('#view')!.attachShadow({ mode: 'open' })
    const style = document.createElement('style'); style.textContent = 'h2{margin:24px 0 12px}section{padding:0 24px}p{line-height:1.8;margin:14px 0}input{display:block;margin:12px 0}button{margin:8px 0}#tail{height:700px}'
    const host = document.createElement('div'); host.dataset.view = 'v-view'
    const paragraphs = (name: string) => Array.from({ length: long ? 50 : 3 }, (_, index) => `<p id="v-view-${name}-p-${index}">${name} paragraph ${index} continues the original chapter.</p>`).join('')
    host.innerHTML = `<section><h2 id="v-view-a-title">Alpha</h2><div id="v-view-a-body">${paragraphs('a')}<input id="v-view-a-input" aria-label="Alpha input" value="alpha draft"></div></section><section><h2 id="v-view-b-title">Beta</h2><div id="v-view-b-body">${paragraphs('b')}<input id="v-view-b-input" aria-label="Beta input" value="beta draft"><button id="v-view-independent">Submit Beta</button><button id="v-view-shared">Submit both</button></div></section><div id="tail"></div>`
    shadow.append(style, host)
    const bundle: Bundle = { profile: 'managed-v1', html: host.innerHTML, css: style.textContent!, state: { schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, additionalProperties: false }, initial: { a: 'alpha draft', b: 'beta draft' }, compatibility_version: 'v1' }, forms: [{ id: 'shared', fields: ['/a', '/b'] }, { id: 'independent', fields: ['/b'] }], behaviors: [{ type: 'input', element_id: 'a-input', field: '/a', control: 'text' }, { type: 'input', element_id: 'b-input', field: '/b', control: 'text' }, { type: 'submit', element_id: 'independent', form_id: 'independent' }, { type: 'submit', element_id: 'shared', form_id: 'shared' }], references: [], export: [] }
    const state: BrowserFixture = { host, manifest, bundle, bodies: [...host.querySelectorAll<HTMLElement>('[id$="-body"]')], saved: [], calls: [], mode: 'immediate', controller: null!, rebuild: () => {} }
    const controller = () => new window.ChapterUI.ChapterPresentation({ host, bundle: state.bundle,
      save: async () => {
        if (state.mode === 'pending') await new Promise<void>(resolve => { state.release = resolve })
        if (state.mode === 'reject') throw Error('VERSION_CONFLICT')
        state.saved.push([...host.querySelectorAll<HTMLInputElement>('input')].map(input => input.value))
      }, canPrepare: () => true,
      cancel: async value => { state.calls.push('cancel:' + value.update_id) },
      query: async value => { state.calls.push('query:' + value.update_id) },
      resolve: value => { state.calls.push('resolve:' + value.update_id) }
    })
    state.controller = controller()
    state.rebuild = (replacements, updates) => {
      const position = window.ChapterUI.captureChapterPosition(host, state.manifest)
      const fields = [...host.querySelectorAll<HTMLInputElement>('input')].map(element => ({ id: element.id, value: element.value }))
      state.controller.dispose()
      for (const [from, to] of replacements) state.bundle.html = state.bundle.html.replace(from, to)
      host.innerHTML = state.bundle.html
      for (const field of fields) host.querySelector<HTMLInputElement>('#' + CSS.escape(field.id))!.value = field.value
      state.manifest = { ...state.manifest, manifest_revision: state.manifest.manifest_revision + 1, view_revision: state.manifest.view_revision + 1 }
      state.bodies = [...host.querySelectorAll<HTMLElement>('[id$="-body"]')]
      state.controller = controller()
      window.ChapterUI.restoreChapterPosition(position, host, state.manifest)
      state.controller.sync(state.manifest, updates)
    }
    window.chapterFixture = state
  }, { manifest: manifest(options.structural), long: Boolean(options.long) })
}
async function sync(...updates: ChapterUpdate[]) {
  await page.evaluate(updates => { const state = window.chapterFixture; state.controller.sync(state.manifest, updates) }, updates)
}
const body = (name: string) => page.locator('#v-view-' + name + '-body')
const card = (name: string) => page.locator('[data-chapter-region="' + name + '"]')

test('concurrent chapter cards preserve original nodes and pause only affected submissions', async () => {
  await fixture({ structural: true })
  await page.evaluate(() => { window.chapterFixture.mode = 'pending' })
  await page.getByLabel('Alpha input').fill('latest alpha draft')
  await sync(update('a'))
  await expect(body('a')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible()
  await expect(page.locator('#v-view-shared')).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Submit Beta', exact: true })).toBeEnabled()
  await page.getByLabel('Beta input').fill('beta while alpha saves')
  await page.evaluate(() => { window.chapterFixture.mode = 'immediate'; window.chapterFixture.release!() })
  await expect(body('a')).toBeHidden()
  expect(await page.evaluate(() => window.chapterFixture.saved)).toEqual([['latest alpha draft', 'beta while alpha saves']])
  await card('a').getByRole('button', { name: '查看上一版', exact: true }).click()
  await expect(card('a').getByLabel('Alpha input')).toHaveValue('latest alpha draft')
  await expect(card('a').getByLabel('Alpha input')).toBeDisabled()
  await card('a').getByRole('button', { name: '收起上一版', exact: true }).click()
  await card('a').getByRole('button', { name: '查看上一版', exact: true }).click()
  await expect(card('a').getByLabel('Alpha input')).toHaveValue('latest alpha draft')
  await sync(update('a'), update('b'))
  await expect(body('b')).toBeHidden()
  await expect(card('a')).toBeVisible()
  await expect(card('b')).toBeVisible()
  expect(await page.evaluate(() => window.chapterFixture.bodies.every(element => element.isConnected && element === window.ChapterUI.chapterElement(window.chapterFixture.host, window.chapterFixture.manifest.chapters[element.id.includes('-a-') ? 0 : 1]!.body_selector)))).toBe(true)
  await sync(update('a', 'cancelled'), update('b'))
  await expect(body('a')).toBeVisible()
  await expect(body('b')).toBeHidden()
  await expect(page.locator('#v-view-shared')).toBeDisabled()
  await sync(update('a', 'cancelled'), update('b', 'failed'))
  await expect(body('b')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Submit both', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.chapterFixture.bundle.html.includes('data-chapter-update'))).toBe(false)
})

test('save conflict keeps the original chapter visible and gives a recovery action', async () => {
  await fixture()
  await page.evaluate(() => { window.chapterFixture.mode = 'reject' })
  await sync(update('a'))
  await expect(body('a')).toBeVisible()
  await expect(card('a').getByRole('button', { name: '保存输入并继续', exact: true })).toBeVisible()
  await expect(page.getByLabel('Alpha input')).toBeEditable()
  await page.getByLabel('Alpha input').fill('retry keeps this')
  await page.evaluate(() => { window.chapterFixture.mode = 'immediate' })
  await card('a').getByRole('button', { name: '保存输入并继续', exact: true }).click()
  await expect(body('a')).toBeHidden()
  expect(await page.evaluate(() => window.chapterFixture.saved[0]![0])).toBe('retry keeps this')
})

test('new intent controls the card while waiting and unknown states stay static', async () => {
  await fixture()
  await sync(update('a'))
  await expect(card('a').locator('[data-active="true"]')).toHaveCount(1)
  await sync(update('a', 'waiting_approval', 2), update('a', 'failed', 1))
  await expect(card('a')).toHaveAttribute('data-chapter-update', 'a-2')
  await expect(card('a').locator('[data-active="true"]')).toHaveCount(0)
  await card('a').getByRole('button', { name: '查看待处理事项', exact: true }).click()
  expect(await page.evaluate(() => window.chapterFixture.calls)).toEqual(['resolve:a-2'])
  await sync(update('a', 'unknown', 2), update('a', 'succeeded', 1))
  await expect(body('a')).toBeHidden()
  await expect(card('a').locator('.activity')).toHaveCount(0)
  await expect(card('a').getByRole('button', { name: '取消更新', exact: true })).toHaveCount(0)
  await card('a').getByRole('button', { name: '查询原操作', exact: true }).click()
  expect(await page.evaluate(() => window.chapterFixture.calls)).toEqual(['resolve:a-2', 'query:a-2'])
  await sync(update('a', 'interrupted', 2))
  await expect(body('a')).toBeVisible()
  await expect(card('a').getByText('更新已中断', { exact: true })).toBeVisible()
})

test('long chapter collapse and preview retain current reading and focus', async () => {
  await fixture({ long: true })
  await page.locator('#v-view-a-p-30').evaluate(element => element.scrollIntoView({ block: 'start' }))
  await sync(update('a'))
  await expect(body('a')).toBeHidden()
  const bounds = await card('a').boundingBox()
  expect(bounds!.y).toBeGreaterThanOrEqual(20)
  expect(bounds!.y).toBeLessThan(100)
  expect(bounds!.height).toBeLessThan(400)
  await card('a').getByRole('button', { name: '查看上一版', exact: true }).click()
  await expect(card('a').getByRole('button', { name: '收起上一版', exact: true })).toBeFocused()
  await card('a').getByRole('button', { name: '收起上一版', exact: true }).click()
  await page.locator('#v-view-b-input').evaluate(element => element.scrollIntoView({ block: 'center' }))
  await page.getByLabel('Beta input', { exact: true }).fill('new typing during generation')
  await page.getByLabel('Beta input', { exact: true }).evaluate((element: HTMLInputElement) => element.setSelectionRange(4, 10, 'backward'))
  const before = await page.getByLabel('Beta input', { exact: true }).boundingBox()
  await sync(update('a', 'failed'))
  const after = await page.getByLabel('Beta input', { exact: true }).boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
  await expect(page.getByLabel('Beta input', { exact: true })).toBeFocused()
  expect(await page.getByLabel('Beta input', { exact: true }).evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual([4, 10, 'backward'])
})

test('concurrent chapters and a corrected intent preserve continuing input across successive DOM publications', async () => {
  await fixture({ structural: true, long: true })
  const first = update('a'), newer = update('a', 'waiting_approval', 2), superseded = update('a', 'superseded'), beta = update('b')
  await sync(first)
  await expect(body('a')).toBeHidden()
  await page.getByLabel('Beta input', { exact: true }).fill('first edit while Alpha generates')
  await sync(newer, superseded)
  await expect(card('a')).toHaveAttribute('data-chapter-update', newer.update_id)
  await page.getByLabel('Beta input', { exact: true }).fill('newest Beta input before its update')
  await sync(newer, superseded, beta)
  await expect(body('a')).toBeHidden()
  await expect(body('b')).toBeHidden()
  await expect(card('a')).toBeVisible()
  await expect(card('b')).toBeVisible()
  expect(await page.evaluate(() => window.chapterFixture.saved.at(-1))).toEqual(['alpha draft', 'newest Beta input before its update'])
  await sync(newer, superseded, { ...beta, state: 'publishing' })
  await expect(body('b')).toBeHidden()
  await expect(page.getByText('Published Beta chapter', { exact: true })).toHaveCount(0)
  await page.evaluate(({ newer, superseded, beta }) => {
    window.chapterFixture.rebuild([['b paragraph 0 continues the original chapter.', 'Published Beta chapter']], [newer, superseded, { ...beta, state: 'succeeded' }])
  }, { newer, superseded, beta })
  await expect(body('a')).toBeHidden()
  await expect(body('b')).toBeVisible()
  await expect(card('b')).toHaveCount(0)
  await expect(page.getByText('Published Beta chapter', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Beta input', { exact: true })).toHaveValue('newest Beta input before its update')
  await page.getByLabel('Beta input', { exact: true }).fill('typing continues while corrected Alpha waits')
  await page.getByLabel('Beta input', { exact: true }).evaluate((element: HTMLInputElement) => element.setSelectionRange(7, 16, 'backward'))
  const before = await page.getByLabel('Beta input', { exact: true }).boundingBox()
  await page.evaluate(({ newer, superseded, beta }) => {
    window.chapterFixture.rebuild([['a paragraph 0 continues the original chapter.', 'Corrected Alpha publication']], [{ ...newer, state: 'succeeded' }, superseded, { ...beta, state: 'succeeded' }])
  }, { newer, superseded, beta })
  await expect(body('a')).toBeVisible()
  await expect(card('a')).toHaveCount(0)
  await expect(page.getByLabel('Beta input', { exact: true })).toHaveValue('typing continues while corrected Alpha waits')
  await expect(page.getByLabel('Beta input', { exact: true })).toBeFocused()
  expect(await page.getByLabel('Beta input', { exact: true }).evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd, element.selectionDirection])).toEqual([7, 16, 'backward'])
  const after = await page.getByLabel('Beta input', { exact: true }).boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2)
  await expect(page.getByText('Published Beta chapter', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.chapterFixture.bundle.html)).toContain('Corrected Alpha publication')
})

test('publication rebuild restores latest non-target control and respects motion preferences', async () => {
  await fixture({ long: true })
  await sync(update('a'))
  await expect(body('a')).toBeHidden()
  await page.getByLabel('Beta input', { exact: true }).fill('latest value survives rebuilding')
  await page.getByLabel('Beta input', { exact: true }).evaluate((element: HTMLInputElement) => element.setSelectionRange(7, 12, 'forward'))
  const result = await page.evaluate(() => {
    const state = window.chapterFixture
    const position = window.ChapterUI.captureChapterPosition(state.host, state.manifest)
    const draft = state.host.querySelector<HTMLInputElement>('#v-view-b-input')!.value
    state.controller.dispose()
    state.host.innerHTML = state.bundle.html.replace('a paragraph 0 continues the original chapter.', 'New Alpha publication')
    state.host.querySelector<HTMLInputElement>('#v-view-b-input')!.value = draft
    window.ChapterUI.restoreChapterPosition(position, state.host, state.manifest)
    const active = state.host.getRootNode() instanceof ShadowRoot ? (state.host.getRootNode() as ShadowRoot).activeElement as HTMLInputElement : null
    return { value: active?.value, start: active?.selectionStart, end: active?.selectionEnd, direction: active?.selectionDirection }
  })
  expect(result).toEqual({ value: 'latest value survives rebuilding', start: 7, end: 12, direction: 'forward' })
  await expect(page.getByText('New Alpha publication', { exact: true })).toBeVisible()
  await fixture()
  await sync(update('a'))
  await expect(body('a')).toBeHidden()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await card('a').locator('.activity').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  for (const colors of [['#171a20', '#f3f4f6'], ['#f2f5f9', '#202938'], ['#dfebd5', '#233027']]) {
    const actual = await page.evaluate(([foreground, surface]) => {
      document.documentElement.style.setProperty('--fg', foreground!); document.documentElement.style.setProperty('--block', surface!)
      const card = window.chapterFixture.host.querySelector('[data-chapter-region]')!.shadowRoot!
      const probe = document.createElement('div'); probe.style.cssText = 'color:var(--fg);background:var(--block)'; document.body.append(probe)
      const expected = getComputedStyle(probe), status = getComputedStyle(card.querySelector('.status')!)
      const result = [status.color, status.backgroundColor, expected.color, expected.backgroundColor]; probe.remove(); return result
    }, colors)
    expect(actual.slice(0, 2)).toEqual(actual.slice(2))
  }
})

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChapterSourceRequest } from '../../src/renderer/src/ChapterEditor'
import type { View } from '../../src/shared/types'

const { build } = createRequire(createRequire(import.meta.url).resolve('vite/package.json'))('esbuild')

interface Harness {
  events: string[]
  requests: Record<string, any>[]
  mode: 'success' | 'save-wait' | 'unknown'
  statusError?: { code: string; message: string }
  release?(): void
  scope?: ChapterSourceRequest
}
declare global {
  interface Window {
    chapterEditorHarness: Harness
    mountChapterEditor(view: View, source?: ChapterSourceRequest): void
    mountChapterQueue(source: ChapterSourceRequest): void
  }
}

const sourceRequest: ChapterSourceRequest = { request_id: 'original-request', text: '原请求摘要：请重新组织这一部分', text_truncated: true, model_config_id: 'original-model' }
const view: View = {
  id: 'view', revision: 3, state_revision: 4, draft: {},
  bundle: { profile: 'managed-v1', html: '', css: '', state: { schema: { type: 'object' }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [] },
  presentation: { html: '', css: '' },
  chapter_manifest: { task_id: 'task', view_id: 'view', view_revision: 3, state_revision: 4, bundle_resource_id: 'source', manifest_revision: 1, shared_revision: 1, request_id: 'goal', intent_revision: 1, chapters: ['Alpha', 'Beta'].map(title => ({ region_id: title.toLowerCase(), revision: 1, title, title_selector: '#' + title + '-title', body_selector: '#' + title + '-body', dependencies: [], ownership: { form_ids: [], behavior_ids: [], reference_ids: [], export_ids: [], css_selectors: [] } })) }
}

let app: ElectronApplication
let page: Page
let directory: string
let script: string
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pliuna-chapter-editor-'))
  const entry = join(directory, 'chapter-editor.cjs')
  await writeFile(join(directory, 'editor.html'), '<!doctype html><html><body></body></html>')
  await writeFile(entry, "const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({width:1000,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false}});window.loadFile(" + JSON.stringify(join(directory, 'editor.html')) + ')})')
  script = (await build({ stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ChapterEditor} from './src/renderer/src/ChapterEditor';
    import {RequestComposer} from './src/renderer/src/RequestComposer';
    let root;
    function setup(){root?.unmount();document.body.innerHTML='<main></main>';const h=window.chapterEditorHarness={events:[],requests:[],mode:'success'};root=createRoot(document.querySelector('main'));return h}
    window.mountChapterEditor=(view,source)=>{const h=setup();let revision=view.state_revision;
      window.pliuna={platform:'linux',request:async request=>{h.requests.push(request);h.events.push(request.type);if(request.type==='chapter.update'&&h.mode==='unknown')return {ok:false,error:{code:'OFFLINE',message:'OFFLINE'}};if(request.type==='chapter.status'&&h.statusError)return {ok:false,error:h.statusError};return {ok:true,data:{}}}};
      root.render(<ChapterEditor taskId="task" view={view} modelId="newly-selected-model" enabled={true} sourceRequest={source} save={async()=>{h.events.push('save');if(h.mode==='save-wait')await new Promise(resolve=>{h.release=resolve});revision=5}} stateRevision={()=>revision} refresh={async()=>{h.events.push('refresh')}} onDirty={()=>{}} onSourceResolved={()=>{h.events.push('resolved')}}/>);
    };
    window.mountChapterQueue=source=>{const h=setup();
      window.pliuna={platform:'linux',request:async request=>{h.requests.push(request);if(request.type==='request.list')return {ok:true,data:{items:[{request_id:source.request_id,state:'confirmation_required',code:'CHAPTER_SCOPE_REQUIRED',text:source.text,text_truncated:source.text_truncated,model_selection:{id:source.model_config_id},materials:[]}],next_before:null,summary:{pending:1,confirmation:1}}};return {ok:true,data:{items:[],next_cursor:null,next_before:null}}}};
      root.render(<RequestComposer taskId="task" active={true} text="" setText={()=>{}} modelId="newly-selected-model" models={{models:[],approval:{mode:'manual',model_id:''}}} busy={false} run={false} composer={{current:null}} onDirty={()=>{}} refresh={async()=>{}} queueOpen={false} setQueueOpen={()=>{}} onQueueChange={()=>{}} onChapterScope={source=>{h.scope=source;return true}}/>);
    };
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic' })).outputFiles[0]!.text
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [entry], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '' } })
  page = await app.firstWindow()
  await page.addScriptTag({ content: script })
})
test.afterAll(async () => { await app?.close(); await rm(directory, { recursive: true, force: true }) })

test('ambiguous requests expose chapter selection and retain the original request identity', async () => {
  await page.evaluate(source => window.mountChapterQueue(source), sourceRequest)
  await page.getByRole('button', { name: '选择要修改的章节', exact: true }).click()
  expect(await page.evaluate(() => window.chapterEditorHarness.scope)).toEqual(sourceRequest)
  await expect(page.getByRole('button', { name: '仅用成功材料继续', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.chapterEditorHarness.requests.some(request => ['request.resolve', 'chapter.update'].includes(request.type)))).toBe(false)
})

test('confirmed scope saves the draft before using the original request and model', async () => {
  await page.evaluate(({ view, source }) => window.mountChapterEditor(view, source), { view, source: sourceRequest })
  await expect(page.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: '更新所选章节', exact: true })).toBeDisabled()
  await expect(page.getByText('此处显示摘要，更新会使用已保存的完整原请求。', { exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Beta', exact: true }).check()
  await page.evaluate(() => { window.chapterEditorHarness.mode = 'save-wait' })
  await page.getByRole('button', { name: '更新所选章节', exact: true }).click()
  expect(await page.evaluate(() => window.chapterEditorHarness.requests)).toEqual([])
  await page.evaluate(() => window.chapterEditorHarness.release!())
  await expect.poll(() => page.evaluate(() => window.chapterEditorHarness.events)).toContain('resolved')
  const requests = await page.evaluate(() => window.chapterEditorHarness.requests)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ type: 'chapter.update', source_request_id: sourceRequest.request_id, text: sourceRequest.text, model_config_id: sourceRequest.model_config_id, view_revision: 3, state_revision: 5, region_ids: ['beta'] })
  expect(await page.evaluate(() => window.chapterEditorHarness.events)).toEqual(['save', 'chapter.update', 'resolved', 'refresh'])
})

test('an uncertain scope submission queries the original update without replaying it', async () => {
  await page.evaluate(({ view, source }) => window.mountChapterEditor(view, source), { view, source: sourceRequest })
  await page.getByRole('checkbox', { name: 'Alpha', exact: true }).check()
  await page.evaluate(() => { window.chapterEditorHarness.mode = 'unknown' })
  await page.getByRole('button', { name: '更新所选章节', exact: true }).click()
  await expect(page.getByRole('button', { name: '查询原更新', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '更新所选章节', exact: true })).toBeDisabled()
  const original = (await page.evaluate(() => window.chapterEditorHarness.requests))[0]!
  await page.getByRole('button', { name: '查询原更新', exact: true }).click()
  expect(await page.evaluate(() => window.chapterEditorHarness.requests)).toEqual([original, { type: 'chapter.status', task_id: 'task', update_id: original.update_id }])
  expect((await page.evaluate(() => window.chapterEditorHarness.events)).filter(event => event === 'resolved')).toHaveLength(1)
})

for (const originalSource of [false, true]) {
  test(`a confirmed unreceived ${originalSource ? 'source request' : 'manual edit'} restores editing without losing the instruction`, async () => {
    await page.evaluate(({ view, source }) => window.mountChapterEditor(view, source), { view, source: originalSource ? sourceRequest : undefined })
    if (!originalSource) {
      await page.getByText('修改正文', { exact: true }).click()
      await page.getByLabel('修改要求', { exact: true }).fill('保留这条修改要求')
    }
    await page.getByRole('checkbox', { name: 'Alpha', exact: true }).check()
    await page.evaluate(() => { window.chapterEditorHarness.mode = 'unknown' })
    await page.getByRole('button', { name: '更新所选章节', exact: true }).click()
    await expect(page.getByRole('button', { name: '查询原更新', exact: true })).toBeVisible()
    const original = (await page.evaluate(() => window.chapterEditorHarness.requests))[0]!
    await page.evaluate(() => { const h = window.chapterEditorHarness; h.mode = 'success'; h.statusError = { code: 'NOT_FOUND', message: 'Chapter update is unavailable' } })
    await page.getByRole('button', { name: '查询原更新', exact: true }).click()
    await expect(page.getByRole('button', { name: '查询原更新', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '更新所选章节', exact: true })).toBeEnabled()
    await expect(page.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeEnabled()
    await expect(page.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeChecked()
    expect(await page.evaluate(() => window.chapterEditorHarness.requests)).toEqual([original, { type: 'chapter.status', task_id: 'task', update_id: original.update_id }])
    expect(await page.evaluate(() => window.chapterEditorHarness.events)).not.toContain('resolved')
    if (originalSource) await expect(page.getByText(sourceRequest.text + '…', { exact: true })).toBeVisible()
    else {
      await expect(page.getByLabel('修改要求', { exact: true })).toBeEnabled()
      await expect(page.getByLabel('修改要求', { exact: true })).toHaveValue('保留这条修改要求')
      await expect(page.getByRole('button', { name: '清除要求', exact: true })).toBeVisible()
      await page.getByLabel('修改要求', { exact: true }).fill('编辑后重新提交')
    }
    await page.getByRole('button', { name: '更新所选章节', exact: true }).click()
    const requests = await page.evaluate(() => window.chapterEditorHarness.requests)
    expect(requests).toHaveLength(3)
    expect(requests[2]).toMatchObject({ type: 'chapter.update', region_ids: ['alpha'], text: originalSource ? sourceRequest.text : '编辑后重新提交', model_config_id: originalSource ? sourceRequest.model_config_id : 'newly-selected-model', ...(originalSource ? { source_request_id: sourceRequest.request_id } : {}) })
    expect(requests[2]!.update_id).not.toBe(original.update_id)
    expect(requests[2]!.input_event_id).not.toBe(original.input_event_id)
  })
}

test('query errors keep an uncertain update locked and never infer absence from message text', async () => {
  await page.evaluate(({ view, source }) => window.mountChapterEditor(view, source), { view, source: sourceRequest })
  await page.getByRole('checkbox', { name: 'Alpha', exact: true }).check()
  await page.evaluate(() => { window.chapterEditorHarness.mode = 'unknown' })
  await page.getByRole('button', { name: '更新所选章节', exact: true }).click()
  await expect(page.getByRole('button', { name: '查询原更新', exact: true })).toBeVisible()
  const original = (await page.evaluate(() => window.chapterEditorHarness.requests))[0]!
  for (const code of ['OFFLINE', 'UNKNOWN_RESULT']) {
    await page.evaluate(code => { window.chapterEditorHarness.statusError = { code, message: 'NOT_FOUND: unconfirmed transport response' } }, code)
    await page.getByRole('button', { name: '查询原更新', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(code)
    await expect(page.getByRole('button', { name: '更新所选章节', exact: true })).toBeDisabled()
    await expect(page.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeDisabled()
    expect(await page.evaluate(() => window.chapterEditorHarness.events)).not.toContain('resolved')
  }
  const requests = await page.evaluate(() => window.chapterEditorHarness.requests)
  expect(requests).toEqual([original, ...Array.from({ length: 2 }, () => ({ type: 'chapter.status', task_id: 'task', update_id: original.update_id }))])
})

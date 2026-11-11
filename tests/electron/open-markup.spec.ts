import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import { managedControls } from '../helpers/managed-controls'
const electronPath: string = createRequire(import.meta.url)('electron')

test('open HTML/CSS remains isolated, interactive, exportable and restart-safe', async () => {
  let surface: { id: string; revision: number }
  const bundle = managedControls()
  bundle.html = '<style>@media(min-width:1px){.details{font-family:monospace;box-shadow:0 1px 3px #0003}}</style><aside role="note" data-proof="open" style="letter-spacing:2px"><details open><summary>OPEN_MARKUP</summary><meter value="0.5">Half</meter></details></aside>' + bundle.html
  bundle.css += ':root{--ink:rgb(12,34,56)} div{color:var(--ink)} button{font-family:monospace} .details::before{content:"DECORATION"} .details{background:linear-gradient(white,#eee);width:calc(100% - 2px)} @keyframes emphasis{from{opacity:.9}to{opacity:1}} .details{animation:emphasis 10s infinite} @media(min-width:1px){.details{border-radius:7px}}'
  bundle.export = [{ id: 'markup', category: 'learning', source: { type: 'element', element_id: 'details' } }]

  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') { textStream(res, 'CONTROLS_READY'); return }
    hostToolStream(res, 'write', { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'controls', slot_id: 'main', bundle: { type: 'inline', bundle } }] })
  })
  const root = await mkdtemp(join(tmpdir(), 'pliuna-controls-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const call = async (request: unknown) => page.evaluate(async request => { const result = await window.pliuna.request(request as any); if (!result.ok) throw Error(result.error.code); return result.data as any }, request)
    await call({ type: 'model.configure', configuration: { id: 'controls', base_url: server.url, wire_model_id: 'wire', context_tokens: 100000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-controls-key', confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'controls', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('Declared controls')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call({ type: 'host.tasks' }))[0]
    surface = (await call({ type: 'task.snapshot', task_id: task.id })).surface
    await call({ type: 'task.submit', task_id: task.id, text: 'Publish controls', model_config_id: 'controls', attachments: [] })
    await expect(page.getByText('CONTROLS_READY', { exact: true })).toBeVisible()
    const count = server.exchanges.length
    const view = page.locator('.managed')
    await expect(view.getByText('OPEN_MARKUP', { exact: true })).toBeVisible()
    expect(await view.locator('[data-proof="open"]').evaluate(el => ({role:el.getAttribute('role'),spacing:getComputedStyle(el).letterSpacing}))).toEqual({role:'note',spacing:'2px'})
    const hostFont = await page.getByRole('button', { name: /Declared controls/ }).evaluate(el => getComputedStyle(el).fontFamily).catch(() => '')
    expect(await view.getByRole('button', { name: 'Toggle details' }).evaluate(el => getComputedStyle(el).fontFamily)).toBe('monospace')
    expect(hostFont).not.toBe('monospace')

    await expect(view.getByText('Local details', { exact: true })).toBeHidden()
    await view.getByRole('button', { name: 'Toggle details', exact: true }).click()
    await expect(view.getByText('Local details', { exact: true })).toBeVisible()
    await expect(view.getByText('Local details', { exact: true })).toHaveClass(/highlight/)
    expect(await view.locator('[id$="-details"]').evaluate(el => ({radius:getComputedStyle(el).borderRadius,shadow:getComputedStyle(el).boxShadow,before:getComputedStyle(el,'::before').content}))).toMatchObject({radius:'7px',before:'"DECORATION"'})
    await expect(view.getByRole('status')).toHaveText('已保存')
    const snapshotBefore = await call({ type: 'task.snapshot', task_id: task.id })
    const job = await call({ type: 'export.prepare', task_id: task.id, answer_ids: [] })
    await expect.poll(async () => (await call({ type: 'export.status', task_id: task.id, operation_id: job.id })).phase).toBe('preview')
    const preview = await call({ type: 'export.preview', task_id: task.id, operation_id: job.id })
    const exported = await app.evaluate(async ({ BrowserWindow }, html) => {
      const win = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
      try { await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); return await win.webContents.executeJavaScript(`(()=>{const host=document.querySelector('section:has(template)')??document.querySelector('body>section');const shadow=host.shadowRoot;const el=shadow.querySelector('[id$="-details"]');return{shadow:!!shadow,text:el.textContent,radius:getComputedStyle(el).borderRadius,before:getComputedStyle(el,'::before').content,hostFont:getComputedStyle(document.querySelector('h1')).fontFamily}})()`) } finally { win.destroy() }
    }, preview.html)
    expect(exported).toMatchObject({shadow:true,text:'Local details',radius:'7px',before:'"DECORATION"'})
    expect(exported.hostFont).not.toBe('monospace')
    await call({ type: 'export.cancel', task_id: task.id, operation_id: job.id })
    expect((await call({ type: 'task.snapshot', task_id: task.id })).views).toEqual(snapshotBefore.views)

    await expect(view.getByLabel('Visible checkbox')).toBeChecked()
    await view.getByLabel('Visible checkbox').uncheck()
    await expect(view.getByText('Local details', { exact: true })).toBeHidden()
    await view.getByLabel('Choice', { exact: true }).selectOption('b')
    await view.getByLabel('Multiple', { exact: true }).selectOption(['x', 'y'])
    await view.getByLabel('Radio B', { exact: true }).check()
    await expect(view.getByLabel('Radio A', { exact: true })).not.toBeChecked()
    await view.getByLabel('Range', { exact: true }).fill('7')
    await expect(view.locator('[id$="-range-text"]')).toHaveText('7')
    await view.getByLabel('Note', { exact: true }).fill('separate note')
    await expect(view.getByRole('status')).toHaveText('已保存')
    expect(server.exchanges).toHaveLength(count)
    await view.getByRole('button', { name: 'Submit choices', exact: true }).click()
    await expect(view.getByRole('status')).toContainText('提交成功')
    let snapshot = await call({ type: 'task.snapshot', task_id: task.id })
    expect(snapshot.answers[0].value).toEqual({ choice: 'b', multi: ['x', 'y'], radio: 'b', range: 7 })
    await view.getByRole('button', { name: 'Submit note', exact: true }).click()
    await expect.poll(async () => (await call({ type: 'task.snapshot', task_id: task.id })).answer_total).toBe(2)
    snapshot = await call({ type: 'task.snapshot', task_id: task.id })
    expect(snapshot.answers.map((answer: { value: unknown }) => answer.value)).toEqual([
      { choice: 'b', multi: ['x', 'y'], radio: 'b', range: 7 }, { note: 'separate note' }
    ])
    await expect(view.getByRole('status')).toContainText('提交成功')
    await app.close(); app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /Declared controls/ }).click()
    await expect(page.getByLabel('Choice', { exact: true })).toHaveValue('b')
    await expect(page.getByLabel('Multiple', { exact: true })).toHaveValues(['x', 'y'])
    await expect(page.getByLabel('Radio B', { exact: true })).toBeChecked()
    await expect(page.getByLabel('Range', { exact: true })).toHaveValue('7')
    await expect(page.locator('[id$="-range-text"]')).toHaveText('7')
    await expect(page.getByLabel('Note', { exact: true })).toHaveValue('separate note')
    expect(server.exchanges).toHaveLength(count)
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy())).catch(() => {})
    await app.close().catch(() => {}); await server.close()
  }
})

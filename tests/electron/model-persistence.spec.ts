import { openPending } from '../helpers/agent-ui'
import { chooseModel, openSettings, closeSettings, addChannel, addModel, testRole } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

test('Plain-file remembered connection survives restart, edits invalidate and credential deletion persists', async () => {
  let dataId = ''
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"saved-wire"}]}'); return }
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') {
      const result = JSON.parse(body.messages.at(-1).content)
      if (result.data?.id) dataId = result.data.id
      textStream(res, 'RESTORED_DATA_RUN_ENDED'); return
    }
    const request = JSON.parse(body.messages.findLast((message: any) => message.role === 'user').content).request
    if (request === 'create initial data') hostToolStream(res, 'write', { type: 'task_data.create', data: { schema: { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false }, value: { stage: 'initial' }, references: [] } })
    else if (request === 'approve update' || request === 'deny update') hostToolStream(res, 'write', { type: 'task_data.replace', id: dataId, expected_revision: request === 'approve update' ? 1 : 2, value: { stage: request === 'approve update' ? 'updated' : 'rejected-test' }, references: [] })
    else textStream(res, 'RESTORED_CONNECTION_OK')
  })
  const directory = await mkdtemp(join(tmpdir(), 'trellis-file-desktop-'))
  const profile = join(directory, '.trellis')
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', TRELLIS_TEST_DATA: profile } })
  let app = await launch()
  const sentinel = 'synthetic-file-desktop-key'
  try {
    let page = await app.firstWindow()
    await openSettings(page, '模型服务')
    const storage = await page.evaluate(async () => (await window.trellis.request({ type: 'model.list' })) as any)
    expect(storage.data.storage).toMatchObject({ available: true, backend: 'plain-file' })
    await addChannel(page,{name:'Remembered',url:server.url,key:sentinel,remember:true})
    await addModel(page,{name:'Remembered main',model:'saved-wire',context:1000000,output:1024})
    const mainId=await page.evaluate(async()=>{const r:any=await window.trellis.request({type:'model.list'});return r.data.models[0].id as string})
    await testRole(page,'主模型')
    expect(await readFile(join(profile, 'settings.json'), 'utf8')).not.toContain(sentinel)
    expect(await readFile(join(profile, 'auth.json'), 'utf8')).toContain(sentinel)
    const beforeRestart = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow()
    await openSettings(page, '模型服务')
    await expect(page.locator('.channel-model .badge')).toContainText('主模型')
    await expect(page.locator('.channel-credentials')).toContainText('已记住连接')
    expect(server.exchanges).toHaveLength(beforeRestart)
    await page.getByRole('button',{name:'渠道设置',exact:true}).click()
    await expect(page.getByLabel('服务 Base URL')).toHaveValue(server.url)
    await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('')
    await page.getByRole('button',{name:'关闭',exact:true}).click()
    await closeSettings(page)
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('记住连接重启测试')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseModel(page, mainId)
    await page.getByLabel('想从哪里开始？').fill('仅回复 RESTORED_CONNECTION_OK')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByText('RESTORED_CONNECTION_OK', { exact: true })).toBeVisible()
    expect(server.exchanges.at(-1)!.authorization).toBe('Bearer ' + sentinel)
    const send = async (request: string) => { await page.getByLabel('想从哪里开始？').fill(request); await page.getByRole('button', { name: /发送 · 新 Run/ }).click() }
    await send('create initial data')
    await expect(page.getByText('RESTORED_DATA_RUN_ENDED', { exact: true })).toHaveCount(1)
    await page.getByRole('tab', { name: /任务数据/ }).click()
    await page.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.record-values')).toContainText('initial')
    await send('approve update')
    await openPending(page)
    await expect(page.getByRole('button', { name: '批准本次动作', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
    await page.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.record-detail')).toContainText('数据值 · r1')
    await expect(page.locator('.record-values')).toContainText('initial')
    await openPending(page)
    await page.getByRole('button', { name: '批准本次动作', exact: true }).click()
    await expect(page.locator('.agent-status')).toContainText('已完成');await page.getByRole('tab', { name: /^内容/ }).click();await expect(page.getByText('RESTORED_DATA_RUN_ENDED', { exact: true })).toHaveCount(1);await page.getByRole('tab', { name: /^任务数据/ }).click()
    await page.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.record-detail')).toContainText('数据值 · r2')
    await expect(page.locator('.record-values')).toContainText('updated')
    await send('deny update');await openPending(page)
    await expect(page.getByRole('button', { name: '拒绝本次动作', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '拒绝本次动作', exact: true }).click()
    await expect(page.locator('.agent-status')).toContainText('已完成');await page.getByRole('tab', { name: /^内容/ }).click();await expect(page.getByText('RESTORED_DATA_RUN_ENDED', { exact: true })).toHaveCount(1);await page.getByRole('tab', { name: /^任务数据/ }).click()
    await page.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.record-detail')).toContainText('数据值 · r2')
    await expect(page.locator('.record-values')).toContainText('updated')
    await expect(page.locator('.object-list>button')).toHaveCount(1)
    await openSettings(page, '存储与恢复')
    const cacheRequests = server.exchanges.length
    const settingsBeforeClear = await readFile(join(profile, 'settings.json'), 'utf8')
    const authBeforeClear = await readFile(join(profile, 'auth.json'), 'utf8')
    await page.getByRole('button', { name: '清理缓存（保留数据与凭据）', exact: true }).click()
    await expect(page.getByRole('status').filter({hasText:'缓存已清理'})).toBeVisible()
    expect(await readFile(join(profile, 'settings.json'), 'utf8')).toBe(settingsBeforeClear)
    expect(await readFile(join(profile, 'auth.json'), 'utf8')).toBe(authBeforeClear)
    expect(server.exchanges).toHaveLength(cacheRequests)
    await openSettings(page)
    await page.getByRole('button',{name:'编辑模型 Remembered main',exact:true}).click()
    await page.getByLabel('输出上限（留空由服务决定）').fill('2048')
    await page.getByRole('button',{name:'保存模型',exact:true}).click()
    await expect(page.getByRole('dialog',{name:'编辑模型',exact:true})).toHaveCount(0)
    await expect(page.locator('.channel-model .badge')).toContainText('未验证')
    await page.getByRole('button',{name:'渠道设置',exact:true}).click()
    page.once('dialog',d=>d.accept())
    await page.getByRole('button',{name:'删除渠道凭据',exact:true}).click()
    await expect(page.getByRole('dialog',{name:'渠道设置',exact:true})).toHaveCount(0)
    await expect(page.locator('.channel-credentials')).toContainText('缺少凭据')
    await app.close();app=await launch();page=await app.firstWindow()
    await openSettings(page)
    await expect(page.locator('.channel-credentials')).toContainText('缺少凭据')
    await page.locator('.channel-model summary').click()
    await expect(page.getByRole('button',{name:'测试并启用主模型',exact:true})).toBeDisabled()
    await page.getByRole('button',{name:'编辑模型 Remembered main',exact:true}).click()
    await expect(page.getByLabel('输出上限（留空由服务决定）')).toHaveValue('2048')
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await scan(path)
        else if (entry.isFile()) expect((await readFile(path)).includes(Buffer.from(sentinel)), entry.name).toBe(false)
      }
    }
    await app.close()
    await scan(directory)
  } finally { await app.close().catch(() => {}); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

import { openPending } from '../helpers/agent-ui'
import { chooseModel, openSettings, closeSettings, addChannel, addModel, testRole } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

test('desktop model test gate, general loop, manual approval, memory-only credentials', async () => {
  let dataId = ''
  let correctedInvalidValue = false
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"wire-model"}]}'); return }
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') {
      const result = JSON.parse(body.messages.at(-1).content)
      if (result.error?.code === 'INVALID_DATA') {
        expect(result.error.message).toContain('expected object, received string')
        correctedInvalidValue = true
        hostToolStream(res, 'write', { type: 'task_data.replace', id: dataId, expected_revision: 1, value: { stage: 'updated' }, references: [] }, '', 'corrected-value')
        return
      }
      if (result.data?.id) dataId = result.data.id
      textStream(res, '本机合成模型完成，无真实服务调用。'); return
    }
    const request = JSON.parse(body.messages.findLast((m: any) => m.role === 'user').content).request as string
    if (request === '创建学习进度') hostToolStream(res, 'write', { type: 'task_data.create', data: { schema: { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false }, value: { stage: 'initial' }, references: [] } })
    else hostToolStream(res, 'write', { type: 'task_data.replace', id: dataId, expected_revision: 1, value: '{"stage":"updated"}', references: [] })
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-model-desktop-'))
  const launch = () => electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
    await addChannel(page,{name:'Desktop',url:server.url,key:'desktop-secret-sentinel'})
    expect(server.exchanges).toHaveLength(0)
    page.once('dialog',d=>d.accept())
    await page.getByRole('button',{name:'发现模型',exact:true}).click()
    await expect(page.getByRole('dialog',{name:'服务可用模型',exact:true})).toContainText('wire-model')
    expect(server.exchanges).toHaveLength(1)
    expect(server.exchanges[0]!.body).toBeNull()
    await page.getByRole('button',{name:'关闭',exact:true}).click()
    await addModel(page,{name:'Main',model:'wire-model',context:1000000,output:1024})
    const mainId=await page.evaluate(async()=>{const r:any=await window.pliuna.request({type:'model.list'});return r.data.models[0].id as string})
    await testRole(page,'主模型')
    await closeSettings(page)
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('模型审批任务')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    await chooseModel(page, mainId)
    await page.getByLabel('想从哪里开始？').fill('创建学习进度')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await expect(page.getByText('本机合成模型完成，无真实服务调用。', { exact: true })).toHaveCount(1)
    await expect(page.locator('.agent-status')).toContainText('已完成')
    expect(dataId).not.toBe('')
    await page.getByRole('tab', { name: /^任务数据/ }).click();await page.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.record-values')).toContainText('initial')
    await page.getByLabel('想从哪里开始？').fill('更新已有进度')
    await page.getByRole('button', { name: /发送 · 新 Run/ }).click()
    await openPending(page)
    await expect(page.getByRole('button', { name: '批准本次动作' })).toBeVisible()
    expect(correctedInvalidValue).toBe(true)
    await page.getByText('具体参数与版本').click()
    await expect(page.locator('.approval-card pre').first()).toContainText('expected_revision')
    await openPending(page)
    await page.getByRole('button', { name: '批准本次动作' }).click()
    await expect(page.locator('.agent-status')).toContainText('已完成');await page.getByRole('tab', { name: /^内容/ }).click();await expect(page.getByText('本机合成模型完成，无真实服务调用。', { exact: true })).toHaveCount(1)
    await expect(page.locator('.agent-messages .approval-card')).toHaveCount(0)
    await page.getByRole('tab', { name: /^任务数据/ }).click();await page.getByRole('button', { name: '刷新全部任务数据', exact: true }).click()
    await page.getByRole('button', { name: new RegExp(dataId) }).click()
    await expect(page.locator('.record-values')).toContainText('updated')
    await page.getByRole('tab', { name: /执行记录/ }).click()
    await page.locator('.execution-category > summary').filter({ hasText: /^原动作$/ }).click()
    await expect(page.getByRole('region', { name: '原动作分页浏览', exact: true })).toContainText('success')
    expect(errors).toEqual([])
    await app.close()
    const dbBytes = await readFile(join(directory, 'pliuna.sqlite'))
    expect(dbBytes.includes(Buffer.from('desktop-secret-sentinel'))).toBe(false)
    app = await launch(); page = await app.firstWindow()
    await page.getByRole('button', { name: /模型审批任务/ }).click()
    await expect(page.locator('.agent-note')).toContainText('选择主模型后即可发送')
    await expect(page.locator('.agent-messages .approval-card')).toHaveCount(0)
    expect(server.exchanges.every(e => e.authorization === 'Bearer desktop-secret-sentinel')).toBe(true)
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

test('channel discovery is explicit, handles authentication and never auto-retries', async () => {
  let mode: 'ok'|'auth'|'empty'='ok'
  const server=await modelServer(({url},res)=>{expect(url).toBe('/v1/models');res.writeHead(mode==='auth'?401:200,{'content-type':'application/json'});res.end(mode==='auth'?'private-provider-error':mode==='empty'?'{"data":[]}':'{"data":[{"id":"model-a"},{"id":"model-b"}]}')})
  const directory=await mkdtemp(join(tmpdir(),'pliuna-catalogue-'))
  const app=await electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:directory}})
  try {
    const page=await app.firstWindow()
    await addChannel(page,{name:'Catalogue',url:server.url,key:'catalogue-test-key'})
    expect(server.exchanges).toHaveLength(0)
    const discover=async()=>{page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'发现模型',exact:true}).click()}
    await discover()
    const choices=page.getByRole('dialog',{name:'服务可用模型',exact:true})
    await expect(choices).toContainText('model-b')
    expect(server.exchanges[0]).toMatchObject({authorization:'Bearer catalogue-test-key',body:null})
    await choices.getByRole('button',{name:'添加此模型',exact:true}).nth(1).click()
    await expect(page.getByLabel('精确模型标识')).toHaveValue('model-b')
    await expect(page.getByLabel('已知上下文容量')).toHaveValue('')
    for(const width of [390,720,1440]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}
    await page.getByRole('button',{name:'关闭',exact:true}).click()
    expect(server.exchanges).toHaveLength(1)
    mode='auth';await discover()
    await expect(page.getByRole('status')).toContainText('MODEL_AUTHENTICATION')
    await expect(choices).toHaveCount(0)
    expect(await page.locator('body').innerText()).not.toContain('private-provider-error')
    await page.waitForTimeout(650);expect(server.exchanges).toHaveLength(2)
    await page.getByRole('button',{name:'渠道设置',exact:true}).click()
    await page.getByLabel('API Key',{exact:true}).fill('new-catalogue-key')
    await page.getByRole('button',{name:'保存渠道',exact:true}).click()
    await expect(page.getByRole('dialog',{name:'渠道设置',exact:true})).toHaveCount(0)
    mode='empty';await discover();await expect(choices).toContainText('服务未返回可用模型')
    expect(server.exchanges).toHaveLength(3)
    expect(server.exchanges.at(-1)!.authorization).toBe('Bearer new-catalogue-key')
  }finally{await app.close();await server.close();await rm(directory,{recursive:true,force:true})}
})

test('desktop real-API onboarding handles authentication, explicit cancellation and retesting', async () => {
  let mode: 'auth' | 'hang' | 'ok' = 'auth'
  let tests = 0
  const server = await modelServer(({ body, url }, res) => {
    if (url === '/v1/models') { res.writeHead(404); res.end('unavailable catalogue'); return }
    tests++
    if (mode === 'auth') { res.writeHead(401); res.end('never-display-provider-secret'); return }
    if (mode === 'hang') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return }
    synthetic(body, res)
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-onboarding-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow()
    await addChannel(page,{name:'Real ready',url:server.url,key:'onboarding-secret'})
    page.once('dialog',d=>d.accept())
    await page.getByRole('button',{name:'发现模型',exact:true}).click()
    await expect(page.getByRole('status')).toContainText('MODEL_UNAVAILABLE')
    await addModel(page,{name:'Main',model:'wire-model',context:1000000,output:1024})
    await page.locator('.channel-model summary').click()
    const testMain = page.getByRole('button', { name: '测试并启用主模型', exact: true })
    await testMain.click(); await expect(page.getByRole('dialog', { name: '确认模型角色测试' })).toContainText('最多两轮'); await page.getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('MODEL_AUTHENTICATION')
    expect(tests).toBe(1)
    await expect(page.locator('.model-entry')).toContainText('未验证')
    expect(await page.locator('body').innerText()).not.toContain('never-display-provider-secret')
    mode = 'hang'
    await testMain.click(); await expect(page.getByRole('dialog', { name: '确认模型角色测试' })).toContainText('最多两轮'); await page.getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect.poll(() => tests).toBe(2)
    await page.getByRole('button', { name: '取消当前连接或测试' }).click()
    await expect(page.getByRole('status')).toContainText('MODEL_CANCELLED')
    await expect(testMain).toBeEnabled()
    await expect(page.locator('.model-entry')).toContainText('未验证')
    mode = 'ok'
    await testMain.click(); await expect(page.getByRole('dialog', { name: '确认模型角色测试' })).toContainText('最多两轮'); await page.getByRole('button', { name: '确认费用并开始测试', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('主模型验证通过')
    expect(tests).toBe(4)
    for (const width of [390, 720, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  } finally { await app.close(); await server.close(); await rm(directory, { recursive: true, force: true }) }
})

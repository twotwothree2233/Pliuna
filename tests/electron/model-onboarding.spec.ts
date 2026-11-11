import { openSettings, addChannel, addModel } from '../helpers/settings-ui'
import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic } from '../helpers/model-server'
const electronPath: string = createRequire(import.meta.url)('electron')

for (const scenario of ['connection-confirmation', 'service-metadata', 'saved-connection-discovery', 'visible-role-confirmation'] as const) test(`model onboarding: ${scenario}`, async () => {
  const server = await modelServer(({ body, url }, response) => {
    if (url === '/v1/models') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'onboarding-wire', context_length: 240000, max_output_tokens: 8192 }] })); return }
    if (synthetic(body, response)) return
    response.writeHead(500); response.end()
  })
  const root = await mkdtemp(join(tmpdir(), 'pliuna-onboarding-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: root } })
  try {
    const page = await app.firstWindow()
    await addChannel(page,{name:'Onboarding',url:server.url,key:'synthetic-key'})
    expect(server.exchanges).toHaveLength(0)
    if (scenario === 'connection-confirmation') {
      await page.getByRole('button',{name:'渠道设置',exact:true}).click()
      await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('')
      await page.getByLabel('渠道名称').fill('Renamed channel')
      await page.getByLabel('显式兼容 Profile').selectOption('chat-max-completion-tokens')
      await page.getByRole('button',{name:'保存渠道',exact:true}).click()
      await expect(page.getByRole('dialog',{name:'渠道设置',exact:true})).toHaveCount(0)
      expect(server.exchanges).toHaveLength(0)
      await page.getByRole('button',{name:'渠道设置',exact:true}).click()
      await expect(page.getByLabel('显式兼容 Profile')).toHaveValue('chat-max-completion-tokens')
      await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('')
      return
    }
    page.once('dialog',d=>d.accept())
    await page.getByRole('button',{name:'发现模型',exact:true}).click()
    const catalogue=page.getByRole('dialog',{name:'服务可用模型',exact:true})
    await expect(catalogue).toContainText('onboarding-wire')
    expect(server.exchanges).toHaveLength(1)
    expect(server.exchanges[0]!.authorization).toBe('Bearer synthetic-key')
    await catalogue.getByRole('button',{name:'添加此模型',exact:true}).click()
    await expect(page.getByLabel('已知上下文容量')).toHaveValue('240000')
    await expect(page.getByLabel('输出上限（留空由服务决定）')).toHaveValue('8192')
    await expect(page.getByLabel('API Key',{exact:true})).toHaveCount(0)
    if (scenario === 'service-metadata') await page.getByLabel('输出上限（留空由服务决定）').fill('2048')
    await page.getByRole('button',{name:'保存模型',exact:true}).click()
    await expect(page.getByRole('dialog',{name:'添加模型',exact:true})).toHaveCount(0)
    await page.locator('.channel-model summary').click()
    if (scenario === 'service-metadata') {
      await expect(page.locator('.channel-model')).toContainText('上下文：service · 输出：manual')
      await page.getByRole('button',{name:'编辑模型 onboarding-wire',exact:true}).click()
      await expect(page.getByLabel('输出上限（留空由服务决定）')).toHaveValue('2048')
      expect(server.exchanges).toHaveLength(1)
      return
    }
    if (scenario === 'saved-connection-discovery') {
      await page.getByRole('button',{name:'渠道设置',exact:true}).click()
      await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('')
      await page.getByRole('button',{name:'保存渠道',exact:true}).click()
      await expect(page.getByRole('dialog',{name:'渠道设置',exact:true})).toHaveCount(0)
      page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'发现模型',exact:true}).click()
      await expect(catalogue).toContainText('onboarding-wire')
      expect(server.exchanges).toHaveLength(2)
      expect(server.exchanges.at(-1)?.authorization).toBe('Bearer synthetic-key')
      return
    }
    const count=server.exchanges.length
    const testMain=page.getByRole('button',{name:'测试并启用主模型',exact:true})
    await testMain.click()
    const confirmation=page.getByRole('dialog',{name:'确认模型角色测试',exact:true})
    await expect(confirmation).toContainText('最多两轮')
    expect(server.exchanges).toHaveLength(count)
    await confirmation.getByRole('button',{name:'取消',exact:true}).click()
    await expect(confirmation).toHaveCount(0)
    expect(server.exchanges).toHaveLength(count)
    await testMain.click();await confirmation.getByRole('button',{name:'确认费用并开始测试',exact:true}).click()
    await expect(page.locator('.channel-model .badge')).toContainText('主模型')
    expect(server.exchanges.filter(e=>e.body)).toHaveLength(2)
  } finally { await app.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

test('offline channel settings save makes no request and restart restores without credential echo', async () => {
  const root=await mkdtemp(join(tmpdir(),'pliuna-offline-settings-'))
  const launch=()=>electron.launch({executablePath:electronPath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:join(root,'.pliuna')}})
  let app=await launch()
  try {
    let page=await app.firstWindow()
    await addChannel(page,{name:'Offline',url:'https://example.invalid/v1',key:'offline-synthetic-key',remember:true})
    await addModel(page,{name:'Offline model',model:'offline-model',context:100000,output:1024})
    await expect(page.locator('.channel-credentials')).toContainText('已记住连接')
    await app.close();app=await launch();page=await app.firstWindow()
    await openSettings(page)
    await expect(page.locator('.channel-model')).toContainText('Offline model')
    await expect(page.locator('.channel-model .badge')).toContainText('未验证')
    await page.getByRole('button',{name:'渠道设置',exact:true}).click()
    await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('')
    await expect(page.getByLabel('服务 Base URL')).toHaveValue('https://example.invalid/v1')
  }finally{await app.close().catch(()=>{});await rm(root,{recursive:true,force:true})}
})

import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream } from '../helpers/model-server'
const executablePath: string = createRequire(import.meta.url)('electron')
test('application settings groups channels, preserves workspace and restores shared credentials', async()=>{
 test.setTimeout(90000)
 const root=await mkdtemp(join(tmpdir(),'pliuna-app-settings-'))
 const server=await modelServer(({body,url},res)=>{if(url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'wire-main',context_length:128000,max_output_tokens:8192},{id:'wire-compact',context_length:64000,max_output_tokens:4096}]}))}else if(!synthetic(body,res))textStream(res,'Synthetic summary')})
 const launch=()=>electron.launch({executablePath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:root}})
 let app=await launch()
 try{
 let page=await app.firstWindow();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message))
 await expect(page.locator('.workspace-body')).toBeVisible()
 await expect(page.locator('.window-tools button')).toHaveText(['导出']);await expect(page.getByRole('button',{name:'布局',exact:true})).toHaveCount(0)
 await page.getByRole('button',{name:'＋ 新建',exact:true}).click();await page.getByLabel('任务名称').fill('设置回归任务');await page.getByRole('button',{name:'创建任务',exact:true}).click()
 await page.locator('#message').fill('打开设置后仍保留的草稿')
 await page.getByRole('button',{name:'设置 ⌘ ,',exact:true}).click()
 const settings=page.getByRole('dialog',{name:'应用设置',exact:true});await expect(settings).toBeVisible()
 await page.getByRole('button',{name:'＋ 添加渠道',exact:true}).click();await page.getByLabel('渠道名称').fill('共享测试渠道');await page.getByLabel('服务 Base URL').fill(server.url);await page.getByLabel('API Key',{exact:true}).fill('shared-test-key');await page.getByRole('button',{name:'保存渠道',exact:true}).click()
 await expect(page.locator('.channel-card')).toContainText('共享测试渠道');await expect(page.locator('.channel-card')).toContainText('0 个模型')
 const count=server.exchanges.length;expect(count).toBe(0)
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'发现模型',exact:true}).click();const discovery=page.getByRole('dialog',{name:'服务可用模型',exact:true});await expect(discovery).toContainText('wire-main');expect(server.exchanges.at(-1)?.authorization).toBe('Bearer shared-test-key')
 await discovery.getByRole('button',{name:'添加此模型',exact:true}).first().click();const model=page.getByRole('dialog',{name:'添加模型',exact:true});await expect(model.getByLabel('已知上下文容量')).toHaveValue('128000');await expect(model.locator('input[type=password],input[type=url]')).toHaveCount(0);await model.getByLabel('模型名称').fill('主推理模型');await model.getByRole('button',{name:'保存模型',exact:true}).click();await expect(page.locator('.channel-model')).toHaveCount(1)
 await page.getByRole('button',{name:'＋ 添加模型',exact:true}).click();await page.getByLabel('模型名称').fill('整理模型');await page.getByLabel('精确模型标识').fill('wire-compact');await page.getByLabel('已知上下文容量').fill('64000');await page.getByLabel('输出上限（留空由服务决定）').fill('4096');await page.getByRole('button',{name:'保存模型',exact:true}).click();await expect(page.locator('.channel-model')).toHaveCount(2)
 const main=page.locator('.channel-model').filter({has:page.getByText('主推理模型',{exact:true})});await main.locator('summary').click();await main.getByRole('button',{name:'测试并启用主模型',exact:true}).click();await page.getByRole('button',{name:'确认费用并开始测试',exact:true}).click();await expect(main.locator('.badge')).toContainText('主模型')
 await expect(page.getByLabel('本次模型')).toContainText('共享测试渠道 / 主推理模型')
 const channel=page.locator('.channel-card');await channel.getByRole('button',{name:'渠道设置',exact:true}).click();await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('');await page.getByRole('button',{name:'保存渠道',exact:true}).click();await expect(main.locator('.badge')).toContainText('主模型')
 const settingsFile=JSON.parse(await readFile(join(root,'settings.json'),'utf8')),auth=JSON.parse(await readFile(join(root,'auth.json'),'utf8'));expect(settingsFile.version).toBe(4);expect(settingsFile.channels).toHaveLength(1);expect(settingsFile.connections).toHaveLength(2);expect(Object.keys(auth.credentials)).toHaveLength(1)
 await page.getByRole('button',{name:'外观',exact:true}).click();for(const theme of ['石墨','暖纸','深夜','暮色','苔原','蓝图']){await page.getByRole('button',{name:theme+' ✓',exact:false}).or(page.getByRole('button',{name:theme,exact:true})).first().click()};await page.getByRole('button',{name:'石墨',exact:true}).click()
 await page.screenshot({path:test.info().outputPath('pliuna-settings-real-appearance.png')})
 await page.getByRole('button',{name:'存储与恢复',exact:true}).click();await expect(page.getByRole('heading',{name:'一致性恢复点',exact:true})).toBeVisible();await expect(settings.getByRole('button',{name:/^返回工作区/})).toBeEnabled();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'创建一致性恢复点',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'维护状态：'})).toContainText('有效点')
 await page.getByRole('button',{name:'插件与主流程',exact:true}).click();await expect(page.getByText('尚无固定插件包。',{exact:false})).toBeVisible()
 await page.getByRole('button',{name:'权限与审批',exact:true}).click();await expect(page.getByRole('heading',{name:'权限与审批',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'当前使用手动审批',exact:true})).toBeVisible()
 await page.keyboard.press('Escape');await expect(settings).toHaveCount(0);await expect(page.locator('#message')).toHaveValue('打开设置后仍保留的草稿');await expect(page.getByLabel('本次模型')).toHaveCount(0)
 await page.locator('#toggle-left').click();await page.locator('[aria-label="关闭Agent 栏"]').click();await expect(page.locator('#pane-left')).toBeHidden();await expect(page.locator('#pane-right')).toBeHidden();await page.locator('.settings-shortcut').click();await expect(settings).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#pane-left')).toBeHidden();await expect(page.locator('#pane-right')).toBeHidden();await page.locator('#toggle-right').click();await expect(page.locator('#message')).toHaveValue('打开设置后仍保留的草稿')
 await page.keyboard.press('ControlOrMeta+,');await expect(settings).toBeVisible();await page.getByRole('button',{name:'模型服务',exact:true}).click();await page.screenshot({path:test.info().outputPath('pliuna-settings-real-models.png')})
 for(const width of [760,390]){await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0]!.setContentSize(w,850),width);for(const name of ['外观','模型服务','权限与审批','插件与主流程','存储与恢复','关于 Pliuna']){await page.getByRole('button',{name,exact:true}).click();expect(await page.locator('.settings-content').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)}}
 await page.getByRole('button',{name:'模型服务',exact:true}).click();await page.screenshot({path:test.info().outputPath('pliuna-settings-real-mobile.png')});expect(errors).toEqual([])
 const beforeRestart=server.exchanges.length;await app.close();app=await launch();page=await app.firstWindow();await page.getByRole('button',{name:'设置 ⌘ ,',exact:true}).click();await expect(page.locator('.channel-card')).toContainText('共享测试渠道');await expect(page.locator('.channel-model')).toHaveCount(2);expect(server.exchanges).toHaveLength(beforeRestart)
 }finally{await app.close();await server.close();await rm(root,{recursive:true,force:true})}
})

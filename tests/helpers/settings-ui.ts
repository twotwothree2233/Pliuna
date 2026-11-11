import { expect, type Page } from '@playwright/test'
export async function openSettings(page: Page, section: '外观'|'模型服务'|'权限与审批'|'插件与主流程'|'存储与恢复'='模型服务') {
  if (!await page.getByRole('dialog',{name:'应用设置',exact:true}).count()) await page.getByRole('button',{name:/^设置(?: (?:⌘ ,|Ctrl\+,))?$/}).click()
  await expect(page.getByRole('dialog',{name:'应用设置',exact:true})).toBeVisible()
  await page.getByRole('button',{name:section,exact:true}).click()
}
export async function closeSettings(page: Page) {
  await page.getByRole('button',{name:/^返回工作区/}).click()
  await expect(page.getByRole('dialog',{name:'应用设置',exact:true})).toHaveCount(0)
}
export async function chooseModel(page: Page, id: string) { await openSettings(page); await page.getByLabel('本次模型',{exact:true}).selectOption(id);await closeSettings(page) }
export async function chooseTheme(page: Page, theme: string) {
  await openSettings(page,'外观')
  if(theme==='system') await page.getByRole('checkbox',{name:'跟随系统',exact:true}).check()
  else await page.locator(`.theme-option[data-theme=${theme}]`).click()
  await closeSettings(page)
}
export async function configureModel(page: Page, input: { id: string; url: string; key: string; model: string; context: number; output?: number; remember?: boolean }) {
  const response=await page.evaluate(async input=>window.pliuna.request({type:'model.configure',configuration:{id:input.id,base_url:input.url,wire_model_id:input.model,context_tokens:input.context,...(input.output===undefined?{}:{max_output_tokens:input.output}),compatibility_profile:'chat-max-tokens'},api_key:input.key,confirm_memory_only:true,remember_connection:!!input.remember,...(input.remember?{confirm_plaintext_storage:true as const}:{})}),input)
  expect(response.ok).toBe(true)
}
export async function addChannel(page: Page, input: { name: string; url: string; key: string; remember?: boolean }) {
  await openSettings(page)
  await page.getByRole('button',{name:'＋ 添加渠道',exact:true}).click()
  await page.getByLabel('渠道名称').fill(input.name)
  await page.getByLabel('服务 Base URL').fill(input.url)
  await page.getByLabel('API Key',{exact:true}).fill(input.key)
  await page.getByRole('checkbox',{name:/^记住渠道连接/}).setChecked(input.remember??false)
  await page.getByRole('button',{name:'保存渠道',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'添加渠道',exact:true})).toHaveCount(0)
}
export async function addModel(page: Page, input: { name: string; model: string; context: number; output?: number }) {
  await page.getByRole('button',{name:'＋ 添加模型',exact:true}).click()
  await page.getByLabel('模型名称').fill(input.name)
  await page.getByLabel('精确模型标识').fill(input.model)
  await page.getByLabel('已知上下文容量').fill(String(input.context))
  if(input.output!==undefined) await page.getByLabel('输出上限（留空由服务决定）').fill(String(input.output))
  await page.getByRole('button',{name:'保存模型',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'添加模型',exact:true})).toHaveCount(0)
}
export async function testRole(page: Page, role: '主模型'|'审批模型'|'压缩模型', name?: string) {
  const row=name?page.locator('.channel-model').filter({has:page.getByText(name,{exact:true})}):page.locator('.channel-model').first()
  const details=row.locator('details');if(!await details.evaluate(el=>(el as HTMLDetailsElement).open))await details.locator('summary').click()
  await row.getByRole('button',{name:'测试并启用'+role,exact:true}).click()
  await page.getByRole('button',{name:'确认费用并开始测试',exact:true}).click()
  await expect(row.locator('.badge')).toContainText(role)
}

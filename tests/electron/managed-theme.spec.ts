import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, hostToolStream } from '../helpers/model-server'
import { chooseTheme } from '../helpers/settings-ui'
import type { Bundle } from '../../src/shared/contracts.generated'
const electronPath: string = createRequire(import.meta.url)('electron')

test('managed presentation follows all themes without changing drafts or SVG series', async () => {
  let surface: { id: string; revision: number }
  let completed = false
  const bundle: Bundle = {
    profile: 'managed-v1',
    html: '<article class="sheet"><h1 id="heading">Theme-aware content</h1><p id="gradient" class="gradient">Gradient text stays visible</p><p id="variable-gradient" class="variable-gradient">Variable gradient</p><section id="panel" class="panel"><p id="inline" style="color:#111!important;background:var(--card)!important;border:2px solid var(--edge);box-shadow:0 3px 9px black;padding:13px">Inline presentation</p><p id="variables" class="variables">Variable shorthand colors</p><p id="clear" class="clear">Transparent surface</p><a id="link" href="#heading"><span id="link-text" style="color:#123!important">Local heading</span></a><button id="control"><span id="control-text" style="color:#123!important">Action</span></button><label for="draft">Unsaved draft</label><input id="draft" type="text"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30" aria-label="Data palette"><circle id="series-a" class="series" cx="15" cy="15" r="10"/><circle id="series-b" cx="45" cy="15" r="10" fill="#217d96"/></svg></section></article>',
    css: '.sheet{--ink:#101520;--edge:#2f6fed;--card:#fff;--wash:linear-gradient(red,blue);color:var(--ink)}.panel{background:linear-gradient(#fff,#eee);border:1px solid red;box-shadow:0 3px 9px #000}.variables{background:var(--card);border-bottom:3px solid var(--edge);border-inline-end:4px solid var(--edge);outline:2px solid var(--edge);text-decoration:underline var(--edge);column-rule:2px solid var(--edge)}.sheet .panel a,.sheet .panel a span,.sheet .panel button,.sheet .panel button span,.sheet .panel input{color:var(--ink)}.sheet .panel button,.sheet .panel input{background:var(--card);border:2px solid var(--edge)}.clear{background:rgba(0,0,0,0);border:1px solid transparent}.series{color:#d02020;fill:currentColor}.gradient{background:linear-gradient(red,blue)}.gradient{color:transparent;-webkit-text-fill-color:transparent;background-clip:text}.variable-gradient{background:var(--wash)}@media(min-width:0px){.sheet h1{color:#141526}}',
    state: { schema: { type: 'object', properties: { draft: { type: 'string' } }, additionalProperties: false }, initial: { draft: '' }, compatibility_version: 'theme-v1' },
    forms: [], behaviors: [{ type: 'input', element_id: 'draft', field: '/draft', control: 'text' }], references: [], export: []
  }
  const server = await modelServer(({ body }, res) => {
    if (synthetic(body, res)) return
    if (body.messages.at(-1).role === 'tool') { textStream(res, 'Published'); completed = true; return }
    hostToolStream(res, 'write', { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [{ type: 'view.create', client_ref: 'theme-test', slot_id: 'main', bundle: { type: 'inline', bundle } }] })
  })
  const directory = await mkdtemp(join(tmpdir(), 'pliuna-managed-theme-'))
  const app = await electron.launch({ executablePath: electronPath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: directory } })
  try {
    const page = await app.firstWindow()
    const call = (request: unknown) => page.evaluate(async request => {
      const result = await window.pliuna.request(request as any)
      if (!result.ok) throw Error(result.error.code)
      return result.data as any
    }, request)
    await call({ type: 'model.configure', configuration: { id: 'theme-test', base_url: server.url, wire_model_id: 'wire', context_tokens: 100000, max_output_tokens: 8192, compatibility_profile: 'chat-max-tokens' }, api_key: 'synthetic-theme-key', confirm_memory_only: true })
    await call({ type: 'model.test', model_id: 'theme-test', role: 'main', confirm_cost: true })
    await page.getByRole('button', { name: '创建第一个任务', exact: true }).click()
    await page.getByLabel('任务名称').fill('Managed colors')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()
    const task = (await call({ type: 'host.tasks' }))[0]
    surface = (await call({ type: 'task.snapshot', task_id: task.id })).surface
    await call({ type: 'task.submit', task_id: task.id, text: 'Publish a themed view', model_config_id: 'theme-test', attachments: [] })
    await expect(page.getByRole('heading', { name: 'Theme-aware content', exact: true })).toBeVisible()
    await expect.poll(() => completed).toBe(true)
    await page.getByLabel('Unsaved draft', { exact: true }).fill('retain this input')
    await page.getByLabel('Unsaved draft', { exact: true }).evaluate(element => { element.dataset.themeIdentity = 'original' })
    const exchanges = server.exchanges.length
    for (const theme of ['graphite', 'paper', 'midnight', 'dusk', 'moss', 'blueprint']) {
      await chooseTheme(page, theme)
      const colors = await page.locator('.managed').evaluate(element => {
        const shadow = element.querySelector('.view-boundary>div')!.shadowRoot!
        const style = (id: string) => getComputedStyle(shadow.querySelector(`[id$="-${id}"]`)!)
        const probe = document.createElement('div')
        probe.style.cssText = 'color:var(--fg);background:var(--block);border:1px solid var(--line);outline-color:var(--accent);text-decoration-color:var(--bg);column-rule-color:var(--accent-ink);box-shadow:var(--elevation)'
        document.body.append(probe)
        const expected = getComputedStyle(probe), panel = style('panel'), inline = style('inline'), clear = style('clear'), variables = style('variables'), control = style('control'), input = style('draft')
        const result = {
          heading: style('heading').color,
          gradient: [style('gradient').color, style('gradient').webkitTextFillColor],
          panel: [panel.backgroundColor, panel.borderTopColor, panel.boxShadow, panel.backgroundImage],
          inline: [inline.color, inline.backgroundColor, inline.borderTopColor, inline.boxShadow, inline.padding],
          variables: [variables.backgroundColor, variables.borderBottomColor, variables.borderRightColor, variables.outlineColor, variables.textDecorationColor, variables.columnRuleColor, variables.borderBottomWidth, variables.borderRightWidth, variables.outlineWidth],
          variableGradient: [style('variable-gradient').backgroundImage, style('variable-gradient').backgroundColor],
          link: [style('link').color, style('link-text').color],
          control: [control.color, style('control-text').color, control.backgroundColor, control.borderTopColor],
          input: [input.color, input.backgroundColor, input.borderTopColor],
          transparent: [clear.backgroundColor, clear.borderTopColor],
          series: [style('series-a').fill, style('series-b').fill],
          expected: { foreground: expected.color, surface: expected.backgroundColor, line: expected.borderTopColor, shadow: expected.boxShadow, accent: expected.outlineColor, accentInk: expected.columnRuleColor, background: expected.textDecorationColor }
        }
        probe.remove()
        return result
      })
      expect(colors.heading).toBe(colors.expected.foreground)
      expect(colors.gradient).toEqual([colors.expected.foreground, colors.expected.foreground])
      expect(colors.panel).toEqual([colors.expected.surface, colors.expected.line, colors.expected.shadow, 'none'])
      expect(colors.inline).toEqual([colors.expected.foreground, colors.expected.surface, colors.expected.line, colors.expected.shadow, '13px'])
      expect(colors.variables).toEqual([colors.expected.surface, ...Array(5).fill(colors.expected.line), '3px', '4px', '2px'])
      expect(colors.variableGradient).toEqual(['none', colors.expected.surface])
      expect(colors.link).toEqual([colors.expected.accent, colors.expected.accent])
      expect(colors.control).toEqual([colors.expected.accentInk, colors.expected.accentInk, colors.expected.accent, colors.expected.accent])
      expect(colors.input).toEqual([colors.expected.foreground, colors.expected.background, colors.expected.line])
      expect(colors.transparent).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'])
      expect(colors.series).toEqual(['rgb(208, 32, 32)', 'rgb(33, 125, 150)'])
      await expect(page.getByLabel('Unsaved draft', { exact: true })).toHaveValue('retain this input')
      await expect(page.getByLabel('Unsaved draft', { exact: true })).toHaveAttribute('data-theme-identity', 'original')
    }
    expect(server.exchanges).toHaveLength(exchanges)
  } finally {
    // The input-retention check can leave a beforeunload guard active. Destroy
    // fixture windows so teardown never races Playwright's dialog handling.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app.close().catch(() => {})
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

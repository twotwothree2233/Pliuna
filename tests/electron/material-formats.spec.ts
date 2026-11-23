import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { binaryPreviewChunk, binaryPreviewLimit } from '../../src/shared/material-formats'
import { pdfFixture } from '../helpers/pdf-fixture'

const executablePath: string = createRequire(import.meta.url)('electron')

for (const transport of ['desktop', 'web'] as const) test(`${transport} imports and previews more material formats`, async () => {
  test.setTimeout(45000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-material-formats-'))
  let app: ElectronApplication | undefined
  try {
    let port = 0
    if (transport === 'web') {
      const server = createServer()
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      port = (server.address() as { port: number }).port
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
    app = await electron.launch({ executablePath, args: ['.'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PLIUNA_TEST_DATA: join(root, 'data'), PLIUNA_WEB: port ? '1' : '', PLIUNA_WEB_PORT: String(port) } })
    const page = await app.firstWindow(), errors: string[] = [], network: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (request.url().startsWith('https://invalid.example/')) network.push(request.url()) })
    await page.getByRole('button', { name: '创建第一个任务' }).click()
    await page.getByLabel('任务名称').fill('格式预览')
    await page.getByRole('button', { name: '创建任务', exact: true }).click()

    const png = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 360
      const context = canvas.getContext('2d')!, image = context.createImageData(360, 360)
      let seed = 1
      for (let i = 0; i < image.data.length; i++) {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
        image.data[i] = (i + 1) % 4 === 0 ? 255 : seed >>> 24
      }
      context.putImageData(image, 0, 0)
      return canvas.toDataURL('image/png').split(',')[1]!
    }), 'base64')
    expect(png.byteLength).toBeGreaterThan(binaryPreviewChunk)
    const csv = '\ufeff城市,备注\r\n上海,"一,二"\r\n北京,"跨行\n""引号"""\r\n'
    const oversizedScan = pdfFixture(['Scan caption', 'Readable next page'], { firstPageImage: { width: 4001, height: 4000 } })
    expect(oversizedScan.byteLength).toBeLessThan(binaryPreviewLimit)
    const fixtures: [string, string | Buffer][] = [
      ['地图.PNG', png], ['报告.pdf', pdfFixture(undefined, { activityUrl: 'https://invalid.example/pdf' })],
      ['大像素扫描.pdf', oversizedScan],
      ['项目.csv', csv], ['记录.tsv', '名称\t值\n记录\t"带\t制表符"'], ['脚本.py', 'def report():\n    return 42\n'],
      ['错误.gif', Buffer.alloc(binaryPreviewChunk + 1)], ['空图.webp', ''], ['大图.jpg', Buffer.alloc(binaryPreviewLimit + 1)]
    ]
    await Promise.all(fixtures.map(([name, content]) => writeFile(join(root, name), content)))
    await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }) }, fixtures.map(([name]) => join(root, name)))
    await page.getByRole('tab', { name: '材料', exact: true }).click()
    await page.getByRole('button', { name: '选择文件导入', exact: true }).click()
    const resources = page.getByRole('region', { name: '全部资源分页浏览' })
    const article = resources.getByRole('article', { name: '材料详情' })
    const open = (name: string) => resources.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).click()
    await open('地图.PNG')
    const img = article.getByRole('img', { name: '地图.PNG', exact: true })
    await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(360)
    await open('报告.pdf')
    const pdf = article.getByRole('region', { name: 'PDF 预览' })
    await expect(pdf.getByText('第 1 页 / 共 2 页')).toBeVisible()
    await expect(pdf.getByRole('img', { name: '报告.pdf，第 1 页' })).toBeVisible()
    await pdf.getByRole('button', { name: '下一页' }).click()
    const canvas = pdf.getByRole('img', { name: '报告.pdf，第 2 页' })
    await expect(canvas).toBeVisible()
    // Confirm there is rendered ink, rather than just a mounted canvas.
    expect(await canvas.evaluate((node: HTMLCanvasElement) => node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data.some((value, i) => i % 4 === 0 && value < 100))).toBe(true)
    await expect(pdf.getByRole('button', { name: '下一页' })).toBeDisabled()
    await article.getByRole('button', { name: '来源与记录' }).click()
    await expect(article.getByText('只读原记录')).toBeVisible()

    await open('大像素扫描.pdf')
    await expect(pdf.getByText('无法显示此页。')).toBeVisible()
    await expect(pdf.getByRole('img', { name: '大像素扫描.pdf，第 1 页' })).toBeHidden()
    await pdf.getByRole('button', { name: '下一页' }).click()
    await expect(pdf.getByRole('img', { name: '大像素扫描.pdf，第 2 页' })).toBeVisible()

    await open('项目.csv')
    const table = article.getByRole('table', { name: '表格预览' })
    await expect(table.getByRole('row')).toHaveCount(3)
    await expect(table.getByRole('cell', { name: '一,二' })).toBeVisible()
    await expect(table.getByRole('cell', { name: '跨行 "引号"' })).toBeVisible()
    await article.getByRole('button', { name: '查看原文' }).click()
    await expect(article.locator('code')).toContainText('"一,二"')
    await article.getByRole('button', { name: '返回表格' }).click()
    await expect(table).toBeVisible()
    await open('记录.tsv')
    await expect(table.getByRole('cell', { name: '带 制表符' })).toBeVisible()
    await open('脚本.py')
    await expect.poll(() => article.locator('pre code').textContent()).toBe('def report():\n    return 42\n')
    await open('错误.gif')
    await expect(article.getByRole('alert')).toContainText('文件内容与格式不符')
    await open('空图.webp')
    await expect(article.getByText('文件为空。')).toBeVisible()
    await open('大图.jpg')
    await expect(article.getByText('此文件超过 8 MB，已保存原件。')).toBeVisible()

    const failures = await page.evaluate(async chunk => {
      const request = window.pliuna.request
      const tasks = await request({ type: 'host.tasks' })
      const other = await request({ type: 'task.create', title: '另一任务' })
      if (!tasks.ok || !other.ok) throw Error('Failed to get tasks')
      const task_id = (tasks.data as { id: string }[])[0]!.id
      const list = await request({ type: 'task.query', task_id, query: { type: 'list', input: { kind: 'resource' } } })
      if (!list.ok) throw Error('Failed to list files')
      const items = (list.data as { items: { id: string; display_name: string }[] }).items
      const preview = { type: 'material.read', representation: 'preview', task_id } as const
      const png = items.find(item => item.display_name === '地图.PNG')!.id
      const gif = items.find(item => item.display_name === '错误.gif')!.id
      const checks = await Promise.all([
        request({ ...preview, task_id: (other.data as { task: { id: string } }).task.id, resource_id: png }),
        request({ ...preview, resource_id: png, offset: 1 }),
        request({ ...preview, resource_id: gif, offset: chunk })
      ])
      return checks.map(value => value.ok ? null : value.error.code)
    }, binaryPreviewChunk)
    expect(failures).toEqual(['IMPORT_NOT_FOUND', 'RESOURCE_RANGE_INVALID', 'UNSUPPORTED_REPRESENTATION'])
    if (transport === 'web') {
      const imageRow = resources.getByRole('group', { name: '地图.PNG', exact: true })
      await imageRow.getByRole('button', { name: '删除', exact: true }).click()
      await page.getByRole('dialog', { name: '删除材料' }).getByRole('button', { name: '确认删除', exact: true }).click()
      await expect(imageRow).toHaveCount(0)
    }
    expect(network).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {})
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})

import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
const text = readFileSync('tests/electron/candidate-business.spec.ts', 'utf8')
const start = text.indexOf("      await panel.getByRole('button', { name: '从文件夹导入固定包' })")
const end = text.indexOf("      await panel.getByRole('checkbox'", start)
if (start < 0 || end < 0) throw Error('REAL_PLUGIN_IMPORT_SEQUENCE_REQUIRED')
const sequence = text.slice(start, end).replace(/page!/g, 'page')
const execute = new (Object.getPrototypeOf(async function () {}).constructor)('panel', 'page', 'expect', sequence)
it('awaits the exact actionable trust control before asserting the imported text', async () => {
  let imported = false, asserted = false
  const card: any = { getByRole: (_role: string, options: {name: string}) => ({ click: async () => { expect(options.name).toBe('核对代码信任'); imported = true } }), filter: () => card }
  const panel = { getByRole: (_role: string, options: {name: string}) => ({ click: async () => { if (options.name === '核对代码信任') imported = true } }), locator: () => card }
  const page = { getByRole: (_role: string, options: {name: string}) => { expect(options.name).toBe('trellis.pdf-text 1.0.0'); return {} } }
  await execute(panel, page, () => ({ toContainText: async (value: string) => { asserted = true; expect(value).toBe('trellis.pdf-text'); expect(imported).toBe(true) } }))
  expect(asserted).toBe(true)
})
it('keeps the original action/scenario budgets and does not catch an import failure', async () => {
  const failed = { click: async () => { throw Error('PLUGIN_IMPORT_NOT_READY') } }
  const panel = { getByRole: () => failed, locator: () => ({ filter: () => ({ getByRole: () => failed }) }) }
  await expect(execute(panel, { getByRole: () => ({}) }, () => ({ toContainText: async () => {} }))).rejects.toThrow('PLUGIN_IMPORT_NOT_READY')
  expect(sequence).not.toContain('timeout:'); expect(text).toContain('test.setTimeout(90000)')
})

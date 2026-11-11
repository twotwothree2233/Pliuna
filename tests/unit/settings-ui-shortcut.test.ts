import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { shortcutLabel } from '../../src/renderer/src/desktop-platform'

const source = readFileSync('tests/helpers/settings-ui.ts', 'utf8')
const literal = source.match(/getByRole\('button',\{name:(\/[^\n]+?\/)\}\)/)?.[1]
if (!literal) throw Error('SETTINGS_BUTTON_LOCATOR_REQUIRED')
const name: RegExp = runInNewContext(literal)

it.each(['darwin', 'win32', 'linux'])('matches the actual rendered settings label on %s', platform => {
  expect(name.test('设置 ' + shortcutLabel(',', platform))).toBe(true)
})
it('retains the plain settings entry and refuses unrelated buttons', () => {
  expect(name.test('设置')).toBe(true)
  for (const value of ['设置 Ctrl+N', '设置 Ctrl+Enter', '重置设置 Ctrl+,', '设置其他', '设置 ⌘N']) expect(name.test(value)).toBe(false)
})

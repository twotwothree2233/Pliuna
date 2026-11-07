import { expect, it } from 'vitest'
import { desktopPlatform, shortcutLabel } from '../../src/renderer/src/desktop-platform'

it('uses the real preload platform before browser hints', () => {
  expect(desktopPlatform('win32', 'MacIntel')).toBe('win32')
  expect(desktopPlatform('darwin', 'Win32')).toBe('darwin')
  expect(desktopPlatform(undefined, 'MacIntel')).toBe('darwin')
  expect(desktopPlatform(undefined, 'Win32')).toBe('win32')
  expect(desktopPlatform(undefined, 'Linux x86_64')).toBe('linux')
})
it('keeps Mac hints and uses Control on Windows and Linux', () => {
  expect((['N', ',', 'Enter'] as const).map(key => shortcutLabel(key, 'darwin'))).toEqual(['⌘N', '⌘ ,', '⌘ ↵'])
  for (const platform of ['win32', 'linux']) {
    expect(shortcutLabel('N', platform)).toBe('Ctrl+N')
    expect(shortcutLabel(',', platform)).toBe('Ctrl+,')
    expect(shortcutLabel('Enter', platform)).toBe('Ctrl+Enter')
  }
})

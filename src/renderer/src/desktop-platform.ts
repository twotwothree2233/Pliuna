// The sandboxed preload reports the real host. Browser previews use the browser
// platform only when no native bridge exists.
export function desktopPlatform(host = typeof window === 'undefined' ? undefined : window.pliuna?.platform, browser = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return host ?? (/Mac/.test(browser) ? 'darwin' : /Win/.test(browser) ? 'win32' : 'linux')
}
export function shortcutLabel(key: 'N' | ',' | 'Enter', platform = desktopPlatform()): string {
  if (platform !== 'darwin') return 'Ctrl+' + key
  return key === 'Enter' ? '⌘ ↵' : key === ',' ? '⌘ ,' : '⌘N'
}

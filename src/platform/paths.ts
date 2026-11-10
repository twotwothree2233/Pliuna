import path from 'node:path'

const invalid = (): never => { throw Object.assign(Error('FILE_PATH_INVALID'), { code: 'FILE_PATH_INVALID' }) }

// Host paths and protocol-relative paths have different grammars.
export function absoluteFilePath(value: string, platform = process.platform): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) return invalid()
  if (platform !== 'win32') {
    if (!path.posix.isAbsolute(value)) return invalid()
    return path.posix.normalize(value)
  }
  let file = value.replaceAll('/', '\\')
  if (/^\\\\\?\\UNC\\/i.test(file)) file = '\\\\' + file.slice(8)
  else if (/^\\\\\?\\[a-z]:\\/i.test(file)) file = file.slice(4)
  else if (/^\\\\[?.]\\/.test(file)) return invalid()
  // Root-relative and drive-relative paths depend on ambient process state.
  if (!/^[a-z]:\\/i.test(file) && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(file)) return invalid()
  file = path.win32.normalize(file)
  const root = path.win32.parse(file).root
  for (const part of file.slice(root.length).split('\\').filter(Boolean)) {
    if (/[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return invalid()
  }
  return file
}

export function pathWithin(root: string, file: string, platform = process.platform): boolean {
  const api = platform === 'win32' ? path.win32 : path.posix
  const relative = api.relative(absoluteFilePath(root, platform), absoluteFilePath(file, platform))
  return relative === '' || (!api.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + api.sep))
}

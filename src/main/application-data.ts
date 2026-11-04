import { join, resolve } from 'node:path'
import { mkdirSync, lstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export function applicationDirectory(home: string, override?: string): string {
  return override ? resolve(override) : join(home, '.trellis')
}

export function prepareApplicationDirectory(directory: string, platform = process.platform): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('SETTINGS_DIRECTORY_INVALID')
  // A leading dot is not a Windows hidden attribute. Do not use a shell or interpolate paths.
  if (platform === 'win32') execFileSync('attrib.exe', ['+H', directory], { windowsHide: true })
}

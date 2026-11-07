import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { win32 } from 'node:path'
import { assertDirectorySync,openRegularFileSync,regularFile,sameFileIdentity } from './files'
import { absoluteFilePath } from './paths'

// Static script: paths are environment data, never PowerShell source/arguments.
const windowsPrivateAcl = `
$ErrorActionPreference = 'Stop'
$path = $env:TRELLIS_PRIVATE_PATH
$directory = $env:TRELLIS_PRIVATE_KIND -eq 'directory'
$attributes = [System.IO.File]::GetAttributes($path)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe reparse point' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ($directory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user, $system)) {
  if ($directory) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  } else { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow') }
  $acl.AddAccessRule($rule)
}
if ($directory) { [System.IO.Directory]::SetAccessControl($path, $acl); $actual = [System.IO.Directory]::GetAccessControl($path) }
else { [System.IO.File]::SetAccessControl($path, $acl); $actual = [System.IO.File]::GetAccessControl($path) }
if (-not $actual.AreAccessRulesProtected) { throw 'Unprotected ACL' }
$seenUser = $false
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -notin @($user.Value, $system.Value)) { throw 'Unexpected principal' }
    if ($rule.IdentityReference.Value -eq $user.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $seenUser = $true }
  }
}
if (-not $seenUser) { throw 'Current user cannot own private data' }
if ($directory -and $env:TRELLIS_PRIVATE_HIDDEN -eq '1') { [System.IO.File]::SetAttributes($path, $attributes -bor [System.IO.FileAttributes]::Hidden) }
`

export function protectPrivatePath(file: string, kind: 'file' | 'directory', hidden = false): void {
  file = absoluteFilePath(file)
  if (kind === 'directory') assertDirectorySync(file)
  else regularFile(fs.lstatSync(file))
  const before = fs.lstatSync(file)
  if (process.platform !== 'win32') {
    const fd = kind === 'file' ? openRegularFileSync(file) : fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0))
    try {
      if (!sameFileIdentity(before, fs.fstatSync(fd))) throw Error('FILE_CHANGED')
      fs.fchmodSync(fd, kind === 'directory' ? 0o700 : 0o600)
    } finally { fs.closeSync(fd) }
    return
  }
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw Error('FILE_PERMISSIONS_UNAVAILABLE')
  const powershell = win32.join(absoluteFilePath(systemRoot, 'win32'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsPrivateAcl, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 15000, stdio: 'pipe',
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        TRELLIS_PRIVATE_PATH: win32.toNamespacedPath(file), TRELLIS_PRIVATE_KIND: kind, TRELLIS_PRIVATE_HIDDEN: hidden ? '1' : '0' }
    })
    const after = fs.lstatSync(file)
    if (!sameFileIdentity(before, after) || after.isSymbolicLink()) throw Error()
  } catch { throw Error('FILE_PERMISSIONS_UNAVAILABLE') }
}

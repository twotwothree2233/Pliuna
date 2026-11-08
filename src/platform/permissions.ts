import { fileLstatSync,fileFstatSync } from './files'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { win32 } from 'node:path'
import { assertDirectorySync,openRegularFileSync,regularFile,sameFileIdentity } from './files'
import { absoluteFilePath } from './paths'
import { protectWindowsPath } from './windows-acl'

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
function Test-PrivateAcl($candidate) {
  if (-not $candidate.AreAccessRulesProtected) { return $false }
  $rules = @($candidate.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $requiredCount = if ($user.Value -eq $system.Value) { 1 } else { 2 }
  if ($rules.Count -ne $requiredCount) { return $false }
  $seen = [System.Collections.Generic.HashSet[string]]::new()
  $inheritance = if ($directory) { [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [System.Security.AccessControl.InheritanceFlags]::None }
  foreach ($rule in $rules) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or
        $rule.IdentityReference.Value -notin @($user.Value, $system.Value) -or
        $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne $inheritance -or
        $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
        -not $seen.Add($rule.IdentityReference.Value)) { return $false }
  }
  return $true
}
if ($directory) { $actual = [System.IO.Directory]::GetAccessControl($path) }
else { $actual = [System.IO.File]::GetAccessControl($path) }
# Reapplying an equivalent inheritable ACL changes child metadata on NTFS.
# Verify every time, but write only when the exact private ACL is missing.
if (-not (Test-PrivateAcl $actual)) {
  if ($directory) { [System.IO.Directory]::SetAccessControl($path, $acl); $actual = [System.IO.Directory]::GetAccessControl($path) }
  else { [System.IO.File]::SetAccessControl($path, $acl); $actual = [System.IO.File]::GetAccessControl($path) }
}
if (-not (Test-PrivateAcl $actual)) { throw 'Private ACL verification failed' }
if ($directory -and $env:TRELLIS_PRIVATE_HIDDEN -eq '1' -and ($attributes -band [System.IO.FileAttributes]::Hidden) -eq 0) { [System.IO.File]::SetAttributes($path, $attributes -bor [System.IO.FileAttributes]::Hidden) }

`

export function protectPrivatePath(file: string, kind: 'file' | 'directory', hidden = false): void {
  file = absoluteFilePath(file)
  if (kind === 'directory') assertDirectorySync(file)
  else regularFile(fileLstatSync(file))
  const before = fileLstatSync(file)
  if (process.platform !== 'win32') {
    const fd = kind === 'file' ? openRegularFileSync(file) : fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_DIRECTORY ?? 0))
    try {
      if (!sameFileIdentity(before, fileFstatSync(fd))) throw Error('FILE_CHANGED')
      fs.fchmodSync(fd, kind === 'directory' ? 0o700 : 0o600)
    } finally { fs.closeSync(fd) }
    return
  }
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw Error('FILE_PERMISSIONS_UNAVAILABLE')
  const powershell = win32.join(absoluteFilePath(systemRoot, 'win32'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  try {
    if (protectWindowsPath(file, kind, hidden, before) === 'legacy') execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsPrivateAcl, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 15000, stdio: 'pipe',
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        TRELLIS_PRIVATE_PATH: win32.toNamespacedPath(file), TRELLIS_PRIVATE_KIND: kind, TRELLIS_PRIVATE_HIDDEN: hidden ? '1' : '0' }
    })
    const after = fileLstatSync(file)
    if (!sameFileIdentity(before, after) || after.isSymbolicLink()) throw Error()
  } catch { throw Error('FILE_PERMISSIONS_UNAVAILABLE') }
}

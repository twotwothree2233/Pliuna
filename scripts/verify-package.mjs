import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileManifest, assertCleanPayload, nativeHashes, packageTarget, sha256 } from './package-macos.mjs'

export function verifyManifest(directory) {
  const expected = JSON.parse(readFileSync(join(directory, 'FILES.json'), 'utf8'))
  const actual = fileManifest(directory).filter(entry => entry.path !== 'FILES.json')
  assertCleanPayload(actual)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error('Package manifest mismatch')
  return actual.length
}

export function verifyPackage(directory) {
  const files = verifyManifest(directory), app = join(directory, 'Trellis.app')
  const root = join(app, 'Contents/Resources/app'), pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (pkg.main !== 'out/main/index.js') throw Error('Candidate must use the ordinary entry')
  for (const [name, hash] of Object.entries(nativeHashes)) {
    const file = join(root, 'node_modules', packageTarget.package, name)
    if (sha256(file) !== hash) throw Error('Native asset mismatch')
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', file], { stdio: 'inherit' })
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(JSON.stringify({ files, manifest: true, ad_hoc_signature: true, direct_entry: true, credentials: false }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Usage: node scripts/verify-package.mjs /candidate-directory')
  verifyPackage(resolve(process.argv[2]))
}

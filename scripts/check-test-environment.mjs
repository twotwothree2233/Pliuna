import { mkdtempSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = mkdtempSync(join(tmpdir(), 'trellis-test-environment-'))
try {
  const file = join(root, 'source'), link = join(root, 'link')
  writeFileSync(file, '')
  symlinkSync(file, link, 'file')
  if (realpathSync(link) !== realpathSync(file)) throw Error('Test symlink identity mismatch')
} catch (error) {
  throw new Error('File symlinks are required for platform tests. On Windows enable Developer Mode or grant Create symbolic links; coverage must not be skipped.', { cause: error })
} finally { rmSync(root, { recursive: true, force: true }) }
console.log(`Test host: ${process.platform}/${process.arch}; Node ${process.versions.node}; file symlinks available`)

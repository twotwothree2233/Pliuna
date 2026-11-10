import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { runInNewContext } from 'node:vm'

it('preserves archive bytes with the real candidate HTTP subprocess options', () => {
  const workflow = readFileSync('.github/workflows/cross-platform.yml', 'utf8')
  const calls = workflow.match(/cp\.execFileSync\(curl, \['--disable', '--config', '-'\], \{ input: config, env: curlEnvironment,[\s\S]*?stdio: \['pipe', 'pipe', 'pipe'\] \}\)/g)
  if (!calls || calls.length !== 1) throw Error('CANDIDATE_HTTP_CALL_UNCONFIRMED')
  const expected = Buffer.from([0, 255, 128, 65])
  let executed = false
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'].includes(key.toUpperCase())))
  const result = runInNewContext(calls[0], {
    curl: 'fixture-client', config: 'fixture-only', curlEnvironment: environment,
    cp: {
      execFileSync(_file: string, _args: string[], options: ExecFileSyncOptions) {
        executed = true
        // Only replace the executable/arguments. Node validates and uses the
        // exact production options, including encoding, stdin and byte limits.
        return execFileSync(process.execPath,
          ['-e', 'process.stdout.write(Buffer.from([0,255,128,65]))'], options)
      }
    }
  })
  expect(executed).toBe(true)
  expect(Buffer.isBuffer(result)).toBe(true)
  expect(result).toEqual(expected)
})

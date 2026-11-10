import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'
import { win32 as path } from 'node:path'
import { runInNewContext } from 'node:vm'

const workflow = readFileSync('.github/workflows/cross-platform.yml', 'utf8')
const section = workflow.split('        id: public_tls\n')[1]?.split('      - uses: actions/checkout@')[0]
if (!section) throw Error('NETWORK_PROBE_INLINE_REQUIRED')
const source = section.split('          script: |\n')[1]?.split('\n').map(line => line.replace(/^ {12}/, '')).join('\n')
if (!source) throw Error('NETWORK_PROBE_SOURCE_REQUIRED')
const parser: any = { require: () => ({}) }
runInNewContext(source.split('async function probe(core)')[0] + '\nglobalThis.summarizeError = summarizeError', parser)
const { summarizeError } = parser

it('keeps native security errors and meaningful TLS failures without native codes', () => {
  expect(summarizeError('curl: (35) schannel: next InitializeSecurityContext failed: SEC_E_ILLEGAL_MESSAGE (0x80090326)')).toMatchObject({
    native_codes: ['SEC_E_ILLEGAL_MESSAGE'], native_hex_codes: ['0x80090326']
  })
  expect(summarizeError('curl: (35) schannel: failed to receive handshake, SSL/TLS connection failed').error_phrase)
    .toContain('failed to receive handshake')
  expect(summarizeError('curl: (60) schannel: CRYPT_E_REVOCATION_OFFLINE (0x80092013)').native_codes)
    .toEqual(['CRYPT_E_REVOCATION_OFFLINE'])
})

it('removes URLs, credentials, proxy values, private paths and unknown tokens', () => {
  const text = JSON.stringify(summarizeError('curl: (35) TLS failed https://user:SECRET@proxy.internal:3128 C:\\Users\\PRIVATE\\client.key "PRIVATE_TOKEN" 10.12.13.14:1234'))
  for (const secret of ['SECRET', 'proxy.internal', 'proxy internal', '3128', 'PRIVATE', 'user', '10.12.13.14', '1234']) expect(text).not.toContain(secret)
  expect(text).toContain('TLS failed')
})

async function replay({ exit = 35, stderr = 'curl: (35) schannel: failed to receive handshake, SSL/TLS connection failed', foreignHost = false, credentialProxy = false, gitExit = 0, gitTimeout = false } = {}) {
  const calls: { executable: string; args: string[]; options: any; input?: string }[] = []
  const cleanup: string[][] = []
  let saved: any, failure: string | undefined
  const token = 'github-token-must-not-be-forwarded'
  const environment = { RUNNER_NAME: 'DESKTOP-SFE95TP', RUNNER_TEMP: 'C:\\temp', TRELLIS_WIN11_GIT_PROBE: 'C:\\verified\\git.exe', SystemRoot: 'C:\\Windows', TEMP: 'C:\\temp', TMP: 'C:\\temp', TRELLIS_WIN11_EVIDENCE: 'C:\\evidence',
    GITHUB_TOKEN: token, 'INPUT_GITHUB-TOKEN': token, HTTPS_PROXY: credentialProxy ? 'http://user:secret@proxy.invalid' : 'http://proxy.invalid:8080' }
  const spawn = (executable: string, args: string[], options: any) => {
    const call: { executable: string; args: string[]; options: any; input?: string } = { executable, args, options }
    calls.push(call)
    const child: any = new EventEmitter()
    child.pid = 1; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter(); child.kill = () => {}; child.unref = () => {}; child.stdout.destroy = () => {}; child.stderr.destroy = () => {}
    const complete = () => queueMicrotask(() => {
      if (executable.endsWith('git.exe')) {
        if (gitTimeout) return
        child.stdout.emit('data', Buffer.from(gitExit ? '' : 'a'.repeat(40) + '\tHEAD\n'))
        child.stderr.emit('data', Buffer.from(gitExit ? 'fatal: unable to access https://github.com/actions/checkout.git: Empty reply from server' : ''))
        child.emit('close', gitExit)
      } else if (args[1] === '--version') {
        child.stdout.emit('data', Buffer.from('curl 8.21.0 (Windows) libcurl/8.21.0 Schannel\nProtocols: http https\n'))
        child.emit('close', 0)
      } else {
        child.stdout.emit('data', Buffer.from(`TRELLIS_TLS_STATUS:${exit ? '000' : '200'}\nTRELLIS_TLS_SECONDS:0.250\n`))
        child.stderr.emit('data', Buffer.from(stderr))
        child.emit('close', exit)
      }
    })
    child.stdin.end = (input: string) => { call.input = input; complete() }
    if (args[1] === '--version' || executable.endsWith('git.exe')) complete()
    return child
  }
  const host = { runner: 'DESKTOP-SFE95TP', standard_user_required: true, elevated: false, administrators_group_present: foreignHost,
    system_account: false, user_interactive: true, session_id: 1, product_type: 1, architecture: 'X64', caption: 'Windows 11 Pro', build: 26300 }
  const box: any = { process: { env: environment, platform: 'win32', arch: 'x64' }, Buffer, core: { setFailed(code: string) { failure = code } },
    setTimeout: (callback: () => void, delay: number) => {
      if (gitTimeout && calls.at(-1)?.executable.endsWith('git.exe')) { queueMicrotask(callback); return 0 }
      return setTimeout(callback, delay)
    }, clearTimeout,
    console: { log() {} }, require: (name: string) => {
      if (name === 'node:fs') return { readFileSync() { return JSON.stringify(host) }, writeFileSync(_file: string, text: string) { saved = JSON.parse(text) } }
      if (name === 'node:path') return path
      if (name === 'node:child_process') return { spawn, execFile(_exe: string, args: string[], _options: any, callback: (error: null) => void) { cleanup.push(args); callback(null) } }
      if (name === 'node:perf_hooks') return { performance }
      return { standardHost() { if (foreignHost) throw Object.assign(Error(), { code: 'STANDARD_WINDOWS11_HOST_REQUIRED' }) } }
    } }
  await runInNewContext('(async () => {' + source + '})()', box)
  expect(JSON.stringify(saved)).not.toContain(token)
  return { calls, saved, failure, environment, cleanup }
}

it('uses a public bounded request without forwarding GitHub credentials or relaxing TLS', async () => {
  const result = await replay()
  expect(result.calls).toHaveLength(3)
  const git = result.calls[0]
  expect(git?.args).toContain('credential.helper=')
  expect(git?.args).toContain('https://github.com/actions/checkout.git')
  expect(git?.options.env.GIT_TERMINAL_PROMPT).toBe('0')
  expect(git?.options.env.GIT_CONFIG_GLOBAL).toBe('NUL')
  expect(git?.options.env).not.toHaveProperty('GITHUB_TOKEN')
  const call = result.calls[2]
  if (!call) throw Error('PUBLIC_TLS_REQUEST_NOT_STARTED')
  expect(call.args).toEqual(['--disable', '--config', '-'])
  expect(call.options.env).not.toHaveProperty('GITHUB_TOKEN')
  expect(call.options.env).not.toHaveProperty('INPUT_GITHUB-TOKEN')
  expect(call.options.env.HTTPS_PROXY).toBe(result.environment.HTTPS_PROXY)
  expect(call.input).toContain('https://api.github.com')
  expect(call.input).toContain('connect-timeout = 10')
  expect(call.input).toContain('max-time = 20')
  expect(call.input).toContain('show-error')
  expect(call.input).not.toMatch(/Authorization|insecure|no-revoke|netrc|verbose|location/)
  expect(result.saved.request).toMatchObject({ exit: 35, http_status: null, transfer_ms: 250 })
  expect(result.saved.request.error_phrase).toContain('failed to receive handshake')
  expect(result.saved.passed).toBe(false)
  expect(result.failure).toBe('PUBLIC_TLS_REQUEST_FAILED')
})

it('requires an actual HTTP 200 and refuses host or credential conflicts before spawning', async () => {
  const success = await replay({ exit: 0, stderr: '' })
  expect(success.saved.passed).toBe(true)
  expect(success.saved.request.http_status).toBe(200)
  expect(success.saved.tls_backend).toBe('Schannel')
  for (const options of [{ foreignHost: true }, { credentialProxy: true }]) {
    const blocked = await replay(options)
    expect(blocked.calls).toHaveLength(0)
    expect(blocked.saved.passed).toBe(false)
    expect(blocked.saved.application_tests).toBe(0)
  }
})

it('still records the strict API result after public Git failure or timeout', async () => {
  for (const options of [{ gitExit: 128 }, { gitTimeout: true }]) {
    const result = await replay({ ...options, exit: 0, stderr: '' })
    expect(result.saved.git.passed).toBe(false)
    expect(result.saved.request.passed).toBe(true)
    expect(result.saved.request.http_status).toBe(200)
    expect(result.saved.passed).toBe(false)
    expect(result.failure).toBe('PUBLIC_GIT_REQUEST_FAILED')
    if (options.gitTimeout) expect(result.cleanup).toEqual([['/PID', '1', '/T', '/F']])
    else expect(result.saved.git.error_phrase).toContain('Empty reply from server')
  }
})

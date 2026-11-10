const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { performance } = require('node:perf_hooks')

const securityCodes = new Set([
  'SEC_E_ILLEGAL_MESSAGE', 'SEC_E_INTERNAL_ERROR', 'SEC_E_INVALID_TOKEN', 'SEC_E_INCOMPLETE_MESSAGE',
  'SEC_E_UNTRUSTED_ROOT', 'SEC_E_WRONG_PRINCIPAL', 'SEC_E_CERT_EXPIRED', 'SEC_E_ALGORITHM_MISMATCH',
  'SEC_E_NO_CREDENTIALS', 'SEC_E_MESSAGE_ALTERED', 'SEC_E_CONTEXT_EXPIRED', 'SEC_E_APPLICATION_PROTOCOL_MISMATCH',
  'CRYPT_E_REVOCATION_OFFLINE', 'CRYPT_E_NO_REVOCATION_CHECK', 'CERT_E_UNTRUSTEDROOT', 'CERT_E_EXPIRED',
  'CERT_E_CN_NO_MATCH', 'CERT_E_REVOKED', 'CERT_E_REVOCATION_FAILURE',
  'WSAECONNRESET', 'WSAETIMEDOUT', 'WSAECONNREFUSED', 'WSAHOST_NOT_FOUND', 'WSATRY_AGAIN', 'WSAENETUNREACH'
])
const safeWords = new Set(('curl schannel openssl ssl tls ssl_tls connection connect connecting handshake failed failure error unknown ' +
  'initial next initializesecuritycontext acquirecredentialshandle certgetcertificatechain unexpected malformed message received receive recv ' +
  'send sending data reset closed aborted eof timeout timed out expired certificate certificates chain trust root issuer local unable get ' +
  'revocation offline algorithm mismatch protocol unsupported invalid incomplete internal wrong principal credentials resolve host proxy ' +
  'tunnel response rejected refused network unreachable while reading writing peer remote server socket syscall ssl_error_syscall ' +
  'to the a an not could was be has with').split(' '))
function summarizeError(stderr) {
  const line = stderr.split(/\r?\n/).find(value => /^curl:\s*\([0-9]{1,3}\)/.test(value)) ?? stderr.split(/\r?\n/).find(value => /schannel|handshake|SSL|TLS/i.test(value)) ?? ''
  // Only a finite vocabulary survives. Never retain a URL, proxy value,
  // certificate subject, account path or unknown token from the error text.
  const privateFree = line.slice(0, 2048).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' [redacted] ')
    .replace(/\b[a-z]:[\\/][^\s]*/gi, ' [redacted] ').replace(/(['"])[^\r\n]*?\1/g, ' [redacted] ')
    .replace(/\b(?:[a-z0-9_-]+\.)+[a-z]{2,}(?::[0-9]+)?\b/gi, ' [redacted] ')
    .replace(/\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]+)?\b/g, ' [redacted] ')
  const codes = [...new Set((privateFree.match(/\b(?:SEC_E|CRYPT_E|CERT_E|WSA)[A-Z0-9_]{2,64}\b/g) ?? []).filter(value => securityCodes.has(value)))].slice(0, 6)
  const hexadecimal = [...new Set((privateFree.match(/\b0x(?:8009|800b|8007)[0-9a-f]{4}\b/gi) ?? []).map(value => '0x' + value.slice(2).toUpperCase()))].slice(0, 6)
  const words = privateFree.match(/[A-Za-z_][A-Za-z0-9_]*|0x[0-9a-f]+/gi) ?? []
  const phrase = words.map(value => securityCodes.has(value) || /^0x(?:8009|800b|8007)[0-9a-f]{4}$/i.test(value) ? value :
    safeWords.has(value.toLowerCase()) ? value : '[redacted]').join(' ').replace(/(?:\[redacted\]\s*)+/g, '[redacted] ').trim().slice(0, 240)
  return { native_codes: codes, native_hex_codes: hexadecimal, error_phrase: phrase || null }
}

const configuration = [
  'url = "https://api.github.com"', 'request = "GET"', 'output = "NUL"', 'silent', 'show-error',
  'retry = 0', 'connect-timeout = 10', 'max-time = 20', 'proto = "=https"',
  'write-out = "TRELLIS_TLS_STATUS:%{http_code}\\nTRELLIS_TLS_SECONDS:%{time_total}\\n"'
].join('\n') + '\n'

module.exports = async function probe(core) {
  const startedAt = performance.now(), deadline = startedAt + 25000
  const report = { stage: 'host', application_tests: 0, credentials_sent: false, tls_verification_enabled: true,
    curl_config_disabled: true, environment_policy: 'same_candidate_network_allowlist', budgets_ms: { version: 3000, connect: 10000, request: 20000, total: 25000 }, passed: false }
  const fail = code => { throw Object.assign(Error(code), { code }) }
  const clean = error => ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EPIPE', 'ENOBUFS'].includes(error?.code) ? error.code : 'TLS_PROBE_FAILED'
  const env = {}
  // The candidate's current Windows/network environment is preserved. No
  // GitHub inputs, token, model configuration or user curlrc enters the child.
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'RUNNER_TRACKING_ID', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  function run(executable, args, budget, input) {
    return new Promise(resolve => {
      const result = { started: false, exit: null, timeout: false, error: null, stdout: '', stderr: '' }
      let child, timer, done = false
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(result) } }
      const stop = (error, timeout = false) => {
        result.error = error; result.timeout = timeout
        try { child?.kill() } catch {}
        finish()
      }
      const remaining = Math.min(budget, deadline - performance.now())
      if (remaining <= 0) { stop('TOTAL_DEADLINE', true); return }
      try {
        child = spawn(executable, args, { env, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
        result.started = Boolean(child.pid)
        timer = setTimeout(() => stop('PROCESS_TIMEOUT', true), remaining)
        child.once('error', error => { result.error = clean(error); finish() })
        for (const [stream, limit] of [['stdout', 8192], ['stderr', 16384]]) child[stream].on('data', value => {
          result[stream] += value.toString('utf8')
          if (Buffer.byteLength(result[stream]) > limit) { result[stream] = ''; stop('OUTPUT_LIMIT') }
        })
        child.once('close', exit => { result.exit = exit; finish() })
        if (input) { child.stdin.on('error', error => stop(clean(error))); child.stdin.end(input) }
      } catch (error) { result.error = clean(error); finish() }
    })
  }
  try {
    require('./windows11-default-data.cjs').standardHost()
    if (!env.SystemRoot || !/^[a-z]:\\/i.test(env.SystemRoot)) fail('SYSTEM_CURL_PATH_UNCONFIRMED')
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      if (env[key] && /(?:^|\/\/)[^/\s]*@/.test(env[key])) fail('NETWORK_ENVIRONMENT_HAS_EMBEDDED_CREDENTIALS')
    }
    const executable = path.join(env.SystemRoot, 'System32', 'curl.exe')
    report.stage = 'version'
    const version = await run(executable, ['--disable', '--version'], 3000)
    if (version.error || version.exit !== 0) fail(version.error ?? 'SYSTEM_CURL_VERSION_FAILED')
    const match = version.stdout.match(/^curl ([0-9]+\.[0-9]+\.[0-9]+)(?:\s|[-+])/)
    if (!match || !/^Protocols:.*\bhttps\b/m.test(version.stdout)) fail('SYSTEM_CURL_HTTPS_UNCONFIRMED')
    report.curl_version = match[1]
    report.tls_backend = version.stdout.match(/\b(?:Schannel|OpenSSL\/[0-9A-Za-z.+-]+|LibreSSL\/[0-9A-Za-z.+-]+|BoringSSL|wolfSSL\/[0-9A-Za-z.+-]+)\b/)?.[0] ?? 'unknown'
    report.stage = 'public_api_tls'
    const requestStartedAt = performance.now()
    const result = await run(executable, ['--disable', '--config', '-'], 20000, configuration)
    report.request = { started: result.started, exit: result.exit, timeout: result.timeout, error: result.error,
      duration_ms: Math.round(performance.now() - requestStartedAt), http_status: null, transfer_ms: null, ...summarizeError(result.stderr) }
    const status = result.stdout.match(/^TRELLIS_TLS_STATUS:([0-9]{3})\r?\nTRELLIS_TLS_SECONDS:([0-9]+(?:\.[0-9]+)?)\r?\n?$/)
    if (status) {
      const value = Number(status[1])
      report.request.http_status = value >= 100 && value <= 599 ? value : null
      report.request.transfer_ms = Math.round(Number(status[2]) * 1000)
    }
    if (result.error || result.exit !== 0) fail(result.error ?? 'PUBLIC_TLS_REQUEST_FAILED')
    if (report.request.http_status !== 200) fail('PUBLIC_TLS_HTTP_NOT_200')
    if (performance.now() > deadline) fail('TOTAL_DEADLINE')
    report.passed = true; report.stage = 'ready'
  } catch (error) {
    report.failed_stage = report.stage; report.stage = 'blocked_environment'
    report.error = /^[A-Z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'TLS_PROBE_FAILED'
  }
  report.duration_ms = Math.round(performance.now() - startedAt)
  fs.writeFileSync(path.join(process.env.TRELLIS_WIN11_EVIDENCE, 'tls-probe.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (!report.passed) core.setFailed(report.error)
  return report
}
module.exports.summarizeError = summarizeError
module.exports.configuration = configuration

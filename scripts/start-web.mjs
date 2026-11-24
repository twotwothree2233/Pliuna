import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

function main() {
  const args = process.argv.slice(2)
  const usage = 'Usage: pnpm start:web [--with-desktop] [--port 4173]'
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(`${usage}\nStarts the built app at http://127.0.0.1:<port>.\nUse --with-desktop to open the desktop window in the same instance. Quit any running desktop instance first.\nRun pnpm build after source changes.`)
    return
  }
  const desktopIndex = args.indexOf('--with-desktop')
  if (desktopIndex !== -1) args.splice(desktopIndex, 1)
  let selectedPort = process.env.PLIUNA_WEB_PORT ?? '4173'
  if (args.length === 2 && args[0] === '--port') selectedPort = args[1]
  else if (args.length === 1 && args[0].startsWith('--port=')) selectedPort = args[0].slice('--port='.length)
  else if (args.length) throw Error(usage)
  if (!/^[1-9]\d{0,4}$/.test(selectedPort) || Number(selectedPort) > 65535) throw Error('Web port must be an integer from 1 to 65535.')

  for (const file of ['out/main/index.js', 'out/main/runtime.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    if (!existsSync(join(root, file))) throw Error('Built application is missing. Run pnpm build before pnpm start:web.')
  }
  const require = createRequire(import.meta.url)
  const env = { ...process.env, PLIUNA_WEB: desktopIndex === -1 ? '1' : 'desktop', PLIUNA_WEB_PORT: selectedPort }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [root], { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true })
  const requestQuit = () => {
    if (!child.connected) return
    child.send('pliuna:web:quit', error => {
      if (error && child.exitCode === null && child.signalCode === null) console.error(`Unable to request Pliuna Web shutdown: ${error.message}`)
    })
  }
  process.on('SIGINT', requestQuit)
  process.on('SIGTERM', requestQuit)
  child.on('error', error => {
    console.error(`Unable to start Pliuna Web: ${error.message}`)
    process.exitCode = 1
  })
  child.on('close', (code, signal) => {
    process.removeListener('SIGINT', requestQuit)
    process.removeListener('SIGTERM', requestQuit)
    process.exitCode = code !== null && code >= 0 ? code : signal ? 128 + (constants.signals[signal] ?? 1) : 1
  })
}

try { main() }
catch (error) { console.error(error instanceof Error ? error.message : 'Unable to start Pliuna Web.'); process.exitCode = 1 }

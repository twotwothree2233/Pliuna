import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostMontyTarget } from '../src/shared/native-targets.mjs'
import { desktopPaths } from './desktop-config.mjs'
import { verifyDesktopPayload } from './desktop-payload.mjs'

export function verifyDesktop(output) {
  if (!isAbsolute(output)) throw Error('Package output must be absolute')
  const target = hostMontyTarget()
  if (!target) throw Error('Unsupported package host')
  const paths = desktopPaths(output, target)
  return { ...verifyDesktopPayload(paths.app, target, join(dirname(paths.app), 'reference-plugins/pdf-text')), ...paths }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(verifyDesktop(process.argv[2])))

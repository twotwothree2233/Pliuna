import { startProcessTree } from '../../src/platform/process-tree'
process.once('message', (spec: Parameters<typeof startProcessTree>[0] & { initial?: unknown }) => {
  const tree = startProcessTree(spec, { runtime: process.execPath,
    message: value => process.send?.({ root: tree.process.pid, value }) })
  tree.process.stdout!.resume(); tree.process.stderr!.resume()
  void tree.ready.then(() => { if (spec.initial) tree.send(spec.initial) })
  void tree.exited.then(() => process.exit())
})

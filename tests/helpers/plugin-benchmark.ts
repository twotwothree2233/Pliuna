import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform, arch } from 'node:os'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { PluginControl } from '../../src/runtime/plugins/control'
import { PluginDirectory, pluginCapabilityId } from '../../src/runtime/plugins/directory'
import { PluginQueries } from '../../src/runtime/plugins/queries'
import { PluginProcesses } from '../../src/runtime/plugins/process'
const count = Number(process.argv[2]), root = mkdtempSync(join(tmpdir(), 'trellis-plugin-scale-'))
const report: Record<string, any> = { packages: count, platform: platform(), arch: arch(), node: process.versions.node, complete: false, cache: 'local temporary filesystem, warm repeated reads; no cache flush', thresholds: { discovery_p95_ms: 100, content_p95_ms: 250, event_loop_p99_ms: 100 }, metrics: {} }
const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable()
const control = new PluginControl(root), directory = new PluginDirectory(root, control), queries = new PluginQueries(directory)
const processes = new PluginProcesses(root, async copy => { await control.executable(copy.digest) }, () => null)
const task = '00000000-0000-4000-8000-000000000001'
async function measure(name: string, work: () => Promise<unknown> | unknown, samples = 5): Promise<any> {
  const times: number[] = []; let result: unknown, bytes = 0
  for (let i = 0; i < samples; i++) { const start = performance.now(); result = await work(); times.push(performance.now() - start); bytes = Math.max(bytes, Buffer.byteLength(JSON.stringify(result) ?? '')) }
  report.metrics[name] = { samples_ms: times.map(t => Math.round(t * 100) / 100), p95_ms: Math.round([...times].sort((a, b) => a - b)[Math.ceil(samples * .95) - 1]! * 100) / 100, max_response_bytes: bytes }
  return result
}
async function main() {
  try {
    if (![1, 20, 100].includes(count)) throw Error('UNSUPPORTED_SCALE')
    const source = join(root, 'source'); await mkdir(source)
    const backend = "require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result=m.method==='initialize'?{protocol_version:'0.1',plugin_id:m.params.plugin_id,capabilities:m.params.capabilities}:m.method==='tools.execute'?{value:m.params.arguments.value}:{accepted:true};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})"
    await writeFile(join(source, 'backend.cjs'), backend)
    await writeFile(join(source, 'workflow.md'), 'Benchmark content. '.repeat(10000))
    const capability = { id: 'echo', description: 'Benchmark echo', when_to_use: 'isolated benchmark', input_schema: { type: 'object' }, output_schema: { type: 'object' }, effect: 'read', timeout_ms: 5000, errors: [], examples: [] }
    await writeFile(join(source, 'echo.json'), JSON.stringify(capability))
    const contributions = [{ id: 'echo', kind: 'tool', entry: 'echo.json', description: 'Benchmark echo' }, ...Array.from({ length: 63 }, (_, n) => ({ id: 'content-' + n, kind: 'skill', entry: 'workflow.md', description: 'Benchmark content' }))]
    let last = ''
    await measure('import_all', async () => {
      for (let n = 0; n < count; n++) {
        await writeFile(join(source, 'manifest.json'), JSON.stringify({ manifest_version: '0.1', protocol_version: '0.1', id: 'benchmark.package-' + n, version: '1.0.0', access_level: 'task', contributes: contributions, backend: { command: process.execPath, args: ['backend.cjs'], entry: 'backend.cjs' } }))
        const copy = await control.install(source); last = copy.digest
        await control.grant(last, { local_code: true, cross_task: false }); const plan = control.plan(task, last)
        await control.enable(task, last, [], plan.fingerprint, false, () => {})
      }
      return { installed: count }
    }, 1)
    await measure('discovery', () => queries.query(task, 'benchmark', { type: 'list', input: { kind: 'capability' } }))
    await measure('management_page', () => directory.list(task))
    await measure('content', () => directory.content(task, last, 'content-0'))
    await measure('first_call', () => processes.execute(control.get(last), task, { call_id: crypto.randomUUID(), capability: 'echo', arguments: { value: 'benchmark' }, references: [], signal: new AbortController().signal, valid() {}, dispatch() {} }), 1)
    await measure('warm_call', () => processes.execute(control.get(last), task, { call_id: crypto.randomUUID(), capability: 'echo', arguments: { value: 'benchmark' }, references: [], signal: new AbortController().signal, valid() {}, dispatch() {} }))
    await measure('capability_contract', () => directory.capability(task, pluginCapabilityId(last, 'echo')))
    await new Promise(resolve => setTimeout(resolve, 30))
    report.event_loop = { p99_ms: Math.round(delay.percentile(99) / 10000) / 100, max_ms: Math.round(delay.max / 10000) / 100 }
    report.rss_mib = Math.round(process.memoryUsage().rss / 1024 ** 2)
    report.meets_baseline = report.metrics.discovery.p95_ms <= 100 && report.metrics.content.p95_ms <= 250 && report.event_loop.p99_ms <= 100
    report.complete = true
  } catch { report.error = 'BENCHMARK_INCOMPLETE'; report.metrics_not_inferred = true }
  finally { delay.disable(); processes.close(); control.close(); await rm(root, { recursive: true, force: true }); console.log(JSON.stringify(report)) }
}
void main()

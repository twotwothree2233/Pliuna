import { expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { captureCheck, generateCheck } from '../../src/runtime/export-check'
import { generateExport } from '../../src/runtime/export-generation'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { digest } from '../../src/runtime/resources'

it('runs the built worker with transferred verified bytes and exact corrupt-image diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trellis-check-worker-')); mkdirSync(join(root, 'resources'))
  const image = { id: 'picture', storage_key: 'picture', sha256: digest(Buffer.from('damaged')), byte_length: 7, media_type: 'image/png', display_name: 'synthetic' }
  const bundle = { profile: 'managed-v1', html: '<section id="lesson">Before<img src="trellis-resource:picture" alt="test">After</section>', css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: '1' }, forms: [], behaviors: [], references: [{ name: 'picture', target: { kind: 'resource', id: image.id } }], export: [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }] }
  const body = Buffer.from(JSON.stringify(bundle)), resource = { ...image, id: 'bundle', storage_key: 'bundle', byte_length: body.length, sha256: digest(body), media_type: 'application/vnd.trellis.bundle+json' }
  writeFileSync(join(root, 'resources', 'bundle'), body); writeFileSync(join(root, 'resources', 'picture'), 'invalid')
  const input = { root, title: 'test', resources: [resource, image], views: [{ bundle_id: resource.id, resource_ids: [image.id] }], answers: [] }
  const captured = captureCheck(input), expected = generateCheck(captured.snapshot)
  expect(expected.issue_codes).toEqual(generateExport(input).issues)
  expect(expected.issues).toContainEqual(expect.objectContaining({ code: 'IMAGE_OMITTED_RESOURCE_CORRUPT' }))
  expect(JSON.stringify(captured.snapshot)).not.toContain(root)
  const bytes = captured.snapshot.bodies.find(b => b.bytes)!.bytes!
  const worker = new Worker(join(process.cwd(), 'out/main/export-check-worker.js'), { workerData: captured.snapshot, transferList: captured.snapshot.bodies.flatMap(b => b.bytes ? [b.bytes.buffer as ArrayBuffer] : []), env: {}, resourceLimits: { maxOldGenerationSizeMb: 256 } })
  expect(bytes.byteLength).toBe(0)
  let result: any
  worker.on('message', message => { result = message })
  await new Promise<void>((resolve, reject) => { worker.on('error', reject); worker.on('exit', code => code === 0 ? resolve() : reject(Error('worker exit ' + code))) })
  expect(result.ok).toBe(true); expect(result.result).toMatchObject(expected)
  expect(result.result.worker_metrics.process_peak_rss_bytes).toBeGreaterThan(0)
})

it('binds damaged-image omissions to their observed file identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'trellis-check-damaged-image-')); mkdirSync(join(root, 'resources'))
  const resource = { id: 'picture', storage_key: 'picture', sha256: digest(Buffer.from('original')), byte_length: 8, media_type: 'image/png', display_name: 'synthetic' }
  const input = { root, title: 'test', resources: [resource], views: [], answers: [] }
  writeFileSync(join(root, 'resources', 'picture'), 'damaged1')
  const before = captureCheck(input)
  writeFileSync(join(root, 'resources', 'picture'), 'damaged2')
  const after = captureCheck(input)
  expect(before.snapshot.bodies[0]).toMatchObject({ error: 'RESOURCE_CORRUPT' })
  expect(before.snapshot.bodies[0]!.bytes).toBeUndefined()
  expect(after.fingerprint).not.toBe(before.fingerprint)
  expect(JSON.stringify(after.snapshot)).not.toContain(root)
})

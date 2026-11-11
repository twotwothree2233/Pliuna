import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { readTextSelection } from '../../src/runtime/plugins/text-selection'
import type { ReadSelection } from '../../src/runtime/model/tool-input'
function saved(text: string | Buffer) {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-text-selection-')), buffer = Buffer.from(text)
  mkdirSync(join(root, 'resources')); writeFileSync(join(root, 'resources', 'text'), buffer)
  const resource = { id: 'r', storage_key: 'text', byte_length: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }
  return { root, resource, read: (selection: ReadSelection, max = 4000, previous?: any, valid = () => {}) => readTextSelection(root, resource, selection, max, previous, undefined, valid) }
}
it.each(['', 'a\r\n中😀\r\nlast', '\ufeff中😀\n'.repeat(3000), '\u0000'.repeat(40000), '😀'.repeat(40000)])('paginates exact body and source coordinates (%#)', async text => {
  const scene = saved(text); let position: any, all = '', offset = 0, result: any
  do {
    result = await scene.read({}, 32000, position); position = result.position
    expect(result.actual_range.start_bytes).toBe(offset); offset = result.actual_range.end_bytes
    expect(Buffer.byteLength(result.data.text)).toBe(offset - result.actual_range.start_bytes)
    expect(result.actual_range.chars).toBeLessThanOrEqual(32000)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(262144)
    all += result.data.text
  } while (!result.completion.selection_complete)
  expect(all).toBe(text); expect(result.completion.full_body_delivered).toBe(true)
})
it('reads original LF lines, long line continuations and an unterminated last line', async () => {
  const line = '中😀'.repeat(12000) + '\r\n', text = 'first\r\n' + line + 'last', scene = saved(text)
  let position: any, result: any, all = '', count = 0
  do { result = await scene.read({ lines: [2, 2] }, 1000, position); all += result.data.text; position = result.position; count++; expect(result.completion.full_body_delivered).toBe(false) } while (!result.completion.selection_complete)
  expect(count).toBeGreaterThan(1); expect(all).toBe(line)
  expect((await scene.read({ lines: [3, 3] })).data.text).toBe('last')
  await expect(scene.read({ lines: [4, 4] })).rejects.toThrow('Start line')
})
it('finds every nonoverlapping literal across blocks and lines with honest source coordinates', async () => {
  const text = 'x\n'.repeat(131070) + 'x' + '中😀\nword\r\nword word\nWORD\nword\nend', scene = saved(text)
  for (const literal of ['中😀\nword', 'word', 'word\r\nword', 'missing']) {
    const expected: number[] = []; for (let index = text.indexOf(literal); index >= 0; index = text.indexOf(literal, index + literal.length)) expected.push(Buffer.byteLength(text.slice(0, index)))
    for (const size of [13, 32000]) {
      let position: any, result: any; const found = new Map<number, string>()
      do {
        result = await scene.read({ find: literal }, size, position); position = result.position
        expect(result.completion.full_body_delivered).toBe(false)
        expect(result.data.matches.reduce((sum: number, item: any) => sum + [...item.text].length, 0)).toBeLessThanOrEqual(size)
        for (const item of result.data.matches) {
          const bytes = Buffer.from(text).subarray(item.actual_range.start_bytes, item.actual_range.end_bytes)
          expect(item.text).toBe(bytes.toString()); found.set(item.match.start_bytes, (found.get(item.match.start_bytes) ?? '') + item.text)
        }
      } while (!result.completion.selection_complete)
      expect([...found.keys()]).toEqual(expected)
      for (const value of found.values()) expect(value).toContain(literal)
      expect(result.completion.search_complete).toBe(true)
    }
  }
})
it('returns a resumable empty scan page rather than a final no-match claim', async () => {
  const scene = saved('a\n'.repeat(600000) + 'needle')
  const first = await scene.read({ find: 'needle' })
  expect(first.data.matches).toEqual([]); expect(first.completion.search_complete).toBe(false)
  const second = await scene.read({ find: 'needle' }, 4000, first.position)
  expect(second.data.matches[0].text).toBe('needle'); expect(second.completion.selection_complete).toBe(true)
})
it('rejects corrupt UTF8 even without matches and stops a pending scan on cancellation', async () => {
  const broken = saved(Buffer.from([65, 255, 66])); await expect(broken.read({ find: 'missing' })).rejects.toThrow('valid UTF-8')
  const scene = saved('a'.repeat(3000000)); let checks = 0
  await expect(scene.read({ find: 'missing' }, 4000, undefined, () => { if (++checks > 4) throw Error('cancelled') })).rejects.toThrow('cancelled')
  writeFileSync(join(scene.root, 'resources', 'text'), 'b'.repeat(3000000)); await expect(scene.read({})).rejects.toThrow('changed')
})
it('packs short hits into one page but preserves every hit across JSON byte limits', async () => {
 const text='a\n'.repeat(1500), scene=saved(text)
 const first=await scene.read({find:'a'},32000)
 expect(first.data.matches.length).toBeGreaterThan(100)
 expect(first.data.matches.length).toBeLessThan(1500)
 let result=first, position:any, found:number[]=[]
 do {
  found.push(...result.data.matches.map((item:any)=>item.match.start_bytes))
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(262144)
  position=result.position
  if(result.completion.selection_complete)break
  result=await scene.read({find:'a'},32000,position)
 }while(true)
 expect(found).toEqual(Array.from({length:1500},(_,i)=>i*2))
})
it('reports actual line positions for long multiline match fragments and saved page byte ranges', async () => {
 const text='one\r\n中😀\nlast', scene=saved(text)
 let result=await scene.read({find:'one\r\n中😀'},3)
 expect(result.lines).toBeUndefined();expect(result.data.matches[0].lines).toEqual({start:1,end:1})
 result=await scene.read({find:'one\r\n中😀'},3,result.position)
 expect(result.data.matches[0].lines).toEqual({start:1,end:2})
 const page=await readTextSelection(scene.root,scene.resource,{pages:[2,2]},4000,undefined,{start:5,end:12},()=>{})
 expect(page.data.text).toBe('中😀');expect(page.lines).toEqual({start:2,end:2})
 expect(page.line_fragment.complete).toBe(false);expect(page.completion.full_body_delivered).toBe(false)
})
it('measures an 8MiB scan and cancellation without caching authority or loading whole text', async () => {
 const text='row\n'.repeat(2*1024*1024), scene=saved(text), before=process.memoryUsage().rss
 const started=performance.now();let result:any,position:any,pages=0,peak=before
 do {result=await scene.read({find:'absent'},4000,position);position=result.position;pages++;peak=Math.max(peak,process.memoryUsage().rss)}while(!result.completion.selection_complete)
 const scanMs=performance.now()-started, controller=new AbortController();let abortedAt=0
 const pending=scene.read({find:'absent'},4000,undefined,()=>{if(controller.signal.aborted)throw Error('cancelled')})
 setTimeout(()=>{abortedAt=performance.now();controller.abort()},0)
 await expect(pending).rejects.toThrow('cancelled')
 console.info(JSON.stringify({benchmark:'verified-text-search',resource_bytes:Buffer.byteLength(text),scan_pages:pages,scan_ms:scanMs,observed_rss_delta_bytes:Math.max(0,peak-before),cancel_observed_ms:performance.now()-abortedAt,real_api_requests:0}))
})

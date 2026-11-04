import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPluginResource, readResourceContent } from '../../src/runtime/plugins/resource-reader'
import { digest } from '../../src/runtime/resources'
let root: string
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'trellis-plugin-read-'));await mkdir(join(root,'resources'))})
afterEach(async()=>{await rm(root,{recursive:true,force:true})})
async function resource(text:string){const body=Buffer.from(text);await writeFile(join(root,'resources','fixture'),body);return {id:'fixture',storage_key:'fixture',sha256:digest(body),byte_length:body.length}}
it('reads complete UTF-8 fragments without splitting code points',async()=>{
 const text='fragment '+String.fromCodePoint(0x1f340).repeat(4000),r=await resource(text);let offset=0,actual=''
 do {const part=await readPluginResource(root,r,offset);expect(Buffer.byteLength(part.text)).toBeLessThanOrEqual(4096);actual+=part.text;offset=part.next_offset??r.byte_length}while(offset<r.byte_length)
 expect(actual).toBe(text)
})
it('fails closed on tampered bytes without repairing the file',async()=>{
 const r=await resource('original');await writeFile(join(root,'resources','fixture'),'modified')
 await expect(readPluginResource(root,r,0)).rejects.toThrow();expect(await readFile(join(root,'resources','fixture'),'utf8')).toBe('modified')
})
it('rejects binary content and non-code-point offsets',async()=>{
 const r=await resource('fixture '+String.fromCodePoint(0x1f340));await expect(readPluginResource(root,r,9)).rejects.toThrow()
 const body=Buffer.from([255]);await writeFile(join(root,'resources','fixture'),body)
 await expect(readPluginResource(root,{...r,byte_length:1,sha256:digest(body)},0)).rejects.toThrow()
})
it('does not suggest character boundaries for malformed UTF8 even when its hash matches',async()=>{
 const body=Buffer.from([65,0x80,90]);await writeFile(join(root,'resources','fixture'),body)
 await expect(readResourceContent(root,{id:'fixture',storage_key:'fixture',byte_length:body.length,sha256:digest(body)},1,body.length,10,()=>{})).rejects.toMatchObject({code:'RESOURCE_CORRUPT'})
})
it('yields control while verifying a large result and handles an empty resource',async()=>{
 const r=await resource('x'.repeat(4*1024*1024));let ticked=false;const reading=readPluginResource(root,r,0);await new Promise<void>(done=>setImmediate(()=>{ticked=true;done()}));await reading;expect(ticked).toBe(true)
 const empty=await resource('');expect(await readPluginResource(root,empty,0)).toEqual({text:'',truncated:false,next_offset:null})
})

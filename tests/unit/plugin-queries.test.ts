import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginControl } from '../../src/runtime/plugins/control'
import { PluginDirectory, pluginContentId } from '../../src/runtime/plugins/directory'
import { PluginQueries } from '../../src/runtime/plugins/queries'
let root: string, control: PluginControl, directory: PluginDirectory, queries: PluginQueries, digest: string
const task = '00000000-0000-4000-8000-000000000001'
beforeEach(async () => {
 root=await mkdtemp(join(tmpdir(),'pliuna-plugin-query-'));control=new PluginControl(root);directory=new PluginDirectory(root,control);queries=new PluginQueries(directory)
 const source=join(root,'source');await mkdir(source)
 await writeFile(join(source,'workflow.md'),'fixture workflow '+ 'long-content '.repeat(1000))
 await writeFile(join(source,'manifest.json'),JSON.stringify({manifest_version:'0.1',protocol_version:'0.1',id:'fixture.content',version:'1.0.0',access_level:'task',extensions:{context_retention:'Keep unresolved errors and exact answer sources; no authority.'},contributes:[{id:'workflow',kind:'workflow',entry:'workflow.md',description:'fixture workflow'}]}))
 const copy=await control.install(source);digest=copy.digest;const plan=control.plan(task,digest);await control.enable(task,digest,[],plan.fingerprint,false,()=>{})
})
afterEach(async()=>{control.close();await rm(root,{recursive:true,force:true})})
it('lists metadata and reads enabled content via portable bounded IDs',async()=>{
 const result:any=await queries.query(task,'run:first',{type:'list',input:{kind:'plugin'}})
 expect(result.items[0]).toMatchObject({id:'package:'+digest,enabled:true});expect(JSON.stringify(result)).not.toContain(root)
 const descriptor:any=await queries.query(task,'run:first',{type:'read',input:{target:{kind:'plugin',id:result.items[0].id}}})
 expect(descriptor.data.contributes[0].id).toBe(pluginContentId(digest,'workflow'))
})
it('continues long content without mixing source, task, target or edited cursors',async()=>{
 const input={target:{kind:'plugin' as const,id:pluginContentId(digest,'workflow')}}
 const first:any=await queries.query(task,'run:first',{type:'read',input});expect(first.truncated).toBe(true);expect(first.next_cursor.length).toBeLessThanOrEqual(200)
 const second:any=await queries.query(task,'run:first',{type:'read',input:{...input,cursor:first.next_cursor}})
 expect(second.content_version).toBe(first.content_version);let body=first.data.text+second.data.text,next=second.next_cursor;while(next){const part:any=await queries.query(task,'run:first',{type:'read',input:{...input,cursor:next}});body+=part.data.text;next=part.next_cursor}expect(JSON.parse(body).text).toContain('fixture workflow')
 for(const [source,targetTask,cursor] of [['run:other',task,first.next_cursor],['run:first','other',first.next_cursor],['run:first',task,first.next_cursor+'x']])await expect(queries.query(targetTask,source,{type:'read',input:{...input,cursor}})).rejects.toThrow()
})
it('discovers the selected workflow through list and fetches its body only through read',async()=>{
 expect((await queries.query(task,'run:first',{type:'list',input:{kind:'plugin'}}) as any).items[0].workflow).toBeNull()
 control.selectWorkflow(task,{digest,contribution_id:'workflow'},()=>{})
 const result:any=await queries.query(task,'run:first',{type:'list',input:{kind:'plugin'}})
 expect(result.items[0].workflow).toEqual({kind:'plugin',id:pluginContentId(digest,'workflow')})
 expect(JSON.stringify(result)).not.toContain('fixture workflow')
 const selected=result.items[0].workflow
 expect((await queries.query(task,'run:first',{type:'read',input:{target:selected}}) as any).data.text).toContain('fixture workflow')
 control.disable(digest,task)
 expect((await queries.query(task,'run:first',{type:'list',input:{kind:'plugin'}}) as any).items[0].workflow).toBeNull()
 await expect(queries.query(task,'run:first',{type:'read',input:{target:{kind:'plugin',id:pluginContentId(digest,'workflow')}}})).rejects.toThrow()
})
it('invalidates list cursors after enablement changes and honors page size',async()=>{
 const rows=Array.from({length:25},(_,i)=>({id:String(i)})),fake={summaries:()=>rows,discovery:()=>rows} as unknown as PluginDirectory
 const q=new PluginQueries(fake),first:any=await q.query(task,'run:first',{type:'list',input:{kind:'plugin',limit:2}})
 expect(first.items).toHaveLength(2);expect(first.next_cursor).toBeTruthy()
 expect((await q.query(task,'run:first',{type:'list',input:{kind:'plugin',limit:2,cursor:first.next_cursor}}) as any).items).toEqual([{id:'2'},{id:'3'}])
 rows.pop();await expect(q.query(task,'run:first',{type:'list',input:{kind:'plugin',cursor:first.next_cursor}})).rejects.toThrow()
})
it('bounds escaped fragments by serialized bytes and reconstructs exact JSON',async()=>{
 const data={text:'\u0000\"\\漢'.repeat(2000)},fake={read:async()=>data} as unknown as PluginDirectory,q=new PluginQueries(fake)
 let cursor:string|undefined,body=''
 do {const part:any=await q.query(task,'source',{type:'read',input:{target:{kind:'plugin',id:'fixture'},cursor}});expect(Buffer.byteLength(JSON.stringify(part.data))).toBeLessThanOrEqual(8192);body+=part.data.text;cursor=part.next_cursor??undefined}while(cursor)
 expect(JSON.parse(body)).toEqual(data)
})
it('honors list limits above 20 without introducing a second hidden item cap', async () => {
 const rows=Array.from({length:120},(_,i)=>({id:String(i)})),q=new PluginQueries({summaries:()=>rows} as unknown as PluginDirectory)
 expect(((await q.query(task,'source',{type:'list',input:{kind:'plugin',limit:100}})) as any).items).toHaveLength(100)
 expect(((await q.query(task,'source',{type:'list',input:{kind:'plugin'}})) as any).items).toHaveLength(50)
})
it('selects bounded retention guidance only for enabled selected workflow or actual historical reads',async()=>{
 expect(await directory.retention(task,[])).toEqual([])
 control.selectWorkflow(task,{digest,contribution_id:'workflow'},()=>{})
 expect(await directory.retention(task,[])).toMatchObject([{id:digest,priority:0}])
 control.selectWorkflow(task,null,()=>{})
 const records=[{payload:{message:{tool_calls:[{function:{name:'read',arguments:JSON.stringify({kind:'plugin',id:pluginContentId(digest,'workflow')})}}]}}}]
 expect(await directory.retention(task,records)).toMatchObject([{id:digest,priority:2}])
 expect(await directory.retention(task,[{payload:{message:{tool_calls:[{function:{name:'read',arguments:JSON.stringify({target:{kind:'plugin',id:pluginContentId(digest,'workflow')}})}}]}}}])).toEqual([])
 control.disable(digest,task);expect(await directory.retention(task,records)).toEqual([])
})

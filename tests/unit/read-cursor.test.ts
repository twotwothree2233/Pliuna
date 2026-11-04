import { expect, it } from 'vitest'
import { ReadCursors } from '../../src/runtime/model/read-cursor'
import { modelReadOptions, modelToolRequest } from '../../src/runtime/model/tool-input'
const request = (raw: any) => modelToolRequest('read', {kind:'resource',id:'r',...raw}) as any
it('restores omitted options and rejects conflicts, tampering, task/Run changes and restart', async () => {
 const cursors = new ReadCursors(), query = (read:any) => ({next_cursor:'inner',options:modelReadOptions(read),target:read.input.target})
 const first = await cursors.read('task','run',request({max_chars:13,selection:{find:'中😀'}}),query)
 expect(first.next_cursor.length).toBeLessThanOrEqual(200)
 const next = await cursors.read('task','run',request({cursor:first.next_cursor}),query)
 expect(next.options).toEqual(first.options)
 for (const raw of [{max_chars:14},{selection:{view:'object'}},{id:'other'}]) await expect(cursors.read('task','run',request({...raw,cursor:first.next_cursor}),query)).rejects.toMatchObject({code:'INVALID_CURSOR'})
 for (const [task,run] of [['other','run'],['task','other']]) await expect(cursors.read(task!,run!,request({cursor:first.next_cursor}),query)).rejects.toMatchObject({code:'INVALID_CURSOR'})
 await expect(cursors.read('task','run',request({cursor:first.next_cursor+'x'}),query)).rejects.toMatchObject({code:'INVALID_CURSOR'})
 cursors.reset();await expect(cursors.read('task','run',request({cursor:first.next_cursor}),query)).rejects.toMatchObject({code:'INVALID_CURSOR'})
})
it('keeps an exact explicitly repeated selection and revision, without cursor authority', async () => {
 const cursors=new ReadCursors(), raw={kind:'task_data',id:'d',selection:{revision:3,view:'object',lines:[1,2]},max_chars:17}
 let received:any
 const query=(read:any)=>{received=read;return {next_cursor:'inner'}}
 const first=await cursors.read('task','run',request(raw),query)
 await cursors.read('task','run',request({...raw,cursor:first.next_cursor}),query)
 expect(received.input.target).toEqual({kind:'task_data',id:'d',expected_revision:3})
})

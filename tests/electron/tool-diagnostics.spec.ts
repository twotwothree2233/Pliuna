import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { modelServer, synthetic, textStream, toolStream } from '../helpers/model-server'

const executablePath: string = createRequire(import.meta.url)('electron')
test('delivers recoverable tool errors, explicit reads and calculation facts across isolated restart', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'pliuna-tool-diagnostics-desktop-'))
  const material = 'A中😀Z', capability = 'builtin:monty:v1'
  let turn = 0, resource = '', failure: string | undefined, continuation: any
  const calculations: any[] = [], feedback: any[] = [], requests: any[] = []
  const server = await modelServer(({body}, response) => {
    try {
      if (synthetic(body, response)) return
      requests.push(body)
      expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_completion_tokens')
      turn++
      const result = turn > 1 ? JSON.parse(body.messages.at(-1).content) : undefined
      if (result) feedback.push(result)
      if (turn === 1) return toolStream(response, 'list', {kind:'contract_target'})
      if (turn === 2) {
        expect(result.error.message).toContain('object_type'); expect(result.error.message).not.toContain('oneOf')
        return toolStream(response, 'list', {kind:'object_type'})
      }
      if (turn === 3) {
        expect(result.execution).toBe('success')
        return toolStream(response, 'read', {kind:'object_type',id:'tool.read'})
      }
      if (turn === 4) {
        expect(JSON.stringify(result)).toContain('search scan is not body delivery')
        return toolStream(response, 'read', {kind:'capability',id:capability})
      }
      if (turn === 5) {
        expect(JSON.stringify(result)).toContain('references do not bind variables or load resource content')
        return toolStream(response, 'read', {kind:'resource',id:resource,selection:{lines:[2,1]}})
      }
      if (turn === 6) {
        expect(result.error.message).toContain('start must not exceed end')
        return toolStream(response, 'read', {kind:'resource',id:resource,selection:{find:'中😀'}})
      }
      if (turn === 7) {
        expect(result.data.data.matches[0].text).toBe(material); expect(result.data.completion.full_body_delivered).toBe(false)
        return toolStream(response, 'read', {kind:'resource',id:resource,max_chars:2})
      }
      if (turn === 8) {
        expect(result.data.data.text).toBe('A中')
        continuation = result.data.next_call
        expect(continuation.name).toBe('read'); expect(continuation.arguments).toEqual({kind:'resource',id:resource,cursor:result.data.next_cursor})
        return toolStream(response, continuation.name, continuation.arguments)
      }
      if (turn === 9) {
        expect(result.data.data.text).toBe('😀Z')
        return toolStream(response, 'call', {capability,input_json:JSON.stringify({code:'result = material',inputs:{}}),references:[{name:'material',target:{kind:'resource',id:resource}}]})
      }
      if (turn === 10) {
        calculations.push(result)
        expect(result).toMatchObject({execution:'failure',error:{code:'MONTY_NAME_ERROR',message:expect.stringContaining('material is not defined')}})
        return toolStream(response, 'read', {kind:'call',id:result.operation_id})
      }
      if (turn === 11) {
        expect(result.data.data.result_data).toEqual(calculations[0])
        return toolStream(response, 'call', {capability,input_json:JSON.stringify({code:'result = sum(values)',inputs:{values:[2,3,5]}})})
      }
      if (turn === 12) {
        calculations.push(result)
        expect(result).toMatchObject({execution:'success',data:{value:{type:'json',value:10}}})
        return toolStream(response, 'call', {capability,input_json:JSON.stringify({code:'result = open("/synthetic-private-path").read()',inputs:{}})})
      }
      if (turn === 13) {
        calculations.push(result)
        expect(result).toMatchObject({execution:'failure',error:{code:'MONTY_OPERATION_DENIED'}})
        expect(result.error.message).not.toMatch(/synthetic-private-path|Traceback/)
        return textStream(response, 'SYNTHETIC_DIAGNOSTICS_COMPLETE')
      }
      throw Error('Unexpected extra model request')
    } catch (error) {failure=String(error);response.writeHead(500);response.end()}
  })
  const launch = () => electron.launch({executablePath,args:['.'],env:{...process.env,ELECTRON_RUN_AS_NODE:'',ELECTRON_RENDERER_URL:'',PLIUNA_TEST_DATA:root,PLIUNA_ENABLE_MONTY:'1'}})
  let app = await launch(), page = await app.firstWindow()
  const call = async (input: any): Promise<any> => {
    const response = await page.evaluate(input => window.pliuna.request(input), input)
    if (!response.ok) throw Error(response.error.code)
    return response.data
  }
  try {
    await call({type:'model.configure',configuration:{id:'diagnostics',base_url:server.url,wire_model_id:'synthetic',context_tokens:1000000,compatibility_profile:'chat-max-tokens'},api_key:'synthetic-only',confirm_memory_only:true,remember_connection:true,confirm_plaintext_storage:true})
    await call({type:'model.test',model_id:'diagnostics',role:'main',confirm_cost:true})
    const task = (await call({type:'task.create',title:'Tool diagnostic regression'})).task.id
    const file = join(root,'synthetic-material.txt'); await writeFile(file,material)
    const staged = await call({type:'material.text',task_id:task,display_name:'synthetic-material.txt',text:material})
    const operation = staged.items[0].operation_id
    await expect.poll(async () => (await call({type:'material.status',task_id:task,operation_id:operation})).state).toBe('success')
    resource = (await call({type:'material.status',task_id:task,operation_id:operation})).resource.id
    const run = await call({type:'task.submit',task_id:task,text:'Synthetic diagnostic recovery fixture.',model_config_id:'diagnostics',attachments:[]})
    await expect.poll(async () => (await call({type:'task.snapshot',task_id:task})).runs.find((item:any)=>item.id===run.run_id)?.state).toBe('completed')
    expect(failure).toBeUndefined(); expect(turn).toBe(13); expect(calculations).toHaveLength(3)
    const before = await call({type:'task.snapshot',task_id:task})
    const query = (kind:string,id?:string) => call({type:'task.query',task_id:task,query:id?{type:'read',input:{target:{kind,id}}}:{type:'list',input:{kind}}})
    expect((await query('call')).items).toHaveLength(3)
    expect((await query('resource')).items).toHaveLength(1)
    const settings = await readFile(join(root,'settings.json')), auth = await readFile(join(root,'auth.json')), count = server.exchanges.length
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForFunction(()=>!!window.pliuna)
    const after = await call({type:'task.snapshot',task_id:task})
    expect({...after,runtime_epoch:null}).toEqual({...before,runtime_epoch:null})
    for (const result of calculations) expect((await query('call',result.operation_id)).data.result_data).toEqual(result)
    expect(await readFile(join(root,'settings.json'))).toEqual(settings); expect(await readFile(join(root,'auth.json'))).toEqual(auth)
    expect(server.exchanges).toHaveLength(count)
    await writeFile(join(root,'synthetic-tool-evidence.json'),JSON.stringify({requests,feedback,restart_requests:server.exchanges.length-count,real_api_requests:0},null,2))
    console.log(JSON.stringify({benchmark:'tool-diagnostics-restart',business_requests:requests.length,calculations:calculations.length,restart_requests:0,real_api_requests:0}))
  } finally {
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.destroy())).catch(()=>{})
    await app.close().catch(()=>{}); await server.close()
  }
})

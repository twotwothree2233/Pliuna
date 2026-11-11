import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync,readFileSync,symlinkSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fork } from 'node:child_process'
import { nativeMonty } from '../../src/runtime/monty/runner'
import { montyAssets } from '../../src/runtime/monty/assets'
import { materializeValue } from '../../src/runtime/monty/value'
import { montyLimits, validateMontyInput } from '../../src/runtime/monty/contract'
const assets = () => montyAssets(join(process.cwd(), 'out/main/monty-worker.js'))
const run = (code: string, inputs = {}, signal = new AbortController().signal) => nativeMonty(assets(), { code, inputs }, signal, process.execPath, () => {}).result
it('returns safe actionable native diagnostics with original code lines', async () => {
  for (const [code, error, message] of [
    ['x = 1\nresult = missing', 'MONTY_NAME_ERROR', 'NameError at code line 2: missing is not defined'],
    ['def f():\n    return missing\nresult = f()', 'MONTY_NAME_ERROR', 'NameError at code line 2: missing is not defined'],
    ['result =', 'MONTY_SYNTAX_ERROR', 'SyntaxError at code line 1'],
    ['result = 1 / 0', 'MONTY_EXECUTION_FAILED', 'ZeroDivisionError at code line 1'],
    ['result = open("/synthetic-private-path").read()', 'MONTY_OPERATION_DENIED', 'PermissionError at code line 1'],
    ['import os\nresult = os.getenv("HOME")', 'MONTY_OPERATION_UNSUPPORTED', 'RuntimeError at code line 2'],
    ['result = "x" * (256 * 1024 * 1024)', 'MONTY_RESOURCE_LIMIT', 'MemoryError'],
  ]) {
    const output = await run(code!)
    expect(output).toMatchObject({ ok: false, execution: 'failure', error })
    expect((output as any).message).toContain(message)
    expect(JSON.stringify(output)).not.toMatch(/synthetic-private-path|Traceback|<python-input|_pliuna_|HOME/)
  }
  expect(await run('raise ValueError("synthetic private diagnostic")')).toMatchObject({ ok: false, message: expect.not.stringContaining('synthetic private diagnostic') })
})
it('preserves plain JSON, special types, bytes and label-shaped user dictionaries before native conversion', async () => {
  const output = await run('result = {"plain": {"type":"bytes","hex":"user data"}, "nested":[2**100, (1,2), {3,4}, frozenset([5]), {1:"one"}, b"abc", float("inf"), float("nan")] }')
  expect(output.ok).toBe(true); if (!output.ok) throw Error(output.error)
  const result = materializeValue(output.value) as any
  expect(result.value.type).toBe('map')
  const entries = Object.fromEntries(result.value.entries.map((e: any) => [e.key.value, e.value]))
  expect(entries.plain).toEqual({ type: 'json', value: { type: 'bytes', hex: 'user data' } })
  expect(entries.nested.items.map((x: any) => x.type)).toEqual(['bigint','tuple','set','frozenset','map','bytes','nonfinite','nonfinite'])
  expect(result.resources[0].body.toString()).toBe('abc')
  expect((await run('result = {"answer": sum(values), "text":"中😀"}', { values: [2,3,5] }) as any).value).toEqual({type:'json',value:{answer:10,text:'中😀'}})
})
it('delivers finite floats and nested decimal calculations without converting them to strings', async () => {
  for (const value of [14.5, -14.5, 0, 1e-20, Number.MAX_SAFE_INTEGER]) {
    const output = await run('result = value', { value })
    expect(output).toMatchObject({ ok: true, value: { type: 'json', value } })
  }
  for (const [literal, value] of [['0.0', 0], ['9007199254740991.0', Number.MAX_SAFE_INTEGER], ['-9007199254740991.0', -Number.MAX_SAFE_INTEGER]] as const) {
    expect(await run('result = ' + literal)).toMatchObject({ ok: true, value: { type: 'json', value } })
  }
  const output = await run('result = {"total": qty * price + freight, "nested": [price, {"freight": freight}], "tuple": (price, freight)}', { qty: 17, price: 14.5, freight: 0.3 })
  expect(output.ok).toBe(true); if (!output.ok) throw Error(output.error)
  const result = materializeValue(output.value).value as any
  const entries = Object.fromEntries(result.entries.map((entry: any) => [entry.key.value, entry.value]))
  expect(entries.total).toEqual({ type: 'json', value: 246.8 })
  expect(entries.nested).toEqual({ type: 'json', value: [14.5, { freight: 0.3 }] })
  expect(entries.tuple).toEqual({ type: 'tuple', items: [{ type: 'json', value: 14.5 }, { type: 'json', value: 0.3 }] })
})
it('rejects cycles, unsupported values, host access and poisoned output rather than stringifying or replaying', async () => {
  expect(await run('x=[]\nx.append(x)\nresult=x')).toMatchObject({ok:false,execution:'success',error:'MONTY_CYCLIC_VALUE'})
  expect(await run('import datetime\nresult=datetime.datetime.now()')).toMatchObject({ok:false,execution:'success',error:'MONTY_VALUE_UNSUPPORTED'})
  for(const value of ['-0.0','1e30', '9007199254740992.0', '{"nested": [-0.0]}', '[1e30]']) expect(await run('result='+value)).toMatchObject({ok:false,execution:'success',error:'MONTY_NONFAITHFUL_FLOAT'})
  for (const code of ['result=open("/synthetic-not-mounted").read()', 'import os\nresult=os.getenv("HOME")', 'import socket\nresult=1', 'import time\ntime.sleep(1)\nresult=1']) expect(await run(code)).toMatchObject({ok:false,execution:'failure'})
  expect(()=>materializeValue({type:'bytes',hex:'not-hex'})).toThrow('faithfully')
  expect(()=>materializeValue({type:'json',value:Infinity})).toThrow('faithfully')
  expect(()=>materializeValue({type:'json',value:{nested:-0}})).toThrow('faithfully')
  expect(()=>materializeValue({type:'json',value:{number:Number.MAX_SAFE_INTEGER+1}})).toThrow('faithfully')
})
it('classifies unexpected encoder failures without exposing exception text as a user value rejection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pliuna-monty-encoding-fault-')), original = assets()
  symlinkSync(join(process.cwd(), 'out/main/chunks'), join(root, 'chunks'))
  symlinkSync(join(process.cwd(), 'node_modules'), join(root, 'node_modules'))
  const source = readFileSync(original.runner, 'utf8'), marker = '    if t is float:'
  expect(source.split(marker)).toHaveLength(2)
  for (const exception of ['AttributeError', 'ValueError']) {
    const runner = join(root, exception + '.mjs')
    writeFileSync(runner, source.replace(marker, '    raise ' + exception + '("synthetic private diagnostic")\n' + marker))
    const output = await nativeMonty({ ...original, runner }, { code: 'result = 14.5', inputs: {} }, new AbortController().signal, process.execPath, () => {}).result
    expect(output).toEqual({ ok: false, execution: 'success', error: 'MONTY_ENCODING_FAILED' })
  }
})
it('does not retain variables and cancels the wrapper and native worker before rejecting', async () => {
  expect(await run('private_value=41\nresult=private_value')).toMatchObject({ok:true})
  expect(await run('result=private_value')).toMatchObject({ok:false})
  const controller = new AbortController(); let pid = 0
  const execution=nativeMonty(assets(),{code:'while True:\n    pass',inputs:{}},controller.signal,process.execPath,value=>{pid=value})
  await new Promise(resolve=>setTimeout(resolve,150));controller.abort()
  await expect(execution.result).rejects.toMatchObject({code:'MONTY_CANCELLED'})
  expect(pid).toBeGreaterThan(0);expect(()=>process.kill(-pid,0)).toThrow()
})
it('uses published input/resource guards without adding model or hidden Run caps',()=>{
  expect(montyLimits).toMatchObject({memory_bytes:134217728,execution_ms:120000,wall_ms:180000,result_bytes:268435456})
  expect(()=>validateMontyInput({code:'result=1',inputs:{},extra:1})).toThrow()
  expect(()=>validateMontyInput({code:'x'.repeat(1048576),inputs:{}})).toThrow('limit')
  expect(()=>montyAssets('/synthetic-missing-worker')).toThrow('fallback')
})
it('rejects production print and allocator quota overflow without silently truncating',async()=>{
 for(const code of ['print("x" * 1048577)\nresult=1','result="x" * (256 * 1024 * 1024)','def f():\n    return f()\nresult=f()']) expect(await run(code)).toMatchObject({ok:false,execution:'failure'})
},20000)
it('kills the whole detached group at its external deadline even if no native PID was received',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pliuna-monty-wall-')),runner=join(root,'hung.cjs');writeFileSync(runner,'process.on("message",()=>{});setInterval(()=>{},1000)')
 let start!:()=>void,pid=0;const started=new Promise<void>(resolve=>{start=resolve})
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
 const execution=nativeMonty({...assets(),runner},{code:'result=1',inputs:{}},new AbortController().signal,process.execPath,value=>{pid=value;start()})
 const checked=expect(execution.result).rejects.toMatchObject({code:'MONTY_TIMEOUT'})
 try {await started;vi.advanceTimersByTime(montyLimits.wall_ms);vi.useRealTimers();await checked;expect(()=>process.kill(-pid,0)).toThrow()}
 finally {vi.useRealTimers();await execution.stop()}
})
it('destroys wrapper and native worker after its owner is SIGKILLed rather than publishing late output',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pliuna-monty-owner-')),supervisor=join(root,'owner.cjs'),a=assets()
 writeFileSync(supervisor,`const {fork}=require('node:child_process');const child=fork(${JSON.stringify(a.runner)},[],{detached:true,env:{},stdio:['ignore','ignore','ignore','ipc']});child.on('message',m=>process.send({wrapper:child.pid,...m}));child.send({binary:${JSON.stringify(a.binary)},input:{code:'while True:\\n    pass',inputs:{}},limits:${JSON.stringify(montyLimits)}});`)
 const owner=fork(supervisor,[],{stdio:['ignore','ignore','ignore','ipc']})
 const ids=await new Promise<{wrapper:number;worker_pid:number}>((resolve,reject)=>{owner.once('message',message=>resolve(message as any));owner.once('error',reject)})
 owner.kill('SIGKILL');await new Promise(resolve=>owner.once('exit',resolve))
 const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
 for(let n=0;n<100&&(alive(-ids.wrapper)||alive(ids.worker_pid));n++)await new Promise(resolve=>setTimeout(resolve,50))
 expect(alive(-ids.wrapper)).toBe(false);expect(alive(ids.worker_pid)).toBe(false)
},15000)

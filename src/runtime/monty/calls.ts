import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { assertContract, ContractError } from '../../shared/validation'
import { digest } from '../resources'
import type { StorageLifecycle } from '../storage-lifecycle'
import { montyAssets, type MontyAssets } from './assets'
import { MONTY_ID, montyLimits, validateMontyInput } from './contract'
import { materializeValue, type MontyResource } from './value'
import { nativeMonty, type MontyRunner, type MontyExecution } from './runner'

type Row = Record<string, any>
const now = () => new Date().toISOString()
type Active = { task: string; run: string; controller: AbortController; execution?: MontyExecution; done: Promise<void>; cleanupUnknown: boolean }
export class MontyCalls {
  private active = new Map<string, Active>()
  private closed = false
  readonly assets: MontyAssets | null
  readonly unavailable: string | null
  constructor(private db: Database.Database, private root: string, private storage: StorageLifecycle, private validSource: (task: string, run: string) => void, private references: (task: string, references: any[]) => void, private record: (task: string, kind: string, value: Row) => string, private runtime: string, enabled: boolean, private runner: MontyRunner = nativeMonty, assetsFinder: () => MontyAssets = () => montyAssets(join(__dirname, 'monty-worker.js'))) {
    try { this.assets = enabled ? assetsFinder() : null; this.unavailable = enabled ? null : 'MONTY_DISABLED' }
    catch (error) { this.assets = null; this.unavailable = error instanceof ContractError ? error.code : 'MONTY_RUNTIME_UNAVAILABLE' }
  }
  get available(): boolean { return !!this.assets && !this.closed }
  busy(task?: string): boolean { return [...this.active.values()].some(entry => !task || entry.task === task) }
  cancelRun(run: string): void { for (const [id, entry] of this.active) if (entry.run === run) { this.db.prepare('UPDATE calls SET commit_valid=0 WHERE id=?').run(id); entry.controller.abort() } }
  async shutdown(): Promise<void> {
    this.closed = true
    for (const [id, entry] of this.active) { this.db.prepare('UPDATE calls SET commit_valid=0 WHERE id=?').run(id); entry.controller.abort() }
    await Promise.all([...this.active.values()].map(entry => entry.done))
    if (this.busy()) throw new ContractError('MONTY_CLEANUP_UNCONFIRMED', 'Calculation cleanup is unresolved; storage remains protected')
  }
  async call(task: string, run: string, raw: unknown, references: any[], signal: AbortSignal): Promise<unknown> {
    if (!this.available || !this.assets) throw new ContractError(this.unavailable ?? 'MONTY_DISABLED', 'Native calculation is unavailable; no host execution fallback')
    const input = validateMontyInput(raw)
    this.validSource(task, run); this.references(task, references)
    if (signal.aborted) throw new ContractError('MONTY_CANCELLED', 'Source cancelled before calculation')
    if (this.busy(task) || this.active.size >= montyLimits.active_app) throw new ContractError('MONTY_BUSY', 'Published calculation concurrency is occupied; no execution was registered')
    const call = randomUUID(), action = randomUUID(), controller = new AbortController(), expires = performance.now() + montyLimits.wall_ms
    let settled!: () => void
    const entry: Active = { task, run, controller, done: new Promise(resolve => { settled = resolve }), cleanupUnknown: false }
    const invalidate = () => { this.db.prepare('UPDATE calls SET commit_valid=0 WHERE id=?').run(call); controller.abort() }
    const valid = () => {
      if (this.closed || controller.signal.aborted) throw new ContractError('MONTY_CANCELLED', 'Calculation no longer has commit permission')
      if (performance.now() >= expires) { this.db.prepare('UPDATE calls SET commit_valid=0 WHERE id=?').run(call); controller.abort(); throw new ContractError('MONTY_TIMEOUT', 'Published whole-call deadline elapsed; no result is committed') }
      this.validSource(task, run); this.references(task, references)
      const row = this.db.prepare('SELECT commit_valid,state FROM calls WHERE id=?').get(call) as Row | undefined
      if (!row?.commit_valid || row.state === 'ended') throw new ContractError('MONTY_SOURCE_INVALID', 'Calculation source ended; late result rejected')
    }
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO calls (id,task_id,run_id,capability_id,state,dispatch,delivery,input_json,limits_json,commit_valid,created_at) VALUES (?,?,?,?,'registered','not_sent','pending',?,?,1,?)").run(call, task, run, MONTY_ID, JSON.stringify({arguments:input,references}), JSON.stringify({version:1,...montyLimits,binary_sha256:this.assets!.binary_sha256}), now())
      this.db.prepare("INSERT INTO actions (id,task_id,run_id,call_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,?,?,'mutation','registered',?,?,1,?)").run(action, task, run, call, JSON.stringify({type:'run',id:run}), JSON.stringify({type:'monty.output',call_id:call}), now())
      this.record(task, 'monty.call.registered', {call_id:call,action_id:action,contract_version:1})
    })()
    this.active.set(call, entry); signal.addEventListener('abort', invalidate, {once:true}); if(signal.aborted)invalidate()
    let executed = false, committed = false, failedExecution: 'failure' | 'unknown' | undefined
    try {
      valid()
      entry.execution = this.runner(this.assets, input, controller.signal, this.runtime, () => {
        valid(); this.db.prepare("UPDATE calls SET state='executing',dispatch='sent' WHERE id=?").run(call)
      })
      const output = await entry.execution.result
      valid()
      if (!output.ok) { executed = output.execution === 'success'; if (!executed) failedExecution = output.execution as 'failure' | 'unknown'; throw new ContractError(output.error, output.message ?? 'Calculation ended without a deliverable value') }
      executed = true
      if (typeof output.stdout !== 'string' || typeof output.stderr !== 'string' || Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > montyLimits.print_bytes) throw new ContractError('MONTY_OUTPUT_INVALID', 'Invalid printed output')
      const decoded = materializeValue(output.value)
      const resources: MontyResource[] = decoded.resources
      const envelope = {version:1,runtime:'@pydantic/monty@1.3.0',contract_version:1,value:decoded.value,stdout:output.stdout,stderr:output.stderr}
      assertContract('monty_result', envelope)
      const encoded = Buffer.from(JSON.stringify(envelope))
      if (encoded.length + resources.reduce((n,r)=>n+r.body.length,0) > montyLimits.result_bytes) throw new ContractError('MONTY_RESULT_LIMIT', 'Combined result exceeds published calculation resource capacity')
      let result: Row = {request_type:'call',operation_id:call,execution:'success',delivery:'delivered',truncated:false,data:envelope}
      if (encoded.length > montyLimits.feedback_bytes / 2 || resources.length) {
        const resource = randomUUID(); resources.push({id:resource,body:encoded,media_type:'application/json',display_name:'Calculation result v1'})
        result = {...result,data:{version:1,result_resource:{kind:'resource',id:resource},notice:'Complete typed result saved; read the immutable JSON resource. No calculation replay.'}}
      }
      this.db.prepare("UPDATE calls SET state='finalizing',wait_reason='result_storage' WHERE id=?").run(call)
      const stages = resources.map(resource => ({resource,stage:randomUUID(),sha256:digest(resource.body)}))
      for (const stage of stages) { valid(); this.storage.publish({id:stage.stage,taskId:task,actionId:action,key:stage.resource.id,bytes:stage.resource.body.length,sha256:stage.sha256},stage.resource.body) }
      this.db.transaction(() => {
        valid()
        const owner = this.db.prepare('SELECT commit_valid,state FROM actions WHERE id=?').get(action) as Row
        if (!owner.commit_valid || owner.state === 'ended') throw new ContractError('MONTY_SOURCE_INVALID', 'Output action no longer eligible')
        for (const stage of stages) {
          this.db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(stage.resource.id,stage.resource.id,stage.sha256,stage.resource.body.length,stage.resource.media_type,stage.resource.display_name,now())
          this.db.prepare('INSERT INTO task_resources VALUES (?,?)').run(task,stage.resource.id);this.storage.commit(stage.stage,stage.resource.id)
        }
        valid()
        // Return one root reference; its typed bytes are still protected by task_resources.
        this.db.prepare("UPDATE actions SET state='ended',result='success',commit_valid=0,authorization_json=?,result_json=?,ended_at=? WHERE id=?").run(JSON.stringify({basis:'default_calculation_output'}),JSON.stringify({call_id:call,resources:stages.map(s=>s.resource.id)}),now(),action)
        this.db.prepare("UPDATE calls SET state='ended',wait_reason=NULL,execution='success',delivery='delivered',commit_valid=0,result_json=?,ended_at=? WHERE id=?").run(JSON.stringify(result),now(),call)
        this.record(task,'monty.call.ended',{call_id:call,execution:'success',delivery:'delivered',resource_count:stages.length})
      })()
      committed = true
      return result
    } catch(error) {
      const code = error instanceof ContractError ? error.code : 'MONTY_SAVE_FAILED'
      if (code === 'MONTY_CLEANUP_UNCONFIRMED') entry.cleanupUnknown=true
      const row = this.db.prepare('SELECT dispatch FROM calls WHERE id=?').get(call) as Row
      const execution = row.dispatch === 'not_sent' ? 'not_executed' : executed ? 'success' : controller.signal.aborted ? 'cancelled' : failedExecution ?? (code === 'MONTY_EXECUTION_FAILED' ? 'failure' : 'unknown')
      const message = error instanceof ContractError ? error.message : 'Calculation result could not be saved'
      const result = {request_type:'call',operation_id:call,execution,delivery:executed?'failed':'delivered',truncated:false,error:{code,message:message + '. No new result was published; original execution is not replayed.'}}
      this.db.transaction(()=>{
        this.db.prepare("UPDATE calls SET state='ended',execution=?,delivery=?,commit_valid=0,result_json=?,ended_at=? WHERE id=?").run(execution,result.delivery,JSON.stringify(result),now(),call)
        this.db.prepare("UPDATE actions SET state='ended',result=?,commit_valid=0,result_json=?,ended_at=? WHERE id=? AND state!='ended'").run(controller.signal.aborted?'cancelled':executed?'failure':row.dispatch==='not_sent'?'not_executed':'unknown',JSON.stringify({code}),now(),action)
        this.record(task,'monty.call.ended',{call_id:call,execution,delivery:result.delivery,error:code})
      })()
      return result
    } finally {
      signal.removeEventListener('abort',invalidate)
      try { if (!committed) this.storage.failed(action) }
      finally {
        if(!entry.cleanupUnknown)this.active.delete(call)
        settled()
      }
    }
  }
}

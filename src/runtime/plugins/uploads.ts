import type Database from 'better-sqlite3'
import { createHash,randomUUID,type Hash } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { flushDirectorySync,managedFile,openExclusiveFileSync,openRegularFile,publishManagedFileSync } from '../../platform/files'
import defaults from '../../shared/contracts/development-defaults.json'
import { assertContract,ContractError } from '../../shared/validation'
import type { StorageLifecycle } from '../storage-lifecycle'
import type { PluginIdentity } from './process'

type Row = Record<string, any>
type Upload = { id: string; action: string; task: string; call: string; identity: PluginIdentity; key: string; fd: number; hash: Hash; expected: number; sha256: string; received: number; media: string; name: string; prepared: boolean; finishing?: boolean; independent?: boolean }
const now = () => new Date().toISOString()
const declarationKey = (d: Row) => JSON.stringify([d.byte_length,d.sha256,d.media_type,d.display_name])
const fail = (code: string): never => { throw new ContractError(code, 'Upload retained but not published. Query its original call; do not replay chunks or read a returned local path') }
export class PluginUploads {
  private uploads = new Map<string, Upload>()
  private grants = new Map<string, { identity: PluginIdentity; task: string; declaration: string; timer: ReturnType<typeof setTimeout> }>()
  constructor(private db: Database.Database, private root: string, private epoch: string, private storage: StorageLifecycle, private valid: (identity: PluginIdentity, task: string, call: string) => void, private resourceAllowed: (id: string) => void, private independentValid?: (identity: PluginIdentity, task: string) => void) {}
  register(identity: PluginIdentity, task: string, declaration: Row): unknown {
    if (!this.independentValid || identity.call_id) fail('PLUGIN_UPLOAD_SOURCE_INVALID')
    this.independentValid!(identity, task)
    assertContract('upload_begin', { task_id: task, owner_id: 'registration', ...declaration })
    if (this.grants.size >= 100 || [...this.grants.values()].filter(g => g.identity.instance_id === identity.instance_id).length >= 20) fail('PLUGIN_UPLOAD_LIMIT')
    const action = randomUUID()
    this.db.prepare("INSERT INTO actions (id,task_id,kind,state,source_json,request_json,authorization_json,commit_valid,created_at) VALUES (?,?,'mutation','registered',?,?,?,1,?)").run(action,task,JSON.stringify({ type: 'plugin_result', instance_id: identity.instance_id, package_digest: identity.digest, epoch: this.epoch }),JSON.stringify({ type:'plugin.result.upload',...declaration }),JSON.stringify({basis:'default_new_resource'}),now())
    const timer = setTimeout(() => this.cancelGrant(action),defaults.run.wall_ms);timer.unref?.()
    this.grants.set(action,{identity,task,declaration:declarationKey(declaration),timer})
    return { action_id: action, status:'registered', upload_owner_id:action }
  }
  private checkIndependent(owner: string, identity: PluginIdentity, task: string): void {
    const grant=this.grants.get(owner)
    if (!grant || grant.identity.instance_id!==identity.instance_id || grant.identity.digest!==identity.digest || grant.task!==task || identity.call_id!==null) fail('PLUGIN_UPLOAD_SOURCE_INVALID')
    this.independentValid!(identity,task)
    const action=this.db.prepare('SELECT commit_valid,state FROM actions WHERE id=?').get(owner) as Row|undefined
    if(!action?.commit_valid || action.state==='ended')fail('PLUGIN_UPLOAD_SOURCE_INVALID')
  }
  owns(action: string, task: string): boolean {
    const upload = [...this.uploads.values()].find(u => u.action === action && u.task === task)
    if (!upload) return false
    try { this.qualify(upload); return true } catch { return false }
  }
  private qualify(upload: Upload): void {
    if(upload.independent)this.checkIndependent(upload.action,upload.identity,upload.task)
    else this.valid(upload.identity, upload.task, upload.call)
    const row = this.db.prepare('SELECT state,commit_valid,source_json FROM actions WHERE id=? AND task_id=?').get(upload.action, upload.task) as Row | undefined
    if (!row?.commit_valid || row.state === 'ended' || JSON.parse(row.source_json).epoch !== this.epoch) fail('PLUGIN_UPLOAD_SOURCE_INVALID')
  }
  async receiveResult(identity: PluginIdentity, task: string, call: string, body: Buffer): Promise<void> {
    const upload = this.handle(identity, 'upload.begin', { task_id: task, owner_id: call, byte_length: body.length, sha256: createHash('sha256').update(body).digest('hex'), media_type: 'application/json', display_name: 'plugin-result.json' }) as Row
    try {
      for (let offset = 0; offset < body.length; offset += defaults.transport.upload_chunk_bytes) {
        this.handle(identity, 'upload.chunk', { upload_id: upload.upload_id, offset, base64: body.subarray(offset, offset + defaults.transport.upload_chunk_bytes).toString('base64') })
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      await this.handle(identity, 'upload.finish', { upload_id: upload.upload_id })
    } catch (error) { const active = this.uploads.get(upload.upload_id); if (active) this.abort(active); throw error }
  }
  handle(identity: PluginIdentity, method: string, params: Row): unknown {
    if (method === 'upload.begin') {
      assertContract<Row>('upload_begin', params)
      const independent = this.grants.has(params.owner_id)
      if(independent){
        this.checkIndependent(params.owner_id,identity,params.task_id)
        const {task_id:_,owner_id:__,...declaration}=params
        if(declarationKey(declaration)!==this.grants.get(params.owner_id)!.declaration || [...this.uploads.values()].some(u=>u.action===params.owner_id))fail('PLUGIN_UPLOAD_SEQUENCE_INVALID')
      } else this.valid(identity, params.task_id, params.owner_id)
      if (this.uploads.size >= 20 || [...this.uploads.values()].filter(u => u.identity.instance_id === identity.instance_id).length >= 4) fail('PLUGIN_UPLOAD_LIMIT')
      const id = randomUUID(), action = independent ? params.owner_id : randomUUID(), key = randomUUID()
      this.resourceAllowed(key)
      this.db.transaction(() => {
        if(independent)this.db.prepare("UPDATE actions SET state='executing' WHERE id=?").run(action)
        else this.db.prepare("INSERT INTO actions (id,task_id,call_id,kind,state,source_json,request_json,authorization_json,commit_valid,created_at) VALUES (?,?,?,'mutation','executing',?,?,?,1,?)").run(action, params.task_id, params.owner_id, JSON.stringify({ type: 'plugin_result', instance_id: identity.instance_id, package_digest: identity.digest, epoch: this.epoch }), JSON.stringify({ type: 'plugin.result.upload', ...params }), JSON.stringify({ basis: 'authorized_call_result', call_id: params.owner_id }), now())
        this.db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES (?,?,'action',?,?,'receiving',?,?,?,?)").run(id, params.task_id, action, this.epoch, key, params.byte_length, params.sha256, now())
      })()
      const upload: Upload = { id, action, task: params.task_id, call: params.owner_id, identity, key, fd: -1, hash: createHash('sha256'), expected: params.byte_length, sha256: params.sha256, received: 0, media: params.media_type, name: params.display_name.replace(/[\x00-\x1f/\\]/g, '_'), prepared: false, independent }
      this.uploads.set(id, upload)
      try { upload.fd = openExclusiveFileSync(managedFile(this.root, 'resources', key + '.tmp')) }
      catch { this.abort(upload); return fail('PLUGIN_UPLOAD_WRITE_FAILED') }
      return { upload_id: id, action_id: action, resource_id: key, state: 'receiving' }
    }
    if (method === 'upload.chunk') assertContract<Row>('upload_chunk', params)
    else if (Object.keys(params).join(',') !== 'upload_id' || typeof params.upload_id !== 'string') fail('PLUGIN_UPLOAD_PARAMS_INVALID')
    const upload = this.uploads.get(params.upload_id)
    if (!upload || upload.identity.instance_id !== identity.instance_id || upload.identity.digest !== identity.digest || upload.identity.call_id !== identity.call_id) return fail('PLUGIN_UPLOAD_UNAVAILABLE')
    if (method === 'upload.abort') { this.abort(upload); return { upload_id: upload.id, state: 'cancelled' } }
    this.qualify(upload)
    try {
      if (upload.prepared || upload.finishing) fail('PLUGIN_UPLOAD_SEQUENCE_INVALID')
      if (method === 'upload.chunk') {
        const bytes = Buffer.from(params.base64, 'base64')
        if (!bytes.length || bytes.length > defaults.transport.upload_chunk_bytes || bytes.toString('base64') !== params.base64 || params.offset !== upload.received || upload.received + bytes.length > upload.expected) fail('PLUGIN_UPLOAD_SEQUENCE_INVALID')
        let written = 0
        while (written < bytes.length) { const count = fs.writeSync(upload.fd, bytes, written, bytes.length - written, upload.received + written); if (!count) fail('PLUGIN_UPLOAD_WRITE_FAILED'); written += count }
        upload.hash.update(bytes); upload.received += bytes.length
        this.db.prepare('UPDATE staging SET received_bytes=? WHERE id=?').run(upload.received, upload.id)
        return { upload_id: upload.id, received_bytes: upload.received }
      }
      if (method !== 'upload.finish' || upload.received !== upload.expected || upload.hash.digest('hex') !== upload.sha256) fail('PLUGIN_UPLOAD_INTEGRITY_INVALID')
      fs.fsyncSync(upload.fd); fs.closeSync(upload.fd); upload.fd = -1
      upload.finishing = true
      return this.finish(upload)
    } catch (error) { this.abort(upload); throw error }
  }
  private async finish(upload: Upload): Promise<unknown> {
    try {
      const path = join(this.root, 'resources', upload.key + '.tmp'), stat = await fs.promises.lstat(path)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== upload.expected) fail('PLUGIN_UPLOAD_INTEGRITY_INVALID')
      const file = await openRegularFile(path)
      try {
        const same = (value: typeof stat) => value.isFile() && value.nlink === 1 && value.ino === stat.ino && value.dev === stat.dev && value.size === stat.size && value.mtimeMs === stat.mtimeMs && value.ctimeMs === stat.ctimeMs
        if (!same(await file.stat())) fail('PLUGIN_UPLOAD_INTEGRITY_INVALID')
        const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024); let offset = 0
        do {
          if (!this.uploads.has(upload.id)) fail('PLUGIN_UPLOAD_SOURCE_INVALID')
          this.qualify(upload)
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
          if (!bytesRead && offset < stat.size) fail('PLUGIN_UPLOAD_INTEGRITY_INVALID')
          hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead
        } while (offset < stat.size)
        if (!same(await file.stat()) || !same(await fs.promises.lstat(path)) || hash.digest('hex') !== upload.sha256) fail('PLUGIN_UPLOAD_INTEGRITY_INVALID')
      } finally { await file.close() }
      if (!this.uploads.has(upload.id)) fail('PLUGIN_UPLOAD_SOURCE_INVALID')
      this.qualify(upload); publishManagedFileSync(path, managedFile(this.root, 'resources', upload.key))
      flushDirectorySync(managedFile(this.root, 'resources'))
      this.db.prepare("UPDATE staging SET state='prepared' WHERE id=?").run(upload.id); upload.prepared = true; upload.finishing = false
      if(upload.independent){
        const resources=this.db.transaction(()=>this.commit(upload.call))();this.settled(upload.call,true)
        return {upload_id:upload.id,action_id:upload.action,state:'committed',published:true,resource:resources[0]}
      }
      return { upload_id: upload.id, resource_id: upload.key, state: 'prepared', published: false }
    } catch (error) { if (this.uploads.has(upload.id)) this.abort(upload); throw error }
  }
  commit(call: string): Row[] {
    if (!this.db.inTransaction) fail('PLUGIN_UPLOAD_TRANSACTION_REQUIRED')
    const uploads = [...this.uploads.values()].filter(u => u.call === call), result: Row[] = []
    for (const upload of uploads) {
      this.qualify(upload)
      if (!upload.prepared) fail('PLUGIN_UPLOAD_INCOMPLETE')
      this.resourceAllowed(upload.key)
      this.db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(upload.key, upload.key, upload.sha256, upload.expected, upload.media, upload.name, now())
      this.db.prepare('INSERT INTO task_resources VALUES (?,?)').run(upload.task, upload.key)
      this.storage.commit(upload.id, upload.key)
      const resource = { id: upload.key, sha256: upload.sha256, byte_length: upload.expected, media_type: upload.media, display_name: upload.name }
      this.db.prepare("UPDATE actions SET state='ended',result='success',commit_valid=0,result_json=?,ended_at=? WHERE id=?").run(JSON.stringify({ resource }), now(), upload.action)
      result.push(resource)
    }
    return result
  }
  settled(call: string, success: boolean): void { for (const upload of [...this.uploads.values()]) if (upload.call === call) { if (success) {this.uploads.delete(upload.id);const grant=this.grants.get(upload.action);if(grant){clearTimeout(grant.timer);this.grants.delete(upload.action)}} else this.abort(upload) } }
  private abort(upload: Upload): void {
    if (upload.fd >= 0) { try { fs.closeSync(upload.fd) } catch {}; upload.fd = -1 }
    this.db.prepare("UPDATE actions SET state='ended',result='cancelled',commit_valid=0,ended_at=? WHERE id=? AND state!='ended'").run(now(), upload.action)
    this.storage.failed(upload.action); this.uploads.delete(upload.id)
    const grant=this.grants.get(upload.action);if(grant){clearTimeout(grant.timer);this.grants.delete(upload.action)}
  }
  private cancelGrant(action:string):void {
    const upload=[...this.uploads.values()].find(u=>u.action===action);if(upload){this.abort(upload);return}
    const grant=this.grants.get(action);if(!grant)return
    this.db.prepare("UPDATE actions SET state='ended',result='cancelled',commit_valid=0,ended_at=? WHERE id=? AND state!='ended'").run(now(),action)
    clearTimeout(grant.timer);this.grants.delete(action)
  }
  check():void {for(const [action,g] of this.grants){try{this.checkIndependent(action,g.identity,g.task)}catch{this.cancelGrant(action)}}}
  cancelTask(task:string):void {for(const [action,g]of this.grants)if(g.task===task)this.cancelGrant(action)}
  busy(task:string):boolean{return [...this.grants.values()].some(g=>g.task===task)}
  close(): void { for (const upload of [...this.uploads.values()]) this.abort(upload);for(const action of this.grants.keys())this.cancelGrant(action) }
}

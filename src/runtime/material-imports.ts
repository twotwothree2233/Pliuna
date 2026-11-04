import type Database from 'better-sqlite3'
import fs, { constants } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'
import defaults from '../shared/contracts/development-defaults.json'
import { ContractError } from '../shared/validation'
import { readPluginResource } from './plugins/resource-reader'
import type { StorageLifecycle } from './storage-lifecycle'
import type { RestoreJournal } from './restore-journal'

type Row = Record<string, any>
type Transfer = { fd: number; key: string; stage: string; received: number; expected: number; hash: ReturnType<typeof createHash>; text: TextDecoder | null; media: string }
const now=()=>new Date().toISOString()
const fail=(code:string):never=>{throw new ContractError(code,'Material operation unavailable; query the original result. No automatic retry or source path access.')}
export class MaterialImports {
  private closed = false
  private transfers=new Map<string,Transfer>()
  constructor(private db:Database.Database,private root:string,private epoch:string,private storage:StorageLifecycle,private journal:RestoreJournal,private record:(task:string,kind:string,data:unknown)=>void){}
  private row(task:string,id:string):Row {
    const row=this.db.prepare("SELECT * FROM actions WHERE id=? AND task_id=? AND json_extract(request_json,'$.type')='material.import'").get(id,task) as Row|undefined
    if(!row)fail('IMPORT_NOT_FOUND');return row!
  }
  private qualify(task:string,id:string):Row {
    const row=this.row(task,id),source=JSON.parse(row.source_json),t=this.db.prepare('SELECT state FROM tasks WHERE id=?').get(task) as Row|undefined
    if(!row.commit_valid||row.state==='ended'||source.type!=='host_import'||source.epoch!==this.epoch||t?.state!=='active')fail('IMPORT_SOURCE_INVALID')
    return row
  }
  private public(row:Row):Row {
    const request=JSON.parse(row.request_json),result=row.result_json?JSON.parse(row.result_json):null
    const stage=this.db.prepare("SELECT received_bytes,expected_bytes FROM staging WHERE owner_id=? AND owner_kind='action'").get(row.id) as Row|undefined
    return {operation_id:row.id,batch_id:request.batch_id,display_name:request.display_name,source:request.source,retry_of:request.retry_of??null,state:row.state==='ended'?(row.result==='success'?'success':row.result==='cancelled'?'cancelled':'failed'):row.state==='registered'?'waiting':'importing',code:result?.code??(row.state==='ended'&&row.result!=='success'?'IMPORT_INTERRUPTED':null),resource:result?.resource??null,received_bytes:stage?.received_bytes??0,expected_bytes:stage?.expected_bytes??null,created_at:row.created_at,ended_at:row.ended_at}
  }
  handle(r:Row):unknown {
    if(r.type==='material.list'){
      const rows=this.db.prepare("SELECT rowid ordinal,* FROM actions WHERE task_id=? AND json_extract(request_json,'$.type')='material.import' AND rowid<? ORDER BY rowid DESC LIMIT 21").all(r.task_id,r.before??Number.MAX_SAFE_INTEGER) as Row[]
      return {items:rows.slice(0,20).map(row=>this.public(row)),next_before:rows.length>20?rows[19]!.ordinal:null}
    }
    if(r.type==='material.status')return this.public(this.row(r.task_id,r.operation_id))
    if(r.type==='material.cancel')return this.end(r.task_id,r.operation_id,'cancelled','IMPORT_CANCELLED')
    if(r.type==='material.internal.fail')return this.end(r.task_id,r.operation_id,'failure',r.code)
    if(r.type==='material.read')return this.read(r.task_id,r.resource_id,r.offset??0)
    if(r.type==='material.internal.register'){
      const task=this.db.prepare('SELECT state FROM tasks WHERE id=?').get(r.task_id) as Row|undefined
      if(task?.state!=='active')fail('IMPORT_TASK_INACTIVE')
      const live=(this.db.prepare("SELECT count(*) n FROM actions WHERE state!='ended' AND json_extract(request_json,'$.type')='material.import'").get() as Row).n
      if(live+r.items.length>50)fail('IMPORT_QUEUE_FULL')
      if(r.retry_of&&(r.items.length!==1||this.row(r.task_id,r.retry_of).state!=='ended'||!['failure','not_executed'].includes(this.row(r.task_id,r.retry_of).result)))fail('IMPORT_RETRY_INVALID')
      const batch=randomUUID(),ids:string[]=[]
      this.db.transaction(()=>{for(const item of r.items){const id=randomUUID();ids.push(id);const display=item.display_name.replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,200)
        this.db.prepare("INSERT INTO actions (id,task_id,kind,state,source_json,request_json,commit_valid,created_at) VALUES (?,?,'mutation','registered',?,?,1,?)").run(id,r.task_id,JSON.stringify({type:'host_import',epoch:this.epoch}),JSON.stringify({type:'material.import',batch_id:batch,display_name:display,source:item.source,...(r.retry_of?{retry_of:r.retry_of}:{})}),now())
      }})()
      return {batch_id:batch,items:ids.map(id=>this.public(this.row(r.task_id,id)))}
    }
    const row=this.qualify(r.task_id,r.operation_id)
    try {
      if(r.type==='material.internal.begin'){
        if(row.state!=='registered'||this.transfers.has(row.id))fail('IMPORT_SEQUENCE_INVALID')
        const key=randomUUID(),stage=randomUUID()
        this.journal.assertResource({id:key,storage_key:key})
        this.db.transaction(()=>{
          this.db.prepare("INSERT INTO staging (id,task_id,owner_kind,owner_id,runtime_epoch,state,storage_key,expected_bytes,sha256,created_at) VALUES (?,?,'action',?,?,'receiving',?,?,NULL,?)").run(stage,r.task_id,row.id,this.epoch,key,r.byte_length,now())
          this.db.prepare("UPDATE actions SET state='executing',request_json=? WHERE id=?").run(JSON.stringify({...JSON.parse(row.request_json),byte_length:r.byte_length,media_type:r.media_type}),row.id)
        })()
        const fd=fs.openSync(join(this.root,'resources',key+'.tmp'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
        this.transfers.set(row.id,{fd,key,stage,received:0,expected:r.byte_length,hash:createHash('sha256'),text:r.media_type.startsWith('text/')?new TextDecoder('utf-8',{fatal:true}):null,media:r.media_type})
      }else{
        const t=this.transfers.get(row.id);if(!t)fail('IMPORT_SEQUENCE_INVALID')
        if(r.type==='material.internal.chunk'){
          const body=Buffer.from(r.data,'base64')
          if(body.toString('base64')!==r.data||!body.length||body.length>defaults.transport.upload_chunk_bytes||r.offset!==t!.received||t!.received+body.length>t!.expected)fail('IMPORT_SEQUENCE_INVALID')
          if(t!.text){try{t!.text.decode(body,{stream:true})}catch{t!.text=null;t!.media='application/octet-stream'}}
          let written=0;while(written<body.length){const n=fs.writeSync(t!.fd,body,written,body.length-written,t!.received+written);if(!n)fail('IMPORT_WRITE_FAILED');written+=n}
          t!.hash.update(body);t!.received+=body.length
          this.db.prepare('UPDATE staging SET received_bytes=? WHERE id=?').run(t!.received,t!.stage)
        }else if(r.type==='material.internal.finish'){
          if(t!.received!==t!.expected)fail('IMPORT_LENGTH_MISMATCH')
          if(t!.text){try{t!.text.decode()}catch{t!.media='application/octet-stream'}}
          fs.fsyncSync(t!.fd);fs.closeSync(t!.fd);t!.fd=-1
          const hash=t!.hash.digest('hex'),temporary=join(this.root,'resources',t!.key+'.tmp'),stat=fs.lstatSync(temporary)
          if(!stat.isFile()||stat.nlink!==1||stat.size!==t!.expected)fail('IMPORT_FILE_CHANGED')
          fs.renameSync(temporary,join(this.root,'resources',t!.key));this.sync()
          this.db.prepare("UPDATE staging SET state='prepared',sha256=? WHERE id=?").run(hash,t!.stage)
          const commit = () => { if (this.closed) fail('IMPORT_SOURCE_INVALID'); this.db.transaction(()=>{
            this.qualify(r.task_id,row.id);this.journal.assertResource({id:t!.key,storage_key:t!.key})
            const resource={id:t!.key,sha256:hash,byte_length:t!.expected,media_type:t!.media,display_name:JSON.parse(row.request_json).display_name}
            this.db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?)').run(t!.key,t!.key,hash,t!.expected,t!.media,resource.display_name,now())
            this.db.prepare('INSERT INTO task_resources VALUES (?,?)').run(r.task_id,t!.key)
            this.storage.commit(t!.stage,t!.key)
            this.record(r.task_id,'material.imported',{action_id:row.id,resource_id:t!.key})
            this.db.prepare("UPDATE actions SET state='ended',result='success',commit_valid=0,authorization_json=?,result_json=?,ended_at=? WHERE id=?").run('{"basis":"explicit_host_import"}',JSON.stringify({resource}),now(),row.id)
          })(); this.transfers.delete(row.id); return this.public(this.row(r.task_id,row.id)) }
          const resource = { id: t!.key, storage_key: t!.key, sha256: hash, byte_length: t!.expected }
          if (t!.expected > 262144) return readPluginResource(this.root, resource, 0, true).then(commit).catch(error => { if (!this.closed) this.end(r.task_id,row.id,'failure',error instanceof ContractError ? error.code : 'IMPORT_SAVE_FAILED'); throw new ContractError('IMPORT_SAVE_FAILED','Material final verification failed; query the original operation') })
          this.readText(resource,0); return commit()
        }else fail('IMPORT_SEQUENCE_INVALID')
      }
      return this.public(this.row(r.task_id,row.id))
    }catch(e){this.end(r.task_id,row.id,'failure',e instanceof ContractError?e.code:'IMPORT_SAVE_FAILED');throw e instanceof ContractError?e:new ContractError('IMPORT_SAVE_FAILED','Material save failed; original source was not changed')}
  }
  private sync():void {if(process.platform!=='win32'){const fd=fs.openSync(join(this.root,'resources'),'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}}
  private end(task:string,id:string,result:string,code:string):unknown {
    const row=this.row(task,id);if(row.state==='ended')return this.public(row)
    this.db.prepare("UPDATE actions SET state='ended',result=?,commit_valid=0,result_json=?,ended_at=? WHERE id=?").run(result,JSON.stringify({code}),now(),id)
    const t=this.transfers.get(id);if(t){if(t.fd>=0)fs.closeSync(t.fd);this.transfers.delete(id)}
    this.storage.failed(id);return this.public(this.row(task,id))
  }
  cancelTask(task:string):void {for(const r of this.db.prepare("SELECT id FROM actions WHERE task_id=? AND state!='ended' AND json_extract(request_json,'$.type')='material.import'").all(task) as Row[])this.end(task,r.id,'cancelled','IMPORT_TASK_STOPPED')}
  close():void {this.closed=true;for(const t of this.transfers.values())if(t.fd>=0)fs.closeSync(t.fd);this.transfers.clear()}
  private read(task:string,id:string,offset:number):unknown {
    const r=this.db.prepare('SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id WHERE t.task_id=? AND r.id=?').get(task,id) as Row|undefined
    if(!r)fail('IMPORT_NOT_FOUND');this.journal.assertResource(r!)
    if(r!.media_type!=='text/plain; charset=utf-8')return {id,content_available:false,reason:'UNSUPPORTED_REPRESENTATION'}
    if(!Number.isSafeInteger(offset)||offset<0||offset>r!.byte_length)fail('INVALID_RANGE')
    if (r!.byte_length > 262144) {
      const frozen = JSON.stringify(r)
      return readPluginResource(this.root, r as any, offset).then(part => {
        if (this.closed || !this.db.open) fail('IMPORT_SOURCE_INVALID')
        const current = this.db.prepare("SELECT r.* FROM resources r JOIN task_resources t ON t.resource_id=r.id JOIN tasks task ON task.id=t.task_id WHERE t.task_id=? AND r.id=? AND task.state!='deleting'").get(task,id)
        if (!current || JSON.stringify(current)!==frozen) fail('RESOURCE_CORRUPT')
        this.journal.assertResource(r!); return { id,sha256:r!.sha256,offset,content_available:true,...part }
      })
    }
    return this.readText(r!,offset)
  }
  readText(r:Row,offset:number):Row {
    this.journal.assertResource(r)
    if(!Number.isSafeInteger(r.byte_length)||r.byte_length<0||r.byte_length>defaults.transport.resource_bytes)fail('RESOURCE_CORRUPT')
    if(!Number.isSafeInteger(offset)||offset<0||offset>r.byte_length)fail('INVALID_RANGE')
    if(!/^[A-Za-z0-9_-]+$/.test(r.storage_key))fail('RESOURCE_CORRUPT')
    const id=r.id,path=join(this.root,'resources',r.storage_key),initial=fs.lstatSync(path)
    if(!/^[A-Za-z0-9_-]+$/.test(r!.storage_key)||!initial.isFile()||initial.nlink!==1||initial.size!==r!.byte_length)fail('RESOURCE_CORRUPT')
    const fd=fs.openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW)
    try {
      const open=fs.fstatSync(fd);if(open.ino!==initial.ino||open.dev!==initial.dev)fail('RESOURCE_CORRUPT')
      const hash=createHash('sha256'),buffer=Buffer.alloc(defaults.transport.upload_chunk_bytes);let pos=0
      while(pos<initial.size){const n=fs.readSync(fd,buffer,0,Math.min(buffer.length,initial.size-pos),pos);if(!n)fail('RESOURCE_CORRUPT');hash.update(buffer.subarray(0,n));pos+=n}
      const end=fs.fstatSync(fd);if(end.size!==initial.size||end.mtimeMs!==initial.mtimeMs||end.ctimeMs!==initial.ctimeMs||hash.digest('hex')!==r!.sha256)fail('RESOURCE_CORRUPT')
      const piece=Buffer.alloc(Math.min(4096,r!.byte_length-offset)),n=piece.length?fs.readSync(fd,piece,0,piece.length,offset):0
      let stop=n;if(offset+stop<r!.byte_length){let start=stop-1;while(start>=0&&(piece[start]!&0xc0)===0x80)start--;if(start>=0){const first=piece[start]!,needed=first<128?1:first<224?2:first<240?3:4;if(stop-start<needed)stop=start}}
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(piece.subarray(0,stop))}catch{if(r.media_type==='text/plain; charset=utf-8')return fail('RESOURCE_CORRUPT');text=''}
      const final=fs.fstatSync(fd),current=fs.lstatSync(path)
      if([final,current].some(s=>s.ino!==initial.ino||s.dev!==initial.dev||s.size!==initial.size||s.mtimeMs!==initial.mtimeMs||s.ctimeMs!==initial.ctimeMs))fail('RESOURCE_CORRUPT')
      return {id,sha256:r!.sha256,text,offset,next_offset:offset+stop<r!.byte_length?offset+stop:null,content_available:true,truncated:offset+stop<r!.byte_length}
    }finally{fs.closeSync(fd)}
  }
}

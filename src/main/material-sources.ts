import fs, { constants } from 'node:fs'
import { basename, extname } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import defaults from '../shared/contracts/development-defaults.json'
type Row=Record<string,any>
export class MaterialSources {
  private active=false
  constructor(private call:(r:Row)=>Promise<any>,private choose:()=>Promise<string[]>){}
  async start(r:Row):Promise<any>{
    if(this.active)throw Error('IMPORT_BUSY')
    this.active=true
    try{
      const files=r.type==='material.pick'?await this.choose():[]
      if(r.type==='material.pick'&&!files.length){this.active=false;return {cancelled:true,items:[]}}
      if(files.length>50)throw Error('IMPORT_BATCH_LIMIT')
      const sources=r.type==='material.text'?[{name:r.display_name,text:r.text,path:null}]:files.map(path=>({name:basename(path).slice(0,200),path,text:null}))
      const registered=await this.call({type:'material.internal.register',task_id:r.task_id,items:sources.map(s=>({display_name:s.name,source:s.path?'file':'text'})),...(r.retry_of?{retry_of:r.retry_of}:{})})
      void this.transfer(r.task_id,sources,registered.items).catch(()=>{}).finally(()=>{this.active=false})
      return registered
    }catch(e){this.active=false;throw e}
  }
  private async transfer(task:string,sources:{name:string;path:string|null;text:string|null}[],items:Row[]):Promise<void>{
    for(let i=0;i<sources.length;i++){
      const source=sources[i]!,id=items[i]!.operation_id;let fd:number|undefined
      const call=(type:string,extra:Row={})=>this.call({type,task_id:task,operation_id:id,...extra})
      try{
        const status=await call('material.status');if(status.state!=='waiting')continue
        let initial:fs.Stats|undefined,body:Buffer|undefined,size:number
        if(source.path){
          initial=fs.lstatSync(source.path)
          if(!initial.isFile()||initial.nlink!==1)throw Error('IMPORT_UNSAFE_SOURCE')
          size=initial.size;if(size>defaults.transport.resource_bytes)throw Error('IMPORT_TOO_LARGE')
          fd=fs.openSync(source.path,constants.O_RDONLY|constants.O_NOFOLLOW)
          const opened=fs.fstatSync(fd);if(opened.ino!==initial.ino||opened.dev!==initial.dev)throw Error('IMPORT_SOURCE_CHANGED')
        }else{body=Buffer.from(source.text!,'utf8');size=body.length;if(size>defaults.resource.inline_bytes)throw Error('IMPORT_TOO_LARGE')}
        const textual=!source.path||['.txt','.md','.csv','.tsv','.json','.log','.html','.htm','.svg','.xml','.css','.js','.ts'].includes(extname(source.name).toLowerCase())
        await call('material.internal.begin',{byte_length:size,media_type:textual?'text/plain; charset=utf-8':'application/octet-stream'})
        const buffer=Buffer.alloc(defaults.transport.upload_chunk_bytes);let offset=0
        while(offset<size){
          const n=body?Math.min(buffer.length,size-offset):fs.readSync(fd!,buffer,0,Math.min(buffer.length,size-offset),offset)
          if(!n)throw Error('IMPORT_SOURCE_CHANGED')
          const chunk=body?body.subarray(offset,offset+n):buffer.subarray(0,n)
          await call('material.internal.chunk',{offset,data:chunk.toString('base64')});offset+=n;await setImmediate()
        }
        if(source.path){const end=fs.fstatSync(fd!),path=fs.lstatSync(source.path);if([end,path].some(s=>s.ino!==initial!.ino||s.dev!==initial!.dev||s.size!==initial!.size||s.mtimeMs!==initial!.mtimeMs||s.ctimeMs!==initial!.ctimeMs))throw Error('IMPORT_SOURCE_CHANGED')}
        await call('material.internal.finish')
      }catch(e){const code=(e as Error).message;await call('material.internal.fail',{code:['IMPORT_UNSAFE_SOURCE','IMPORT_TOO_LARGE','IMPORT_SOURCE_CHANGED'].includes(code)?code:'IMPORT_SOURCE_UNAVAILABLE'}).catch(()=>{})}
      finally{if(fd!==undefined)fs.closeSync(fd)}
    }
  }
}

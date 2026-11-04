import { useEffect, useRef, useState } from 'react'
import { hostRequest } from './ModelSettings'
import { RecordBrowser } from './TaskInspector'
import { DialogFocus } from './Dialog'
type Item={operation_id:string;display_name:string;state:string;code:string|null;received_bytes:number;expected_bytes:number|null;resource:{id:string}|null;retry_of:string|null}
const labels:Record<string,string>={waiting:'等待',importing:'导入中',success:'已导入',failed:'失败',cancelled:'已取消'}
export function Materials({taskId,active,onDirty}:{taskId:string;active:boolean;onDirty:(id:string,dirty:boolean)=>void}){
 const [items,setItems]=useState<Item[]>([]),[before,setBefore]=useState<number|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[text,setText]=useState(''),[name,setName]=useState('文本材料'),[retry,setRetry]=useState<string|null>(null),[detail,setDetail]=useState<any>(null),[version,setVersion]=useState(0)
 const pageBefore=useRef<number|null>(null), pendingText=useRef<{id:string;text:string}|null>(null), loadSequence=useRef(0), seenSuccess=useRef(new Set<string>())
 const [textPending,setTextPending]=useState(false),[unknown,setUnknown]=useState(false)
 const [discardOpen,setDiscardOpen]=useState(false)
 useEffect(()=>{onDirty('material-text',!!text||unknown);return()=>onDirty('material-text',false)},[text,unknown])
 async function load(older=false){const sequence=++loadSequence.current;try{if(older)pageBefore.current=before;const r=await hostRequest<any>({type:'material.list',task_id:taskId,...(pageBefore.current?{before:pageBefore.current}:{})});const pending=pendingText.current;if(pending){const row=await hostRequest<Item>({type:'material.status',task_id:taskId,operation_id:pending.id});if(!['waiting','importing'].includes(row.state)){if(row.state==='success')setText(old=>old===pending.text?'':old);pendingText.current=null;setTextPending(false)}}if(sequence!==loadSequence.current)return;const successes=r.items.filter((x:Item)=>x.state==='success');if(successes.some((x:Item)=>!seenSuccess.current.has(x.operation_id)))setVersion(v=>v+1);seenSuccess.current=new Set(successes.map((x:Item)=>x.operation_id));setItems(r.items);setBefore(r.next_before)}catch(e){setError(String(e))}}
 useEffect(()=>{void load();const timer=setInterval(()=>{void load()},1000);return()=>{clearInterval(timer);loadSequence.current++}},[taskId])
 async function start(type:'material.pick'|'material.text'){
  setBusy(true);setError('')
  try{const base={task_id:taskId,...(retry?{retry_of:retry}:{})};const r=await hostRequest<any>(type==='material.text'?{type,...base,display_name:name,text}:{type,...base});if(!r.cancelled){if(type==='material.text'){pendingText.current={id:r.items[0].operation_id,text};setTextPending(true)}setRetry(null);setVersion(v=>v+1)}await load()}
  catch(e){if(/UNKNOWN_RESULT|CONNECTION_LOST|OFFLINE/.test(String(e)))setUnknown(true);setError(String(e)+'。若结果未知，请先刷新原操作，不要重复提交。')}
  finally{setBusy(false)}
 }
 async function read(id:string,offset=0){setBusy(true);setError('');try{setDetail(await hostRequest({type:'material.read',task_id:taskId,resource_id:id,offset}))}catch(e){setError(String(e));setDetail(null)}finally{setBusy(false)}}
 return <section className="inspector" aria-label="材料导入"><h2>任务材料</h2>
  <p className="notice">导入只保存，不启动 Agent、不解析、不执行文件、不自动外发。已导入不等于已解析或已发送。每批最多 50 项，文件上限 256 MiB，粘贴文本上限 256 KiB（UTF-8 字节）；不扫描文件夹、不解压。其他格式可保存，未支持预览时只显示元信息。</p>
  <button disabled={busy||textPending||unknown||!active} onClick={()=>void start('material.pick')}>选择文件导入{retry?'（仅重试此项）':''}</button>
  <label>材料名称<input aria-label="材料名称" disabled={busy||textPending} value={name} maxLength={200} onChange={e=>setName(e.target.value)}/></label>
  <label>添加为材料的文本<textarea aria-label="添加为材料的文本" disabled={busy||textPending} value={text} onChange={e=>setText(e.target.value)}/></label>
  <button disabled={busy||textPending||unknown||!active||!text||!name} onClick={()=>void start('material.text')}>将文本保存为材料</button>
  {text&&<button disabled={busy||textPending} onClick={()=>setDiscardOpen(true)}>丢弃未导入文本</button>}
  {discardOpen&&<DialogFocus><div className="overlay"><section className="modal" role="dialog" aria-modal="true" aria-label="丢弃未导入文本" onKeyDown={e=>{if(e.key==='Escape')setDiscardOpen(false)}}><h2>丢弃未导入文本？</h2><p>只清除当前尚未导入的文本，不删除已导入材料或历史操作。取消将保留输入。</p><div><button onClick={()=>setDiscardOpen(false)}>取消</button><button disabled={busy||textPending} onClick={()=>{setText('');setDiscardOpen(false)}}>确认丢弃</button></div></section></div></DialogFocus>}
  {retry&&<p role="status">重试原失败项 {retry}；新导入产生新操作，不覆盖旧结果。请选择一个文件或明确添加文本。<button onClick={()=>setRetry(null)}>取消重试选择</button></p>}
  {unknown&&<p role="alert">注册结果未知，提交已暂停。请刷新并查询导入操作；不要重复导入。<button onClick={()=>{if(confirm('已检查原导入操作并确认结果？解除暂停不会重新导入。'))setUnknown(false)}}>已核对原结果，解除暂停</button></p>}
  {error&&<p role="alert">{error}</p>}
  <section aria-label="导入操作"><header className="section-heading"><h3>导入操作</h3><button onClick={()=>{pageBefore.current=null;setVersion(v=>v+1);void load()}}>刷新导入结果</button></header>
   {!items.length&&<p>尚无导入操作。</p>}
   {items.map(item=><article key={item.operation_id}><h4>{item.display_name}</h4><p>{labels[item.state]} · {item.received_bytes} / {item.expected_bytes??'待检查'} 字节{item.code?' · '+item.code:''}</p><p className="mono">原操作 {item.operation_id}</p>
    {['waiting','importing'].includes(item.state)&&<button onClick={async()=>{try{await hostRequest({type:'material.cancel',task_id:taskId,operation_id:item.operation_id});await load()}catch(e){setError(String(e))}}}>取消此项导入</button>}
    {item.state==='failed'&&<button onClick={()=>setRetry(item.operation_id)}>选择来源重试此失败项</button>}
    <button onClick={async()=>{try{const current=await hostRequest<Item>({type:'material.status',task_id:taskId,operation_id:item.operation_id});setItems(old=>old.map(v=>v.operation_id===current.operation_id?current:v))}catch(e){setError(String(e))}}}>查询此原操作</button>
    {item.resource&&<button disabled={busy} onClick={()=>void read(item.resource!.id)}>安全查看此材料</button>}
   </article>)}
   {before!==null&&<button onClick={()=>void load(true)}>查看更早导入操作</button>}
  </section>
  {detail&&<article aria-label="材料文本片段"><h3>材料查看</h3>{detail.content_available?<><p>字节偏移 {detail.offset} · {detail.truncated?'当前仅为片段':'已到末尾'}，不自动执行或外联。</p><pre>{detail.text}</pre>{detail.next_offset!==null&&<button disabled={busy} onClick={()=>void read(detail.id,detail.next_offset)}>读取下一段材料</button>}</>:<p>保存成功，但暂不支持此格式预览；未调用解析或执行能力。</p>}</article>}
  <RecordBrowser key={version} taskId={taskId} kind="resource" label="全部资源"/>
 </section>
}

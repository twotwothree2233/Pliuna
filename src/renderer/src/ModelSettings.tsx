import { useEffect, useRef, useState } from 'react'
import type { HostRequest } from '../../shared/types'
import type { ModelConfiguration } from '../../shared/contracts.generated'
import type { ModelChannel } from '../../runtime/model/channels'
import type { ModelCatalogue } from '../../runtime/model/adapter'
import type { ConnectionTest } from '../../runtime/model/service'
import { WorkspaceIcon } from './WorkspaceIcon'
import './model-settings.css'
import { modelMetadata, officialProviders } from '../../runtime/model/metadata'
import { modelErrorMessage } from './model-errors'
import { DialogFocus } from './Dialog'
import { ModelCatalogueDialog } from './ModelCatalogueDialog'
import { ApprovalSettings } from './ApprovalSettings'
export interface ModelOption extends ModelConfiguration { revision: number; roles: ('main' | 'approval' | 'compaction')[]; occupied: boolean; credential_storage: 'plain-file' | 'system-secure' | 'memory-only'; credential_missing: boolean; connection_test?: ConnectionTest }
export interface ChannelOption extends ModelChannel { revision: number; remembered: boolean; credential_missing: boolean; occupied: boolean }
export interface ModelState { models: ModelOption[]; channels?: ChannelOption[]; storage?: { available: boolean; backend: string; error?: string }; approval: { mode: 'manual' | 'assisted'; model_id: string }; features?: { view_replacement: boolean } }
export async function hostRequest<T>(input: HostRequest): Promise<T> {
  if (!window.pliuna) throw new Error('桌面桥接不可用：请通过 pnpm dev 启动 Electron 使用本地数据。')
  const response = await window.pliuna.request(input)
  if (!response.ok) throw Object.assign(new Error(`${response.error.code}: ${response.error.message}`), { code: response.error.code })
  return response.data as T
}
export const availableModels = (models: ModelOption[]) => models.filter(model => !model.credential_missing)
const limitLabels = [['request_timeout_ms','单请求超时（毫秒）'],['response_bytes','单请求响应流累计字节']] as const
export function ModelSettings({ state, reload, section = 'models', onBusy, selection }: { state: ModelState; reload(): Promise<void>; section?: 'models' | 'approval'; onBusy?(busy: boolean): void; selection: { id: string; set(id: string): void; locked: boolean } }) {
  const [busy, setBusy] = useState(false), active = useRef<string | null>(null), [status, setStatus] = useState('')
  const [channel, setChannel] = useState<{ id: string; name: string; base_url: string; compatibility_profile: ModelChannel['compatibility_profile']; key: string; reuse: boolean; remember: boolean; existing: boolean } | null>(null)
  const [editor, setEditor] = useState<{ channelId: string; id: string; existing: boolean; name: string; model: string; context: string; output: string; compact: string; history: boolean; limits: Record<string,string>; metadata?: ModelConfiguration['metadata'] } | null>(null)
  const [catalogue, setCatalogue] = useState<{ channelId: string; data: ModelCatalogue } | null>(null)
  const [test, setTest] = useState<ModelOption | null>(null)
  const [testingApproval, setTestingApproval] = useState(false)
  const [expanded, setExpanded] = useState<Record<string,boolean>>({})
  const channels = state.channels ?? []
  const catalogueChannel = channels.find(c => c.id === catalogue?.channelId)
  useEffect(() => () => { if (active.current) void hostRequest({ type:'model.cancel', operation_id:active.current }).catch(() => {}) }, [])
  async function operation(work: (id: string) => Promise<void>) {
    if (active.current) return
    const id = crypto.randomUUID(); active.current=id; setBusy(true); onBusy?.(true); setStatus('处理中…')
    try { await work(id) } catch(error) { setStatus(modelErrorMessage(error)) }
    finally { try { await reload() } catch { setStatus('状态查询失败；请重新查询，不自动重发操作。') }; active.current=null;setBusy(false);onBusy?.(false) }
  }
  async function cancel() { if (active.current) { try { await hostRequest({type:'model.cancel',operation_id:active.current});setStatus('已请求取消，正在等待清理。') } catch(error) {setStatus(modelErrorMessage(error))} } }
  function addModel(c: ChannelOption, m?: ModelOption, candidate?: ModelCatalogue['models'][number]) {
    setEditor({channelId:c.id,id:m?.id??crypto.randomUUID(),existing:!!m,name:m?.display_name??m?.wire_model_id??candidate?.id??'',model:m?.wire_model_id??candidate?.id??'',context:m?String(m.context_tokens):candidate?.context_tokens===undefined?'':String(candidate.context_tokens),output:m?.max_output_tokens===undefined?(candidate?.max_output_tokens===undefined?'':String(candidate.max_output_tokens)):String(m.max_output_tokens),compact:m?.compaction_model_id??'',history:false,limits:Object.fromEntries(Object.entries(m?.limits??{}).map(([k,v])=>[k,String(v)])),metadata:m?.metadata??modelMetadata(candidate,catalogue?.data.fetched_at,candidate?{context:false,output:false}:{context:true,output:true})})
  }
  const modal = (title: string, body: React.ReactNode, close: () => void) => <DialogFocus><div className="overlay"><section className="modal model-modal" role="dialog" aria-modal="true" aria-label={title} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();if(!busy)close()}}}><header><h2>{title}</h2><button disabled={busy} onClick={close}>关闭</button></header>{body}<p role="status" className="settings-operation-status">{status}</p>{busy&&<button onClick={()=>void cancel()}>取消当前操作</button>}</section></div></DialogFocus>
  const available = availableModels(state.models)
  const modelLabel = (model: ModelOption) => `${channels.find(c => c.id === model.channel_id)?.name ?? new URL(model.base_url).host} / ${model.display_name ?? model.wire_model_id}`
  function newChannel() {
    setChannel({ id: crypto.randomUUID(), name: '', base_url: '', compatibility_profile: 'chat-max-tokens', key: '', reuse: false, remember: !!state.storage?.available && !state.storage.error, existing: false })
  }
  function discover(c: ChannelOption) {
    if (!confirm(`查询 ${c.name} 的模型列表？此操作使用渠道凭据。`)) return
    void operation(async id => {
      const data = await hostRequest<ModelCatalogue>({ type: 'model.channel.discover', channel_id: c.id, operation_id: id, confirm_external_processing: true })
      setCatalogue({ channelId: c.id, data }); setStatus('')
    })
  }
  function removeModel(model: ModelOption) {
    if (!confirm('移除此模型？渠道连接和其他模型保留。')) return
    void operation(async () => { await hostRequest({ type: 'model.remove', model_id: model.id }); setStatus('模型已移除。') })
  }
  function saveApproval({ mode, model_id }: ModelState['approval']) {
    void operation(async id => {
      if (mode === 'assisted' && !state.models.find(model => model.id === model_id)?.roles.includes('approval')) {
        setTestingApproval(true)
        try { await hostRequest({ type: 'model.test', model_id, role: 'approval', confirm_cost: true, operation_id: id }) }
        finally { setTestingApproval(false) }
      }
      try { await hostRequest({ type: 'approval.configure', mode, model_id, confirm_external_processing: mode === 'assisted' }) }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'CONFIGURATION_BUSY') throw Error('执行期间无法修改审批设置。')
        throw error
      }
      setStatus('已保存')
    })
  }
  if (section === 'approval') return <ApprovalSettings saved={state.approval} models={available.map(model => ({ id: model.id, label: modelLabel(model), verified: model.roles.includes('approval') }))}
    locked={selection.locked || busy} status={status} onSave={saveApproval} onCancelTest={testingApproval ? () => void cancel() : undefined} />
  return <div className="model-settings-content">
      <header className="model-page-title"><h1>模型服务</h1><p>保存模型后即可使用，连接测试可选。</p></header>
      <section className="model-current" aria-labelledby="current-model-heading">
        <div className="model-current-label"><span className="model-current-icon"><WorkspaceIcon name="chat" /></span><div>
          <h2 id="current-model-heading">当前主模型</h2><p>用于下一次请求</p>
        </div></div>
        <select aria-label="本次模型" value={selection.id} disabled={selection.locked || busy} onChange={e => selection.set(e.target.value)}>
          <option value="" disabled>{available.length ? '选择主模型' : '尚无可用模型'}</option>
          {available.map(model => <option key={model.id} value={model.id}>{modelLabel(model)}</option>)}
          <option value="fixture">开发 fixture（固定示例，不联网）</option>
        </select>
      </section>
      <section className="model-channels" aria-labelledby="model-channels-heading">
        <header className="model-channels-heading">
          <div><h2 id="model-channels-heading">服务渠道</h2><p>同一渠道的模型共用 API 地址和密钥。</p></div>
          <button className="primary" disabled={busy} onClick={newChannel}>＋ 添加渠道</button>
        </header>
        {!channels.length && <div className="model-empty"><strong>尚未配置渠道</strong><p>添加渠道后，可手动添加模型或从服务获取列表。</p></div>}
        {channels.map(c => {
          const models = state.models.filter(m => m.channel_id === c.id)
          const open = expanded[c.id] !== false
          return <section className="model-channel" key={c.id} aria-label={c.name}>
            <header className="model-channel-heading">
              <button className="model-channel-toggle" aria-expanded={open} onClick={() => setExpanded(old => ({ ...old, [c.id]: !open }))}>
                <span className="model-channel-chevron" aria-hidden="true" />
                <span><strong>{c.name}</strong><small>{c.base_url}</small></span>
              </button>
              <div className="channel-credentials" data-missing={c.credential_missing}>{c.credential_missing ? '缺少凭据' : c.remembered ? '已记住连接' : '仅本次运行'}</div>
              <button disabled={busy || c.occupied} onClick={() => setChannel({ ...c, key: '', reuse: !c.credential_missing, remember: c.remembered, existing: true })}>渠道设置</button>
            </header>
            {open && <>
              {models.length ? <ul className="model-channel-list" aria-label={`${c.name} 的模型`}>{models.map(m => {
                const name = m.display_name ?? m.wire_model_id
                const state = m.credential_missing ? 'missing' : m.connection_test?.status ?? 'untested'
                const label = { missing: '缺少凭据', connected: '已连通', failed: '连接失败', untested: '未测试' }[state]
                return <li className="channel-model" key={m.id}>
                  <div className="model-row-name">
                    <div><strong>{name}</strong>{m.id === selection.id && <span className="model-current-tag">当前主模型</span>}</div>
                    <small>{name !== m.wire_model_id && <><code>{m.wire_model_id}</code> · </>}{m.context_tokens.toLocaleString()} tokens{m.occupied && ' · 使用中'}</small>
                    <details><summary>参数来源</summary><p>上下文：{m.metadata?.context_tokens.source ?? 'legacy'} · 输出：{m.metadata?.max_output_tokens.source ?? 'legacy'}</p></details>
                  </div>
                  <span className="model-connection-state" data-state={state} title={m.connection_test?.status === 'failed' ? modelErrorMessage(m.connection_test.code) : undefined}>{label}</span>
                  <div className="model-row-actions">
                    <button disabled={busy || m.occupied || m.credential_missing} onClick={() => setTest(m)}>测试连接</button>
                    <button disabled={busy || m.occupied} onClick={() => addModel(c, m)} aria-label={`编辑模型 ${name}`}>编辑</button>
                    <button disabled={busy || m.occupied} onClick={() => removeModel(m)}>移除</button>
                  </div>
                </li>
              })}</ul> : <p className="model-channel-empty">此渠道还没有模型。</p>}
              <footer className="model-channel-actions">
                <button disabled={busy || c.credential_missing} onClick={() => discover(c)}>发现模型</button>
                <button disabled={busy || c.occupied || c.credential_missing} onClick={() => addModel(c)}>＋ 添加模型</button>
              </footer>
            </>}
          </section>
        })}
      </section>
      <details className="model-storage-details"><summary>连接保存方式</summary><p>模型参数保存在 settings.json。记住连接时，API Key 明文保存在本机 auth.json。</p><p>设置存储：{state.storage?.available ? '可用' : '不可用'}{state.storage?.error ? ` · ${state.storage.error}` : ''}</p><button disabled={busy} onClick={() => void operation(async () => { setStatus('已重新查询配置。') })}>重新查询配置状态</button></details>
    <div className="model-operation"><div role="status" className="settings-operation-status">{status}</div>{busy && !channel && !editor && <button onClick={() => void cancel()}>取消当前连接或测试</button>}</div>
    {channel&&modal(channel.existing?'渠道设置':'添加渠道',<form onSubmit={e=>{e.preventDefault();void operation(async()=>{await hostRequest({type:'model.channel.configure',channel:{id:channel.id,name:channel.name.trim(),base_url:channel.base_url.trim(),compatibility_profile:channel.compatibility_profile},api_key:channel.key,use_saved_credential:channel.reuse&&!channel.key,remember_connection:channel.remember,confirm_memory_only:true,...(channel.remember?{confirm_plaintext_storage:true as const}:{})});setChannel(null);setStatus('渠道已保存，所属模型共用连接。')})}}><div className="model-form"><label>渠道名称<input autoFocus required value={channel.name} onChange={e=>setChannel({...channel,name:e.target.value})}/></label><label>服务 Base URL<input type="url" required value={channel.base_url} onChange={e=>setChannel({...channel,base_url:e.target.value,reuse:channel.existing&&!channels.find(c=>c.id===channel.id)?.credential_missing&&channels.find(c=>c.id===channel.id)?.base_url===e.target.value})}/></label><label>API Key<input type="password" autoComplete="off" value={channel.key} placeholder={channel.reuse?'留空复用渠道凭据':'无认证服务可留空'} onChange={e=>setChannel({...channel,key:e.target.value})}/></label><label>显式兼容 Profile<select value={channel.compatibility_profile} onChange={e=>setChannel({...channel,compatibility_profile:e.target.value as ModelChannel['compatibility_profile']})}><option value="chat-max-tokens">max_tokens</option><option value="chat-max-completion-tokens">max_completion_tokens</option></select></label><label className="checkbox-line"><input type="checkbox" disabled={busy||((!state.storage?.available||!!state.storage.error)&&!channel.remember)} checked={channel.remember} onChange={e=>setChannel({...channel,remember:e.target.checked})}/>记住渠道连接（API Key 明文保存至 auth.json）</label>{channel.remember&&<p className="notice">保存即确认将渠道凭据明文保存在本机。请勿分享该文件。</p>}<div className="inline-actions"><button type="button" disabled={busy} onClick={()=>setChannel(null)}>取消</button>{channel.existing&&state.models.some(m=>m.channel_id===channel.id)&&<button type="button" disabled={busy} onClick={()=>{if(!confirm('删除此渠道全部模型的凭据？保留连接参数，相关模型将无法发送请求。'))return;const id=state.models.find(m=>m.channel_id===channel.id)!.id;void operation(async()=>{await hostRequest({type:'model.credential.delete',model_id:id,confirm:true});setChannel(null);setStatus('渠道凭据已删除。')})}}>删除渠道凭据</button>}{channel.existing&&!state.models.some(m=>m.channel_id===channel.id)&&<button type="button" disabled={busy} onClick={()=>{if(confirm('删除此空渠道及其凭据？'))void operation(async()=>{await hostRequest({type:'model.channel.remove',channel_id:channel.id});setChannel(null);setStatus('空渠道已删除。')})}}>删除空渠道</button>}<button className="primary" disabled={busy||(channel.remember&&(!state.storage?.available||!!state.storage.error))}>保存渠道</button></div></div></form>,()=>setChannel(null))}
    {editor&&modal(editor.existing?'编辑模型':'添加模型',<form onSubmit={e=>{e.preventDefault();const c=channels.find(c=>c.id===editor.channelId)!;void operation(async()=>{await hostRequest({type:'model.channel.model',channel_id:c.id,configuration:{id:editor.id,channel_id:c.id,display_name:editor.name.trim(),base_url:c.base_url,compatibility_profile:c.compatibility_profile,wire_model_id:editor.model.trim(),context_tokens:Number(editor.context),...(editor.output?{max_output_tokens:Number(editor.output)}:{}),limits:Object.fromEntries(Object.entries(editor.limits).filter(([,v])=>v.trim()).map(([k,v])=>[k,Number(v)])),...(editor.metadata?{metadata:editor.metadata}:{}),...(editor.compact?{compaction_model_id:editor.compact}:{})},...(editor.history?{confirm_history_processing:true as const}:{})});setEditor(null);setStatus('模型已保存，可以直接使用。')})}}><p className="notice">{channels.find(c=>c.id===editor.channelId)?.name} · 自动使用渠道连接与密钥。</p><div className="model-form"><label>模型名称<input autoFocus required value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})}/></label><label>精确模型标识<input required value={editor.model} onChange={e=>setEditor({...editor,model:e.target.value,metadata:modelMetadata()})}/></label><label>已知上下文容量<input required type="number" min="1" value={editor.context} onChange={e=>setEditor({...editor,context:e.target.value,metadata:editor.metadata?{...editor.metadata,context_tokens:{source:'manual',fetched_at:null,manual_override:true}}:undefined})}/></label><label>输出上限（留空由服务决定）<input type="number" min="1" value={editor.output} onChange={e=>setEditor({...editor,output:e.target.value,metadata:editor.metadata?{...editor.metadata,max_output_tokens:{source:'manual',fetched_at:null,manual_override:true}}:undefined})}/></label><button type="button" disabled={busy||!editor.model||!officialProviders[channels.find(c=>c.id===editor.channelId)!.base_url.replace(/\/$/,'')]} onClick={()=>void operation(async()=>{
        const c=channels.find(c=>c.id===editor.channelId)!,provider=officialProviders[c.base_url.replace(/\/$/,'')]!
        const result=await hostRequest<{candidate:{context_tokens?:number;max_output_tokens?:number}|null;fetched_at:string}>({type:'host.directory.lookup',base_url:c.base_url,provider_id:provider,wire_model_id:editor.model,refresh:true})
        setEditor(current=>{if(!current)return current;const metadata=structuredClone(current.metadata??modelMetadata()),next={...current,metadata};for(const [field,key] of [['context_tokens','context'],['max_output_tokens','output']] as const){if(!current[key]&&result.candidate?.[field]!==undefined){next[key]=String(result.candidate[field]);metadata[field]={source:'models.dev',fetched_at:result.fetched_at,manual_override:false}}}metadata.provider_id=provider;return next})
        setStatus(result.candidate?'已补充缺失的容量，保留已填写的值。':'公开目录无精确匹配，参数保持不变。')
      })}>从公开目录补充缺失容量</button><details><summary>运行限额与压缩模型</summary>{limitLabels.map(([k,label])=><label key={k}>{label}<input type="number" min="1" value={editor.limits[k]??''} onChange={e=>setEditor({...editor,limits:{...editor.limits,[k]:e.target.value}})} placeholder="不限制"/></label>)}<label>独立压缩模型<select value={editor.compact} onChange={e=>setEditor({...editor,compact:e.target.value,history:false})}><option value="">默认当前主模型</option>{state.models.filter(m=>m.id!==editor.id&&(!m.credential_missing||m.id===editor.compact)).map(m=><option key={m.id} value={m.id}>{channels.find(c=>c.id===m.channel_id)?.name} / {m.display_name??m.wire_model_id}</option>)}</select></label>{editor.compact&&<label className="checkbox-line"><input type="checkbox" checked={editor.history} onChange={e=>setEditor({...editor,history:e.target.checked})}/>我确认任务历史将发送至所选压缩服务，可能产生费用。</label>}</details><button disabled={busy} className="primary">保存模型</button></div></form>,()=>setEditor(null))}
    {catalogue && catalogueChannel && <ModelCatalogueDialog channelName={catalogueChannel.name} models={catalogue.data.models}
      addedIds={new Set(state.models.filter(model => model.channel_id === catalogueChannel.id).map(model => model.wire_model_id))}
      busy={busy} status={status} onCancel={() => void cancel()} onClose={() => setCatalogue(null)}
      onAdd={candidate => { addModel(catalogueChannel, undefined, candidate); setCatalogue(null) }} />}
    {test && modal('测试模型连接', <>
      <p>向 <strong>{modelLabel(test)}</strong> 发送一条简短请求。可能产生少量费用，不会发送任务内容。</p>
      <div className="inline-actions"><button onClick={() => setTest(null)}>取消</button><button className="primary" onClick={() => {
        const selected = test; setTest(null)
        void operation(async id => {
          await hostRequest({ type: 'model.test', model_id: selected.id, confirm_cost: true, operation_id: id })
          setStatus(`${selected.display_name ?? selected.wire_model_id} · 连接成功`)
        })
      }}>开始测试</button></div>
    </>, () => setTest(null))}
  </div>
}

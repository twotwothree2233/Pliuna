import { useEffect, useRef, useState } from 'react'
import type { HostRequest } from '../../shared/types'
import { modelErrorMessage } from './model-errors'
import { DialogFocus } from './Dialog'
import { modelMetadata, officialProviders } from '../../runtime/model/metadata'
import type { ModelConfiguration } from '../../shared/contracts.generated'
import type { ModelCatalogue } from '../../runtime/model/adapter'
export interface ModelOption { id: string; revision: number; wire_model_id: string; base_url: string; roles: ('main' | 'approval' | 'compaction')[]; metadata?: ModelConfiguration['metadata']; compaction_model_id?: string; occupied: boolean; context_tokens: number; max_output_tokens?: number; limits?: ModelConfiguration['limits']; compatibility_profile: 'chat-max-tokens' | 'chat-max-completion-tokens'; credential_storage: 'plain-file' | 'system-secure' | 'memory-only'; credential_missing: boolean }
export interface ModelState { models: ModelOption[]; storage?: { available: boolean; backend: string; error?: string }; approval: { mode: 'manual' | 'assisted'; model_id: string }; features?: { view_replacement: boolean } }
export async function hostRequest<T>(input: HostRequest): Promise<T> {
  if (!window.trellis) throw new Error('桌面桥接不可用：浏览器仅预览宿主界面，请通过 pnpm dev 启动 Electron 使用本地数据。')
  const response = await window.trellis.request(input)
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
  return response.data as T
}
export function ModelSettings({ state, reload, close }: { state: ModelState; reload: () => Promise<void>; close: () => void }) {
  const [id, setId] = useState(''), [url, setUrl] = useState(''), [model, setModel] = useState(''), [key, setKey] = useState('')
  const [context, setContext] = useState(''), [output, setOutput] = useState(''), [profile, setProfile] = useState<'chat-max-tokens' | 'chat-max-completion-tokens'>('chat-max-tokens')
  const [memory, setMemory] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [discovered, setDiscovered] = useState<string[]>([])
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null), [metadataStatus, setMetadataStatus] = useState('')
  const [testConfirmation, setTestConfirmation] = useState<{ model: ModelOption; role: 'main' | 'approval' | 'compaction' } | null>(null)
  const [compactModel, setCompactModel] = useState(''), [historyConsent, setHistoryConsent] = useState(false)
  const [limits, setLimits] = useState<Record<string, string>>({})
  const [fieldMetadata, setFieldMetadata] = useState<ModelConfiguration['metadata']>()
  const manualCapacity = useRef({ context: false, output: false })
  const [remember, setRemember] = useState(true), [reuse, setReuse] = useState(false)
  const [approvalModel, setApprovalModel] = useState(state.approval.model_id), [external, setExternal] = useState(false)
  const activeOperation = useRef<string | null>(null)
  const connectionRevision = useRef(0)
  const attemptedConnection = useRef<number | null>(null)
  const savedConnection = useRef<{ id: string; url: string; profile: string } | null>(null)
  const [catalogueLoaded, setCatalogueLoaded] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  function connectionChanged() { setFieldMetadata(undefined); setCompactModel(''); setHistoryConsent(false); savedConnection.current = null; setReuse(false); connectionRevision.current++; setDiscovered([]); setCatalogue(null); setCatalogueLoaded(false); setMemory(false); setMetadataStatus(''); manualCapacity.current = { context: false, output: false } }
  function edit(entry: ModelOption) {
    connectionRevision.current++; attemptedConnection.current = null
    setId(entry.id); setUrl(entry.base_url); setModel(entry.wire_model_id); setContext(String(entry.context_tokens)); setOutput(entry.max_output_tokens === undefined ? '' : String(entry.max_output_tokens)); setLimits(Object.fromEntries(Object.entries(entry.limits ?? {}).map(([key,value]) => [key,String(value)]))); setProfile(entry.compatibility_profile)
    setCompactModel(entry.compaction_model_id ?? ''); setHistoryConsent(false); setFieldMetadata(entry.metadata ? { ...entry.metadata, capabilities: { tools: 'unknown', streaming: 'unknown', vision: 'unknown', structured_output: 'unknown' } } : undefined)
    setCatalogue(null); setMetadataStatus('已保存参数保持不变；刷新仅提供参考，不自动覆盖。来源：' + JSON.stringify(entry.metadata ?? 'legacy')); manualCapacity.current = { context: true, output: true }
    setKey(''); setRemember(entry.credential_storage !== 'memory-only'); setReuse(!entry.credential_missing); setMemory(false); setDiscovered([]); setCatalogueLoaded(false)
    savedConnection.current = { id: entry.id, url: entry.base_url, profile: entry.compatibility_profile }
    setStatus('已载入连接参数，不回显凭据、不联网。相同地址和 Profile 可复用凭据；配置变化后需重新验证。')
  }
  function queryModels() {
    if (activeOperation.current || !memory || !url.trim()) return
    attemptedConnection.current = connectionRevision.current
    setDiscovered([]); setCatalogue(null); setCatalogueLoaded(false)
    void operation(async operationId => {
      const saved = savedConnection.current
      const result = await hostRequest<ModelCatalogue>(saved?.url === url && !key ? { type: 'model.discover', model_id: saved.id, operation_id: operationId, include_metadata: true } : { type: 'model.probe', base_url: url, api_key: key, operation_id: operationId, confirm_memory_only: true, include_metadata: true })
      const ids = result.models.map(model => model.id)
      setCatalogue(result); setDiscovered(ids); setCatalogueLoaded(true)
      setStatus(ids.length ? `查询到 ${ids.length} 个服务候选；未保存模型或启用角色。请选择精确标识，并按服务已知规格补充容量。` : '服务返回 0 个可用模型；未保存模型或启用角色。请检查账号权限，或按服务文档手动填写精确标识。')
    })
  }
  function chooseModel(value: string) {
    setModel(value); setFieldMetadata(undefined)
    const candidate = catalogue?.models.find(candidate => candidate.id === value)
    if (!candidate) { setMetadataStatus('服务没有此精确模型的元数据；仍缺字段需手动填写。'); return }
    if (!manualCapacity.current.context) setContext(candidate.context_tokens === undefined ? '' : String(candidate.context_tokens))
    if (!manualCapacity.current.output) setOutput(candidate.max_output_tokens === undefined ? '' : String(candidate.max_output_tokens))
    const missing = [candidate.context_tokens === undefined ? '上下文容量' : '', candidate.max_output_tokens === undefined ? '输出上限' : ''].filter(Boolean)
    setMetadataStatus('参数来源：当前服务 GET /models · ' + new Date(catalogue!.fetched_at).toLocaleString() + '。' + (missing.length ? '缺失或冲突：' + missing.join('、') + '，请仅补充这些字段；不会按同名模型猜测。' : '已读取容量；仍须真实角色测试。') + (candidate.conflicts.length ? ' 服务数值无效或不一致，未自动采用。' : '') + (manualCapacity.current.context || manualCapacity.current.output ? ' 已有手动/保存值保留，不被覆盖。' : ''))
  }
  useEffect(() => {
    if (!memory || !url.trim()) return
    const timer = setTimeout(() => {
      if (activeOperation.current || attemptedConnection.current === connectionRevision.current) return
      queryModels()
    }, 500)
    return () => clearTimeout(timer)
  }, [url, key, memory])
  async function operation(action: (id: string) => Promise<void>) {
    if (activeOperation.current) return
    const operationId = crypto.randomUUID(); activeOperation.current = operationId
    setBusy(true); setCancelling(false); setStatus('处理中：等待服务或模型响应…')
    try { await action(operationId) } catch (e) { setStatus(modelErrorMessage(e)) }
    finally {
      try { await reload() } catch { setStatus('无法查询配置状态；先重新查询，不自动重发测试。') }
      activeOperation.current = null; setBusy(false); setCancelling(false)
    }
  }
  async function cancel() {
    if (!activeOperation.current) return
    setCancelling(true); setStatus('正在取消，等待请求清理；配置仍锁定。')
    try { await hostRequest({ type: 'model.cancel', operation_id: activeOperation.current }) }
    catch (e) { setStatus(modelErrorMessage(e)); setCancelling(false) }
  }
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) { if (testConfirmation) { setTestConfirmation(null); setStatus('已取消角色测试，未发送请求。') } else close() } }; document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener) }, [busy, testConfirmation])
  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget && !busy && !testConfirmation) close() }}><section className="modal model-modal" role="dialog" aria-modal="true" aria-label="模型与审批配置"><header><h2>模型与审批</h2><button disabled={busy} onClick={close}>关闭</button></header><p className="notice">仅文本 Chat Completions。默认记住连接：配置保存至 ~/.trellis/settings.json，API Key 明文保存至 auth.json（不是加密存储）。请勿分享该文件；缓存可独立清理。也可取消记住连接，仅在本次运行中使用。重启恢复不联网、不续跑；配置、凭据或协议变化后需重新验证。测试可能产生费用。</p>
    <p className="notice">程序设置文件：{state.storage?.available ? '可用 · Key 明文保存' : '不可用，不能记住连接'}{state.storage?.error ? ` · ${state.storage.error}，保留原文件，不自动覆盖。` : ''}</p>
    <button disabled={busy} onClick={() => void operation(async () => { await hostRequest({ type: 'host.cache.clear' }); setStatus('浏览器缓存已清理；配置、凭据、任务数据及 View 状态均保留，未联网。') })}>清理缓存（保留数据与凭据）</button>
    <button disabled={busy} onClick={() => void operation(async () => { await hostRequest({ type: 'host.directory.clear' }); setStatus('公开模型目录缓存已清理，配置、凭据和任务均保留。') })}>单独清理公开模型目录缓存</button>
    {busy && <button disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '取消清理中…' : '取消当前连接或测试'}</button>}
    <form className="model-form" onSubmit={e => { e.preventDefault(); const queryAfterSave = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('data-query') === 'true'; void operation(async operationId => {
      if (queryAfterSave && !memory) throw new Error('请先确认查询服务模型列表，或选择仅保存配置。')
      attemptedConnection.current = connectionRevision.current
      await hostRequest({ type: 'model.configure', configuration: { id, base_url: url, wire_model_id: model, context_tokens: Number(context), ...(output.trim() ? { max_output_tokens: Number(output) } : {}), limits: Object.fromEntries(Object.entries(limits).filter(([, value]) => value.trim()).map(([key, value]) => [key, Number(value)])), compatibility_profile: profile, metadata: fieldMetadata ?? modelMetadata(catalogue?.models.find(m => m.id === model), catalogue?.fetched_at, manualCapacity.current), ...(compactModel ? { compaction_model_id: compactModel } : {}) }, ...(historyConsent ? { confirm_history_processing: true as const } : {}), api_key: key, confirm_memory_only: true, remember_connection: remember, ...(remember ? { confirm_plaintext_storage: true as const } : {}), use_saved_credential: reuse && !key })
      savedConnection.current = { id, url, profile }; setReuse(true)
      setKey('')
      if (!queryAfterSave) { setStatus(`已保存${remember ? '文件' : '内存'}配置，未联网；角色未自动启用。`); return }
      setStatus(`已保存${remember ? '文件' : '内存'}配置。正在查询服务模型列表…`)
      setDiscovered([]); setCatalogueLoaded(false)
      try { const result = await hostRequest<ModelCatalogue>({ type: 'model.discover', model_id: id, operation_id: operationId, include_metadata: true }); setCatalogue(result); setDiscovered(result.models.map(model => model.id)); setCatalogueLoaded(true); setStatus(`查询到 ${result.models.length} 个服务候选；目录不代表角色验证通过。`) }
      catch (error) { setStatus(`${modelErrorMessage(error)} 连接已保存，目录不代表角色验证；请核对当前角色状态。`) }
    }) }}>
      <label>配置标识<input autoFocus required disabled={busy} maxLength={200} value={id} onChange={e => { setId(e.target.value); savedConnection.current = null; setReuse(false) }} placeholder="例如 local-main" /></label>
      <label>服务 Base URL<input type="url" required disabled={busy} value={url} onChange={e => { setUrl(e.target.value); connectionChanged() }} placeholder="https://服务地址/v1" /></label>
      <label>API Key<input type="password" autoComplete="off" disabled={busy} value={key} placeholder={reuse ? '留空复用已有凭据，不回显' : '请输入凭据；无认证服务可留空'} onChange={e => { setKey(e.target.value); connectionChanged() }} /></label>
      <label className="checkbox-line"><input type="checkbox" disabled={busy} checked={memory} onChange={e => setMemory(e.target.checked)} />我确认连接凭据在运行时内存中使用，查询服务模型列表，不发送任务内容。</label>
      <label className="checkbox-line"><input type="checkbox" disabled={busy || !state.storage?.available || !!state.storage.error} checked={remember} onChange={e => setRemember(e.target.checked)} />记住连接（settings.json 保存参数，auth.json 明文保存 API Key）</label>
      <small className="model-discovery-help">填写连接信息并确认后自动查询一次 GET /models，无需模型名称或容量；失败不会自动重试。地址需包含服务要求的路径（通常为 /v1）。</small>
      <button type="button" disabled={busy || !memory || !url.trim()} onClick={queryModels}>先查询服务模型（无需容量）</button>
      <label>服务可用模型<select aria-label="服务可用模型" value={discovered.includes(model) ? model : ''} disabled={busy || !discovered.length} onChange={e => { if (e.target.value) chooseModel(e.target.value) }}><option value="">{discovered.length ? `请选择 API 返回的模型（${discovered.length} 个）` : catalogueLoaded ? 'API 未返回可用模型，可手动填写' : '尚未取得模型列表'}</option>{discovered.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>精确模型标识<input required list="service-models" value={model} onChange={e => chooseModel(e.target.value)} /><datalist id="service-models">{discovered.map(id => <option key={id} value={id} />)}</datalist></label>
      {metadataStatus && <p className="notice">{metadataStatus}</p>}
      <button type="button" disabled={busy || !model || !officialProviders[url.replace(/\/$/, '')]} onClick={() => void operation(async () => {
        const provider = officialProviders[url.replace(/\/$/, '')]!
        const result = await hostRequest<{ candidate: { context_tokens?: number; max_output_tokens?: number } | null; fetched_at: string }>({ type: 'host.directory.lookup', base_url: url, provider_id: provider, wire_model_id: model, refresh: true })
        const service = catalogue?.models.find(m => m.id === model), metadata = fieldMetadata ?? modelMetadata(service, catalogue?.fetched_at, manualCapacity.current)
        for (const [field, manual, apply] of [['context_tokens', manualCapacity.current.context, setContext], ['max_output_tokens', manualCapacity.current.output, setOutput]] as const) {
          if (!manual && service?.[field] === undefined && result.candidate?.[field] !== undefined) { apply(String(result.candidate[field])); metadata[field] = { source: 'models.dev', fetched_at: result.fetched_at, manual_override: false } }
        }
        metadata.provider_id = provider; setFieldMetadata(metadata); setMetadataStatus('models.dev 精确匹配：' + (result.candidate ? '仅补缺失且未覆盖的容量；不证明账号可用或能力。' : '无匹配，未修改容量。')); setStatus('公开目录查询完成，不发送凭据或任务。')
      })}>从公开目录补充缺失容量</button>
      <label>独立压缩模型<select value={compactModel} onChange={e => { setCompactModel(e.target.value); setHistoryConsent(false) }}><option value="">默认当前主模型</option>{state.models.filter(m => m.roles.includes('compaction') && m.id !== id).map(m => <option key={m.id} value={m.id}>{m.id} · {m.base_url}</option>)}</select></label>
      {compactModel && <label className="checkbox-line"><input type="checkbox" checked={historyConsent} onChange={e => setHistoryConsent(e.target.checked)} />我确认所属任务的历史将发送至所选压缩模型的服务，可能产生费用；不是审批授权。</label>}
      <label>已知上下文容量<input type="number" required min="1" value={context} onChange={e => { setFieldMetadata(previous => previous ? { ...previous, context_tokens: { source: 'manual', fetched_at: null, manual_override: true } } : undefined); manualCapacity.current.context = true; setContext(e.target.value) }} placeholder="服务未提供时手动补充，不猜测" /></label>
      <label>输出上限（留空由服务决定）<input aria-label="输出上限" type="number" min="1" placeholder="留空不发送输出上限，不补默认值" value={output} onChange={e => { setFieldMetadata(previous => previous ? { ...previous, max_output_tokens: { source: 'manual', fetched_at: null, manual_override: true } } : undefined); manualCapacity.current.output = true; setOutput(e.target.value) }} /></label>
      <fieldset><legend>独立运行限额（均可留空，留空不设限制）</legend>{([
        ['request_timeout_ms', '单请求超时（毫秒）'], ['response_bytes', '单请求响应流累计字节'], ['run_tokens', 'Run 累计输入输出 token'], ['run_model_requests', 'Run 模型请求次数'], ['run_tool_requests', 'Run 工具次数'], ['run_wall_ms', 'Run 总时间（毫秒）']
      ] as const).map(([key,label]) => <label key={key}>{label}<input type="number" min="1" step="1" value={limits[key] ?? ''} placeholder="不限制" onChange={e => setLimits(old => ({...old,[key]:e.target.value}))} /></label>)}<p>所有角色按所选模型的输出设置发送，不另设测试/摘要上限。Run 累计限额由启动时主模型配置固定，摘要和审批共享；若设置累计 token 预算，所有实际使用角色需填写输出上限才能预留，缺失时明确拒绝，不猜测。</p></fieldset>
      <p className="notice">资源保护独立于生成设置：SSE 单帧最多 1MiB、历史装载单条事件最多 1MiB、总装载有界；触发会明确停止，不把残缺内容当成功。输入容量等于设置的上下文容量，不扣输出上限。按 UTF-8 字节 + 256 保守估算，不是精确 tokenizer。剩余容量不超过 10% 时，在完整请求边界同步压缩；Run 内也可压缩。最终仍受服务规格约束。</p>
      <label>显式兼容 Profile<select value={profile} onChange={e => { setProfile(e.target.value as typeof profile); savedConnection.current = null; setReuse(false) }}><option value="chat-max-tokens">max_tokens</option><option value="chat-max-completion-tokens">max_completion_tokens</option></select></label>
      <button type="submit" disabled={busy || (remember && (!state.storage?.available || !!state.storage.error))}>仅保存配置（不联网）</button>
      <button type="submit" className="primary" disabled={busy || !memory || (remember && (!state.storage?.available || !!state.storage.error))} data-query="true">{remember ? '保存连接并查询' : '保存内存配置并查询'}</button>
    </form>
    <div role="status" className="notice">{status || '配置尚未测试时保持关闭。容量和 profile 均不按模型名字猜测。'}</div>
    <button disabled={busy} onClick={() => void operation(async () => { await reload(); setStatus('已重新查询配置状态，没有重发目录或模型请求。') })}>重新查询配置状态（不重试请求）</button>
    <section><h3>角色验证</h3>{state.models.length === 0 && <p>尚无服务配置。开发 fixture 无需真实服务。</p>}{state.models.map(m => <div className="model-entry" key={m.id}><strong>{m.id}</strong><small>{m.wire_model_id} · r{m.revision} · {m.occupied ? '执行占用，配置锁定' : '空闲'} · {m.credential_storage !== 'memory-only' ? '已记住连接' : '仅内存'}{m.credential_missing ? ' · 凭据已删除，需重新填写' : ''} · 已验证：{m.roles.join(' / ') || '无'}</small><small>容量来源：上下文 {m.metadata?.context_tokens.source ?? 'legacy'} / 输出 {m.metadata?.max_output_tokens.source ?? 'legacy'} · 能力 {JSON.stringify(m.metadata?.capabilities ?? 'unknown')}</small><div><button disabled={busy || m.occupied} onClick={() => edit(m)}>编辑连接</button>{m.credential_storage === 'memory-only' && <button disabled={busy || m.occupied || !state.storage?.available || !!state.storage.error} onClick={() => { if (!confirm('将连接保存到 settings.json、Key 明文保存到 auth.json？不会回显凭据，不会自动联网。')) return; void operation(async () => { await hostRequest({ type: 'model.remember', model_id: m.id, confirm: true }); setStatus('已记住连接；重启后恢复，不自动联网。') }) }}>记住此连接</button>}<button disabled={busy || m.occupied || m.credential_missing} onClick={() => { if (!confirm('删除同一渠道所有模型的已保存及内存凭据？连接参数保留，角色关闭；不保证清除外部备份或介质残留。')) return; void operation(async () => { await hostRequest({ type: 'model.credential.delete', model_id: m.id, confirm: true }); savedConnection.current = null; setReuse(false); setKey(''); setStatus('同一渠道凭据已删除，角色已关闭；连接参数保留。') }) }}>删除凭据</button>{(['main', 'approval', 'compaction'] as const).map(role => <button key={role} disabled={busy || m.occupied || m.credential_missing} onClick={() => setTestConfirmation({ model: m, role })}>测试并启用{role === 'main' ? '主模型' : role === 'approval' ? '审批模型' : '压缩模型'}</button>)}<button disabled={busy || m.occupied} onClick={() => { if (!confirm('移除此连接及已保存凭据？')) return; void operation(async () => { await hostRequest({ type: 'model.remove', model_id: m.id }); if (savedConnection.current?.id === m.id) { savedConnection.current = null; setReuse(false); setKey('') }; setStatus('已移除连接与凭据') }) }}>移除</button></div></div>)}</section>
    {testConfirmation && <DialogFocus><div className="overlay"><section className="modal" role="dialog" aria-modal="true" aria-label="确认模型角色测试"><h2>确认模型角色测试</h2><p>向 {testConfirmation.model.base_url} 的 {testConfirmation.model.wire_model_id} 发送{testConfirmation.role === 'main' ? '主模型合成测试（最多两轮，每轮最多 1024 输出 token）' : testConfirmation.role === 'approval' ? '审批合成测试（最多一轮 1024 输出 token）' : '压缩格式合成测试（最多一轮 1024 输出 token）'}，可能产生费用。不会发送任务材料；取消不保证已发请求未计费。</p><div><button onClick={() => { setTestConfirmation(null); setStatus('已取消角色测试，未发送请求。') }}>取消</button><button className="primary" onClick={() => { const selected = testConfirmation; setTestConfirmation(null); void operation(async operationId => { await hostRequest({ type: 'model.test', model_id: selected.model.id, role: selected.role, confirm_cost: true, operation_id: operationId }); setStatus(`${selected.model.id} / ${selected.role} 合成验证通过；不代表模型质量或完整服务兼容性。`) }) }}>确认费用并开始测试</button></div></section></div></DialogFocus>}
    <section className="approval-settings"><h3>权限审批</h3><p>仅针对具体动作，不代答学习问题、删除、信任、丢弃输入等本人意图确认。</p><button disabled={busy} onClick={() => void operation(async () => { await hostRequest({ type: 'approval.configure', mode: 'manual', model_id: '', confirm_external_processing: false }); setStatus('已选择手动审批') })}>使用手动审批</button><label>独立辅助审批模型<select value={approvalModel} onChange={e => setApprovalModel(e.target.value)}><option value="">请选择已验证角色</option>{state.models.filter(m => m.roles.includes('approval')).map(m => <option key={m.id} value={m.id}>{m.id}</option>)}</select></label><label className="checkbox-line"><input type="checkbox" checked={external} onChange={e => setExternal(e.target.checked)} />我知晓具体操作、必要任务请求将发送至所选审批服务，可能产生费用。</label><button disabled={busy || !external || !approvalModel} onClick={() => void operation(async () => { await hostRequest({ type: 'approval.configure', mode: 'assisted', model_id: approvalModel, confirm_external_processing: true }); setStatus('已选择独立辅助审批；异常或不确定转人工，不延长原期限') })}>启用独立辅助审批</button><small>当前模式：{state.approval.mode}。执行期间不能修改模式或占用配置。</small></section>
  </section></div>
}

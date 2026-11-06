import { useEffect, useRef, useState, type ReactNode } from 'react'
import { hostRequest } from './ModelSettings'
import type { HostRequest } from '../../shared/types'

type Plugin = { digest: string; id: string; version: string; access_level: 'task' | 'global'; executable: boolean; trusted: boolean; enabled: boolean; available: boolean; workflow: string | null; contributions: { id: string; kind: string; description: string }[]; dependencies: { plugin_id: string; version_range: string; required: boolean }[]; instances: { instance_id: string; state: string; call_id: string | null; pending: number; cleanup_error?: string }[]; unsupported: string[] }
type Page = { items: Plugin[]; next_before: number | null }
type Plan = { fingerprint: string; root: string; packages: { digest: string; plugin_id: string; version: string; access_level: 'task' | 'global'; executable: boolean; already_enabled: boolean }[] }
export function PluginSettings({ task, close, changed, embedded = false, onBusy, taskSelection }: { task: string; close(): void; changed(): Promise<void>; embedded?: boolean; onBusy?(busy: boolean): void; taskSelection?: ReactNode }) {
  const [page, setPage] = useState<Page>({ items: [], next_before: null }), [before, setBefore] = useState(0)
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(''), [plan, setPlan] = useState<Plan | null>(null)
  const [selection, setSelection] = useState<string[]>([]), [localCode, setLocalCode] = useState(false), [globalScope, setGlobalScope] = useState(false)
  const [trust, setTrust] = useState<Plugin | null>(null), [disable, setDisable] = useState<{ plugin: Plugin; revoke: boolean } | null>(null)
  const [content, setContent] = useState<{ digest: string; id: string; text: string; next: number | null } | null>(null)
  const active = useRef(false)
  const currentPage = useRef(0)
  async function reload(offset = currentPage.current) {
    if (!task) return
    setPage(await hostRequest<Page>({ type: 'plugin.list', task_id: task, before: offset })); currentPage.current = offset; setBefore(offset)
  }
  async function operation(work: () => Promise<void>) {
    if (active.current) return
    active.current = true; setBusy(true); setStatus('处理中；不自动重发操作。')
    try { await work(); await reload(); await changed() } catch (error) { setStatus(String(error)) }
    finally { active.current = false; setBusy(false) }
  }
  async function send(input: HostRequest) { await hostRequest(input); setStatus('已保存。保存内容与执行许可分开；不会自动启动模型或插件。') }
  useEffect(() => { void reload().catch(e => setStatus(String(e))) }, [task])
  useEffect(() => { onBusy?.(busy); return () => onBusy?.(false) }, [busy, onBusy])
  useEffect(() => { if (embedded) return; const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !active.current) { e.stopPropagation(); close() } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key) }, [close])
  function resetConfirmations() { setLocalCode(false); setGlobalScope(false) }
  async function prepare(plugin: Plugin) {
    setPlan(await hostRequest<Plan>({ type: 'plugin.plan', task_id: task, digest: plugin.digest, choices: selection.filter(d => d !== plugin.digest) }))
    resetConfirmations(); setStatus('请逐项核对依赖与范围；不会自动下载、安装依赖或选择主流程。')
  }
  const risk = <><p className="notice">后端是你主动信任的本地代码，可以访问操作系统允许的文件和网络。宿主审批不是 OS 沙箱；撤销不能追回已读数据或回滚外部副作用。解释器和依赖由你准备，不自动安装。</p><label className="check"><input type="checkbox" checked={localCode} onChange={e => setLocalCode(e.target.checked)} />我已核对固定包代码，允许其以当前 OS 用户身份执行</label></>
  return <div className={embedded ? "settings-embedded" : "overlay"}><section className={embedded ? "plugin-settings-content" : "modal model-modal plugin-modal"} role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : true} aria-label="插件与主流程"><header><h2>插件与主流程</h2>{!embedded && <button disabled={busy} onClick={close}>关闭</button>}</header>
    <p className="settings-lead">导入插件，按任务管理启用状态与主流程。</p>
    <div className="inline-actions plugin-toolbar" role="group" aria-label="插件操作"><button className="primary" disabled={busy} onClick={() => void operation(async () => { const result = await hostRequest<{ cancelled?: boolean; digest?: string }>({ type: 'plugin.pick' }); setPlan(null); setTrust(null); setDisable(null); setStatus(result.cancelled ? '已取消导入。' : `固定副本已导入，未启用、未执行。${task ? '' : '选择任务后可查看和启用。'}摘要：${result.digest ?? '请重新查询核对'}`) })}>从文件夹导入固定包</button><button disabled={busy} onClick={() => void operation(async () => { await reload(); setStatus(task ? '已重新查询；未重发任何操作。' : '已更新任务列表。选择任务后可查看插件与启用状态。') })}>重新查询状态</button></div>
    <p role="status" className={/Error|INVALID|FAILED|UNKNOWN/.test(status) ? 'error' : 'muted'}>{status}</p>
    {!task && <section className="settings-section plugin-task-selection"><h3>选择任务以管理插件</h3><p>可以先导入插件。启用、停用和主流程选择需要关联任务。</p><fieldset disabled={busy}>{taskSelection}</fieldset></section>}
    {task && <>
    <p className="notice">当前任务：{task}。导入仅复制并校验固定包，不执行。信任绑定整个摘要；任务级只绑定本任务，全局级可读取多个任务。恢复旧业务数据不恢复已撤销信任。已保存内容不随停用删除。</p>
    <p className="muted">如必需依赖有多个已安装版本，先勾选精确版本，再点击目标插件“核对启用依赖”。缺失或冲突会拒绝，不自动替换。当前页 {before / 20 + 1}。</p>
    {!page.items.length && <p>尚无固定插件包。不会自动查找本机目录或下载插件。</p>}
    <div className="plugin-list">{page.items.map(plugin => <article className="plugin-card" key={plugin.digest}>
      <header><h3>{plugin.id} <small>{plugin.version}</small></h3><span className="badge">{plugin.access_level === 'global' ? '全局 · 多任务读取' : '任务级'}</span></header>
      <code className="plugin-digest">SHA256 {plugin.digest}</code><p>{plugin.executable ? plugin.trusted ? '本地代码已信任' : '本地代码尚未信任' : '纯内容 · 无后端进程'} · {plugin.enabled ? plugin.available ? '当前可用' : '已启用但依赖不可用' : '未启用'}</p>
      <p>宿主进程事实：{plugin.instances.length ? plugin.instances.map(i => `${i.state}${i.cleanup_error ? ` · ${i.cleanup_error}` : ''} · Call ${i.call_id ?? '无'} · 在途 ${i.pending}`).join('；') : '未启动，不代表外部环境已验证'}</p>{!!plugin.unsupported.length && <p className="error">缺少宿主要求：{plugin.unsupported.join('、')}</p>}
      <label className="check"><input type="checkbox" disabled={busy || !!plan} checked={selection.includes(plugin.digest)} onChange={e => setSelection(value => e.target.checked ? [...value, plugin.digest] : value.filter(d => d !== plugin.digest))} />选为依赖精确版本</label>
      {!!plugin.dependencies.length && <p>依赖：{plugin.dependencies.map(d => `${d.plugin_id} ${d.version_range}（${d.required ? '必需' : '可选，不自动启用'}）`).join('；')}</p>}
      <div className="inline-actions">{plugin.executable && !plugin.trusted && <button disabled={busy} onClick={() => { setTrust(plugin); setPlan(null); setDisable(null); resetConfirmations() }}>核对代码信任</button>}{!plugin.enabled && <button disabled={busy} onClick={() => void operation(() => prepare(plugin))}>核对启用依赖</button>}{plugin.enabled && <button disabled={busy} onClick={() => { setDisable({ plugin, revoke: false }); setPlan(null); setTrust(null) }}>停用</button>}{plugin.trusted && <button disabled={busy} onClick={() => { setDisable({ plugin, revoke: true }); setPlan(null); setTrust(null) }}>撤销代码信任</button>}</div>
      <ul>{plugin.contributions.map(contribution => <li key={contribution.id}><b>{contribution.kind} · {contribution.id}</b> {contribution.description}<div className="inline-actions">{contribution.kind !== 'tool' && <button disabled={busy || !plugin.available} onClick={() => void operation(async () => { const value = await hostRequest<{ text: string; next_offset: number | null }>({ type: 'plugin.content', task_id: task, digest: plugin.digest, contribution_id: contribution.id }); setContent({ digest: plugin.digest, id: contribution.id, text: value.text, next: value.next_offset }); setStatus('已读取内容；不启动后端，不授予权限。') })}>读取内容</button>}{contribution.kind === 'workflow' && <button disabled={busy || !plugin.available || plugin.workflow === contribution.id} onClick={() => void operation(() => send({ type: 'plugin.workflow', task_id: task, selection: { digest: plugin.digest, contribution_id: contribution.id } }))}>{plugin.workflow === contribution.id ? '当前主流程' : '选择为唯一主流程'}</button>}</div></li>)}</ul>
      {plugin.workflow && <button disabled={busy} onClick={() => void operation(() => send({ type: 'plugin.workflow', task_id: task, selection: null }))}>清除主流程选择</button>}
    </article>)}</div>
    <div className="inline-actions"><button disabled={busy || before === 0} onClick={() => void operation(() => reload(Math.max(0, before - 20)))}>上一页</button><button disabled={busy || page.next_before === null} onClick={() => void operation(() => reload(page.next_before!))}>下一页</button></div>
    {trust && <section className="plugin-confirm"><h3>信任精确固定包：{trust.id}</h3><code className="plugin-digest">{trust.digest}</code>{risk}{trust.access_level === 'global' && <label className="check"><input type="checkbox" checked={globalScope} onChange={e => setGlobalScope(e.target.checked)} />我确认该全局后端可通过宿主读取多个任务，影响不限当前任务</label>}<button disabled={busy} onClick={() => setTrust(null)}>取消信任</button><button disabled={busy || !localCode || (trust.access_level === 'global' && !globalScope)} onClick={() => void operation(async () => { await send({ type: 'plugin.trust', digest: trust.digest, confirm_local_code: true, confirm_cross_task: globalScope }); setTrust(null) })}>确认代码信任</button></section>}
    {plan && <section className="plugin-confirm"><h3>共同启用清单</h3><ul>{plan.packages.map(p => <li key={p.digest}>{p.plugin_id} {p.version} · {p.access_level} · {p.executable ? '需已确认代码信任' : '纯内容'} · {p.already_enabled ? '已启用' : '将启用'}<code className="plugin-digest">{p.digest}</code></li>)}</ul>{plan.packages.some(p => p.access_level === 'global' && !p.already_enabled) && <label className="check"><input type="checkbox" checked={globalScope} onChange={e => setGlobalScope(e.target.checked)} />我确认新增全局范围会影响所有任务并允许多任务读取</label>}<p>启用期间若存在活跃执行会拒绝；主流程仍需单独选择。</p><button disabled={busy} onClick={() => setPlan(null)}>取消启用</button><button disabled={busy || (plan.packages.some(p => p.access_level === 'global' && !p.already_enabled) && !globalScope)} onClick={() => void operation(async () => { await send({ type: 'plugin.enable', task_id: task, digest: plan.root, choices: selection.filter(d => d !== plan.root), fingerprint: plan.fingerprint, confirm_cross_task: globalScope }); setPlan(null); setSelection([]) })}>确认共同启用</button></section>}
    {disable && <section className="plugin-confirm"><h3>{disable.revoke ? '撤销代码信任' : '安全停用'}：{disable.plugin.id}</h3><p>将立即拒绝后续相关访问，取消依赖它的未完成执行并拒绝迟到结果，保留已保存内容；依赖能力会不可用，相关主流程将清除。{disable.plugin.access_level === 'global' ? '全局插件会影响所有相关任务。' : '影响此任务的插件使用。'}外部副作用不保证回滚。</p><button disabled={busy} onClick={() => setDisable(null)}>取消</button><button disabled={busy} onClick={() => void operation(async () => { await send(disable.revoke ? { type: 'plugin.revoke', digest: disable.plugin.digest } : { type: 'plugin.disable', digest: disable.plugin.digest, task_id: disable.plugin.access_level === 'global' ? null : task }); setDisable(null) })}>确认{disable.revoke ? '撤销' : '停用'}</button></section>}
    {content && <section className="plugin-confirm"><h3>内容预览 · {content.id}</h3><pre>{content.text}</pre>{content.next !== null && <button disabled={busy} onClick={() => void operation(async () => { const value = await hostRequest<{ text: string; next_offset: number | null }>({ type: 'plugin.content', task_id: task, digest: content.digest, contribution_id: content.id, offset: content.next! }); setContent({ ...content, text: value.text, next: value.next_offset }); setStatus('已读取下一片段。') })}>下一片段</button>}<button disabled={busy} onClick={() => setContent(null)}>关闭内容</button></section>}
    </>}
  </section></div>
}

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { HostRequest, Snapshot, Task, View } from '../../shared/types'
import { hostRequest, type ModelState } from './ModelSettings'
import { applySync } from './sync'
import type { SyncReply } from '../../runtime/sync'
import { AgentPanel } from './AgentPanel'
import { TaskReply } from './TaskReply'
import { TaskData, ExecutionHistory, AnswerHistory, RecordBrowser, viewTitle } from './TaskInspector'
import { DialogFocus } from './Dialog'
import { Materials } from './Materials'
import { StorageStatus } from './StorageStatus'
import { PluginSettings } from './PluginSettings'
import { bindManagedBehaviors } from './managed-behaviors'
import { ExportPanel } from './ExportPanel'
import { WorkspaceLayout, PaneToggle, PaneClose, SettingsShortcut, type WorkspaceHandle } from './WorkspaceLayout'
import { ApplicationSettings, type SettingsPage } from './ApplicationSettings'
import { readTextSize, applyTextSize, managedTextStyles, scaleManagedInlineText } from './text-size'
import { desktopPlatform, shortcutLabel } from './desktop-platform'
import './style.css'

const request = hostRequest
interface ViewEditor { taskId: string; hold(): () => void; save(token?: string): Promise<void> }
function ManagedView({ view, taskId, refresh, onDirty, onSubmission, register }: { view: View; taskId: string; refresh: () => Promise<void>; onDirty: (id: string, dirty: boolean) => void; onSubmission: (id: string, pending: boolean) => void; register: (id: string, editor: ViewEditor | null) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const pending = useRef(new Map<string, unknown>())
  const revision = useRef(view.state_revision)
  const saving = useRef<Promise<void> | null>(null)
  const firstChange = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [status, setStatus] = useState('已保存')
  const submitting = useRef(false)
  const answerUnknown = useRef(false)
  const [resetCounter, setResetCounter] = useState(0)
  const resetDraft = useRef<View | null>(null)
  const renderedRevision = useRef(view.revision)
  const conflict = useRef(false)
  const held = useRef(false)
  const bindings = useRef<ReturnType<typeof bindManagedBehaviors> | null>(null)
  const checked = view.presentation
  async function save(token?: string): Promise<void> {
    clearTimeout(timer.current)
    if (saving.current) { await saving.current; if (pending.current.size) return save(token); return }
    if (!pending.current.size) return
    if (conflict.current) throw new Error('保留了本地输入；请先明确选择如何处理版本冲突')
    const changes = new Map(pending.current)
    pending.current.clear()
    const fields = [...changes].map(([path, value]) => ({ path, value }))
    const first = fields.shift()!
    const nonemptyFields: [{ path: string; value: unknown }, ...{ path: string; value: unknown }[]] = [first, ...fields]
    const operation = (async () => {
      setStatus('保存中')
      try {
        const result = await request<{ state_revision: number }>({ type: 'draft.save', task_id: taskId, view_id: view.id, view_revision: view.revision, expected_state_revision: revision.current, fields: nonemptyFields, ...(token ? { maintenance_token: token } : {}) })
        revision.current = result.state_revision; firstChange.current = 0
        onDirty(view.id, pending.current.size > 0)
        setStatus(pending.current.size ? '未保存' : '已保存')
      } catch (e) {
        for (const [path, value] of changes) if (!pending.current.has(path)) pending.current.set(path, value)
        conflict.current = true; setStatus(String(e)); throw e
      }
    })()
    saving.current = operation
    try { await operation } finally { saving.current = null }
  }
  useLayoutEffect(() => {
    const shadow = root.current!.shadowRoot ?? root.current!.attachShadow({ mode: 'open' })
    if (checked.error) { shadow.replaceChildren(); register(view.id, null); return }
    const style = document.createElement('style')
    style.textContent = 'button,input,textarea,select{font-size:calc(13.3333px * var(--text-scale,1))}\n' + managedTextStyles(checked.css)
    const host = document.createElement('div')
    host.dataset.view = 'v-' + view.id
    content.current = host
    shadow.replaceChildren(style, host)
    if (renderedRevision.current !== view.revision) resetDraft.current = null
    renderedRevision.current = view.revision
    revision.current = (resetDraft.current ?? view).state_revision
    conflict.current = false
    setStatus('已保存')
    host.innerHTML = checked.html
    scaleManagedInlineText(host)
    const preventSubmit = (event: Event) => event.preventDefault()
    const preventNavigation = (event: MouseEvent) => {
      const link = (event.target as Element).closest('a,area')
      if (!link) return
      event.preventDefault()
      const id = link.getAttribute('href')?.slice(1)
      if (id) host.querySelector('#' + CSS.escape(id))?.scrollIntoView({ block: 'nearest' })
    }
    host.addEventListener('submit', preventSubmit)
    host.addEventListener('click', preventNavigation)
    bindings.current = bindManagedBehaviors(host, 'v-' + view.id, view.bundle, (resetDraft.current ?? view).draft, (field, value) => {
      pending.current.set(field, value)
      onDirty(view.id, true)
      setStatus('未保存'); if (!firstChange.current) firstChange.current = Date.now()
      clearTimeout(timer.current)
      timer.current = setTimeout(() => { void save().catch(() => {}) }, Math.min(500, Math.max(0, 2000 - (Date.now() - firstChange.current))))
    }, () => held.current)
    for (const b of view.bundle.behaviors) {
      const el = host.querySelector<HTMLElement>('#v-' + view.id + '-' + b.element_id)!
      if (b.type === 'submit') el.onclick = async () => {
        if (submitting.current || held.current || answerUnknown.current) return
        submitting.current = true; onSubmission(view.id, true)
        host.querySelectorAll('button').forEach(button => { button.disabled = true })
        try {
          await save()
          await request({ type: 'answer.submit', task_id: taskId, view_id: view.id, view_revision: view.revision, expected_state_revision: revision.current, form_id: b.form_id })
          setStatus('提交成功 · 已保存不可变答案'); await refresh()
        } catch (e) { if (/UNKNOWN_RESULT|CONNECTION_LOST|OFFLINE/.test(String(e))) answerUnknown.current = true; setStatus(String(e)) }
        finally { submitting.current = false; if (!answerUnknown.current) onSubmission(view.id, false); host.querySelectorAll('button').forEach(button => { button.disabled = answerUnknown.current }) }
      }
    }
    register(view.id, { taskId, save, hold: () => {
      if (submitting.current || held.current || answerUnknown.current) throw new Error('答案提交或替换未确认，请先核对原结果；不会创建恢复点')
      clearTimeout(timer.current)
      held.current = true; host.inert = true
      return () => { held.current = false; host.inert = false }
    } })
    return () => {
      clearTimeout(timer.current); register(view.id, null)
      bindings.current?.dispose(); bindings.current = null
      host.removeEventListener('submit', preventSubmit)
      host.removeEventListener('click', preventNavigation)
      content.current = null
      host.querySelectorAll<HTMLInputElement>('input,textarea,select').forEach(el => { el.oninput = null })
      host.querySelectorAll<HTMLButtonElement>('button').forEach(el => { el.onclick = null })
    }
  }, [view.id, view.revision, checked.error?.code, resetCounter])
  useEffect(() => {
    if (view.state_revision < revision.current) return
    if (view.state_revision !== revision.current && !saving.current) {
      if (pending.current.size) { conflict.current = true; setStatus('版本冲突：本地输入已保留，不会自动覆盖远端'); return }
      revision.current = view.state_revision
      bindings.current?.sync(view.draft)
    }
  }, [view.state_revision])
  return <article className="managed" id={`content-${view.id}`}><header className="view-meta"><span>内容 · v{view.revision}</span><span role="status">{checked.error ? '已阻止呈现' : status}</span></header>{checked.error && <p className="error" role="alert">{checked.error.message}（{checked.error.code}）</p>}{answerUnknown.current && <div className="error" role="alert">答案提交结果未知；禁止重复提交和创建恢复点。<button onClick={async () => {
    try { await request({ type: 'task.snapshot', task_id: taskId }); await refresh(); answerUnknown.current = false; onSubmission(view.id, false); content.current?.querySelectorAll('button').forEach(button => { button.disabled = false }); setStatus('已同步保存状态；请查看作答记录确认原答案，未自动重发') } catch (e) { setStatus(String(e)) }
  }}>查询已保存作答状态</button></div>}{conflict.current && <div className="error"><button onClick={async () => {
    if (!confirm('放弃本地未保存输入并重新加载已保存版本？')) return
    const next = await request<Snapshot>({ type: 'task.snapshot', task_id: taskId })
    const remote = next.views.find(v => v.id === view.id)
    if (!remote || remote.revision !== view.revision) { setStatus('内容版本变化，请关闭此任务后重新打开'); return }
    pending.current.clear(); conflict.current = false; revision.current = remote.state_revision
    resetDraft.current = remote; onDirty(view.id, false); setResetCounter(n => n + 1); setStatus('已载入远端保存版本')
  }}>放弃本地输入并重新加载</button><p>本地未保存值：{JSON.stringify([...pending.current])}</p></div>}<div className="view-boundary"><div ref={root} /></div></article>
}
function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const taskQueryGeneration = useRef(0)
  const [taskCursor, setTaskCursor] = useState<string | null>(null)
  const taskPageLimit = useRef(50)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const taskNameComposing = useRef(false)
  const [creating, setCreating] = useState(false)
  const [creationError, setCreationError] = useState('')
  const [busy, setBusy] = useState(false)
  const [theme, setTheme] = useState(localStorage.getItem('trellis-theme') ?? 'system')
  const [textSize, setTextSize] = useState(readTextSize)
  useLayoutEffect(() => { applyTextSize(textSize) }, [textSize])
  const workspace = useRef<WorkspaceHandle>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('appearance')
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [modelId, setModelId] = useState('')
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<'surface' | 'data' | 'answers' | 'execution' | 'resources'>('surface')
  const [connected, setConnected] = useState(false)
  const [models, setModels] = useState<ModelState>({ models: [], approval: { mode: 'manual', model_id: '' } })
  const composerDrafts = useRef(new Map<string, string>())
  const composer = useRef<HTMLTextAreaElement>(null)
  async function reloadModels() {
    const next = await request<ModelState>({ type: 'model.list' }); setModels(next)
    setModelId(previous => previous === 'fixture' || next.models.some(m => m.id === previous && m.roles.includes('main')) ? previous : next.models.find(m => m.roles.includes('main'))?.id ?? '')
  }
  const dirty = useRef(new Set<string>())
  const submissions = useRef(new Set<string>())
  const onSubmission = (id: string, pending: boolean) => { if (pending) submissions.current.add(id); else submissions.current.delete(id) }
  const editors = useRef(new Map<string, ViewEditor>())
  const maintenance = useRef<{ token: string | null; releases: (() => void)[]; restore?: boolean; epoch?: string } | null>(null)
  const [detachedDrafts, setDetachedDrafts] = useState<string[]>([])
  const [maintenanceUnknown, setMaintenanceUnknown] = useState(false)
  const replacing = useRef(false)
  const unsettledSurface = useRef<{ taskId: string; actionId: string; epoch: string; releases: (() => void)[] } | null>(null)
  const [surfaceUnknown, setSurfaceUnknown] = useState(false)
  const registerEditor = useCallback((id: string, editor: ViewEditor | null) => { if (editor) editors.current.set(id, editor); else editors.current.delete(id) }, [])
  const onDirty = (id: string, value: boolean) => { if (value) dirty.current.add(id); else dirty.current.delete(id) }
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirty.current.size && !submissions.current.size && !replacing.current && !maintenance.current) return
      event.preventDefault(); event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
  function canLeave(): boolean { if (submissions.current.size) { setError('答案提交尚未确认；请先查询已保存作答状态，不重发。'); return false }; if (maintenance.current) { setError('维护结果尚未确认，输入保持暂停；请先查询原维护结果。'); return false }; if (replacing.current) { setError('正在检查替换提交，请等待结束再切换。'); return false }; if (dirty.current.size) { setError('存在未保存或冲突输入，请等待保存完成或明确处理冲突后再切换任务。'); return false }; return true }
  function releaseMaintenance() {
    for (const release of maintenance.current?.releases.reverse() ?? []) release()
    maintenance.current = null; setMaintenanceUnknown(false); setBusy(false)
  }
  async function queryMaintenance() {
    const state = await request<{ phase: string; reservation: { token: string } | null; restore: { last: { token: string; phase: string } | null } }>({ type: 'maintenance.status' })
    if (state.phase === 'blocked') throw new Error('恢复点控制检查失败，输入保持暂停；不能强制继续')
    if (['creating', 'restoring', 'collecting'].includes(state.phase)) throw new Error('维护仍在执行，请稍后只查询原结果')
    if (state.reservation) {
      if (state.reservation.token !== maintenance.current?.token) throw new Error('预约结果尚未关联，输入保持暂停；等待预约过期后查询')
      await request({ type: 'maintenance.cancel', token: state.reservation.token })
    }
    if (maintenance.current?.restore) {
      if (state.restore.last?.token === maintenance.current.token && state.restore.last.phase === 'completed') await synchronizeRestoredWorkspace()
    }
    releaseMaintenance()
  }
  async function synchronizeRestoredWorkspace() {
    const unsent = [...composerDrafts.current.values(), text, title].filter(value => value.trim())
    setDetachedDrafts(old => [...new Set([...old, ...unsent])])
    composerDrafts.current.clear(); selected.current = null; generation.current++; taskQueryGeneration.current++
    flushSync(() => { setSnapshot(null); setText(''); setTitle(''); setTab('surface') })
    dirty.current.clear(); submissions.current.clear(); await refresh(); await reloadModels()
  }
  async function restoreRecovery(point: { id: string; created_at: string; database_sha256: string; task_ids: string[]; schema_version: number; app_version: string }) {
    if ((dirty.current.has('material-text') || dirty.current.has('request-materials'))) throw new Error('请先保存材料文本、处理请求材料选择或查询未知提交，维护尚未开始');
    if (maintenance.current || replacing.current || submissions.current.size || busy || (settingsOpen && settingsPage !== 'storage')) throw new Error('正在提交、替换或配置，不能恢复旧数据')
    maintenance.current = { token: null, releases: [], restore: true, epoch: snapshot?.runtime_epoch }; setBusy(true)
    let submitted = false
    try {
      const entries = [...editors.current.entries()]
      for (const [, editor] of entries) maintenance.current.releases.push(editor.hold())
      const state = await request<{ reservation: { token: string } }>({ type: 'maintenance.begin', inputs: entries.map(([view_id, editor]) => ({ task_id: editor.taskId, view_id })) })
      const token = state.reservation.token; maintenance.current.token = token
      for (const [, editor] of entries) await editor.save(token)
      if (dirty.current.size) throw new Error('仍有未保存或冲突输入，恢复已阻止')
      if (!confirm(`恢复旧数据 · 本人确认\n时间：${new Date(point.created_at).toLocaleString()}\n应用 ${point.app_version} / schema ${point.schema_version}\n恢复点：${point.id}\n任务范围：${point.task_ids.length} 个（${point.task_ids.join(', ')}）\n\n整个当前工作空间将替换为该点的数据，之后新增的任务、草稿、答案和记录不再出现在当前库中。刚保存的输入也可能被旧草稿替换。\n未发送消息和名称只读保留为恢复前文本，不自动发送。当前连接和安全凭据不回滚；旧 Run、工具和审批不会续跑。副本及 staging 仅按另行独立确认回收，迁移保持关闭。\n确认恢复？`)) {
        await request({ type: 'maintenance.cancel', token }); releaseMaintenance(); return
      }
      submitted = true
      await request({ type: 'maintenance.restore', token, point_id: point.id, database_sha256: point.database_sha256, inputs_saved: true, confirm_replace_newer_data: true })
      await synchronizeRestoredWorkspace(); releaseMaintenance()
    } catch (error) {
      try { await queryMaintenance() } catch { setMaintenanceUnknown(true); setBusy(false) }
      throw new Error(String(error) + (submitted ? '；只查询原恢复结果，不重新执行。' : '；本地输入保留。'))
    }
  }
  async function createRecovery(replace: string | null) {
    if ((dirty.current.has('material-text') || dirty.current.has('request-materials'))) throw new Error('请先保存材料文本、处理请求材料选择或查询未知提交，维护尚未开始');
    if (maintenance.current || replacing.current || submissions.current.size || busy || (settingsOpen && settingsPage !== 'storage')) throw new Error('正在提交、替换或配置，请等待结束后再创建恢复点')
    maintenance.current = { token: null, releases: [] }; setBusy(true)
    let submitted = false
    try {
      const entries = [...editors.current.entries()], active = entries.map(([, editor]) => editor)
      for (const editor of active) maintenance.current.releases.push(editor.hold())
      const state = await request<{ reservation: { token: string } }>({ type: 'maintenance.begin', inputs: entries.map(([view_id, editor]) => ({ task_id: editor.taskId, view_id })) })
      const token = state.reservation.token; maintenance.current.token = token
      for (const editor of active) await editor.save(token)
      if (dirty.current.size) throw new Error('仍有未保存或冲突输入，未创建恢复点；本地输入保留')
      if (!confirm(replace ? '确认用当前已保存数据替换唯一有效恢复点？新候选校验成功前旧点保持有效。未发送的消息和任务名称不在恢复点中。' : '确认创建当前已保存数据的一致性恢复点？未发送的消息和任务名称不在恢复点中，不会自动发送。不会自动恢复旧数据。')) {
        await request({ type: 'maintenance.cancel', token }); releaseMaintenance(); return
      }
      submitted = true
      await request({ type: 'maintenance.create', token, inputs_saved: true, replace_id: replace })
      releaseMaintenance()
    } catch (error) {
      try { await queryMaintenance() } catch { setMaintenanceUnknown(true); setBusy(false) }
      // A possibly submitted backup is never replayed; the original status remains queryable.
      throw new Error(String(error) + (submitted ? '；只查询原维护结果，不重发创建。' : '；输入已保留。'))
    }
  }
  async function collectStaging(operationId?: string, after = 0) {
    if ((dirty.current.has('material-text') || dirty.current.has('request-materials'))) throw new Error('请先保存材料文本、处理请求材料选择或查询未知提交，维护尚未开始');
    if (maintenance.current || replacing.current || submissions.current.size || busy || (settingsOpen && settingsPage !== 'storage')) throw new Error('正在提交、替换或配置，不能回收暂存')
    maintenance.current = { token: null, releases: [] }; setBusy(true)
    let submitted = false, original = operationId
    try {
      const entries = [...editors.current.entries()]
      for (const [, editor] of entries) maintenance.current.releases.push(editor.hold())
      const state = await request<{ reservation: { token: string } }>({ type: 'maintenance.begin', inputs: entries.map(([view_id, editor]) => ({ task_id: editor.taskId, view_id })) })
      const token = state.reservation.token; maintenance.current.token = token
      for (const [, editor] of entries) await editor.save(token)
      if (dirty.current.size) throw new Error('仍有未保存或冲突输入，暂存回收已阻止')
      const preview = operationId ? (await request<{ last: any }>({ type: 'maintenance.gc.status', operation_id: operationId })).last : await request<any>({ type: 'maintenance.gc.preview', token, inputs_saved: true, after })
      if (!preview) throw new Error('原 GC 作业不可用')
      original = preview.id
      const files = preview.items.filter((item: any) => ['pending', 'failed'].includes(item.state))
      if (!confirm(`受限暂存回收 · 本人确认\n原作业：${preview.id}\n本批候选文件 ${files.length} 个，候选大小 ${files.reduce((sum: number, item: any) => sum + item.bytes, 0)} 字节\n受保护 ${preview.protected} 项，待核对 ${preview.reviews} 项。每批最多检查 50 个 staging。\n\n只删除再次证明孤立的已登记暂存及对应临时文件。正式材料、历史、数据库、回退副本和恢复点及其资源均保留。预览不是删除许可，变化项会跳过；失败或未到重试时间的项不会强行删除。\n不调用模型、不自动继续新批次。确认${operationId ? '重试原未完成项' : '回收本批'}？`)) {
        await request({ type: 'maintenance.cancel', token }); releaseMaintenance(); return
      }
      submitted = true
      await request({ type: operationId ? 'maintenance.gc.retry' : 'maintenance.gc.execute', token, operation_id: preview.id, inputs_saved: true, confirm_delete_orphans: true })
      releaseMaintenance()
    } catch (error) {
      let detail = ''
      if (submitted && original) try { const result = await request<any>({ type: 'maintenance.gc.status', operation_id: original }); detail = `；原 GC 作业 ${original}：${result.error ?? result.last?.phase ?? '未知'}，请查询结果，不重发` } catch { detail = '；原 GC 结果未知，不重发' }
      try { await queryMaintenance() } catch { setMaintenanceUnknown(true); setBusy(false) }
      throw new Error(String(error) + detail)
    }
  }
  async function retireReplica(replicaId: string, operationId?: string) {
    if ((dirty.current.has('material-text') || dirty.current.has('request-materials'))) throw new Error('请先保存材料文本、处理请求材料选择或查询未知提交，维护尚未开始');
    if (maintenance.current || replacing.current || submissions.current.size || busy || (settingsOpen && settingsPage !== 'storage')) throw new Error('正在提交、替换或配置，不能退役副本')
    maintenance.current = { token: null, releases: [] }; setBusy(true)
    let submitted = false, original = operationId
    try {
      const entries = [...editors.current.entries()]
      for (const [, editor] of entries) maintenance.current.releases.push(editor.hold())
      const state = await request<{ reservation: { token: string } }>({ type: 'maintenance.begin', inputs: entries.map(([view_id, editor]) => ({ task_id: editor.taskId, view_id })) })
      const token = state.reservation.token; maintenance.current.token = token
      for (const [, editor] of entries) await editor.save(token)
      if (dirty.current.size) throw new Error('仍有未保存或冲突输入，副本退役已阻止')
      const preview = operationId ? await request<any>({ type: 'maintenance.replica.status', operation_id: operationId }) : await request<any>({ type: 'maintenance.replica.preview', token, replica_id: replicaId, inputs_saved: true })
      original = preview.id
      if (!confirm(`副本退役 · 本人确认\n原操作：${preview.id}\n仅处理这一个已核验副本的 ${preview.files.length} 个数据库文件，总大小 ${preview.files.reduce((n: number, f: any) => n + f.bytes, 0)} 字节。\n\n确认后此副本永远不可再选择或恢复。先持久退役，再删除数据库文件组，全部删除并登记后才解除其独占保护。部分失败保留保护，只能明确重试原操作。\n当前代际、故障回退依赖及有效恢复点不在范围；不废止有效点，不删除正式资源，不调用模型，不等于安全擦除。\n确认${operationId ? '重试原副本退役' : '退役此副本'}？`)) {
        await request({ type: 'maintenance.cancel', token }); releaseMaintenance(); return
      }
      submitted = true
      await request({ type: operationId ? 'maintenance.replica.retry' : 'maintenance.replica.execute', token, operation_id: preview.id, inputs_saved: true, confirm_retire_replica: true })
      releaseMaintenance()
    } catch (error) {
      let detail = ''
      if (submitted && original) try { const result = await request<any>({ type: 'maintenance.replica.status', operation_id: original }); detail = `；原副本操作 ${original}：${result.phase}，仅查询，不重发` } catch { detail = '；原副本结果未知，不重发' }
      try { await queryMaintenance() } catch { setMaintenanceUnknown(true); setBusy(false) }
      throw new Error(String(error) + detail)
    }
  }
  async function collectResource(operationId: string, retry = false) {
    if ((dirty.current.has('material-text') || dirty.current.has('request-materials'))) throw new Error('请先保存材料文本、处理请求材料选择或查询未知提交，维护尚未开始');
    if (maintenance.current || replacing.current || submissions.current.size || busy || (settingsOpen && settingsPage !== 'storage')) throw new Error('正在提交、替换或配置，不能回收正式资源')
    maintenance.current = { token: null, releases: [] }; setBusy(true)
    let submitted = false, original = operationId
    try {
      const entries = [...editors.current.entries()]
      for (const [, editor] of entries) maintenance.current.releases.push(editor.hold())
      const state = await request<{ reservation: { token: string } }>({ type: 'maintenance.begin', inputs: entries.map(([view_id, editor]) => ({ task_id: editor.taskId, view_id })) })
      const token = state.reservation.token; maintenance.current.token = token
      for (const [, editor] of entries) await editor.save(token)
      if (dirty.current.size) throw new Error('仍有未保存或冲突输入，正式资源回收已阻止')
      const preview = retry ? await request<any>({ type: 'maintenance.resource.status', operation_id: operationId }) : await request<any>({ type: 'maintenance.resource.preview', token, operation_id: operationId, inputs_saved: true })
      original = preview.id
      if (!confirm(`正式资源回收 · 本人确认\n资源：${preview.display_name}\n资源 ID：${preview.resource_id}\n原操作：${preview.id}\n大小：${preview.bytes} 字节\n\n只处理这一项来源明确、全部保护已解除的正式资源，不包含临时文件。确认后资源不可再关联或恢复；先持久退役，再删除文件并同步、登记，最后清理元数据。失败保留原阶段，仅明确重试原操作。\n不会删除共享、历史、staging、有效恢复点或保留副本保护的资源；不主动废止有效点，不强制处理损坏资源，不等于安全擦除。\n确认${retry ? '继续原资源收尾' : '回收此正式资源'}？`)) {
        await request({ type: 'maintenance.cancel', token }); releaseMaintenance(); return
      }
      submitted = true
      await request({ type: retry ? 'maintenance.resource.retry' : 'maintenance.resource.execute', token, operation_id: preview.id, inputs_saved: true, confirm_retire_resource: true })
      releaseMaintenance()
    } catch (error) {
      let detail = ''
      if (submitted && original) try { const result = await request<any>({ type: 'maintenance.resource.status', operation_id: original }); detail = `；原资源操作 ${original}：${result.phase}，仅查询，不重发` } catch { detail = '；原资源结果未知，不重发' }
      try { await queryMaintenance() } catch { setMaintenanceUnknown(true); setBusy(false) }
      throw new Error(String(error) + detail)
    }
  }
  async function completeSurface(update: Snapshot['surface_updates'][number]) {
    if (!snapshot || replacing.current) return
    const taskId = snapshot.task.id, releases: (() => void)[] = []
    const change = update.request as { input: { operations: { type: string; view_id?: string }[] } }
    let submitted = false, settled = false
    replacing.current = true; setBusy(true); setError('')
    try {
      const targets = change.input.operations.some(op => op.type === 'layout.set') ? snapshot.views.map(view => view.id) : change.input.operations.filter(op => op.type === 'view.replace' || op.type === 'view.remove').map(op => op.view_id!)
      const active = targets.map(id => editors.current.get(id)).filter((editor): editor is ViewEditor => !!editor)
      for (const editor of active) releases.push(editor.hold())
      for (const editor of active) await editor.save()
      if (targets.some(id => dirty.current.has(id))) throw new Error('目标 View 仍有未保存输入，替换已阻止')
      // Separate human intent from the model-assisted permission decision.
      if (update.reset_requires_confirmation && !confirm('本次 reset 或移除将丢弃目标 View 的当前草稿，包括已保存输入。正式答案和历史版本仍保留。确认继续？')) {
        submitted = true
        await request({ type: 'surface.respond', task_id: taskId, action_id: update.action_id, proceed: false, confirm_discard: false })
      } else {
        submitted = true
        await request({ type: 'surface.respond', task_id: taskId, action_id: update.action_id, proceed: true, confirm_discard: update.reset_requires_confirmation })
      }
      const next = await request<Snapshot>({ type: 'task.snapshot', task_id: taskId })
      flushSync(() => { if (selected.current === taskId) installSnapshot(next) })
      settled = true
    } catch (e) {
      setError(String(e))
      if (!submitted) {
        try { await request({ type: 'surface.respond', task_id: taskId, action_id: update.action_id, proceed: false, confirm_discard: false }) } catch { /* Only cancel a proposal never sent for commit. */ }
        settled = true
      }
    } finally {
      if (settled) { for (const release of releases.reverse()) release(); replacing.current = false }
      else { unsettledSurface.current = { taskId, actionId: update.action_id, epoch: snapshot.runtime_epoch, releases }; setSurfaceUnknown(true) }
      setBusy(false)
    }
  }
  async function changeViewPage(offset: number) {
    if (!snapshot || busy || replacing.current || submissions.current.size || maintenance.current) return
    const taskId = snapshot.task.id, releases: (() => void)[] = []
    setBusy(true); setError('')
    try {
      for (const editor of editors.current.values()) if (editor.taskId === taskId) { releases.push(editor.hold()); await editor.save() }
      if (dirty.current.size) throw Error('当前页仍有未保存输入，请先处理冲突')
      const next = await request<Snapshot>({ type: 'host.views.page', task_id: taskId, offset, expected_revision: snapshot.surface.revision })
      flushSync(() => { if (selected.current === taskId) installSnapshot(next) })
    } catch (error) { setError(String(error)) }
    finally { releases.reverse().forEach(release => release()); setBusy(false) }
  }
  async function querySurfaceOutcome() {
    const pending = unsettledSurface.current
    if (!pending || busy) return
    setBusy(true)
    try {
      const operation = await request<{ metadata: { state: string } }>({ type: 'task.query', task_id: pending.taskId, query: { type: 'read', input: { target: { kind: 'action', id: pending.actionId } } } })
      const next = await request<Snapshot>({ type: 'task.snapshot', task_id: pending.taskId })
      if (next.runtime_epoch === pending.epoch && operation.metadata.state !== 'ended') throw new Error('原动作尚未确认结束；继续保持输入暂停，只查询，不重发')
      flushSync(() => { if (selected.current === pending.taskId) installSnapshot(next) })
      for (const release of pending.releases.reverse()) release()
      unsettledSurface.current = null; replacing.current = false; setSurfaceUnknown(false); setError('')
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const selected = useRef<string | null>(null)
  const generation = useRef(0)
  const syncQuery = useRef(0)
  const syncState = useRef<{ task: string; cursor: { runtime_epoch: string; sequence: number }; snapshot: Snapshot } | null>(null)
  function installSnapshot(next: Snapshot) {
    setSnapshot(previous => {
      if (previous?.task.id === next.task.id && previous.runtime_epoch === next.runtime_epoch) {
        if (previous.task.revision > next.task.revision || previous.surface.revision > next.surface.revision) return previous
        if (previous.views.some(view => { const other = next.views.find(v => v.id === view.id); return other && (view.revision > other.revision || view.state_revision > other.state_revision) })) return previous
      }
      return next
    })
  }
  async function refresh() {
    const taskId = selected.current, gen = generation.current, query = ++syncQuery.current, taskQuery = ++taskQueryGeneration.current
    let cursor: string | undefined; const list: Task[] = []
    do {
      const page: { items: Task[]; next_cursor: string | null } = await request({ type: 'host.tasks.page', input: { kind: 'task', limit: 50, ...(filter.trim() ? { filters: { name_query: filter.trim() } } : {}), ...(cursor ? { cursor } : {}) } })
      list.push(...page.items); cursor = page.next_cursor ?? undefined
    } while (cursor && list.length < taskPageLimit.current)
    if (taskQuery === taskQueryGeneration.current) { setTasks(list); setTaskCursor(cursor ?? null) }
    setConnected(true)
    if (taskId) {
      const state = syncState.current?.task === taskId ? syncState.current : null
      let reply = await request<SyncReply>({ type: 'sync.subscribe', task_id: taskId, ...(state ? { after: state.cursor } : {}) })
      let next = applySync(state?.snapshot ?? null, state?.cursor ?? null, reply)
      if (!next) { reply = await request<SyncReply>({ type: 'sync.subscribe', task_id: taskId }); next = reply.snapshot ?? null }
      if (generation.current === gen && query === syncQuery.current && selected.current === taskId && next) { syncState.current = { task: taskId, cursor: { runtime_epoch: reply.runtime_epoch, sequence: reply.sequence }, snapshot: next }; installSnapshot(next) }
    }
  }
  async function select(taskId: string) {
    if (!canLeave()) return
    if (selected.current) composerDrafts.current.set(selected.current, text)
    generation.current++; selected.current = taskId; setSnapshot(null); setText(composerDrafts.current.get(taskId) ?? ''); setTab('surface'); workspace.current?.dismissDrawer(); setError('')
    try { await refresh() } catch (e) { setError(String(e)); setConnected(false) }
  }
  useEffect(() => {
    taskPageLimit.current = 50
    const timer = setTimeout(() => { void refresh().catch(e => setError(String(e))) }, 150)
    return () => clearTimeout(timer)
  }, [filter])
  function newTask() { if (!busy && canLeave()) { taskNameComposing.current = false; setSettingsOpen(false); setCreationError(''); setCreating(true); workspace.current?.dismissDrawer() } }
  async function settings() {
    setCreating(false); setSettingsPage('models'); setSettingsOpen(true); workspace.current?.dismissDrawer()
    try { await reloadModels() } catch (e) { setError(String(e)) }
  }
  useEffect(() => { void refresh().catch(e => setError(String(e))); void reloadModels().catch(() => {}) }, [])
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dusk' : 'graphite') : theme }
    apply(); media.addEventListener('change', apply); localStorage.setItem('trellis-theme', theme)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !creating && !settingsOpen && !exportOpen) { event.preventDefault(); newTask() }
      if ((event.metaKey || event.ctrlKey) && event.key === ',' && !creating && !settingsOpen && !exportOpen) { event.preventDefault(); settings() }
    }
    document.addEventListener('keydown', keyboard)
    return () => document.removeEventListener('keydown', keyboard)
  }, [creating, settingsOpen, busy])
  useEffect(() => {
    if (!snapshot && !settingsOpen) return
    const executing = snapshot?.runs.some(r => ['running', 'waiting'].includes(r.state))
    let inFlight = false
    const interval = setInterval(() => {
      if (inFlight) return
      inFlight = true
      void Promise.all([refresh(), reloadModels()]).catch(e => setError(String(e))).finally(() => { inFlight = false })
    }, executing || settingsOpen ? 300 : 1000)
    return () => clearInterval(interval)
  }, [settingsOpen, snapshot?.task.id, snapshot?.runs[0]?.state])
  async function act(input: HostRequest) {
    setBusy(true); setError('')
    try { await request(input); await refresh(); await reloadModels() } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const run = snapshot?.runs.find(r => ['running', 'waiting'].includes(r.state))
  const readyModels = models.models.filter(m => m.roles.includes('main'))
  const taskState = (state: Task['state']) => ({ active: '进行中', stopping: '停止中', stopped: '已停止', deleting: '删除中' })[state]
  const filteredTasks = tasks.filter(t => t.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  return <WorkspaceLayout ref={workspace} nativeMac={desktopPlatform() === 'darwin' && Boolean(window.trellis)}
    header={<><PaneToggle side="left" /><div className="window-title"><b>Trellis</b><span>{snapshot?.task.title ?? '工作空间'}</span></div><div className="window-tools"><button disabled={!snapshot || busy || exportOpen} onClick={() => setExportOpen(true)}>导出</button></div></>}
    sidebar={<><div className="sidebar-heading"><span>任务</span><div className="sidebar-actions"><button onClick={newTask} title={`新建任务（${shortcutLabel('N')}）`}>＋ 新建</button><PaneClose side="left" /></div></div><input type="search" aria-label="筛选任务" placeholder="筛选任务" value={filter} onChange={e => setFilter(e.target.value)} /><div className="task-list">{filteredTasks.map((t, i) => <button className={'task-row ' + (t.id === snapshot?.task.id ? 'selected' : '')} key={t.id} aria-current={t.id === snapshot?.task.id ? 'page' : undefined} title={`${t.title} · ${taskState(t.state)}`} onClick={() => void select(t.id)}><span className="task-number">{String(i + 1).padStart(2, '0')}</span><span className="task-name">{t.title}</span><span className={'task-dot ' + t.state} aria-label={taskState(t.state)} /></button>)}{taskCursor && <button onClick={() => { taskPageLimit.current += 50; void refresh().catch(e => setError(String(e))) }}>加载更多任务</button>}{!filteredTasks.length && <p className="sidebar-empty">{tasks.length ? '没有匹配的任务' : '尚无任务'}</p>}</div><div className="sidebar-footer"><button onClick={settings}>设置 <span>{shortcutLabel(',')}</span></button><small>本地保存 · 切换任务不取消执行</small></div></>}
    content={<><nav className="toolbar" aria-label="当前任务工具栏"><span className="breadcrumb">{snapshot ? snapshot.task.title : '工作空间'}{snapshot && <span className="badge">{taskState(snapshot.task.state)}</span>}</span>{snapshot && <div><button disabled={busy || snapshot.task.state === 'stopping'} onClick={() => void act({ type: snapshot.task.state === 'stopped' ? 'task.resume' : 'task.stop', task_id: snapshot.task.id })}>{snapshot.task.state === 'stopped' ? '恢复任务' : snapshot.task.state === 'stopping' ? '停止中…' : '停止任务'}</button><button disabled={busy} onClick={async () => { if (!canLeave() || !confirm('永久删除任务及应用内记录？此操作不能撤销。资源文件先保留并登记收尾，只有全部保护解除后，才能在“存储检查”另行确认物理回收。')) return; setBusy(true); try { const recovery = await request<{ active: { id: string; task_ids: string[] } | null }>({ type: 'maintenance.status' }); const affected = recovery.active?.task_ids.includes(snapshot.task.id) ? recovery.active.id : undefined; if (affected && !confirm('该任务包含在当前唯一有效恢复点中。继续删除会先废止整个恢复点（包括其他任务的恢复能力），不能撤销。确认继续？')) return; await request({ type: 'task.delete', task_id: snapshot.task.id, ...(affected ? { invalidate_recovery_id: affected } : {}) }); composerDrafts.current.delete(snapshot.task.id); selected.current = null; generation.current++; setSnapshot(null); setText(''); setError(''); await refresh() } catch (e) { setError(String(e)) } finally { setBusy(false) } }}>删除</button></div>}</nav>
    {detachedDrafts.length > 0 && <section className="notice" aria-label="恢复前未发送文本"><h3>恢复前未发送文本（只读，未自动发送）</h3>{detachedDrafts.map((draft, index) => <pre key={index}>{draft}</pre>)}<button onClick={() => { if (confirm('确认清除当前窗口保留的恢复前未发送文本？')) setDetachedDrafts([]) }}>清除恢复前文本</button></section>}
    {maintenanceUnknown && <div className="error" role="alert">维护结果尚未确认，输入保持暂停。<button onClick={() => void queryMaintenance().catch(e => setError(String(e)))}>查询原维护结果</button></div>}
    {surfaceUnknown && <div className="error" role="alert">替换结果尚未确认，目标输入保持暂停。只查询原动作，不重发。<button disabled={busy} onClick={() => void querySurfaceOutcome()}>查询原替换结果并同步</button></div>}
    {error && <div className="error" role="alert">{error}<button onClick={() => void Promise.all([refresh(), reloadModels()]).catch(e => setError(String(e)))}>重新查询状态</button></div>}
    {snapshot ? <><div className="workspace-tabs" role="tablist" aria-label="任务工作区">{([['surface', '内容', snapshot.view_page?.total ?? snapshot.views.length], ['data', '任务数据', snapshot.task_data.total], ['resources', '资源', null], ['answers', '作答记录', snapshot.answer_total], ['execution', '执行记录', snapshot.runs.length]] as const).map(([id, label, count]) => <button key={id} role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls="workspace-panel" onClick={() => { if (canLeave()) { setError(''); setTab(id) } }}>{label}{count !== null && <span>{count}</span>}</button>)}</div><div className="workspace-scroll" role="tabpanel" id="workspace-panel" aria-labelledby={`tab-${tab}`}>
      {tab === 'surface' && <div className="document"><header className="document-heading"><span className="eyebrow">任务内容 · r{snapshot.surface.revision}</span><h1>{snapshot.task.title}</h1><p className="doc-meta">{snapshot.view_page?.total ?? snapshot.views.length} 个内容单元 · {snapshot.answer_total} 份正式作答</p>{snapshot.views.length > 1 && <nav className="content-directory" aria-label="内容目录"><label htmlFor="content-location">本页内容</label><select id="content-location" value="" onChange={event => { const target = document.getElementById(`content-${event.target.value}`); target?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}><option value="" disabled>定位到内容…</option>{snapshot.views.map((view, index) => <option key={view.id} value={view.id}>{viewTitle(view, index)}</option>)}</select></nav>}{snapshot.view_page && snapshot.view_page.total > 10 && <div className="inline-actions"><button disabled={busy || snapshot.view_page.offset === 0} onClick={() => void changeViewPage(snapshot.view_page!.offset - 10)}>上一页内容</button><span>第 {snapshot.view_page.offset + 1}–{Math.min(snapshot.view_page.offset + 10, snapshot.view_page.total)} 项 / 共 {snapshot.view_page.total} 项</span><button disabled={busy || snapshot.view_page.offset + 10 >= snapshot.view_page.total} onClick={() => void changeViewPage(snapshot.view_page!.offset + 10)}>下一页内容</button></div>}</header>{(snapshot.surface.layout?.slots.flatMap(slot => slot.groups) ?? [{ id: 'default', type: 'column', views: snapshot.views.map(v => v.id) }]).map(group => <div key={group.id} className={'surface-group ' + (group.type === 'responsive_columns' ? 'surface-columns' : '')} style={{ ...(group.type === 'responsive_columns' && 'column_weights' in group && group.column_weights ? { '--surface-columns': group.column_weights.map(weight => `minmax(0,${weight}fr)`).join(' ') } : {}), gap: ({ none: 0, small: 8, medium: 16, large: 24 } as Record<string, number>)[group.gap ?? 'medium'], alignItems: group.align === 'start' ? 'start' : group.align === 'center' ? 'center' : 'stretch' }}>{group.views.map(viewId => { const v = snapshot.views.find(item => item.id === viewId); return v ? <ManagedView key={v.id} view={v} taskId={snapshot.task.id} refresh={refresh} onDirty={onDirty} onSubmission={onSubmission} register={registerEditor} /> : null })}</div>)}{!snapshot.views.length && !snapshot.runs.length && <section className="empty-state"><h2>{run ? 'Agent 正在处理请求' : snapshot.task_data.total ? '任务已保存结构化数据' : '尚未发布任务界面'}</h2><p>{run ? '执行状态可在右侧或执行记录中查看。界面只有通过校验并发布后才会出现在这里。' : snapshot.task_data.total ? '数据写入不等于生成界面。可切换到任务数据查看真实保存的对象。' : '在 Agent 面板输入目标。模型可以回复文字、保存任务数据，或发布可交互内容；文字回复在当前内容页查看，交互单元仍需单独发布。'}</p><div className="inline-actions">{snapshot.task_data.total > 0 && <button onClick={() => setTab('data')}>查看任务数据</button>}<button onClick={() => { workspace.current?.showAgent() }}>打开 Agent 输入</button>{!modelId && <button className="primary" onClick={settings}>配置主模型</button>}</div></section>}<TaskReply key={`${snapshot.task.id}:${snapshot.runtime_epoch}`} snapshot={snapshot} onRecords={() => { if (canLeave()) setTab('execution') }} /></div>}
      {tab === 'resources' && <Materials key={snapshot.task.id} taskId={snapshot.task.id} active={snapshot.task.state==='active'} onDirty={onDirty} />}
      {tab === 'data' && <TaskData key={snapshot.task.id} snapshot={snapshot} />}
      {tab === 'answers' && <AnswerHistory key={snapshot.task.id} snapshot={snapshot} continueDisabled={busy || Boolean(run) || !modelId || snapshot.task.state !== 'active'} onReturnToContent={() => { if (canLeave()) setTab('surface') }} onContinue={answerId => { if (!confirm(`基于当前选中的正式作答发送新请求？这会调用当前主模型，并产生一次新的运行。\n作答 ID：${answerId}`)) return; void act({ type: 'task.submit', task_id: snapshot.task.id, text: `请阅读已保存的正式作答（ID：${answerId}），继续本任务。`, model_config_id: modelId, attachments: [] }) }} />}
      {tab === 'execution' && <ExecutionHistory key={snapshot.task.id} snapshot={snapshot} />}
    </div></> : <div className="workspace-scroll"><section className="workspace-start"><header><span className="eyebrow">本地工作空间</span><h1>{tasks.length ? '选择任务' : '尚无任务'}</h1><p>{tasks.length ? '从左侧选择已有任务，或新建任务。打开任务不会自动运行 Agent。' : '先配置主模型，再创建任务并输入目标。内容、任务数据、作答和执行记录分别保存。'}</p></header><div className="start-actions"><button className="primary" onClick={newTask}>{tasks.length ? '新建任务' : '创建第一个任务'}</button><button onClick={settings}>配置模型与审批</button></div><dl className="workspace-readiness"><div><dt>主模型</dt><dd>{readyModels.length ? `${readyModels.length} 个已通过角色测试` : '未配置 · 不自动联网'}</dd></div><div><dt>审批</dt><dd>{models.approval.mode === 'manual' ? '手动批准具体动作' : '独立辅助审批'}</dd></div><div><dt>可用入口</dt><dd>任务内容 / 数据 / 材料 / 作答 / 请求与执行记录</dd></div><div><dt>计算能力</dt><dd>Monty · 通过工具发现可用性</dd></div></dl></section></div>}</>}
    agent={<AgentPanel key={snapshot?.task.id ?? 'no-task'} snapshot={snapshot} run={run} modelId={modelId} models={models} busy={busy} text={text} setText={setText} composer={composer} onDirty={onDirty} refresh={async()=>{await refresh();await reloadModels()}} act={act} settings={()=>void settings()} onRecords={() => { if (canLeave()) { setTab('execution'); workspace.current?.dismissDrawer() } }} surfaceChecks={snapshot?.surface_updates.map(update => ({ id: update.action_id, content: <section className="approval-card pending" key={update.action_id}><b>替换提交检查 · 本人操作</b><p>{update.reset_requires_confirmation ? '包含 reset：继续后将另行确认丢弃草稿。权限审批不能代替此确认。' : '保留兼容的已保存草稿；先保存待写输入，版本变化则本动作冲突。'}</p><details><summary>目标、内容及版本</summary><pre>{JSON.stringify(update.request, null, 2)}</pre>{update.request_truncated && <RecordBrowser taskId={snapshot.task.id} kind="action" label="本次替换原动作" initialId={update.action_id} />}</details><small>期限：{new Date(update.expires_at).toLocaleString()}</small><div><button disabled={busy} onClick={() => void act({ type: 'surface.respond', task_id: snapshot.task.id, action_id: update.action_id, proceed: false, confirm_discard: false })}>取消本次替换</button><button disabled={busy} onClick={() => void completeSurface(update)}>保存输入并检查替换</button></div></section> })) ?? []} />}
    footer={<><span className={connected ? 'online' : ''}>{connected ? '● 运行时已连接' : '○ 未连接运行时'}</span><span>本地运行 <SettingsShortcut open={() => void settings()} /></span><span>{snapshot ? `${snapshot.views.length} 个内容单元 · ${snapshot.task_data.total} 个数据对象 · ${snapshot.answer_total} 份作答` : `${tasks.length} 个本地任务`}</span></>}
  >
    {exportOpen && snapshot && <DialogFocus><ExportPanel snapshot={snapshot} close={() => setExportOpen(false)} /></DialogFocus>}
    {settingsOpen && <ApplicationSettings page={settingsPage} setPage={setSettingsPage} close={() => { if (!settingsBusy && !maintenance.current) setSettingsOpen(false) }} locked={settingsBusy || busy || Boolean(maintenance.current)} theme={theme} setTheme={setTheme} textSize={textSize} setTextSize={setTextSize} models={models} reloadModels={reloadModels} modelId={modelId} setModelId={setModelId} onBusy={setSettingsBusy}
      plugins={<PluginSettings key={snapshot?.task.id ?? 'no-task'} embedded task={snapshot?.task.id ?? ''} close={() => setSettingsOpen(false)} changed={refresh} onBusy={setSettingsBusy} taskSelection={<><label>管理任务<select aria-label="插件管理任务" value="" disabled={!tasks.length || busy} onChange={event => { if (event.target.value) void select(event.target.value) }}><option value="">{tasks.length ? '选择一个任务' : '暂无任务'}</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label><button disabled={busy} onClick={newTask}>新建任务</button></>} />}
      storage={<StorageStatus embedded onBusy={setSettingsBusy} createRecovery={createRecovery} restoreRecovery={restoreRecovery} collectStaging={collectStaging} retireReplica={retireReplica} collectResource={collectResource} close={() => { if (!maintenance.current) setSettingsOpen(false) }} />}
    />}
    {creating && <DialogFocus><div className="overlay" onClick={e => { if (e.target === e.currentTarget && !busy) setCreating(false) }}><form className="modal" role="dialog" aria-modal="true" aria-label="新建任务" onKeyDown={e => {
      if (taskNameComposing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
        if (e.key === 'Enter') e.preventDefault()
        return
      }
      if (e.key === 'Escape' && !busy) setCreating(false)
    }} onSubmit={async e => { e.preventDefault(); if (taskNameComposing.current || busy || !title.trim()) return; setCreationError(''); setBusy(true); try { const next = await request<Snapshot>({ type: 'task.create', title }); if (selected.current) composerDrafts.current.set(selected.current, text); selected.current = next.task.id; generation.current++; setSnapshot(next); setText(''); setTab('surface'); setCreating(false); setTitle(''); await refresh(); workspace.current?.showAgent() } catch (e) { setCreationError(String(e)) } finally { setBusy(false) } }}><h2>新建任务</h2>{creationError && <p className="error" role="alert">{creationError}</p>}<label htmlFor="title">任务名称</label><input autoFocus id="title" maxLength={200} required value={title} onChange={e => setTitle(e.target.value)} onCompositionStart={() => { taskNameComposing.current = true }} onCompositionEnd={e => { taskNameComposing.current = false; setTitle(e.currentTarget.value) }} placeholder="为这个任务命名" /><p className="muted">创建只保存任务，不启动模型。目标在右侧 Agent 中输入。</p><div><button type="button" disabled={busy} onClick={() => setCreating(false)}>取消</button><button className="primary" disabled={busy || !title.trim()}>创建任务</button></div></form></div></DialogFocus>}
  </WorkspaceLayout>
}
createRoot(document.getElementById('root')!).render(<App />)

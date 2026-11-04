import React, { useEffect, useRef, useState } from 'react'
import { hostRequest } from './ModelSettings'
import type { Snapshot } from '../../shared/types'
type CatalogFragment = { id: string; category: string; selectable: boolean; personal_binding?: { answer_id: string; view_history_id: string } }
export function ExportPanel({ snapshot, close }: { snapshot: Snapshot; close(): void }) {
  const [job, setJob] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [partial, setPartial] = useState(false), [answers, setAnswers] = useState<string[]>([]), [history, setHistory] = useState<any[]>([])
  const [check, setCheck] = useState<any>(null)
  const [inspection, setInspection] = useState<any>(null)
  const checkEpoch = useRef(0), checkId = useRef<string | null>(null)
  const [views, setViews] = useState(snapshot.views.map(view => view.id))
  const [catalog, setCatalog] = useState<{ items: {id:string;revision:number;history_id:string;fragments:CatalogFragment[]}[]; offset:number; total:number } | null>(null)
  const [fragments, setFragments] = useState<Record<string, string[]>>({})
  const [answerItems, setAnswerItems] = useState<{ id:string;created_at:string }[]>([]), [answerCursor, setAnswerCursor] = useState<string | null>(null)
  const alive = useRef(true), queryEpoch = useRef(0)
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [sourceRevision] = useState(snapshot.surface.revision)
  const task_id = snapshot.task.id
  const selection = { task_id, answer_ids: answers, view_ids: views, expected_revision: sourceRevision, fragment_selection: views.map(view_id => ({ view_id, fragment_ids: fragments[view_id] ?? [] })) }
  const selectionKey = JSON.stringify(selection)
  const visibleCheck = check?.key === selectionKey ? check : null
  async function cancelInspection() {
    const id = checkId.current
    if (!id) return
    const result = await hostRequest<any>({ type: 'export.check.cancel', task_id, check_id: id })
    if (alive.current && checkId.current === id) setInspection(result)
  }
  async function inspectSelection(offset = 0) {
    const epoch = checkEpoch.current, key = selectionKey
    if (offset) {
      const result = await hostRequest<any>({ type: 'export.check.status', task_id, check_id: checkId.current!, offset })
      if (!alive.current || epoch !== checkEpoch.current) return
      if (result.phase !== 'ready' || check?.selection_hash !== result.selection_hash) { setCheck(null); throw Error('导出来源已变化，请重新检查选择') }
      setCheck({ ...result, key, issues: [...check.issues, ...result.issues] }); return
    }
    setError(''); setCheck(null); setInspection({ phase: 'starting', exited: false })
    try {
      const result = await hostRequest<any>({ type: 'export.check.start', ...selection })
      if (!alive.current || epoch !== checkEpoch.current) {
        await hostRequest({ type: 'export.check.cancel', task_id, check_id: result.id }); return
      }
      checkId.current = result.id; setInspection(result)
    } catch (e) { if (alive.current && epoch === checkEpoch.current) { setInspection(null); setError(String(e)) } }
  }
  useEffect(() => {
    checkEpoch.current++; setCheck(null)
    const id = checkId.current
    checkId.current = null; setInspection(null)
    if (id) void hostRequest({ type: 'export.check.cancel', task_id, check_id: id }).catch(() => {})
    return () => {
      checkEpoch.current++
      const previous = checkId.current
      checkId.current = null
      if (previous) void hostRequest({ type: 'export.check.cancel', task_id, check_id: previous }).catch(() => {})
    }
  }, [selectionKey])
  useEffect(() => {
    if (!inspection?.id || !['checking', 'cancelling'].includes(inspection.phase)) return
    const id = inspection.id, epoch = checkEpoch.current
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await hostRequest<any>({ type: 'export.check.status', task_id, check_id: id, offset: 0 })
        if (!active || !alive.current || epoch !== checkEpoch.current) return
        setInspection(result)
        if (result.phase === 'ready') setCheck({ ...result, key: selectionKey })
        else if (['failed', 'invalidated'].includes(result.phase)) { setCheck(null); setError(result.error) }
        if (['checking', 'cancelling'].includes(result.phase)) timer = setTimeout(poll, 100)
      } catch (e) { if (active && alive.current) { setInspection(null); setCheck(null); setError(String(e)) } }
    }
    timer = setTimeout(poll, 50)
    return () => { active = false; clearTimeout(timer) }
  }, [inspection?.id, inspection?.phase, selectionKey])
  const reload = async () => setHistory(await hostRequest<any[]>({ type: 'export.list', task_id }))
  async function loadCatalog(offset = 0) { const page = await hostRequest<NonNullable<typeof catalog>>({ type: 'export.catalog', task_id, offset, expected_revision: sourceRevision }); setCatalog(page); setFragments(old => { const next = { ...old }; for (const view of page.items) if (!next[view.id]) next[view.id] = view.fragments.filter(f => f.category === 'learning').map(f => f.id); return next }) }
  async function loadAnswers(more = false) {
    const page = await hostRequest<any>({ type: 'task.query', task_id, query: { type: 'list', input: { kind: 'answer', limit: 50, ...(more && answerCursor ? { cursor: answerCursor } : {}) } } })
    setAnswerItems(old => more ? [...old, ...page.items].slice(-200) : page.items); setAnswerCursor(page.next_cursor)
  }
  useEffect(() => { alive.current = true; void Promise.all([reload(), loadCatalog(), loadAnswers()]).catch(e => setError(String(e))); return () => { alive.current = false } }, [task_id])
  async function status(id: string) {
    const epoch = queryEpoch.current
    const next = await hostRequest<any>({ type: 'export.status', task_id, operation_id: id })
    const result = next.phase === 'preview' ? await hostRequest<any>({ type: 'export.preview', task_id, operation_id: id }) : next
    if (alive.current && epoch === queryEpoch.current) setJob(result)
  }
  useEffect(() => {
    if (job?.phase !== 'preparing') return
    let active = true, timer: ReturnType<typeof setTimeout>
    const poll = async () => { try { if (active) await status(job.id) } catch (e) { if (active) setError(String(e)) }; if (active) timer = setTimeout(poll, 500) }
    timer = setTimeout(poll, 100)
    return () => { active = false; clearTimeout(timer) }
  }, [job?.id, job?.phase])
  async function act(work: () => Promise<void>) { queryEpoch.current++; setBusy(true); setError(''); try { await work(); await reload() } catch (e) { setError(String(e)) } finally { queryEpoch.current++; setBusy(false) } }
  async function dismiss() {
    close()
  }
  return <div className="overlay"><section className="modal export-panel" role="dialog" aria-modal="true" aria-label="导出离线材料"><h2>导出离线材料</h2>
    <p>固定已发布内容版本，不调用模型或插件。默认排除个人作答、反馈和未提交草稿；正文和图片仍可能包含个人信息，请检查预览。</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!job && <><fieldset><legend>跨页选择已发布内容（最多 50 项，已选 {views.length} 项）</legend>{catalog?.items.map((view, index) => <div key={view.id}><label><input type="checkbox" checked={views.includes(view.id)} disabled={busy || (!views.includes(view.id) && views.length >= 50)} onChange={event => setViews(old => event.target.checked ? [...old, view.id] : old.filter(id => id !== view.id))} />内容 {catalog.offset + index + 1} · 版本 {view.revision}</label>{views.includes(view.id) && view.fragments.map(f => <label key={f.id}><input type="checkbox" checked={(fragments[view.id] ?? []).includes(f.id)} disabled={busy || !f.selectable} onChange={e => setFragments(old => ({ ...old, [view.id]: e.target.checked ? [...(old[view.id] ?? []), f.id] : (old[view.id] ?? []).filter(id => id !== f.id) }))} />片段 {f.id} · {f.category}{f.personal_binding ? ` · 需另选正式作答 ${f.personal_binding.answer_id.slice(0, 8)}（附原题）` : f.category !== 'learning' ? ' · 缺少绑定或分类，不可选择' : ''}</label>)}</div>)}{catalog && <><p>共 {catalog.total} 项，翻页保留选择；内容版本变化时请关闭后重新选择。</p><button disabled={busy || catalog.offset === 0} onClick={() => void act(() => loadCatalog(Math.max(0, catalog.offset - 20)))}>上一页导出内容</button><button disabled={busy || catalog.offset + catalog.items.length >= catalog.total} onClick={() => void act(() => loadCatalog(catalog.offset + 20))}>下一页导出内容</button></>}</fieldset><details><summary>可选：附带已提交作答（已选 {answers.length} 份）</summary>{answerItems.map((a, i) => <label key={a.id}><input type="checkbox" checked={answers.includes(a.id)} disabled={busy || (!answers.includes(a.id) && answers.length >= 50)} onChange={e => setAnswers(old => e.target.checked ? [...old, a.id] : old.filter(x => x !== a.id))} />{new Date(a.created_at).toLocaleString()} · {a.id.slice(0, 8)} · 原题版本绑定</label>)}{answerCursor && <button disabled={busy} onClick={() => void act(() => loadAnswers(true))}>加载更多可选作答</button>}</details><button disabled={busy || !catalog || !views.length || inspection?.exited === false} onClick={() => void inspectSelection()}>检查当前导出选择</button>{inspection && <section aria-label="后台预检状态"><p role="status">预检状态：{({ starting: '启动中', checking: '检查中', cancelling: '取消中，等待线程退出', cancelled: '已取消，线程已退出', ready: '检查完成', failed: '检查失败', invalidated: '来源已变化，请重新检查' } as Record<string, string>)[inspection.phase]}{inspection.phase === 'checking' ? '；可继续选择或关闭面板' : ''}</p><button disabled={inspection.phase !== 'checking'} onClick={() => void cancelInspection().catch(e => setError(String(e)))}>取消本次检查</button></section>}{visibleCheck && <section aria-label="导出选择检查"><p role="status">{visibleCheck.complete ? '完整性检查通过' : '存在遗漏，完整导出受阻'} · {visibleCheck.issue_count} 项诊断</p><p>包含已选作答的冻结原题；修改当前内容不会修改旧原题。检查不创建作业，保存前仍会重新核验。</p><ul>{visibleCheck.issues.map((issue: any, i: number) => <li key={i}>{issue.source === 'original_question' ? '冻结原题' : '当前内容'} · View {issue.view_id} · 版本 {issue.revision} · 历史 {issue.history_id} · {issue.code}{issue.fragment_id ? ` · 片段 ${issue.fragment_id}` : ''}{issue.element_id ? ` · 元素 ${issue.element_id}` : ''}{issue.node_path !== undefined ? ` · 节点 ${issue.node_path}` : ''}</li>)}</ul>{visibleCheck.next_offset !== null && <button disabled={busy} onClick={() => void act(() => inspectSelection(visibleCheck.next_offset))}>加载更多诊断</button>}</section>}<button disabled={busy || !catalog || !views.length} onClick={() => void act(async () => { setJob(await hostRequest({ type: 'export.prepare', ...selection })); setPartial(false) })}>固定快照并预览</button></>}
    {job && <><p role="status">导出状态：{job.phase} · {job.bytes ?? 0} 字节</p>{job.html && <iframe title="固定快照离线预览" sandbox="" srcDoc={job.html} style={{ width: '100%', height: 300, border: '1px solid var(--line)' }} />}
      {job.issues?.length > 0 && <><p className="error">完整导出被以下遗漏阻止：</p><ul>{job.issues.map((issue: string, i: number) => <li key={i}>{issue}</li>)}</ul><label><input type="checkbox" checked={partial} onChange={e => setPartial(e.target.checked)} />我确认部分导出，文件内保留遗漏提示</label></>}
      <button disabled={busy || job.phase !== 'preview' || Boolean(job.issues?.length && !partial)} onClick={() => void act(async () => { const next = await hostRequest<any>({ type: 'export.save', task_id, operation_id: job.id, partial }); if (!next.cancelled) setJob(next) })}>选择位置并保存 HTML</button>
      <button disabled={busy} onClick={() => void act(async () => { await status(job.id) })}>查询原导出结果</button>
      <button disabled={busy || !['preview', 'preparing', 'interrupted'].includes(job.phase)} onClick={() => void act(async () => { await hostRequest({ type: 'export.cancel', task_id, operation_id: job.id }); setJob(null) })}>取消并释放本次快照</button>
    </>}
    <details><summary>原导出作业（最近 20 项）</summary>{history.map(row => <div key={row.id}><button disabled={busy} onClick={() => void act(() => status(row.id))}>查看此原作业</button><span>{row.phase} · {row.pinned ? '资源仍保护' : '已结束'} · {row.reason ?? ''}</span>{row.phase === 'unknown' && <><label><input type="checkbox" checked={acknowledged.includes(row.id)} onChange={e => setAcknowledged(old => e.target.checked ? [...old, row.id] : old.filter(id => id !== row.id))} />我已自行检查保存位置；即使无法证明结果，仍结束此作业并解除快照保护，文件可能已经生成</label><button disabled={busy || !acknowledged.includes(row.id)} onClick={() => void act(async () => { await hostRequest({ type: 'export.resolve', task_id, operation_id: row.id, acknowledge: true }); if (job?.id === row.id) setJob(null) })}>核对并结束未知作业（不重试、不删除成品）</button></>}{['interrupted', 'preview', 'preparing'].includes(row.phase) && <button disabled={busy} onClick={() => void act(async () => { await hostRequest({ type: 'export.cancel', task_id, operation_id: row.id }); if (job?.id === row.id) setJob(null) })}>取消此原作业</button>}</div>)}</details>
    <p className="muted">关闭面板会取消临时预检，不取消正式后台作业；可继续使用任务，再从原导出作业查看。需解除资源保护请明确取消。</p><button disabled={busy} onClick={() => void dismiss()}>关闭导出</button>
  </section></div>
}

import { useEffect, useRef, useState } from 'react'
import { hostRequest } from './ModelSettings'
type Item = { id: string; state: string; attempt: number; next_attempt_at: string | null; assessment: string; reason: string; retained_bytes: number | null }
type RecoveryPoint = { id: string; created_at: string; resource_count: number; database_sha256: string; task_ids: string[]; schema_version: number; app_version: string }
type Status = { maintenance_error: string | null; summary: { total: number; candidates: number; reviews: number; known_bytes: number; unknown_sizes: number }; items: Item[]; next_after: number | null }
const labels: Record<string, string> = { committed: '正式提交已核对', pinned: '在途保护', candidate: '孤立候选（保留）', absent: '无残留文件', review: '需要核对（保留）' }
type GcResult = { id: string; phase: string; authorized: boolean; files_deleted: number; deleted_bytes: number; next_after: number | null; protected: number; reviews: number; items: { index: number; state: string; reason: string; attempt: number; next_retry_at: string | null }[] }
export function StorageStatus({ close, createRecovery, restoreRecovery, collectStaging, retireReplica, collectResource }: { close(): void; createRecovery(replace: string | null): Promise<void>; restoreRecovery(point: RecoveryPoint): Promise<void>; collectStaging(operationId?: string, after?: number): Promise<void>; retireReplica(replicaId: string, operationId?: string): Promise<void>; collectResource(operationId: string, retry?: boolean): Promise<void> }) {
  const [resources, setResources] = useState<any[]>([]), [resourceBefore, setResourceBefore] = useState<number | null>(null), [resourceError, setResourceError] = useState('')
  async function loadResources(more = false) {
    try { const value = await hostRequest<{ items: any[]; next_before: number | null }>({ type: 'maintenance.resource.list', summary: true, ...(more && resourceBefore ? { before: resourceBefore } : {}) }); setResources(value.items); setResourceBefore(value.next_before); setResourceError('') } catch (e) { setResourceError(String(e)) }
  }
  const [replicaBefore, setReplicaBefore] = useState<number | null>(null)
  const [replicas, setReplicas] = useState<{ replica_id: string; label: string; eligible: boolean; can_request: boolean; checked: boolean; operation: { id: string; phase: string; reason: string; protection_released: boolean; attempt: number; next_retry_at: string | null } | null }[]>([])
  const [replicaError, setReplicaError] = useState('')
  const [recovery, setRecovery] = useState<{ phase: string; error: string | null; active: RecoveryPoint | null; restore_enabled: boolean; gc_enabled: boolean; gc: { error: string | null; last: GcResult | null }; restore: { last: { id: string; phase: string } | null }; retained_candidates: number } | null>(null)
  const [status, setStatus] = useState<Status | null>(null), [items, setItems] = useState<Item[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [inspection, setInspection] = useState<any>(null), [inspectionError, setInspectionError] = useState(''), [resourceId, setResourceId] = useState('')
  const currentInspection = useRef<any>(null)
  currentInspection.current = inspection
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; const job = currentInspection.current; if (job?.phase === 'running') void hostRequest({ type: 'storage.inspect.cancel', job_id: job.id }).catch(() => {}) } }, [])
  useEffect(() => {
    if (inspection?.phase !== 'running') return
    const timer = setInterval(() => { void hostRequest<any>({ type: 'storage.inspect.status', job_id: inspection.id }).then(value => { if (mounted.current) setInspection(value) }).catch(e => { if (mounted.current) setInspectionError(String(e)) }) }, 300)
    return () => clearInterval(timer)
  }, [inspection?.id, inspection?.phase])
  async function inspect(scope: 'growth' | 'resources' | 'resource', after?: number) {
    setInspectionError('')
    try { setInspection(await hostRequest({ type: 'storage.inspect.start', scope, ...(scope === 'resource' ? { resource_id: resourceId.trim() } : {}), ...(after !== undefined ? { after } : {}) })) } catch (e) { setInspectionError(String(e)) }
  }
  const [gcHistory, setGcHistory] = useState<GcResult[]>([]), [gcBefore, setGcBefore] = useState<number | null>(null)
  async function loadGcHistory(more = false) {
    const result = await hostRequest<{ items: GcResult[]; next_before: number | null }>({ type: 'maintenance.gc.list', ...(more && gcBefore ? { before: gcBefore } : {}) })
    setGcHistory(result.items); setGcBefore(result.next_before)
  }
  async function load(more = false) {
    setBusy(true); setError('')
    try {
      setRecovery(await hostRequest({ type: 'maintenance.status' }))
      await loadGcHistory()
      await loadResources()
      try { const result = await hostRequest<{ items: typeof replicas; next_before: number | null }>({ type: 'maintenance.replica.list', summary: true }); setReplicas(result.items); setReplicaBefore(result.next_before); setReplicaError('') } catch (e) { setReplicas([]); setReplicaError(String(e)) }
      const value = await hostRequest<Status>({ type: 'storage.status', ...(more && status?.next_after ? { after: status.next_after } : {}) })
      setStatus(value); setItems(value.items)
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  async function retry(id: string) {
    setBusy(true); setError('')
    try { await hostRequest({ type: 'storage.retry', job_id: id }); await load() }
    catch (e) { setError(String(e)); setBusy(false) }
  }
  async function collect(id?: string, after = 0) {
    setBusy(true); setError('')
    let failure = ''
    try { await collectStaging(id, after) } catch (e) { failure = String(e) }
    finally { await load(); if (failure) setError(failure) }
  }
  useEffect(() => { void load() }, [])
  return <div className="overlay"><section className="modal model-modal" role="dialog" aria-modal="true" aria-label="存储检查" onKeyDown={e => { if (e.key === 'Escape' && !busy) close() }}>
    <header><h2>存储检查</h2><button disabled={busy} onClick={close}>关闭</button></header>
    <p className="notice">仅开放已登记 staging、已核验副本及已删除任务的正式资源受限回收，迁移未开放。恢复旧数据须本人确认。重新核对只更新维护登记，不删除文件、不重新执行模型或写入。不是全部磁盘文件扫描。</p>
    <section aria-label="只读诊断与增长"><h3>只读诊断与增长</h3>
      <p>独立只读检查，不保存草稿、不修复、不删除、不改变保护或原重试次数，不调用模型。仅已登记资源，每批最多 50 项；结果是该次观察，不是回收许可。SQLite 读取可能产生辅助文件。控制损坏时不猜测当前代际。</p>
      <button disabled={inspection?.phase === 'running'} onClick={() => void inspect('growth')}>检查控制清单增长</button>
      <button disabled={inspection?.phase === 'running'} onClick={() => void inspect('resources')}>只读核验资源首批</button>
      <label>诊断资源 ID<input aria-label="诊断资源 ID" value={resourceId} onChange={e => setResourceId(e.target.value)} /></label>
      <button disabled={inspection?.phase === 'running' || !/^[a-f0-9-]{36}$/.test(resourceId.trim())} onClick={() => void inspect('resource')}>只读诊断此资源</button>
      {inspection && <><p role="status">只读检查 {inspection.id} · {inspection.phase} · {inspection.progress?.phase} · 已检查 {inspection.progress?.checked ?? 0} 项</p>
        {inspection.phase === 'running' && <button onClick={async () => { try { setInspection(await hostRequest({ type: 'storage.inspect.cancel', job_id: inspection.id })) } catch (e) { setInspectionError(String(e)) } }}>取消只读检查</button>}
        {inspection.result && <><p>检查范围：{inspection.result.scope ?? '未完成'} · {inspection.result.started_at ?? inspection.started_at} 至 {inspection.result.finished_at ?? '未完成'} · {inspection.result.complete ? '本次范围检查完成' : '未完成，不能推断健康或无保护'}</p>
          {inspection.result.error && <p role="alert">{inspection.result.error}：文件和原保护保留，不提供强制继续。</p>}
          {inspection.result.controls && <><h4>独立控制记录（只增不裁剪）</h4><p>控制格式 {inspection.result.controls.format} · 资源收尾 {inspection.result.controls.resource_records} · 删除来源 {inspection.result.controls.deletion_sources} · 副本退役 {inspection.result.controls.replica_records} · 恢复操作 {inspection.result.controls.restore_operations} · GC 记录 {inspection.result.controls.gc_records}</p><p>控制文件字节：选择与收尾 {inspection.result.controls.restore_bytes} · 恢复点 {inspection.result.controls.recovery_bytes} · GC {inspection.result.controls.gc_bytes}</p>{inspection.result.controls.plugins && <p>插件控制格式 {inspection.result.controls.plugins.format} · {inspection.result.controls.plugins.bytes} 字节 · 固定包 {inspection.result.controls.plugins.packages} · 信任记录 {inspection.result.controls.plugins.trust_records} · 启用 {inspection.result.controls.plugins.enabled} · 主流程 {inspection.result.controls.plugins.workflows}。不裁剪记录，不回收插件包。</p>}{inspection.result.controls.exports && <p>导出控制格式 {inspection.result.controls.exports.format} · {inspection.result.controls.exports.bytes} 字节 · 原作业 {inspection.result.controls.exports.jobs} · 未核清保护 {inspection.result.controls.exports.unfinished}。不裁剪控制记录。</p>}<pre>{JSON.stringify(inspection.result.controls.resource_phases, null, 2)}</pre></>}
          {inspection.result.business && <><h4>业务元信息（未扫描文件正文）</h4><pre>{JSON.stringify(inspection.result.business, null, 2)}</pre><p>资源声明字节不是已核实占用，数据库/WAL 文件字节不等于系统可用空间。保留代际条目 {inspection.result.protection.retained_generation_entries} · 未释放副本保护 {inspection.result.protection.unreleased_replica_records}</p></>}
          {inspection.result.items?.map((item: any) => <article key={item.resource_id}><h4>{item.resource_id}</h4><p>{item.state} · {item.reason ?? '本次文件长度／摘要核验通过'} · {item.checked_at}</p><p>观察到的保护来源：{item.observed_protection_sources?.join('、') || '本次范围未发现；不代表无保护'}</p><p>保护状态未作完整核验，不授予删除许可；异常时相关资源使用及要求完整资源的维护可能受阻。保留现场，核对原来源；修复需另行决定。</p></article>)}
          {inspection.result.next_after !== null && inspection.result.next_after !== undefined && <button disabled={inspection.phase === 'running'} onClick={() => void inspect('resources', inspection.result.next_after)}>只读核验下一批资源</button>}
        </>}
      </>}
      {inspectionError && <p role="alert">{inspectionError}</p>}
    </section>
    <section aria-label="一致性恢复点"><h3>一致性恢复点</h3><p>仅创建本机已保存数据的校验快照，不包含 API Key，不是独立灾备。正式资源原文件仍需保留。未发送输入只留在当前窗口。</p>
      {recovery && <p role="status">维护状态：{recovery.phase} · 保留候选 {recovery.retained_candidates} 个{recovery.active ? ` · 有效点 ${recovery.active.id} · ${new Date(recovery.active.created_at).toLocaleString()} · ${recovery.active.resource_count} 个资源` : ' · 暂无有效恢复点'}</p>}
      {recovery?.error && <p className="error" role="alert">{recovery.error}：写入已暂停，文件保留；请检查隔离验证结果后再处理，不能强制继续。</p>}
      <button disabled={busy || recovery?.phase === 'blocked' || recovery?.phase === 'creating' || recovery?.phase === 'restoring'} onClick={async () => { setBusy(true); setError(''); try { await createRecovery(recovery?.active?.id ?? null) } catch (e) { setError(String(e)) } finally { setBusy(false); try { setRecovery(await hostRequest({ type: 'maintenance.status' })) } catch { /* Keep the original error visible. */ } } }}>{recovery?.active ? '创建新点并替换旧点' : '创建一致性恢复点'}</button>
      <button disabled={busy || !recovery?.restore_enabled || recovery?.phase !== 'idle'} onClick={async () => {
        if (!recovery?.active) return
        setBusy(true); setError('')
        try { await restoreRecovery(recovery.active) } catch (e) { setError(String(e)) }
        finally { setBusy(false); try { setRecovery(await hostRequest({ type: 'maintenance.status' })) } catch { /* Original outcome remains visible. */ } }
      }}>恢复此点的旧数据</button>
      {recovery?.restore.last && <p role="status">原恢复操作：{recovery.restore.last.id} · {recovery.restore.last.phase}</p>}
      <p>仅恢复当前有效点的 v1 数据，不自动续跑。当前连接／安全凭据不回滚。副本回收须另行本人确认，迁移关闭。删除包含任务会先确认并废止整个恢复点；旧点及失败候选文件不自动清理；未知或损坏副本保留。</p>
    </section>
    <section aria-label="受限暂存回收"><h3>受限暂存回收</h3><p>只核对每批最多 50 个已登记 staging。正式材料、历史、代际数据库、回退副本及恢复点资源保留。重启只核对原结果，不静默继续删除。文件字节不等于系统实际腾出的磁盘空间。</p>
      {recovery?.gc?.error && <p role="alert" className="error">{recovery.gc.error}：GC 已关闭，不能强制继续。</p>}
      <button disabled={busy || !recovery?.gc_enabled || recovery.phase !== 'idle'} onClick={() => void collect()}>检查并回收暂存首批</button>
      {recovery?.gc?.last && <><p role="status">原 GC 作业 {recovery.gc.last.id} · {recovery.gc.last.phase} · 已确认删除 {recovery.gc.last.files_deleted} 个／{recovery.gc.last.deleted_bytes} 字节 · 受保护 {recovery.gc.last.protected} 项／待核对 {recovery.gc.last.reviews} 项</p>
        {recovery.gc.last.items.map(item => <p key={item.index}>文件 {item.index + 1}：{item.state} · {item.reason} · 尝试 {item.attempt} 次{item.next_retry_at ? ` · 可重试时间 ${new Date(item.next_retry_at).toLocaleString()}` : ''}</p>)}
        <button disabled={busy || !recovery.gc_enabled || recovery.phase !== 'idle' || !recovery.gc.last.authorized || !recovery.gc.last.items.some(item => ['pending', 'failed'].includes(item.state) && item.attempt < 4)} onClick={() => void collect(recovery.gc!.last!.id)}>重试原 GC 未完成项</button>
        {recovery.gc.last.next_after !== null && <button disabled={busy || !recovery.gc_enabled || recovery.phase !== 'idle'} onClick={() => void collect(undefined, recovery.gc!.last!.next_after!)}>检查并回收下一批</button>}
      </>}
      <details><summary>查询原 GC 作业记录</summary>{gcHistory.map(op => <div key={op.id}><p>{op.id} · {op.phase} · 已确认删除 {op.files_deleted} 个／{op.deleted_bytes} 字节</p><button disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { const result = await hostRequest<{ last: GcResult }>({ type: 'maintenance.gc.status', operation_id: op.id }); setRecovery(old => old ? { ...old, gc: { ...old.gc, last: result.last } } : old) } catch (e) { setError(String(e)) } finally { setBusy(false) }
      }}>查询此 GC 原结果</button><button disabled={busy || !recovery?.gc_enabled || recovery.phase !== 'idle' || !op.authorized || !op.items.some(i => ['pending', 'failed'].includes(i.state) && i.attempt < 4)} onClick={() => void collect(op.id)}>重试此 GC 未完成项</button></div>)}{gcBefore !== null && <button disabled={busy} onClick={async () => { setBusy(true); try { await loadGcHistory(true) } catch (e) { setError(String(e)) } finally { setBusy(false) } }}>加载更早 GC 作业</button>}</details>
    </section>
    <section aria-label="副本退役与回收"><h3>副本退役与回收</h3><p>每次只确认一个已核验副本。当前代际、待定恢复、有效点和未通过启动核对的回退依赖受保护。先永久退役、再删除完整文件组、最后解除该副本保护；正式资源原件保持不变。重启不会继续删除。</p>
      {replicaError && <p role="alert" className="error">{replicaError}：副本回收已阻止，文件保留。</p>}
      {replicas.map(replica => <article key={replica.replica_id}><h4>{replica.label}</h4><p>{replica.operation ? `${replica.operation.id} · ${replica.operation.phase} · ${replica.operation.reason} · ${replica.operation.protection_released ? '该副本保护已解除' : '保护保留'}` : replica.can_request ? '尚未完整核验，可申请核验' : '受保护，不能退役'}</p>
        {replica.operation?.next_retry_at && <p>可重试时间：{new Date(replica.operation.next_retry_at).toLocaleString()}</p>}
        <button disabled={busy || recovery?.phase !== 'idle' || !replica.can_request} onClick={async () => { setBusy(true); let failure = ''; try { await retireReplica(replica.replica_id) } catch (e) { failure = String(e) } finally { await load(); if (failure) setError(failure) } }}>核验并退役此副本</button>
        {replica.operation && <><button disabled={busy} onClick={async () => { try { const result = await hostRequest<any>({ type: 'maintenance.replica.status', operation_id: replica.operation!.id }); setReplicas(old => old.map(r => r.replica_id === replica.replica_id ? { ...r, operation: result } : r)) } catch (e) { setError(String(e)) } }}>查询原副本结果</button><button disabled={busy || recovery?.phase !== 'idle' || replica.operation.phase === 'released' || replica.operation.attempt >= 4 || !!(replica.operation.next_retry_at && Date.parse(replica.operation.next_retry_at) > Date.now())} onClick={async () => { setBusy(true); let failure = ''; try { await retireReplica(replica.replica_id, replica.operation!.id) } catch (e) { failure = String(e) } finally { await load(); if (failure) setError(failure) } }}>重试原副本未完成项</button></>}
      </article>)}
    </section>
    {replicaBefore !== null && <button disabled={busy} onClick={async () => { setBusy(true); try { const value = await hostRequest<{ items: typeof replicas; next_before: number | null }>({ type: 'maintenance.replica.list', summary: true, before: replicaBefore }); setReplicas(value.items); setReplicaBefore(value.next_before) } catch (e) { setReplicaError(String(e)) } finally { setBusy(false) } }}>查看更早副本登记</button>}
    <section aria-label="正式资源删除收尾"><h3>正式资源删除收尾</h3><p>任务记录删除不等于文件已清空。每次只确认一项已登记资源；共享、历史、staging、恢复点及副本仍保护时保留。退役后不再允许关联或恢复；文件删除并登记完成后才清理元数据。重启不自动删除，临时文件不在范围。</p>
      {resourceError && <p role="alert" className="error">{resourceError}：正式资源回收保留待核对。</p>}
      {resources.length === 0 && <p>暂无已登记的任务资源收尾。</p>}
      {resources.map(r => <article key={r.id}><h4>{r.display_name}</h4><p>资源 {r.resource_id} · {r.bytes} 字节</p><p>原收尾 {r.id} · {r.phase} · {r.checked ? r.protection_reason ?? r.reason : '尚未核验保护与文件；列表不是删除许可'} · {r.metadata_cleaned ? '元数据收尾完成' : '元数据保留'} · 尝试 {r.attempt} 次</p>{r.next_retry_at && <p>可重试时间：{new Date(r.next_retry_at).toLocaleString()}</p>}
        <button disabled={busy || recovery?.phase !== 'idle' || !r.can_request} onClick={async () => { setBusy(true); let failure = ''; try { await collectResource(r.id) } catch (e) { failure = String(e) } finally { await load(); if (failure) setError(failure) } }}>核验并回收此正式资源</button>
        <button disabled={busy} onClick={async () => { try { const value = await hostRequest<any>({ type: 'maintenance.resource.status', operation_id: r.id }); setResources(old => old.map(item => item.id === r.id ? { ...item, ...value } : item)) } catch (e) { setError(String(e)) } }}>查询原资源收尾</button>
        <button disabled={busy || recovery?.phase !== 'idle' || r.phase === 'candidate' || r.phase === 'complete' || r.attempt >= 4 || !!r.protection_reason || !!(r.next_retry_at && Date.parse(r.next_retry_at) > Date.now())} onClick={async () => { setBusy(true); let failure = ''; try { await collectResource(r.id, true) } catch (e) { failure = String(e) } finally { await load(); if (failure) setError(failure) } }}>重试原资源未完成收尾</button>
      </article>)}
      {resourceBefore !== null && <button disabled={busy} onClick={() => void loadResources(true)}>查看更早资源收尾</button>}
    </section>
    {error && <p role="alert" className="error">{error}</p>}
    {status?.maintenance_error && <p role="alert" className="error">{status.maintenance_error}：后台登记失败，自动核对已停止，原文件保留。请检查存储后重新核对。</p>}
    {status && <p role="status">已登记 {status.summary.total} 项 · 孤立候选 {status.summary.candidates ?? 0} 项 · 待核对 {status.summary.reviews ?? 0} 项 · 已知占用 {status.summary.known_bytes} 字节{status.summary.unknown_sizes ? ` · ${status.summary.unknown_sizes} 项空间未知` : ''}</p>}
    <button disabled={busy} onClick={() => void load()}>刷新存储登记</button>
    {items.map(item => <article key={item.id}><h3>{labels[item.assessment] ?? '保留待核对'}</h3><p className="mono">{item.id}</p><p>{item.reason} · {item.retained_bytes === null ? '空间未知' : `${item.retained_bytes} 字节`} · 自动重试已执行 {item.attempt} 次</p>{item.next_attempt_at && <p>下次核对：{new Date(item.next_attempt_at).toLocaleString()}</p>}<button disabled={busy} onClick={() => void retry(item.id)}>重新核对此项</button></article>)}
    {status?.next_after && <button disabled={busy} onClick={() => void load(true)}>加载更多存储登记</button>}
  </section></div>
}

import { useState } from 'react'
import { hostRequest } from './ModelSettings'
import type { RequestAccounting } from '../../runtime/model/accounting'

type RequestFact = RequestAccounting & { event_id: string; dispatched: boolean; notice: string }
type Ledger = { requests: RequestFact[]; next_cursor: string | null; complete: boolean; through_sequence: number }
const emptyUsage = { input: 0, output: 0, unknown: 0, requests: 0 }
function addUsage(previous: typeof emptyUsage, requests: RequestFact[]) {
  return requests.reduce((sum, item) => ({ input: sum.input + (item.usage?.prompt_tokens ?? 0), output: sum.output + (item.usage?.completion_tokens ?? 0), unknown: sum.unknown + (item.usage ? 0 : 1), requests: sum.requests + 1 }), previous)
}
async function object(task: string, kind: 'run' | 'event', id: string): Promise<any> {
  let cursor: string | null = null, version: string | undefined, text = ''
  const seen = new Set<string>()
  for (let count = 0; count < 128; count++) {
    const part: { data: any; representation?: string; content_version?: string; next_cursor: string | null } = await hostRequest({ type: 'task.query', task_id: task, query: { type: 'read', input: { target: { kind, id }, ...(cursor ? { cursor } : {}) } } })
    if (!part.representation) return part.data
    if (version && version !== part.content_version) throw Error('记录已变化，请重新查询，不拼接旧版本。')
    version = part.content_version; text += part.data.text
    if (text.length > 1024 * 1024) throw Error('记录超过界面读取上限，请通过原记录分段查询。')
    if (!part.next_cursor) return JSON.parse(text)
    if (seen.has(part.next_cursor)) throw Error('续读游标重复，请重新查询。')
    seen.add(part.next_cursor); cursor = part.next_cursor
  }
  throw Error('续读超过界面上限，请通过原记录分段查询。')
}
const purposes = { main: '主模型', summary: '摘要', summary_correction: '摘要纠正', approval: '辅助审批' }
const phases = { reserved: '已预留，未登记派发', dispatched: '已登记派发', completed: '请求完成', failed: '派发前失败', unknown: '结果未知' }
export function RequestUsage({ taskId, runId }: { taskId: string; runId: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [event, setEvent] = useState<unknown>(null), [page, setPage] = useState(0)
  const [traversed, setTraversed] = useState(emptyUsage)
  async function load(eventId?: string, cursor?: string) {
    setBusy(true); setError(''); setEvent(null)
    try { if (eventId) setEvent(await object(taskId, 'event', eventId)); else { const result = await hostRequest({ type: 'host.run.accounting', task_id: taskId, run_id: runId, ...(cursor ? { cursor } : {}) }) as Ledger; setLedger(result); setPage(cursor ? page + 1 : 0); setTraversed(old => addUsage(cursor ? old : emptyUsage, result.requests)) } }
    catch (e) { setError(String(e)); if (!eventId) setLedger(null) } finally { setBusy(false) }
  }
  const pageUsage = ledger && addUsage(emptyUsage, ledger.requests)
  return <section aria-label="单次请求用量" className="request-usage"><button disabled={busy} onClick={() => void load()}>查询单次请求用量</button>
    <p>只读查询，不调用模型。字节构成为输入大小，不是精确 token 归因；估算为字节数 + 256。单次容量与 Run 累计用量不同；服务 usage 不是费用账单。派发登记先于适配器调用，不保证服务已收到。</p>
    {error && <p role="alert">{error}</p>}{ledger && <p role="status">快照截至记录序号 {ledger.through_sequence} · 第 {page + 1} 页。仅显示本页，不是整个 Run 的合计；新增请求及迟到 usage 请重新查询。{ledger.complete ? '已到快照末页。' : '还有后续请求。'}</p>}
    {pageUsage && <p>本页已知服务 usage：输入 {pageUsage.input} / 输出 {pageUsage.output} token；另有 {pageUsage.unknown} 个请求 usage 未知，未计入，不是零消耗或完整账单。</p>}
    {ledger && <p>已遍历 {traversed.requests} 个请求，{ledger.complete ? '已覆盖当前快照全部请求' : '仅覆盖已遍历部分'}；已知服务 usage 累计：输入 {traversed.input} / 输出 {traversed.output} token；{traversed.unknown} 个请求 usage 未知，不计为零。{ledger.complete && traversed.unknown === 0 ? '当前快照 usage 齐全，仍不是费用账单。' : '不是完整消耗或费用账单。'}</p>}
    {ledger && !ledger.requests.length && <p role="status">此 Run 未记录单次请求用量，不从旧聚合预算反推。</p>}
    {ledger?.requests.map((item, index) => <details key={item.request_id}><summary>请求 {page * 20 + index + 1} · {purposes[item.purpose]} · {phases[item.phase]}</summary>
      <p>模型 {item.model_id} · 配置版本 {item.model_revision} · 请求 {item.request_id}</p><p>输入 {item.input_bytes} 字节 · {item.usage ? `服务端输入 ${item.usage.prompt_tokens} token` : `服务端用量未返回，输入估算 ${item.estimated_input_tokens} token`} · 输出设置 {item.output_reserve === null ? '未知（未设置输出上限，由服务决定）' : item.output_reserve} · 配置容量 {item.context_tokens}。输入容量不扣输出；剩余不超过10%时在完整请求边界压缩。累计限制仅使用显式设置。</p>
      <p>{item.usage ? `服务 usage：输入 ${item.usage.prompt_tokens} / 输出 ${item.usage.completion_tokens} token` : '服务 usage 未知，不是零消耗。'}{item.error && ` · ${item.error}`}</p>
      <dl>{Object.entries(item.components).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value} 字节</dd></div>)}</dl>
      <p>原事件 {item.event_id} · {item.at}。{item.phase === 'reserved' || item.phase === 'unknown' ? '不会自动重试或继续业务。' : ''}</p><button disabled={busy} onClick={() => void load(item.event_id)}>查看此请求原用量事件</button>
    </details>)}{ledger?.next_cursor && <button disabled={busy} onClick={() => void load(undefined, ledger.next_cursor!)}>下一页请求用量</button>}{event !== null && <pre aria-label="原用量事件">{JSON.stringify(event, null, 2)}</pre>}
  </section>
}

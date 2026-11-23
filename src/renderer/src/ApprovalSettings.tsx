import { useEffect, useId, useRef, useState } from 'react'
import type { ModelState } from './ModelSettings'

type Approval = ModelState['approval']

export function ApprovalSettings({ saved, models, locked, status, onSave }: {
  saved: Approval
  models: { id: string; label: string }[]
  locked: boolean
  status: string
  onSave(approval: Approval): void
}) {
  const id = useId()
  const [edit, setEdit] = useState<{ from: Approval; next: Approval } | null>(null)
  const saveRequested = useRef(false)
  const activeMode = useRef<HTMLInputElement>(null)
  const current = edit?.from.mode === saved.mode && edit.from.model_id === saved.model_id ? edit.next : saved
  const setDraft = (next: Approval) => setEdit({ from: saved, next })
  const automatic = current.mode === 'assisted'
  const modelId = current.model_id
  const validModel = models.some(model => model.id === modelId)
  const changed = current.mode !== saved.mode || (automatic && modelId !== saved.model_id)

  useEffect(() => {
    if (!locked && !changed && saveRequested.current) {
      saveRequested.current = false
      if (document.activeElement === document.body) activeMode.current?.focus()
    }
  }, [locked, changed])

  return <div className="approval-settings">
    <header className="model-page-title"><h1>权限与审批</h1></header>
    <form onSubmit={event => {
      event.preventDefault()
      if (locked || !changed || (automatic && !validModel)) return
      saveRequested.current = true
      onSave({ mode: current.mode, model_id: automatic ? modelId : '' })
    }}>
      <div className="approval-settings-panel">
        <div className="approval-settings-row">
          <h2 id={`${id}-mode`}>审批方式</h2>
          <div className="approval-mode" role="radiogroup" aria-labelledby={`${id}-mode`} data-automatic={automatic}>
            {([['manual', '手动'], ['assisted', '自动']] as const).map(([mode, label]) => <label className="approval-mode-option" key={mode}>
              <input type="radio" name={`${id}-mode`} ref={current.mode === mode ? activeMode : undefined} checked={current.mode === mode}
                disabled={locked} onChange={() => setDraft({ ...current, mode })} />
              <span>{label}</span>
            </label>)}
          </div>
        </div>
        {automatic && <div className="approval-settings-row approval-model-row">
          <label htmlFor={`${id}-model`}>审批模型</label>
          <select id={`${id}-model`} value={modelId} disabled={locked || !models.length} onChange={event => setDraft({ ...current, model_id: event.target.value })}>
            <option value="" disabled>{models.length ? '选择审批模型' : '请先在模型服务中添加模型'}</option>
            {modelId && !validModel && <option value={modelId} disabled>当前审批模型不可用</option>}
            {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select>
        </div>}
      </div>
      {automatic && <p className="approval-settings-note">删除、信任与丢弃输入仍需本人确认。模型异常时转人工。</p>}
      {changed && automatic && <p id={`${id}-consent`} className="approval-settings-consent">操作和必要的请求内容将发给所选模型服务，可能计费。</p>}
      {changed && <div className="approval-settings-actions">
        <span>未保存</span>
        <button className="primary" disabled={locked || (automatic && !validModel)} aria-describedby={automatic ? `${id}-consent` : undefined}>
          {automatic ? '同意并保存' : '保存'}
        </button>
      </div>}
      <p role="status" className="settings-operation-status">{changed && status === '已保存' ? '' : status}</p>
    </form>
  </div>
}

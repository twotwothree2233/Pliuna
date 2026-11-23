import { useId, useRef, useState } from 'react'
import type { ModelCatalogue } from '../../runtime/model/adapter'
import { DialogFocus } from './Dialog'
import { WorkspaceIcon } from './WorkspaceIcon'

type Candidate = ModelCatalogue['models'][number]

export function ModelCatalogueDialog({ channelName, models, addedIds, busy, status, onAdd, onClose, onCancel }: {
  channelName: string
  models: ModelCatalogue['models']
  addedIds: ReadonlySet<string>
  busy: boolean
  status: string
  onAdd(candidate: Candidate): void
  onClose(): void
  onCancel(): void
}) {
  const headingId = useId()
  const results = useRef<HTMLElement>(null)
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const matches = query ? models.filter(model => model.id.toLowerCase().includes(query)) : models

  return <DialogFocus><div className="overlay">
    <section className="modal model-catalogue" role="dialog" aria-modal="true" aria-labelledby={headingId}
      data-long={models.length > 8} onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.stopPropagation()
        event.preventDefault()
        if (!busy) onClose()
      }}>
      <header className="model-catalogue-heading">
        <div><h2 id={headingId}>服务可用模型</h2><p>{channelName}</p></div>
        <button type="button" disabled={busy} onClick={onClose}>关闭</button>
      </header>
      {models.length > 0 && <div className="model-catalogue-tools">
        <label className="model-catalogue-search">
          <WorkspaceIcon name="search" />
          <input type="search" aria-label="搜索模型标识" placeholder="搜索模型标识" value={search} onChange={event => {
            setSearch(event.target.value)
            if (results.current) results.current.scrollTop = 0
          }} />
        </label>
        <span className="model-catalogue-count" role="status" aria-atomic="true">{query ? `${matches.length} / ${models.length}` : models.length} 个模型</span>
      </div>}
      <section ref={results} className="model-catalogue-results" aria-label="模型列表" tabIndex={matches.length ? 0 : undefined}>
        {matches.length ? <ul>{matches.map((model, index) => {
          const modelId = `${headingId}-model-${index}`
          const added = addedIds.has(model.id)
          return <li key={model.id}>
            <div className="model-catalogue-model">
              <code id={modelId}>{model.id}</code>
              {(model.context_tokens !== undefined || model.max_output_tokens !== undefined) && <small>
                {model.context_tokens !== undefined && <span>上下文 {model.context_tokens.toLocaleString()}</span>}
                {model.max_output_tokens !== undefined && <span>输出上限 {model.max_output_tokens.toLocaleString()}</span>}
              </small>}
            </div>
            {added ? <span className="model-catalogue-added"><WorkspaceIcon name="check" />已添加</span> :
              <button className="model-catalogue-add" type="button" disabled={busy} aria-label="添加此模型" aria-describedby={modelId} onClick={() => onAdd(model)}>添加</button>}
          </li>
        })}</ul> : <div className="model-catalogue-empty">
          <strong>{models.length ? '未找到匹配模型' : '服务未返回可用模型'}</strong>
          <p>{models.length ? '试试其他关键词。' : '可返回渠道手动添加。'}</p>
        </div>}
      </section>
      {(status || busy) && <footer className="model-catalogue-status">
        {status && <p role="status" className="settings-operation-status">{status}</p>}
        {busy && <button type="button" onClick={onCancel}>取消当前操作</button>}
      </footer>}
    </section>
  </div></DialogFocus>
}

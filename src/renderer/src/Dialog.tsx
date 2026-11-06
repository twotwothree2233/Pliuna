import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function DialogFocus({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const previous = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    const controls = () => [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el => el.getClientRects().length)
    const initial = root.current!.querySelector<HTMLElement>('input:not(:disabled)') ?? controls()[0]
    initial?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const top = [...document.querySelectorAll('[role=dialog]')].at(-1)
      if (top && !root.current?.contains(top)) return
      const items = controls(), first = items[0], last = items.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); if (previous.current?.isConnected) previous.current.focus() }
  }, [])
  return createPortal(<div className="dialog-root" ref={root}>{children}</div>, document.body)
}

export function AgentDialog({ title, close, children }: { title: string; close(): void; children: ReactNode }) {
  return <DialogFocus><div className="overlay" onClick={event => { if (event.target === event.currentTarget) close() }}><section className="modal agent-dialog" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close() }
  }}><header className="agent-dialog-heading"><h2>{title}</h2><button aria-label="关闭弹窗" onClick={close}>×</button></header><div className="agent-dialog-content">{children}</div></section></div></DialogFocus>
}

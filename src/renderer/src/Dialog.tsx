import { useEffect, useRef, type ReactNode } from 'react'

export function DialogFocus({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const previous = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    const controls = () => [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el => el.getClientRects().length)
    const initial = root.current!.querySelector<HTMLElement>('input:not(:disabled)') ?? controls()[0]
    initial?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = controls(), first = items[0], last = items.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !items.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', trap)
    return () => { document.removeEventListener('keydown', trap); if (previous.current?.isConnected) previous.current.focus() }
  }, [])
  return <div className="dialog-root" ref={root}>{children}</div>
}

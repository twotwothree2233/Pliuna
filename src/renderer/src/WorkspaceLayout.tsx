import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { defaultWorkspace, fitWorkspace, maximumPaneWidth, paneMinimum, resizeWorkspace, type PaneSide, type WorkspaceGeometry, type WorkspacePreferences } from './workspace-layout'
import { shortcutLabel } from './desktop-platform'
import { WorkspaceIcon } from './WorkspaceIcon'

export interface WorkspaceHandle { showContent(): void; showAgent(): void }
interface LayoutControls {
  narrow: boolean
  visible(side: PaneSide): boolean
  toggle(side: PaneSide): void
  resize(side: PaneSide | 'center', value: number): void
  reset(): void
  geometry: WorkspaceGeometry
  preferences: WorkspacePreferences
}
const LayoutContext = createContext<LayoutControls | null>(null)
function useLayoutControls() { const controls = useContext(LayoutContext); if (!controls) throw new Error('Workspace controls require WorkspaceLayout'); return controls }
const paneName = { left: '任务栏', right: 'Agent 栏' }

export function PaneToggle({ side, pending = 0 }: { side: PaneSide; pending?: number }) {
  const layout = useLayoutControls(), visible = layout.visible(side)
  const title = `${visible ? '收起' : '打开'}${paneName[side]}`
  return <button className="pane-toggle" id={`toggle-${side}`} aria-label={title} aria-expanded={visible} aria-controls={`pane-${side}`} title={title} onClick={() => layout.toggle(side)}><WorkspaceIcon name={side === 'left' ? 'tasks' : 'agent'} /><span>{side === 'left' ? '任务' : 'Agent'}</span>{!visible && pending > 0 && <span className="pane-pending" aria-label={`${pending} 项待审批`}>{pending}</span>}</button>
}
export function SettingsShortcut({ open }: { open(): void }) {
  const layout = useLayoutControls()
  return (layout.narrow || !layout.visible('left')) ? <button className="settings-shortcut" onClick={open} title={`设置（${shortcutLabel(',')}）`}><WorkspaceIcon name="settings" />设置</button> : null
}

interface Drag { side: PaneSide; pointer: number; x: number; start: number; original: WorkspacePreferences; target: HTMLDivElement }
const collapseDistance = 48
const paneTransitionMs = 200
const dockPreference = { left: 'leftOpen', right: 'rightOpen' } as const
const dockState = { left: 'leftDock', right: 'rightDock' } as const
interface Props { header: ReactNode; sidebar: ReactNode; content: ReactNode; agent: ReactNode; footer: ReactNode; children?: ReactNode; nativeMac: boolean; taskInert: boolean; agentPending?: number }
export const WorkspaceLayout = forwardRef<WorkspaceHandle, Props>(function WorkspaceLayout({ header, sidebar, content, agent, footer, children, nativeMac, taskInert, agentPending = 0 }, ref) {
  const [preferences, setPreferences] = useState({ ...defaultWorkspace }), [width, setWidth] = useState(0)
  const [page, setPage] = useState<PaneSide | 'content'>('content'), [resizing, setResizing] = useState(false)
  const [armed, setArmed] = useState<PaneSide | null>(null)
  const [motion, setMotion] = useState<Record<PaneSide, number> | null>(null)
  const body = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null), drag = useRef<Drag | null>(null)
  const narrow = width > 0 && width <= 900
  const geometry = fitWorkspace(width, preferences)
  const state = useRef({ preferences, geometry, narrow }); state.current = { preferences, geometry, narrow }
  const visible = (side: PaneSide) => narrow ? page === side : geometry[dockState[side]]
  const focusToggle = (side: PaneSide) => root.current?.querySelector<HTMLElement>(narrow ? '.workspace-mobile-nav [aria-current=page]' : `#toggle-${side}`)?.focus({ preventScroll: true })
  function stopDrag(restore = false) {
    const active = drag.current; if (!active) return
    drag.current = null; setResizing(false); setArmed(null)
    if (restore) setPreferences(active.original)
    if (active.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer)
  }
  useLayoutEffect(() => {
    const element = body.current!
    let measured = 0
    const measure = () => {
      const next = element.getBoundingClientRect().width
      if (next === measured) return
      measured = next; stopDrag(); setMotion(null); setWidth(next)
    }
    measure(); const observer = new ResizeObserver(measure); observer.observe(element)
    return () => { observer.disconnect(); const active = drag.current; drag.current = null; if (active?.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer) }
  }, [])
  useEffect(() => {
    if (!motion) return
    // Also settle if the document is hidden or the user changes motion preferences.
    const timer = setTimeout(() => setMotion(null), paneTransitionMs + 80)
    return () => clearTimeout(timer)
  }, [motion])
  useEffect(() => {
    const blur = () => stopDrag()
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || document.querySelector('[role="dialog"]')) return
      if (drag.current) { event.preventDefault(); event.stopPropagation(); stopDrag(true) }
    }
    window.addEventListener('blur', blur); document.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('blur', blur); document.removeEventListener('keydown', key, true) }
  }, [])
  useLayoutEffect(() => {
    for (const side of ['left', 'right'] as const) if (!visible(side) && root.current?.querySelector(`#pane-${side}`)?.contains(document.activeElement)) focusToggle(side)
  }, [geometry.leftDock, geometry.rightDock, narrow, page])
  useImperativeHandle(ref, () => ({
    showContent: () => setPage('content'),
    showAgent: () => {
      const next = { ...state.current.preferences, rightOpen: true }
      if (state.current.narrow) setPage('right')
      else setPreferences(next)
      requestAnimationFrame(() => body.current?.querySelector<HTMLTextAreaElement>('#message')?.focus())
    }
  }), [])
  function resize(side: PaneSide | 'center', value: number) {
    setMotion(null)
    setPreferences(previous => resizeWorkspace(previous, state.current.geometry, side, value))
  }
  function changePanes(next: WorkspacePreferences) {
    const target = fitWorkspace(width, next)
    if ((geometry.leftDock !== target.leftDock || geometry.rightDock !== target.rightDock) && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMotion({ left: motion?.left || geometry.left || target.left, right: motion?.right || geometry.right || target.right })
    }
    setPreferences(next)
  }
  const controls: LayoutControls = {
    narrow, visible, preferences, geometry, resize,
    toggle(side) {
      stopDrag(); const next = { ...preferences, [dockPreference[side]]: !visible(side) }
      changePanes(next); focusToggle(side)
    },
    reset() { stopDrag(); setMotion(null); setPreferences({ ...defaultWorkspace }); setPage('content') }
  }
  const requestedWidth = (active: Drag, x: number) => active.start + (x - active.x) * (active.side === 'left' ? 1 : -1)
  function separator(side: PaneSide) {
    const docked = !narrow && geometry[dockState[side]]
    return <div className={`pane-separator ${drag.current?.side === side ? 'active' : ''}`} data-side={side} hidden={!docked && !motion?.[side]} inert={!docked} tabIndex={0} role="separator" aria-orientation="vertical" aria-label={`调整${side === 'left' ? '任务与内容' : '内容与 Agent'}栏宽度`} aria-controls={`pane-${side}`} aria-valuemin={paneMinimum[side]} aria-valuemax={Math.floor(maximumPaneWidth(geometry, side))} aria-valuenow={Math.round(geometry[side])} aria-valuetext={armed === side ? '松手收起' : `${Math.round(geometry[side])} 像素`} title="拖动调整宽度 · 双击恢复默认 · 方向键微调"
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return
        event.preventDefault(); const target = event.currentTarget
        const start = body.current?.querySelector(`#pane-slot-${side}`)?.getBoundingClientRect().width ?? geometry[side]
        drag.current = { side, pointer: event.pointerId, x: event.clientX, start: Math.max(paneMinimum[side], start), original: preferences, target }
        target.setPointerCapture(event.pointerId); setMotion(null); setResizing(true)
      }}
      onPointerMove={event => {
        const active = drag.current; if (active?.pointer !== event.pointerId) return
        const value = requestedWidth(active, event.clientX)
        setArmed(value <= paneMinimum[side] - collapseDistance ? side : null)
        resize(side, value)
      }}
      onPointerUp={event => {
        const active = drag.current; if (active?.pointer !== event.pointerId) return
        const collapse = requestedWidth(active, event.clientX) <= paneMinimum[side] - collapseDistance
        stopDrag()
        if (collapse) { changePanes({ ...preferences, [side]: active.original[side], [dockPreference[side]]: false }); focusToggle(side) }
      }}
      onPointerCancel={event => { if (drag.current?.pointer === event.pointerId) stopDrag(true) }}
      onLostPointerCapture={event => { if (drag.current?.pointer === event.pointerId) stopDrag() }}
      onDoubleClick={() => { stopDrag(); resize(side, defaultWorkspace[side]) }}
      onKeyDown={event => {
        let value = geometry[side]
        if (event.key === 'Home') value = paneMinimum[side]
        else if (event.key === 'End') value = maximumPaneWidth(geometry, side)
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') value += (event.key === 'ArrowRight' ? 1 : -1) * (side === 'left' ? 1 : -1) * (event.shiftKey ? 50 : 10)
        else return
        event.preventDefault(); resize(side, value)
      }} />
  }
  function pane(side: PaneSide, contents: ReactNode) {
    const showing = visible(side)
    return <div id={`pane-slot-${side}`} className="pane-slot" data-side={side} style={motion?.[side] && !narrow ? { '--pane-canvas': `${motion[side]}px` } as CSSProperties : undefined} inert={!showing || (side === 'right' && taskInert)} hidden={narrow && !showing}>
      <aside id={`pane-${side}`} className={`${side === 'left' ? 'sidebar' : 'agent'}`} hidden={!showing && !motion?.[side]} aria-label={side === 'left' ? '任务导航' : 'Agent 面板'}>{contents}</aside>
    </div>
  }
  const style = { gridTemplateColumns: narrow ? 'minmax(0,1fr)' : `${geometry.left}px ${geometry.leftGap}px minmax(0,1fr) ${geometry.rightGap}px ${geometry.right}px`, '--pane-duration': `${paneTransitionMs}ms` } as CSSProperties
  return <LayoutContext.Provider value={controls}><div ref={root} data-narrow={narrow || undefined} className={`app${nativeMac ? ' native-mac' : ''}${resizing ? ' resizing' : ''}`}>
    <header className="titlebar">{header}</header>
    <div className="workspace-body" ref={body} style={style} data-pane-motion={motion ? '' : undefined} onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === 'grid-template-columns') setMotion(null) }}>
      {pane('left', sidebar)}
      {separator('left')}
      <main className="content" id="main-workspace" inert={taskInert} hidden={narrow && page !== 'content'}>{content}</main>
      {separator('right')}
      {pane('right', agent)}
      {armed && <div className="pane-collapse-hint" data-side={armed} role="status">松手收起</div>}
    </div>
    {narrow ? <nav className="workspace-mobile-nav" aria-label="工作区视图">{([
      ['left', '任务', 'tasks', 'pane-left'], ['content', '内容', 'doc', 'main-workspace'], ['right', 'Agent', 'chat', 'pane-right']
    ] as const).map(([id, label, glyph, target]) => <button key={id} aria-controls={target} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)}><WorkspaceIcon name={glyph} />{label}{id === 'right' && page !== id && agentPending > 0 && <span className="pane-pending" aria-label={`${agentPending} 项待确认`}>{agentPending}</span>}</button>)}</nav> : <footer className="statusbar">{footer}</footer>}{children}
  </div></LayoutContext.Provider>
})

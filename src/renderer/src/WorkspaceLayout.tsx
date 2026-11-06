import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { defaultWorkspace, fitWorkspace, maximumPaneWidth, paneMinimum, resizeWorkspace, type PaneSide, type WorkspaceGeometry, type WorkspacePreferences } from './workspace-layout'

export interface WorkspaceHandle { dismissDrawer(): void; showAgent(): void }
interface LayoutControls {
  visible(side: PaneSide): boolean
  toggle(side: PaneSide): void
  close(side: PaneSide): void
  resize(side: PaneSide | 'center', value: number): void
  reset(): void
  geometry: WorkspaceGeometry
  preferences: WorkspacePreferences
}
const LayoutContext = createContext<LayoutControls | null>(null)
function useLayoutControls() { const controls = useContext(LayoutContext); if (!controls) throw new Error('Workspace controls require WorkspaceLayout'); return controls }
const paneName = { left: '任务栏', right: 'Agent 栏' }

function PanelIcon({ side }: { side: PaneSide }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d={side === 'left' ? 'M9 4v16' : 'M15 4v16'} /></svg>
}
export function PaneToggle({ side, pending = 0 }: { side: PaneSide; pending?: number }) {
  const layout = useLayoutControls(), visible = layout.visible(side)
  return <button className="pane-toggle" id={`toggle-${side}`} aria-label={`${visible ? '关闭' : '打开'}${paneName[side]}`} aria-expanded={visible} aria-controls={`pane-${side}`} title={`${visible ? '关闭' : '打开'}${paneName[side]}`} onClick={() => layout.toggle(side)}><PanelIcon side={side} />{pending > 0 && <span className="pane-pending" aria-label={`${pending} 项待审批`}>{pending}</span>}</button>
}
export function PaneClose({ side }: { side: PaneSide }) {
  const layout = useLayoutControls()
  return <button className="pane-close" aria-label={`关闭${paneName[side]}`} title={`关闭${paneName[side]}`} onClick={() => layout.close(side)}>×</button>
}
export function PaneReopen() {
  const layout = useLayoutControls()
  return !layout.visible('right') ? <div className="agent-reopen"><PaneToggle side="right" /></div> : null
}
export function SettingsShortcut({ open }: { open(): void }) {
  const layout = useLayoutControls()
  return !layout.visible('left') ? <button className="settings-shortcut" onClick={open} title="设置（⌘,）">设置</button> : null
}

interface Drag { side: PaneSide; pointer: number; x: number; start: number; original: WorkspacePreferences; target: HTMLDivElement }
interface Props { header: ReactNode; sidebar: ReactNode; content: ReactNode; agent: ReactNode; footer: ReactNode; children?: ReactNode; nativeMac: boolean }
export const WorkspaceLayout = forwardRef<WorkspaceHandle, Props>(function WorkspaceLayout({ header, sidebar, content, agent, footer, children, nativeMac }, ref) {
  const [preferences, setPreferences] = useState({ ...defaultWorkspace }), [width, setWidth] = useState(0)
  const [drawer, setDrawer] = useState<PaneSide | null>(null), [resizing, setResizing] = useState(false)
  const body = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null), drag = useRef<Drag | null>(null)
  const geometry = fitWorkspace(width, preferences)
  const state = useRef({ preferences, geometry, drawer }); state.current = { preferences, geometry, drawer }
  const visible = (side: PaneSide) => geometry[side === 'left' ? 'leftDock' : 'rightDock'] || drawer === side
  const focusToggle = (side: PaneSide) => root.current?.querySelector<HTMLElement>(`#toggle-${side}`)?.focus({ preventScroll: true })
  function stopDrag(restore = false) {
    const active = drag.current; if (!active) return
    drag.current = null; setResizing(false)
    if (restore) setPreferences(active.original)
    if (active.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer)
  }
  useLayoutEffect(() => {
    const element = body.current!
    const measure = () => { stopDrag(); setWidth(element.getBoundingClientRect().width) }
    measure(); const observer = new ResizeObserver(measure); observer.observe(element)
    return () => { observer.disconnect(); const active = drag.current; drag.current = null; if (active?.target.hasPointerCapture(active.pointer)) active.target.releasePointerCapture(active.pointer) }
  }, [])
  useEffect(() => {
    const blur = () => stopDrag()
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"]')) return
      if (drag.current) { event.preventDefault(); event.stopPropagation(); stopDrag(true) }
      else if (state.current.drawer) { const side = state.current.drawer; setDrawer(null); focusToggle(side) }
    }
    window.addEventListener('blur', blur); document.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('blur', blur); document.removeEventListener('keydown', key, true) }
  }, [])
  useLayoutEffect(() => {
    if (drawer && geometry[drawer === 'left' ? 'leftDock' : 'rightDock']) setDrawer(null)
    for (const side of ['left', 'right'] as const) if (!visible(side) && root.current?.querySelector(`#pane-${side}`)?.contains(document.activeElement)) focusToggle(side)
  }, [geometry.leftDock, geometry.rightDock, drawer])
  useImperativeHandle(ref, () => ({
    dismissDrawer: () => setDrawer(null),
    showAgent: () => {
      const next = { ...state.current.preferences, rightOpen: true }
      setPreferences(next); setDrawer(fitWorkspace(state.current.geometry.width, next).rightDock ? null : 'right')
      requestAnimationFrame(() => body.current?.querySelector<HTMLTextAreaElement>('#message')?.focus())
    }
  }), [])
  function resize(side: PaneSide | 'center', value: number) {
    setPreferences(previous => resizeWorkspace(previous, state.current.geometry, side, value))
  }
  const controls: LayoutControls = {
    visible, preferences, geometry, resize,
    toggle(side) {
      stopDrag(); const next = { ...preferences, [side === 'left' ? 'leftOpen' : 'rightOpen']: !visible(side) }
      setPreferences(next); setDrawer(!visible(side) && !fitWorkspace(width, next)[side === 'left' ? 'leftDock' : 'rightDock'] ? side : null); focusToggle(side)
    },
    close(side) { stopDrag(); setPreferences(previous => ({ ...previous, [side === 'left' ? 'leftOpen' : 'rightOpen']: false })); if (drawer === side) setDrawer(null); focusToggle(side) },
    reset() { stopDrag(); setPreferences({ ...defaultWorkspace }); setDrawer(null) }
  }
  function separator(side: PaneSide) {
    const docked = geometry[side === 'left' ? 'leftDock' : 'rightDock']
    return <div className={`pane-separator ${drag.current?.side === side ? 'active' : ''}`} data-side={side} hidden={!docked} tabIndex={0} role="separator" aria-orientation="vertical" aria-label={`调整${side === 'left' ? '任务与内容' : '内容与 Agent'}栏宽度`} aria-controls={`pane-${side}`} aria-valuemin={paneMinimum[side]} aria-valuemax={Math.floor(maximumPaneWidth(geometry, side))} aria-valuenow={Math.round(geometry[side])} aria-valuetext={`${Math.round(geometry[side])} 像素`} title="拖动调整宽度 · 双击恢复默认 · 方向键微调"
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return
        event.preventDefault(); const target = event.currentTarget
        drag.current = { side, pointer: event.pointerId, x: event.clientX, start: geometry[side], original: preferences, target }
        target.setPointerCapture(event.pointerId); target.focus({ preventScroll: true }); setResizing(true)
      }}
      onPointerMove={event => { const active = drag.current; if (active?.pointer === event.pointerId) resize(side, active.start + (event.clientX - active.x) * (side === 'left' ? 1 : -1)) }}
      onPointerUp={event => { if (drag.current?.pointer === event.pointerId) stopDrag() }}
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
  const style: CSSProperties = { gridTemplateColumns: `${geometry.left}px ${geometry.leftGap}px minmax(0,1fr) ${geometry.rightGap}px ${geometry.right}px` }
  return <LayoutContext.Provider value={controls}><div ref={root} className={`app${nativeMac ? ' native-mac' : ''}${resizing ? ' resizing' : ''}`}>
    <header className="titlebar">{header}</header>
    <div className="workspace-body" ref={body} style={style}>
      <aside id="pane-left" className={`sidebar${drawer === 'left' ? ' drawer' : ''}`} hidden={!visible('left')} style={{ '--drawer-width': `${preferences.left}px` } as CSSProperties} aria-label="任务导航">{sidebar}</aside>
      {separator('left')}
      <main className="content">{content}</main><PaneReopen />
      {separator('right')}
      <aside id="pane-right" className={`agent${drawer === 'right' ? ' drawer' : ''}`} hidden={!visible('right')} style={{ '--drawer-width': `${preferences.right}px` } as CSSProperties} aria-label="Agent 面板">{agent}</aside>
      {drawer && <button className="drawer-dismiss" aria-label="关闭侧面板" onClick={() => { setDrawer(null); focusToggle(drawer) }} />}
    </div>
    <footer className="statusbar">{footer}</footer>{children}
  </div></LayoutContext.Provider>
})

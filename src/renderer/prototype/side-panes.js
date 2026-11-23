const sides = {
  tasks: { label: '任务栏', min: 200, max: 420, defaultWidth: width => Math.min(256, Math.max(214, width * .175)), direction: 1 },
  agent: { label: 'Agent 栏', min: 260, max: 560, defaultWidth: width => Math.min(350, Math.max(278, width * .24)), direction: -1 }
}
const centerMinimum = 400
const collapseBuffer = 48
const clamp = (width, min, max) => Math.min(max, Math.max(min, width))

export function paneSlot(side, content) {
  const { label } = sides[side]
  return `<div class="p-pane-slot" data-side="${side}"><div class="p-pane-clip">${content}</div>
    <div class="p-separator" data-resize="${side}" role="separator" aria-orientation="vertical" aria-label="调整${label}宽度" aria-controls="${side}-pane" tabindex="0">
      <span class="p-resize-hint" aria-hidden="true">松开收起${label}</span></div></div>`
}

export function setupSidePanes(root) {
  const desktop = matchMedia('(width > 900px)')
  const prefs = { tasks: { open: true, width: null }, agent: { open: true, width: null } }
  const geometry = {}
  let elements
  let drag

  function sync() {
    const { workspace, shell, panes } = elements
    const viewport = workspace.clientWidth
    const available = viewport - centerMinimum
    const desired = side => Math.round(prefs[side].width ?? sides[side].defaultWidth(viewport))
    const width = (side, space) => prefs[side].open ? clamp(desired(side), sides[side].min, Math.min(sides[side].max, space)) : 0
    geometry.tasks = width('tasks', available - (prefs.agent.open ? sides.agent.min : 0))
    geometry.agent = width('agent', available - geometry.tasks)

    for (const [side, { slot, clip, grip, toggle }] of Object.entries(panes)) {
      const { open } = prefs[side]
      const { min, label } = sides[side]
      const collapsed = desktop.matches && !open
      shell.style.setProperty(`--${side}-track`, `${geometry[side]}px`)
      if (desktop.matches && open) slot.style.setProperty('--pane-width', `${geometry[side]}px`)
      if (collapsed && (clip.contains(document.activeElement) || document.activeElement === grip)) toggle.focus({ preventScroll: true })
      clip.inert = collapsed
      slot.dataset.open = open
      grip.hidden = !desktop.matches || !open
      grip.setAttribute('aria-valuemin', min)
      grip.setAttribute('aria-valuemax', limit(side))
      grip.setAttribute('aria-valuenow', geometry[side])
      grip.setAttribute('aria-valuetext', `${geometry[side]} 像素`)
      toggle.setAttribute('aria-expanded', open)
      toggle.setAttribute('aria-label', `${open ? '收起' : '展开'}${label}`)
    }
    shell.dataset.tasksOpen = prefs.tasks.open
  }

  function limit(side) {
    const other = side === 'tasks' ? 'agent' : 'tasks'
    return clamp(elements.workspace.clientWidth - centerMinimum - geometry[other], sides[side].min, sides[side].max)
  }

  function finish(cancel = false) {
    if (!drag) return
    const { side, grip, pointer, original, armed } = drag
    drag = null
    delete grip.dataset.armed
    delete elements.workspace.dataset.resizing
    if (grip.hasPointerCapture(pointer)) grip.releasePointerCapture(pointer)
    if (cancel || armed) prefs[side].width = original
    if (!cancel && armed) prefs[side].open = false
    sync()
  }

  function move(event) {
    const { side, start, grip } = drag
    if (event.clientX === start && !drag.moved) return
    drag.moved = true
    const { min, direction } = sides[side]
    const requested = drag.width + (event.clientX - start) * direction
    drag.armed = requested < min - collapseBuffer
    grip.toggleAttribute('data-armed', drag.armed)
    prefs[side].width = clamp(Math.round(requested), min, limit(side))
    sync()
  }

  root.addEventListener('pointerdown', event => {
    const grip = event.target.closest('[data-resize]')
    if (!grip || grip.hidden || drag || !event.isPrimary || event.button !== 0) return
    const side = grip.dataset.resize
    event.preventDefault()
    grip.focus({ preventScroll: true })
    grip.setPointerCapture(event.pointerId)
    elements.workspace.dataset.resizing = side
    drag = { side, grip, pointer: event.pointerId, start: event.clientX, width: geometry[side], original: prefs[side].width, armed: false }
  })
  root.addEventListener('pointermove', event => { if (drag?.pointer === event.pointerId) move(event) })
  root.addEventListener('pointerup', event => {
    if (drag?.pointer !== event.pointerId) return
    if (drag.start === event.clientX && !drag.moved) { finish(true); return }
    move(event)
    finish()
  })
  for (const type of ['pointercancel', 'lostpointercapture']) {
    root.addEventListener(type, event => { if (drag?.pointer === event.pointerId) finish(true) })
  }
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(true); return }
    const side = event.target.dataset.resize
    if (!side || drag) return
    const { min, direction } = sides[side]
    const values = { ArrowLeft: geometry[side] - 16 * direction, ArrowRight: geometry[side] + 16 * direction, Home: min, End: limit(side) }
    if (event.key === 'Enter') prefs[side].open = false
    else if (Object.hasOwn(values, event.key)) prefs[side].width = clamp(values[event.key], min, limit(side))
    else return
    event.preventDefault()
    sync()
  })
  window.addEventListener('blur', () => finish(true))
  window.addEventListener('resize', () => { if (drag) finish(true); else sync() })

  return {
    refresh() {
      finish(true)
      const panes = Object.fromEntries(Object.keys(sides).map(side => {
        const slot = root.querySelector(`[data-side="${side}"]`)
        return [side, { slot, clip: slot.firstElementChild, grip: slot.lastElementChild, toggle: root.querySelector(`[data-action="toggle-pane:${side}"]`) }]
      }))
      elements = { shell: root.firstElementChild, workspace: root.querySelector('.p-workspace'), panes }
      sync()
    },
    toggle(side) { finish(true); prefs[side].open = !prefs[side].open; sync() },
    show(side) { if (desktop.matches && !prefs[side].open) { prefs[side].open = true; sync() } }
  }
}

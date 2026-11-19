import type { Bundle, ChapterManifest, ChapterUpdate } from '../../shared/contracts.generated'

type Chapter = ChapterManifest['chapters'][number]
type Stage = ChapterUpdate['state']
interface FocusPosition { element: Element; id: string; region?: string; start?: number | null; end?: number | null; direction?: 'forward' | 'backward' | 'none' | null }
interface ReadingPosition { element: Element; id: string; region?: string; top: number; scroll: HTMLElement }
export interface ChapterPosition { reading?: ReadingPosition; focus?: FocusPosition }
const chapterCards = new WeakSet<Element>()

export function chapterElement(host: HTMLElement, selector: string): HTMLElement | null {
  // Only the host-validated mapping grammar is accepted. Structural paths
  // count published nodes, so inserting a status card cannot shift a boundary.
  if (/^#[A-Za-z][\w-]*$/.test(selector)) return host.querySelector<HTMLElement>('#' + CSS.escape(host.dataset.view + '-' + selector.slice(1)))
  if (!/^:scope(?: > [a-z][a-z0-9-]*:nth-child\([1-9]\d*\))+$/.test(selector)) return null
  let element = host
  for (const step of selector.slice(':scope > '.length).split(' > ')) {
    const match = /^([a-z][a-z0-9-]*):nth-child\(([1-9]\d*)\)$/.exec(step)!
    const child = [...element.children].filter(node => !chapterCards.has(node))[Number(match[2]) - 1]
    if (!(child instanceof HTMLElement) || child.localName !== match[1]) return null
    element = child
  }
  return element
}

function applicationHost(host: HTMLElement): HTMLElement {
  const root = host.getRootNode()
  return root instanceof ShadowRoot ? root.host as HTMLElement : host
}
function deepestActive(root: Document | ShadowRoot): Element | null {
  const active = root.activeElement
  return active?.shadowRoot ? deepestActive(active.shadowRoot) ?? active : active
}
function atPoint(root: Document | ShadowRoot, x: number, y: number): Element | null {
  const element = root.elementFromPoint(x, y)
  return element?.shadowRoot && element.shadowRoot !== root ? atPoint(element.shadowRoot, x, y) ?? element : element
}
function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}
function composedContains(container: Element, element: Element): boolean {
  for (let current: Element | null = element; current; current = composedParent(current)) if (current === container) return true
  return false
}
function regionFor(host: HTMLElement, manifest: ChapterManifest | undefined, element: Element): Chapter | undefined {
  for (let current: Element | null = element; current && current !== host; current = composedParent(current)) {
    const region = (current as HTMLElement).dataset.chapterRegion
    if (region) return manifest?.chapters.find(chapter => chapter.region_id === region)
  }
  return manifest?.chapters.find(chapter => {
    const body = chapterElement(host, chapter.body_selector)
    return body && composedContains(body, element)
  })
}

export function captureChapterPosition(host: HTMLElement, manifest?: ChapterManifest): ChapterPosition {
  const result: ChapterPosition = {}
  const scroll = applicationHost(host).closest<HTMLElement>('.workspace-scroll')
  if (scroll) {
    const bounds = scroll.getBoundingClientRect()
    const x = Math.min(bounds.right - 16, Math.max(bounds.left + 16, host.getBoundingClientRect().left + 24))
    const y = Math.max(0, bounds.top) + 24
    let element = atPoint(document, x, y)
    // Inert content is omitted by hit testing while a save is in flight. Its
    // geometry still describes what the reader sees, including a long middle.
    for (const chapter of manifest?.chapters ?? []) {
      const body = chapterElement(host, chapter.body_selector)
      if (!body?.inert || !body.getClientRects().length) continue
      const containsPoint = (node: Element) => { const rect = node.getBoundingClientRect(); return rect.left <= x && rect.right >= x && rect.top <= y && rect.bottom >= y }
      if (!containsPoint(body)) continue
      element = [...body.querySelectorAll('*')].reverse().find(containsPoint) ?? body
      break
    }
    if (element && element !== scroll && !['HTML', 'BODY'].includes(element.tagName)) {
      // Prefer a stable ID, but keep a live node for unrelated Views. Those
      // nodes survive a replacement and are a better anchor than an old offset.
      element = element.closest('[id]') ?? element
      const region = regionFor(host, manifest, element)
      result.reading = { element, id: element.id, ...(region ? { region: region.region_id } : {}), top: element.getBoundingClientRect().top, scroll }
    }
  }
  const active = deepestActive(document)
  if (active && composedContains(host, active)) {
    const region = regionFor(host, manifest, active)
    result.focus = { element: active, id: active.id, ...(region ? { region: region.region_id } : {}) }
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      result.focus.start = active.selectionStart; result.focus.end = active.selectionEnd; result.focus.direction = active.selectionDirection
    }
  }
  return result
}

export function restoreChapterPosition(position: ChapterPosition, host: HTMLElement, manifest?: ChapterManifest, replacement?: HTMLElement): void {
  const reading = position.reading
  if (reading) {
    const region = manifest?.chapters.find(chapter => chapter.region_id === reading.region)
    const existing = reading.element.isConnected && reading.element.getClientRects().length ? reading.element : null
    const byId = reading.id ? host.querySelector<HTMLElement>('#' + CSS.escape(reading.id)) : null
    const target = existing ?? (byId?.getClientRects().length ? byId : null) ?? replacement ?? (region ? chapterElement(host, region.body_selector) : null)
    if (target) {
      const bounds = reading.scroll.getBoundingClientRect()
      const top = existing || byId === target ? reading.top : Math.max(bounds.top + 16, reading.top)
      reading.scroll.scrollTop += target.getBoundingClientRect().top - top
    }
  }
  const focus = position.focus
  if (!focus) return
  const region = manifest?.chapters.find(chapter => chapter.region_id === focus.region)
  const original = focus.element.isConnected && focus.element.getClientRects().length ? focus.element as HTMLElement : null
  const target = original ?? (focus.id ? host.querySelector<HTMLElement>('#' + CSS.escape(focus.id)) : null) ?? replacement ?? (region ? chapterElement(host, region.body_selector) : null)
  if (!target || !target.getClientRects().length || target.closest('[inert]')) return
  if (!target.matches('input,textarea,select,button,a,[tabindex]')) target.tabIndex = -1
  target.focus({ preventScroll: true })
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && focus.start !== undefined) {
    try { target.setSelectionRange(focus.start ?? 0, focus.end ?? 0, focus.direction ?? 'none') } catch { /* A new control may have a non-text input type. */ }
  }
}

const activeStates = new Set<Stage>(['queued', 'generating', 'waiting_input', 'waiting_approval', 'assembling', 'publishing', 'unknown'])
const stages: Record<Stage, { title: string; detail: string }> = {
  queued: { title: '更新已排队', detail: '轮到本章节后开始处理，其他章节可继续阅读。' },
  generating: { title: '正在更新这一章', detail: '新内容发布后会在这里接替。上一版仍可查看。' },
  waiting_input: { title: '需要补充信息', detail: '请在 Agent 面板补充信息后继续。' },
  waiting_approval: { title: '等待确认', detail: '请检查待处理操作，确认后继续。' },
  assembling: { title: '正在准备新版本', detail: '正在合入已完成的修改，并保留其他章节。' },
  publishing: { title: '正在应用更新', detail: '正在核对当前正文和输入，发布完成后显示新内容。' },
  unknown: { title: '正在核对发布结果', detail: '本次操作结果尚未确认。查询原操作后更新显示。' },
  succeeded: { title: '更新完成', detail: '' },
  failed: { title: '更新未完成', detail: '已恢复上一版正文，可调整要求后再次修改。' },
  cancelled: { title: '更新已取消', detail: '上一版正文已恢复。' },
  interrupted: { title: '更新已中断', detail: '上一版正文已恢复，可检查状态后继续。' },
  superseded: { title: '已采用新的修改要求', detail: '' }
}

const cardStyle = `
:host{display:block!important;box-sizing:border-box!important;clear:both!important;max-width:100%!important;margin:12px 0 20px!important;color:var(--fg)!important;font:calc(12px * var(--text-scale,1))/1.7 var(--font-ui)!important;text-align:start!important}
*{box-sizing:border-box} .status{padding:20px 22px;background:var(--block);border:1px solid var(--line);border-radius:var(--radius-md,6px);overflow-wrap:anywhere;min-height:126px;outline:none}
.status:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.title{display:flex;align-items:center;gap:9px;font-weight:600;margin:0;color:var(--fg)}p{margin:8px 0 0;color:var(--muted);max-width:62ch}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
button{font:inherit;font-size:calc(11px * var(--text-scale,1));color:var(--fg);background:var(--bg);border:1px solid var(--line-strong);border-radius:var(--button-radius,4px);padding:5px 10px;cursor:pointer;min-height:30px}button:hover{background:var(--hover)}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}button:disabled{opacity:.55;cursor:default}
.activity{width:6px;height:6px;flex:none;border-radius:50%;background:var(--accent)}[data-active=true] .activity{animation:chapter-activity 1.8s ease-in-out infinite}.preview{max-height:22rem;overflow:auto;margin-top:16px;border-top:1px solid var(--line);padding-top:16px}.preview[hidden]{display:none}.error{color:var(--warn)}
@keyframes chapter-activity{0%,100%{opacity:1}50%{opacity:.35}}@media(prefers-reduced-motion:reduce){[data-active=true] .activity{animation:none}}@media(max-width:520px){.status{padding:16px}}
`

interface InstalledCard {
  body: HTMLElement; element: HTMLElement; update: ChapterUpdate; previousHidden: boolean; previousInert: boolean
  previousDisplay: string; previousDisplayPriority: string
  status: HTMLElement; title: HTMLElement; detail: HTMLElement; actions: HTMLElement; preview: HTMLElement; prepared: boolean
}
export interface ChapterPresentationOptions {
  host: HTMLElement
  bundle: Bundle
  save(): Promise<void>
  canPrepare(): boolean
  cancel(update: ChapterUpdate): Promise<void>
  query(update: ChapterUpdate): Promise<void>
  resolve(update: ChapterUpdate): void
}

export class ChapterPresentation {
  private manifest?: ChapterManifest
  private updates: ChapterUpdate[] = []
  private cards = new Map<string, InstalledCard>()
  private guardButtons = new Map<HTMLButtonElement, { disabled: boolean; title: string }>()
  private generation = 0
  private disposed = false
  private signature = ''
  private readonly hiddenStyle = document.createElement('style')
  constructor(private readonly options: ChapterPresentationOptions) {
    this.hiddenStyle.textContent = '[data-chapter-body-hidden=true]{display:none!important}'
    options.host.getRootNode().appendChild(this.hiddenStyle)
  }

  sync(manifest: ChapterManifest | undefined, updates: ChapterUpdate[] = [], force = false): void {
    const signature = JSON.stringify([manifest?.manifest_revision, manifest?.view_revision, updates.map(update => [update.update_id, update.state, update.region_ids, update.region_intents, update.reason, update.action_id])])
    this.manifest = manifest; this.updates = updates
    if (!force && signature === this.signature) return
    this.signature = signature
    const generation = ++this.generation
    const wanted = new Map<string, ChapterUpdate>()
    for (const update of updates) for (const id of update.region_ids) {
      const previous = wanted.get(id)
      const intent = (value: ChapterUpdate) => value.region_intents.find(item => item.region_id === id)?.intent_revision ?? 0
      if (!previous || intent(update) >= intent(previous)) wanted.set(id, update)
    }
    for (const [id, card] of this.cards) {
      const update = wanted.get(id)
      if (!update || update.update_id !== card.update.update_id || !activeStates.has(update.state)) this.removeCard(id)
    }
    for (const chapter of manifest?.chapters ?? []) {
      const update = wanted.get(chapter.region_id)
      if (!update || ['succeeded', 'superseded'].includes(update.state)) continue
      const body = chapterElement(this.options.host, chapter.body_selector)
      const title = chapterElement(this.options.host, chapter.title_selector)
      if (!body || !title || body.contains(title)) continue
      let card = this.cards.get(chapter.region_id)
      if (!card) {
        card = this.createCard(body, update, chapter.region_id)
        this.cards.set(chapter.region_id, card)
      }
      card.update = update
      this.paint(card)
      if (activeStates.has(update.state) && !card.prepared) void this.prepare(card, generation)
    }
    this.applySubmissionGuards()
  }

  blocksForm(formId: string): boolean {
    const form = this.options.bundle.forms.find(form => form.id === formId)
    if (!form) return false
    for (const card of this.cards.values()) {
      if (!activeStates.has(card.update.state)) continue
      for (const behavior of this.options.bundle.behaviors) {
        if (!('field' in behavior) || !form.fields.includes(behavior.field)) continue
        const element = this.options.host.querySelector('#' + CSS.escape(this.options.host.dataset.view + '-' + behavior.element_id))
        if (element && card.body.contains(element)) return true
      }
    }
    return false
  }

  applySubmissionGuards(): void {
    const blocked = new Set<HTMLButtonElement>()
    for (const behavior of this.options.bundle.behaviors) {
      if (behavior.type !== 'submit' || !this.blocksForm(behavior.form_id)) continue
      const button = this.options.host.querySelector<HTMLButtonElement>('#' + CSS.escape(this.options.host.dataset.view + '-' + behavior.element_id))
      if (!button) continue
      blocked.add(button)
      if (!this.guardButtons.has(button)) this.guardButtons.set(button, { disabled: button.disabled, title: button.title })
      button.disabled = true; button.title = '此表单包含正在更新的章节，请等待更新完成'
    }
    for (const [button, previous] of this.guardButtons) if (!blocked.has(button)) {
      button.disabled = previous.disabled; button.title = previous.title; this.guardButtons.delete(button)
    }
  }

  private createCard(body: HTMLElement, update: ChapterUpdate, regionId: string): InstalledCard {
    const position = captureChapterPosition(this.options.host, this.manifest)
    const element = document.createElement('section')
    chapterCards.add(element)
    element.dataset.chapterUpdate = update.update_id
    element.dataset.chapterRegion = regionId
    element.setAttribute('aria-label', '章节更新')
    const shadow = element.attachShadow({ mode: 'open' })
    const style = document.createElement('style'); style.textContent = cardStyle
    const status = document.createElement('div'); status.className = 'status'; status.tabIndex = -1
    const title = document.createElement('div'); title.className = 'title'; title.setAttribute('role', 'status'); title.setAttribute('aria-live', 'polite'); title.setAttribute('aria-atomic', 'true')
    const detail = document.createElement('p')
    const actions = document.createElement('div'); actions.className = 'actions'
    const preview = document.createElement('div'); preview.className = 'preview'; preview.hidden = true; preview.setAttribute('aria-label', '上一版内容（只读）')
    status.append(title, detail, actions, preview); shadow.append(style, status)
    body.before(element)
    restoreChapterPosition(position, this.options.host, this.manifest)
    return { body, element, update, previousHidden: body.hidden, previousInert: body.inert, previousDisplay: body.style.getPropertyValue('display'), previousDisplayPriority: body.style.getPropertyPriority('display'), status, title, detail, actions, preview, prepared: false }
  }

  private async prepare(card: InstalledCard, generation: number): Promise<void> {
    const beforeSave = captureChapterPosition(this.options.host, this.manifest)
    card.body.inert = true
    try {
      if (!this.options.canPrepare()) throw new Error('输入正在提交或等待核对，正文继续保留。处理完成后可重试。')
      await this.options.save()
      if (this.disposed || generation !== this.generation || !this.cardsHas(card) || !activeStates.has(card.update.state)) {
        if (!this.cardsHas(card)) card.body.inert = card.previousInert
        return
      }
      const position = captureChapterPosition(this.options.host, this.manifest)
      const active = deepestActive(document)
      const focusWasInside = beforeSave.focus?.region === card.element.dataset.chapterRegion
      const focusMoved = active && !['HTML', 'BODY'].includes(active.tagName) && active !== applicationHost(this.options.host) && !composedContains(card.body, active)
      card.prepared = true; card.body.hidden = true; card.body.dataset.chapterBodyHidden = 'true'
      card.body.style.setProperty('display', 'none', 'important')
      restoreChapterPosition({ reading: position.reading }, this.options.host, this.manifest, card.element)
      if (focusWasInside && !focusMoved) card.status.focus({ preventScroll: true })
      this.paint(card)
    } catch (error) {
      if (this.disposed || !this.cardsHas(card)) return
      card.body.inert = card.previousInert
      card.detail.textContent = '输入尚未保存，原正文仍可见。' + String(error).replace(/^Error:\s*/, '')
      card.detail.classList.add('error')
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '保存输入并继续'
      retry.onclick = () => this.sync(this.manifest, this.updates, true)
      card.actions.replaceChildren(retry)
    }
  }

  private cardsHas(card: InstalledCard): boolean { return [...this.cards.values()].includes(card) }

  private paint(card: InstalledCard): void {
    const active = deepestActive(document)
    const actionFocused = active && composedContains(card.actions, active)
    const stage = stages[card.update.state]
    card.title.textContent = stage.title
    card.status.dataset.active = String(card.prepared && card.update.state === 'generating')
    if (card.prepared && card.update.state === 'generating') {
      const activity = document.createElement('span'); activity.className = 'activity'; activity.setAttribute('aria-hidden', 'true'); card.title.prepend(activity)
    }
    card.detail.textContent = stage.detail; card.detail.classList.remove('error')
    if (card.update.reason && !/^[A-Z_\d]+$/.test(card.update.reason)) card.detail.textContent += ' ' + card.update.reason
    card.actions.replaceChildren()
    if (actionFocused) card.status.focus({ preventScroll: true })
    if (!activeStates.has(card.update.state)) return
    const button = (label: string, action: () => void) => {
      const element = document.createElement('button'); element.type = 'button'; element.textContent = label; element.onclick = action; card.actions.append(element); return element
    }
    const preview = button(card.preview.hidden ? '查看上一版' : '收起上一版', () => {
      const position = captureChapterPosition(this.options.host, this.manifest)
      if (card.preview.hidden && !card.preview.shadowRoot) this.makePreview(card)
      card.preview.hidden = !card.preview.hidden
      preview.textContent = card.preview.hidden ? '查看上一版' : '收起上一版'; preview.setAttribute('aria-expanded', String(!card.preview.hidden))
      restoreChapterPosition(position, this.options.host, this.manifest)
    })
    preview.setAttribute('aria-expanded', String(!card.preview.hidden))
    const perform = async (element: HTMLButtonElement, action: () => Promise<void>) => {
      element.disabled = true
      try { await action() } catch (error) { card.detail.textContent = String(error).replace(/^Error:\s*/, ''); card.detail.classList.add('error') } finally { element.disabled = false }
    }
    if (card.update.state === 'unknown') {
      const query = button('查询原操作', () => { void perform(query, () => this.options.query(card.update)) })
    } else if (['waiting_input', 'waiting_approval'].includes(card.update.state)) button('查看待处理事项', () => this.options.resolve(card.update))
    if (['queued', 'generating', 'waiting_input', 'waiting_approval', 'assembling'].includes(card.update.state)) {
      const cancel = button('取消更新', () => { void perform(cancel, () => this.options.cancel(card.update)) })
    }
  }

  private makePreview(card: InstalledCard): void {
    const shadow = card.preview.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    const sourceStyle = this.options.host.getRootNode() instanceof ShadowRoot ? (this.options.host.getRootNode() as ShadowRoot).querySelector('style') : null
    style.textContent = (sourceStyle?.textContent ?? '') + '\n:host{display:block}input,textarea,select,button{cursor:default!important}a{pointer-events:none}'
    const host = document.createElement('div'); host.dataset.view = this.options.host.dataset.view
    const body = card.body.cloneNode(true) as HTMLElement
    body.hidden = card.previousHidden; body.inert = false; body.style.setProperty('display', card.previousDisplay, card.previousDisplayPriority); delete body.dataset.chapterBodyHidden
    const originalControls = card.body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select')
    body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select').forEach((element, index) => {
      const original = originalControls[index]
      if (original) { element.value = original.value; if (element instanceof HTMLInputElement && original instanceof HTMLInputElement) element.checked = original.checked }
      element.disabled = true
    })
    body.querySelectorAll<HTMLButtonElement>('button').forEach(element => { element.disabled = true })
    body.querySelectorAll<HTMLElement>('[contenteditable],a,[tabindex]').forEach(element => { element.removeAttribute('contenteditable'); element.tabIndex = -1 })
    host.append(body); shadow.append(style, host)
    host.addEventListener('click', event => event.preventDefault()); host.addEventListener('submit', event => event.preventDefault())
  }

  private removeCard(id: string): void {
    const card = this.cards.get(id)
    if (!card) return
    const position = captureChapterPosition(this.options.host, this.manifest)
    card.body.hidden = card.previousHidden; card.body.inert = card.previousInert
    if (card.body.dataset.chapterBodyHidden) { delete card.body.dataset.chapterBodyHidden; card.body.style.setProperty('display', card.previousDisplay, card.previousDisplayPriority) }
    card.element.remove(); this.cards.delete(id)
    restoreChapterPosition(position, this.options.host, this.manifest, card.body)
  }

  dispose(): void {
    this.disposed = true; this.generation++
    for (const id of this.cards.keys()) this.removeCard(id)
    for (const [button, previous] of this.guardButtons) { button.disabled = previous.disabled; button.title = previous.title }
    this.guardButtons.clear()
    this.hiddenStyle.remove()
  }
}

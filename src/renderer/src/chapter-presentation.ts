import type { Bundle, ChapterManifest, ChapterUpdate, ContentNode, ContentOperationPlan } from '../../shared/contracts.generated'

type Stage = ChapterUpdate['state']
interface RegionPosition { region?: string; neighbors?: string[] }
interface FocusPosition extends RegionPosition { element: Element; id: string; start?: number | null; end?: number | null; direction?: 'forward' | 'backward' | 'none' | null }
interface ReadingPosition extends RegionPosition { element: Element; id: string; top: number; scroll: HTMLElement }
export interface ChapterPosition { reading?: ReadingPosition; focus?: FocusPosition }
const chapterCards = new WeakSet<Element>()

type InsertPlan = Extract<ContentOperationPlan, { type: 'insert' | 'move' }>
interface ContentRange { id: string; roots: HTMLElement[]; inner: boolean; gap?: { container: HTMLElement; before: Node | null } }
interface StatusScope { key: string; id: string; update: ChapterUpdate; insert?: InsertPlan }

export function chapterElement(host: HTMLElement, selector: string): HTMLElement | null {
  // Only the host-validated mapping grammar is accepted. Structural paths
  // count published nodes, so inserting a status card cannot shift a boundary.
  if (selector === ':scope') return host
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
function contentRange(host: HTMLElement, manifest: ChapterManifest | undefined, id: string): ContentRange | undefined {
  const node = manifest?.content_tree?.nodes.find(node => node.node_id === id)
  if (node) {
    const first = chapterElement(host, node.selector), last = chapterElement(host, node.end_selector)
    if (!first || !last || first.parentElement !== last.parentElement) return
    const roots = [first]
    for (let current = first; current !== last;) {
      const next = current.nextElementSibling
      if (!(next instanceof HTMLElement)) return
      if (!chapterCards.has(next)) roots.push(next)
      current = next
    }
    return { id, roots, inner: first === last && (first === host || /^(?:li|td|th|tr|thead|tbody|tfoot|table|ul|ol|menu)$/.test(first.localName)) }
  }
  const chapter = manifest?.chapters.find(chapter => chapter.region_id === id)
  const body = chapter && chapterElement(host, chapter.body_selector)
  return body ? { id, roots: [body], inner: false } : undefined
}
function insertionRange(host: HTMLElement, manifest: ChapterManifest | undefined, operation: InsertPlan): ContentRange | undefined {
  const parent = contentRange(host, manifest, operation.parent_id)
  if (!parent) return
  const first = parent.roots[0]!, last = parent.roots.at(-1)!
  let container = first, before: Node | null = null
  if (operation.position === 'before' || operation.position === 'after') {
    const anchor = contentRange(host, manifest, operation.anchor_id)
    if (!anchor) return
    const boundary = operation.position === 'before' ? anchor.roots[0]! : anchor.roots.at(-1)!
    if (!boundary.parentElement) return
    container = boundary.parentElement; before = operation.position === 'before' ? boundary : boundary.nextSibling
  } else if (first !== last || /^h[1-6]$/.test(first.localName)) {
    if (!first.parentElement) return
    container = first.parentElement; before = operation.position === 'start' ? first.nextSibling : last.nextSibling
  } else if (operation.position === 'start') before = first.firstChild
  return { id: operation.parent_id, roots: [], inner: false, gap: { container, before } }
}
function rangeContains(range: ContentRange, element: Element): boolean {
  return range.roots.some(root => composedContains(root, element))
}
function nodeNeighbors(manifest: ChapterManifest | undefined, id: string): string[] {
  const tree = manifest?.content_tree
  if (!tree) return []
  const nodes = new Map(tree.nodes.map(node => [node.node_id, node]))
  const result: string[] = []
  for (let node = nodes.get(id); node?.parent_id;) {
    const parent = nodes.get(node.parent_id)
    if (!parent) break
    const index = parent.children.indexOf(node.node_id)
    for (let distance = 1; distance < parent.children.length; distance++) {
      const after = parent.children[index + distance], before = parent.children[index - distance]
      if (after) result.push(after)
      if (before) result.push(before)
    }
    if (parent.node_id !== tree.root_id) result.push(parent.node_id)
    node = parent
  }
  return result
}
function regionFor(host: HTMLElement, manifest: ChapterManifest | undefined, element: Element): RegionPosition {
  for (let current: Element | null = element; current && current !== host; current = composedParent(current)) {
    const region = (current as HTMLElement).dataset.chapterRegion
    if (region) return { region, neighbors: nodeNeighbors(manifest, region) }
  }
  const nodes = [...(manifest?.content_tree?.nodes ?? [])].sort((a, b) => a.span.end - a.span.start - (b.span.end - b.span.start))
  const region = [...nodes.map(node => node.node_id), ...(manifest?.chapters.map(chapter => chapter.region_id) ?? [])].find(id => {
    const range = contentRange(host, manifest, id)
    return range && rangeContains(range, element)
  })
  return region ? { region, neighbors: nodeNeighbors(manifest, region) } : {}
}
function regionElement(host: HTMLElement, manifest: ChapterManifest | undefined, position: RegionPosition): HTMLElement | undefined {
  const tree = manifest?.content_tree
  let id = position.region
  const visited = new Set<string>()
  while (id && !visited.has(id)) {
    visited.add(id)
    const target = contentRange(host, manifest, id)?.roots.find(root => root.getClientRects().length)
    if (target) return target
    const successors = tree?.lineage.find(item => item.previous_node_id === id)?.successor_node_ids
    id = successors?.length === 1 ? successors[0] : undefined
  }
  for (const neighbor of position.neighbors ?? []) {
    const target = contentRange(host, manifest, neighbor)?.roots.find(root => root.getClientRects().length)
    if (target) return target
  }
}
function nodeOverlaps(left: ContentNode | undefined, right: ContentNode | undefined): boolean {
  return Boolean(left && right && left.span.start < right.span.end && right.span.start < left.span.end)
}
function gapKey(manifest: ChapterManifest | undefined, operation: InsertPlan): string {
  const children = manifest?.content_tree?.nodes.find(node => node.node_id === operation.parent_id)?.children ?? []
  const index = operation.position === 'start' ? 0 : operation.position === 'end' ? children.length : children.indexOf('anchor_id' in operation ? operation.anchor_id : '') + Number(operation.position === 'after')
  return `${operation.parent_id}:gap:${children[index - 1] ?? ''}:${children[index] ?? ''}`
}
function scopeOverlaps(manifest: ChapterManifest | undefined, left: StatusScope, right: StatusScope): boolean {
  if (left.insert && right.insert) return gapKey(manifest, left.insert) === gapKey(manifest, right.insert)
  const nodes = manifest?.content_tree?.nodes ?? []
  const node = (id: string) => nodes.find(node => node.node_id === id)
  if (!left.insert && !right.insert) return nodeOverlaps(node(left.id), node(right.id))
  const insertion = left.insert ?? right.insert!, target = node(left.insert ? right.id : left.id), parent = node(insertion.parent_id)
  return Boolean(target && parent && (target.span.start <= parent.span.start && target.span.end >= parent.span.end || 'anchor_id' in insertion && nodeOverlaps(target, node(insertion.anchor_id))))
}
function statusMount(container: HTMLElement, element: HTMLElement): HTMLElement {
  let mount = element
  const wrappers = /^(?:ul|ol|menu)$/.test(container.localName) ? ['li'] : container.localName === 'tr' ? ['td'] : /^(?:thead|tbody|tfoot)$/.test(container.localName) ? ['tr', 'td'] : container.localName === 'table' ? ['tbody', 'tr', 'td'] : []
  for (const tag of wrappers.reverse()) {
    const wrapper = document.createElement(tag)
    chapterCards.add(wrapper)
    if (tag === 'td') wrapper.setAttribute('colspan', String(Math.max(1, container.querySelector('tr')?.children.length ?? container.children.length)))
    wrapper.append(mount); mount = wrapper
  }
  return mount
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
    for (const body of host.querySelectorAll<HTMLElement>('[inert]')) {
      if (!body.getClientRects().length) continue
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
      result.reading = { element, id: element.id, ...region, top: element.getBoundingClientRect().top, scroll }
    }
  }
  const active = deepestActive(document)
  if (active && composedContains(host, active)) {
    const region = regionFor(host, manifest, active)
    result.focus = { element: active, id: active.id, ...region }
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      result.focus.start = active.selectionStart; result.focus.end = active.selectionEnd; result.focus.direction = active.selectionDirection
    }
  }
  return result
}

export function restoreChapterPosition(position: ChapterPosition, host: HTMLElement, manifest?: ChapterManifest, replacement?: HTMLElement): void {
  const reading = position.reading
  if (reading) {
    const existing = reading.element.isConnected && reading.element.getClientRects().length ? reading.element : null
    const byId = reading.id ? host.querySelector<HTMLElement>('#' + CSS.escape(reading.id)) : null
    const target = existing ?? (byId?.getClientRects().length ? byId : null) ?? replacement ?? regionElement(host, manifest, reading)
    if (target) {
      const bounds = reading.scroll.getBoundingClientRect()
      const top = existing || byId === target ? reading.top : Math.max(bounds.top + (target === replacement ? 16 : 1), reading.top)
      reading.scroll.scrollTop += target.getBoundingClientRect().top - top
    }
  }
  const focus = position.focus
  if (!focus) return
  const original = focus.element.isConnected && focus.element.getClientRects().length ? focus.element as HTMLElement : null
  const byId = focus.id ? host.querySelector<HTMLElement>('#' + CSS.escape(focus.id)) : null
  const target = original ?? (byId?.getClientRects().length ? byId : null) ?? replacement ?? regionElement(host, manifest, focus)
  if (!target || !target.getClientRects().length || target.closest('[inert]')) return
  if (!target.matches('input,textarea,select,button,a,[tabindex]')) target.tabIndex = -1
  target.focus({ preventScroll: true })
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && focus.start !== undefined) {
    try { target.setSelectionRange(focus.start ?? 0, focus.end ?? 0, focus.direction ?? 'none') } catch { /* A new control may have a non-text input type. */ }
  }
}

const activeStates = new Set<Stage>(['queued', 'generating', 'waiting_input', 'waiting_approval', 'assembling', 'publishing', 'unknown'])
const stages: Record<Stage, { title: string; detail: string }> = {
  queued: { title: '更新已排队', detail: '轮到这部分后开始处理，其他内容可继续阅读。' },
  generating: { title: '正在更新内容', detail: '新内容发布后会在这里接替。上一版仍可查看。' },
  waiting_input: { title: '需要补充信息', detail: '请在 Agent 面板补充信息后继续。' },
  waiting_approval: { title: '等待确认', detail: '请检查待处理操作，确认后继续。' },
  assembling: { title: '正在准备新版本', detail: '正在合入已完成的修改，并保留其他内容。' },
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

interface ElementState {
  element: HTMLElement; hidden: boolean; inert: boolean; display: string; displayPriority: string
}
interface InstalledCard {
  range: ContentRange; contents: Node[]; originals: ElementState[]; mount: HTMLElement; element: HTMLElement; update: ChapterUpdate
  originalFocus?: FocusPosition
  status: HTMLElement; title: HTMLElement; detail: HTMLElement; actions: HTMLElement; preview: HTMLElement; prepared: boolean; preparing: boolean
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
  private readonly revisions = new Map<string, ChapterUpdate>()
  private cards = new Map<string, InstalledCard>()
  private guardButtons = new Map<HTMLButtonElement, { disabled: boolean; title: string }>()
  private disposed = false
  private signature = ''
  private readonly hiddenStyle = document.createElement('style')
  constructor(private readonly options: ChapterPresentationOptions) {
    this.hiddenStyle.textContent = '[data-chapter-body-hidden=true]{display:none!important}'
    options.host.getRootNode().appendChild(this.hiddenStyle)
  }

  sync(manifest: ChapterManifest | undefined, updates: ChapterUpdate[] = [], force = false): void {
    updates = updates.map(update => {
      const previous = this.revisions.get(update.update_id)
      if (previous && (previous.scope_revision ?? -1) > (update.scope_revision ?? -1)) return previous
      if (previous?.scope_active === false && (previous.scope_revision ?? 0) > 0 && previous.scope_revision === update.scope_revision && update.scope_active !== false) return previous
      this.revisions.set(update.update_id, structuredClone(update))
      return update
    })
    const signature = JSON.stringify([manifest?.manifest_revision, manifest?.view_revision, manifest?.content_tree?.revision, updates.map(update => [update.update_id, update.scope_revision, update.scope_active, update.state, update.region_ids, update.region_intents, update.tree_operations, update.reason, update.action_id])])
    this.manifest = manifest; this.updates = updates
    if (!force && signature === this.signature) return
    this.signature = signature
    const wanted = new Map<string, StatusScope>()
    const intent = (id: string, update: ChapterUpdate) => update.region_intents.find(item => item.region_id === id)?.intent_revision ?? update.intent_revision
    for (const update of updates.filter(update => update.scope_revision !== 0 && update.scope_active !== false)) for (const id of update.region_ids) {
      const scopes: StatusScope[] = (update.tree_operations ?? []).filter((operation): operation is InsertPlan => (operation.type === 'insert' || operation.type === 'move') && operation.parent_id === id).map(insert => ({ key: gapKey(manifest, insert), id, update, insert }))
      if (!update.tree_operations?.length || update.tree_operations.some(operation => operation.type !== 'insert' && operation.node_ids.includes(id))) scopes.push({ key: id, id, update })
      for (const scope of scopes) {
        const previous = wanted.get(scope.key)
        if (!previous || update.intent_revision > previous.update.intent_revision || update.intent_revision === previous.update.intent_revision && intent(id, update) >= intent(previous.id, previous.update)) wanted.set(scope.key, scope)
      }
    }
    const selected = new Map<string, StatusScope>()
    for (const scope of [...wanted.values()].filter(({ update }) => !['succeeded', 'superseded'].includes(update.state)).sort((left, right) => right.update.intent_revision - left.update.intent_revision || updates.indexOf(right.update) - updates.indexOf(left.update))) {
      if ([...selected.values()].some(other => scopeOverlaps(manifest, scope, other))) continue
      selected.set(scope.key, scope)
    }
    for (const [id, card] of this.cards) {
      const update = selected.get(id)?.update
      if (!update || update.update_id !== card.update.update_id || update.scope_revision !== card.update.scope_revision || activeStates.has(card.update.state) && !activeStates.has(update.state)) this.removeCard(id)
    }
    for (const [key, { id, update, insert }] of selected) {
      const range = insert ? insertionRange(this.options.host, manifest, insert) : contentRange(this.options.host, manifest, id)
      if (!range) continue
      let card = this.cards.get(key)
      if (!card) {
        card = this.createCard(range, update)
        this.cards.set(key, card)
      }
      card.update = update
      this.paint(card)
      if (activeStates.has(update.state) && !card.prepared && !card.preparing) void this.prepare(card)
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
        const id = this.options.host.dataset.view + '-' + behavior.element_id
        if (card.originals.some(({ element }) => element.id === id || element.querySelector('#' + CSS.escape(id)))) return true
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
      button.disabled = true; button.title = '此表单包含正在更新的内容，请等待更新完成'
    }
    for (const [button, previous] of this.guardButtons) if (!blocked.has(button)) {
      button.disabled = previous.disabled; button.title = previous.title; this.guardButtons.delete(button)
    }
  }

  private createCard(range: ContentRange, update: ChapterUpdate): InstalledCard {
    const position = captureChapterPosition(this.options.host, this.manifest)
    const contents = range.inner ? [...range.roots[0]!.childNodes] : []
    const originals = (range.inner ? contents.filter((node): node is HTMLElement => node instanceof HTMLElement) : range.roots).map(element => ({ element, hidden: element.hidden, inert: element.inert, display: element.style.getPropertyValue('display'), displayPriority: element.style.getPropertyPriority('display') }))
    const element = document.createElement('span')
    chapterCards.add(element)
    element.dataset.chapterUpdate = update.update_id
    element.dataset.chapterRegion = range.id
    if (update.scope_revision !== undefined) element.dataset.chapterRevision = String(update.scope_revision)
    element.setAttribute('aria-label', '内容更新')
    const shadow = element.attachShadow({ mode: 'open' })
    const style = document.createElement('style'); style.textContent = cardStyle
    const status = document.createElement('div'); status.className = 'status'; status.tabIndex = -1
    const title = document.createElement('div'); title.className = 'title'; title.setAttribute('role', 'status'); title.setAttribute('aria-live', 'polite'); title.setAttribute('aria-atomic', 'true')
    const detail = document.createElement('p')
    const actions = document.createElement('div'); actions.className = 'actions'
    const preview = document.createElement('div'); preview.className = 'preview'; preview.hidden = true; preview.setAttribute('aria-label', '上一版内容（只读）')
    status.append(title, detail, actions, preview); shadow.append(style, status)
    let mount: HTMLElement = element
    if (range.gap) {
      mount = statusMount(range.gap.container, element)
      range.gap.container.insertBefore(mount, range.gap.before)
    } else if (range.inner) {
      const root = range.roots[0]!
      mount = statusMount(root, element)
      root.append(mount)
    } else range.roots[0]!.before(element)
    restoreChapterPosition(position, this.options.host, this.manifest)
    return { range, contents, originals, mount, element, update, status, title, detail, actions, preview, prepared: false, preparing: false }
  }

  private async prepare(card: InstalledCard): Promise<void> {
    card.preparing = true
    const beforeSave = captureChapterPosition(this.options.host, this.manifest)
    if (beforeSave.focus && rangeContains(card.range, beforeSave.focus.element)) card.originalFocus = beforeSave.focus
    for (const { element } of card.originals) element.inert = true
    try {
      if (!this.options.canPrepare()) throw new Error('输入正在提交或等待核对，正文继续保留。处理完成后可重试。')
      await this.options.save()
      if (this.disposed || !this.cardsHas(card) || !activeStates.has(card.update.state)) return
      const position = captureChapterPosition(this.options.host, this.manifest)
      const active = deepestActive(document)
      const focusWasInside = beforeSave.focus && rangeContains(card.range, beforeSave.focus.element)
      const focusMoved = active && !['HTML', 'BODY'].includes(active.tagName) && active !== applicationHost(this.options.host) && !rangeContains(card.range, active)
      card.prepared = true
      if (card.range.inner) for (const node of card.contents) node.parentNode?.removeChild(node)
      else for (const { element } of card.originals) {
        element.hidden = true; element.dataset.chapterBodyHidden = 'true'; element.style.setProperty('display', 'none', 'important')
      }
      restoreChapterPosition({ reading: position.reading }, this.options.host, this.manifest, card.element)
      if (focusWasInside && !focusMoved) card.status.focus({ preventScroll: true })
      this.paint(card)
    } catch (error) {
      if (this.disposed || !this.cardsHas(card)) return
      for (const original of card.originals) original.element.inert = original.inert
      card.detail.textContent = '输入尚未保存，原正文仍可见。' + String(error).replace(/^Error:\s*/, '')
      card.detail.classList.add('error')
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '保存输入并继续'
      retry.onclick = () => this.sync(this.manifest, this.updates, true)
      card.actions.replaceChildren(retry)
    } finally { card.preparing = false }
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
    if (!card.range.gap) {
      const preview = button(card.preview.hidden ? '查看上一版' : '收起上一版', () => {
        const position = captureChapterPosition(this.options.host, this.manifest)
        if (card.preview.hidden && !card.preview.shadowRoot) this.makePreview(card)
        card.preview.hidden = !card.preview.hidden
        preview.textContent = card.preview.hidden ? '查看上一版' : '收起上一版'; preview.setAttribute('aria-expanded', String(!card.preview.hidden))
        restoreChapterPosition(position, this.options.host, this.manifest)
      })
      preview.setAttribute('aria-expanded', String(!card.preview.hidden))
    }
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
    const clone = (original: Node): Node => {
      const result = original.cloneNode(false)
      if (original instanceof HTMLElement && result instanceof HTMLElement) {
        const previous = card.originals.find(item => item.element === original)
        result.hidden = previous?.hidden ?? original.hidden; result.inert = false
        if (previous) result.style.setProperty('display', previous.display, previous.displayPriority)
        delete result.dataset.chapterBodyHidden
        if (original instanceof HTMLInputElement && result instanceof HTMLInputElement) { result.value = original.value; result.checked = original.checked; result.disabled = true }
        else if (original instanceof HTMLTextAreaElement && result instanceof HTMLTextAreaElement) { result.value = original.value; result.disabled = true }
        if (result instanceof HTMLButtonElement) result.disabled = true
        if (result.matches('[contenteditable],a,[tabindex]')) { result.removeAttribute('contenteditable'); result.tabIndex = -1 }
      }
      for (const child of original.childNodes) if (!(child instanceof Element && chapterCards.has(child))) result.appendChild(clone(child))
      if (original instanceof HTMLSelectElement && result instanceof HTMLSelectElement) {
        for (const [index, option] of [...result.options].entries()) option.selected = original.options[index]?.selected ?? false
        result.disabled = true
      }
      return result
    }
    const fragment = document.createDocumentFragment()
    if (card.range.inner) {
      const root = card.range.roots[0]!.cloneNode(false) as HTMLElement
      root.inert = false
      root.append(...card.contents.map(clone)); fragment.append(root)
    } else fragment.append(...card.range.roots.map(clone))
    let preview: Node = fragment
    for (let parent = card.range.roots[0]?.parentElement; parent && /^(?:ul|ol|menu|table|thead|tbody|tfoot|tr)$/.test(parent.localName); parent = parent.parentElement) {
      const wrapper = parent.cloneNode(false) as HTMLElement
      wrapper.append(preview); preview = wrapper
    }
    host.append(preview); shadow.append(style, host)
    host.addEventListener('click', event => event.preventDefault()); host.addEventListener('submit', event => event.preventDefault())
  }

  private removeCard(id: string): void {
    const card = this.cards.get(id)
    if (!card) return
    const position = captureChapterPosition(this.options.host, this.manifest)
    for (const original of card.originals) {
      original.element.hidden = original.hidden; original.element.inert = original.inert
      if (original.element.dataset.chapterBodyHidden) { delete original.element.dataset.chapterBodyHidden; original.element.style.setProperty('display', original.display, original.displayPriority) }
    }
    if (card.prepared && card.range.inner) for (const node of card.contents) card.range.roots[0]!.insertBefore(node, card.mount)
    const active = deepestActive(document)
    if (card.originalFocus && (position.focus && composedContains(card.element, position.focus.element) || !active || ['HTML', 'BODY'].includes(active.tagName) || active === applicationHost(this.options.host))) position.focus = card.originalFocus
    card.mount.remove(); this.cards.delete(id)
    restoreChapterPosition(position, this.options.host, this.manifest, card.range.roots[0])
  }

  dispose(): void {
    this.disposed = true
    for (const id of this.cards.keys()) this.removeCard(id)
    for (const [button, previous] of this.guardButtons) { button.disabled = previous.disabled; button.title = previous.title }
    this.guardButtons.clear()
    this.hiddenStyle.remove()
  }
}

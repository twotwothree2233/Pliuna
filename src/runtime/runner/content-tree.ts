import { randomUUID } from 'node:crypto'
import { defaultTreeAdapter, html as htmlNamespace, type DefaultTreeAdapterMap } from 'parse5'
import type { ContentLineage, ContentNode, ContentOperation, ContentOperationPlan, ContentTree } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { RUNNER_LIMITS } from './limits'
import { parseContentMarkup as markup, type ContentMarkup as Markup } from './content-markup'

type AstNode = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
type Span = ContentNode['span']
type Kind = ContentNode['kind']
interface Draft { kind: Kind; element?: Element; last?: Element; span: Span; inner: Span; title: string; children: Draft[] }
interface Edit extends Span { text: string; inside: string[]; operation: number; insertion?: boolean }
// Public operations use the generated strict union. Internal validation also
// handles malformed runtime values before accessing variant-specific fields.
interface OperationFields { type: ContentOperation['type']; node_ids?: string[]; parent_id?: string; position?: 'before' | 'after' | 'start' | 'end'; anchor_id?: string; html?: string }
interface Prepared { operation: OperationFields; targets: ContentNode[]; span?: Span; shell: boolean; gap?: ContentGap; context?: Element; edits: Edit[] }

export interface ContentTreeOptions { nextId?: () => string; revision?: number; root_id?: string }
export interface ContentGap {
  parent_id: string
  position: 'before' | 'after' | 'start' | 'end'
  anchor_id?: string
  /** The adjacent node before and after the gap; null denotes the container edge. */
  before_id: string | null
  after_id: string | null
}
export interface ContentOperationScope { node_ids: string[]; gaps: ContentGap[] }
export type ContentTreeBaseline = ContentTree
export interface ContentOperationsInput {
  html: string
  tree: ContentTree
  baseline?: ContentTreeBaseline
  operations: ContentOperation[]
  nextId?: () => string
}
export interface ContentOperationsResult { html: string; tree: ContentTree; changed_ids: string[]; retired_ids: string[] }

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const LAYOUT = new Set(['div', 'main', 'section', 'article', 'header', 'footer', 'aside', 'nav'])
const INERT = new Set(['head', 'style', 'script', 'template', 'link', 'meta', 'title', 'base'])
const ATOMIC = new Set(['form', 'fieldset', 'details', 'iframe', 'canvas', 'audio', 'video', 'object'])
const BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'menu', 'table', 'div', 'main', 'section', 'article', 'blockquote', 'pre', 'figure', 'img', 'picture', 'svg', 'math', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const fail = (code: string, message: string): never => { throw new ContractError(code, message) }
const invalid = (message: string): never => fail('CONTENT_STRUCTURE_INVALID', message)
const element = (node: AstNode): node is Element => 'tagName' in node
const children = (node: AstNode): AstNode[] => 'childNodes' in node ? node.childNodes : []
const plain = (node: AstNode): string => node.nodeName === '#text' && 'value' in node ? node.value : children(node).map(plain).join('')
const significant = (node: AstNode): boolean => element(node) ? !INERT.has(node.tagName) : node.nodeName === '#text' && !!plain(node).trim()
const encloses = (outer: Span, inner: Span): boolean => outer.start <= inner.start && outer.end >= inner.end
const sameSpan = (left: Span, right: Span): boolean => left.start === right.start && left.end === right.end
const overlaps = (left: Span, right: Span): boolean => left.start < right.end && right.start < left.end
const heading = (node: Element): number => /^h[1-6]$/.test(node.tagName) ? Number(node.tagName[1]) : 0
function boundedTitle(value: string): string {
  let result = '', bytes = 0
  for (const point of value) { const size = Buffer.byteLength(point, 'utf8'); if (bytes + size > RUNNER_LIMITS.index.title_bytes) break; result += point; bytes += size }
  return result
}

function sourceSpan(node: AstNode): Span | undefined {
  if (!('sourceCodeLocation' in node) || !node.sourceCodeLocation) return undefined
  return { start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset }
}
function innerSpan(node: Element): Span | undefined {
  const location = node.sourceCodeLocation
  if (!location?.startTag) return undefined
  return { start: location.startTag.endOffset, end: location.endTag?.startOffset ?? location.endOffset }
}
function complete(node: Element): boolean {
  const location = node.sourceCodeLocation
  if (!location?.startTag || (!location.endTag && !VOID.has(node.tagName) && node.namespaceURI === 'http://www.w3.org/1999/xhtml')) return false
  const span = sourceSpan(node)!
  let previous = span.start
  for (const child of children(node)) {
    const range = sourceSpan(child)
    if (range && (!encloses(span, range) || range.start < previous)) return false
    if (range) previous = range.end
  }
  return true
}
function selector(markup: Markup, node: Element): string {
  const identity = node.attrs.find(attr => attr.name === 'id')?.value
  if (identity && /^[A-Za-z][\w-]*$/.test(identity) && markup.identities.get(identity) === 1) return '#' + identity
  const path: string[] = []
  let current = node
  while (current.parentNode && 'childNodes' in current.parentNode) {
    const tag = markup.document && ['html', 'head', 'body'].includes(current.tagName) ? 'div' : current.tagName
    path.unshift(`${tag}:nth-child(${markup.positions.get(current)})`)
    if (current.parentNode === markup.root) return ':scope > ' + path.join(' > ')
    if (!element(current.parentNode)) break
    current = current.parentNode
  }
  return invalid('Content boundaries must be inside the rendered source')
}
function formula(node: Element): boolean {
  return node.tagName === 'math' || node.attrs.some(attr => attr.name === 'role' && attr.value === 'math' || attr.name === 'class' && /(?:^|\s)(?:katex(?:-display)?|MathJax|math(?:-display)?|formula)(?:\s|$)/.test(attr.value))
}
function draft(kind: Kind, node: Element, nested: Draft[] = []): Draft {
  const span = sourceSpan(node) ?? invalid('Content has no complete source boundary')
  return { kind, element: node, last: node, span, inner: innerSpan(node) ?? span, title: '', children: nested }
}

/** Parse semantic source ranges without inserting wrappers or serializing the source. */
function parseDrafts(markup: Markup): { nodes: Draft[]; inner: Span } {
  const sequence = (source: AstNode[]): Draft[] => {
    const visible = source.filter(significant)
    if (!visible.length) return []
    // Bare text and repaired descendants have no independent complete element.
    // Their closest complete ancestor remains one editable block.
    if (visible.some(node => !element(node) || !complete(node))) return []
    const result: Draft[] = [], stack: { level: number; value: Draft }[] = []
    for (const ast of visible as Element[]) {
      const span = sourceSpan(ast)
      if (!span) continue
      const level = heading(ast)
      if (level) {
        if (!complete(ast)) return []
        while (stack.length && stack.at(-1)!.level >= level) stack.pop()
        const section = draft('section', ast)
        section.title = boundedTitle(plain(ast).trim())
        section.inner = { start: span.end, end: span.end }
        ;(stack.at(-1)?.value.children ?? result).push(section)
        stack.push({ level, value: section })
      } else {
        const values = semantic(ast)
        ;(stack.at(-1)?.value.children ?? result).push(...values)
      }
      for (const entry of stack) {
        entry.value.last = ast
        entry.value.span.end = span.end
        entry.value.inner.end = span.end
      }
    }
    return result
  }
  const nested = (node: Element): Draft[] => {
    const source = ['li', 'td', 'th', 'blockquote'].includes(node.tagName) ? children(node).filter(child => element(child) && (BLOCK_TAGS.has(child.tagName) || formula(child))) : children(node)
    const values = sequence(source)
    return values.every(item => encloses(sourceSpan(node)!, item.span)) ? values : []
  }
  const semantic = (node: Element): Draft[] => {
    if (INERT.has(node.tagName)) return []
    if (!complete(node)) return [draft('block', node)]
    if (formula(node)) return [draft('formula', node)]
    if (node.tagName === 'pre' || node.tagName === 'code') return [draft('code', node)]
    if (['img', 'picture', 'svg', 'figure'].includes(node.tagName)) return [draft('image', node)]
    if (node.tagName === 'p') return [draft('paragraph', node)]
    if (['ul', 'ol', 'menu'].includes(node.tagName)) return [draft('list', node, nested(node))]
    if (node.tagName === 'li') return [draft('list_item', node, nested(node))]
    if (node.tagName === 'table') return [draft('table', node, tableChildren(node))]
    if (['thead', 'tbody', 'tfoot'].includes(node.tagName)) return nested(node)
    if (node.tagName === 'tr') return [draft('row', node, nested(node))]
    if (['td', 'th'].includes(node.tagName)) return [draft('cell', node, nested(node))]
    if (ATOMIC.has(node.tagName)) return [draft('block', node)]
    if (LAYOUT.has(node.tagName)) {
      const values = nested(node)
      return values.length ? values : [draft('block', node)]
    }
    return [draft('block', node, nested(node))]
  }
  const tableChildren = (node: Element): Draft[] => {
    const result: Draft[] = []
    for (const child of children(node).filter(element)) {
      if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) {
        for (const row of children(child).filter(element)) {
          if (row.tagName === 'tr' && complete(row)) result.push(draft('row', row, nested(row)))
          else return []
        }
      } else if (child.tagName === 'tr' && complete(child)) result.push(draft('row', child, nested(child)))
      else if (sourceSpan(child)) result.push(draft('block', child))
    }
    return result
  }
  const body = markup.document ? markup.elements.find(node => node.tagName === 'body') : undefined
  const source = body ?? markup.root
  const bodyChildren = children(source).filter(significant), located = bodyChildren.map(sourceSpan).filter((span): span is Span => !!span)
  const inner = body ? innerSpan(body) ?? (located.length ? { start: Math.min(...located.map(span => span.start)), end: Math.max(...located.map(span => span.end)) } : { start: 0, end: markup.html.length }) : { start: 0, end: markup.html.length }
  const nodes = sequence(children(source))
  if (nodes.length) return { nodes, inner }
  if (!children(source).some(significant)) return { nodes: [], inner }
  return { nodes: [{ kind: 'block', span: inner, inner, title: '', children: [] }], inner }
}

export function buildContentTree(html: string, options: ContentTreeOptions = {}): ContentTree {
  const parsed = markup(html), structure = parseDrafts(parsed), used = new Set<string>()
  const fresh = (): string => {
    const id = options.nextId?.() ?? `node-${randomUUID()}`
    if (!id || used.has(id)) return fail('CONTENT_ID_INVALID', 'Content identities must be nonempty and unique')
    used.add(id); return id
  }
  const root_id = options.root_id ?? fresh()
  used.add(root_id)
  const nodes: ContentNode[] = [{ node_id: root_id, parent_id: null, kind: 'document', revision: 1, position_revision: 1, title: '', children: [], selector: ':scope', end_selector: ':scope', tag: '', span: { start: 0, end: html.length }, inner_span: structure.inner }]
  const add = (value: Draft, parent: ContentNode): void => {
    const node: ContentNode = {
      node_id: fresh(), parent_id: parent.node_id, kind: value.kind, revision: 1, position_revision: 1,
      title: value.title, children: [], selector: value.element ? selector(parsed, value.element) : ':scope',
      end_selector: value.last ? selector(parsed, value.last) : ':scope', tag: value.element?.tagName ?? '', span: value.span, inner_span: value.inner
    }
    parent.children.push(node.node_id); nodes.push(node)
    value.children.forEach(child => add(child, node))
  }
  structure.nodes.forEach(value => add(value, nodes[0]!))
  const tree: ContentTree = { version: 1, revision: options.revision ?? 1, root_id, nodes, lineage: [] }
  assertTree(tree, html)
  return tree
}

export function contentNode(tree: ContentTree, id: string): ContentNode {
  const node = tree.nodes.find(node => node.node_id === id)
  if (node) return node
  const history = [...tree.lineage].reverse().find(item => item.previous_node_id === id)
  return fail(history ? 'CONTENT_NODE_RETIRED' : 'CONTENT_NODE_NOT_FOUND', history ? `Content node is retired; query its recorded successors: ${history.successor_node_ids.join(', ') || '(deleted)'}` : 'Content node does not exist in this snapshot')
}
function ancestors(tree: ContentTree, id: string): string[] {
  const values: string[] = [], seen = new Set<string>()
  let node: ContentNode | undefined = contentNode(tree, id)
  while (node) {
    if (seen.has(node.node_id)) return invalid('Content parent relationships contain a cycle')
    seen.add(node.node_id); values.push(node.node_id)
    node = node.parent_id ? contentNode(tree, node.parent_id) : undefined
  }
  return values
}
export function contentScopeOverlaps(tree: ContentTree, leftIds: readonly string[], rightIds: readonly string[]): boolean {
  return leftIds.some(left => rightIds.some(right => left === right || ancestors(tree, left).includes(right) || ancestors(tree, right).includes(left)))
}
function descendants(tree: ContentTree, id: string): ContentNode[] {
  const node = contentNode(tree, id)
  return [node, ...node.children.flatMap(child => descendants(tree, child))]
}
function gap(tree: ContentTree, operation: OperationFields): ContentGap {
  if (!operation.parent_id || !operation.position) return fail('CONTENT_OPERATION_INVALID', 'Structural operations require a parent and an exact position')
  const parent = contentNode(tree, operation.parent_id)
  if (!['document', 'section', 'list', 'list_item', 'table', 'row', 'cell', 'block'].includes(parent.kind)) return fail('CONTENT_CONTAINER_INVALID', 'This node cannot contain independent blocks; replace the node instead')
  const removed = operation.type === 'move' ? new Set(operation.node_ids ?? []) : new Set<string>()
  const siblings = parent.children.filter(id => !removed.has(id))
  let offset: number
  if (operation.position === 'start' || operation.position === 'end') {
    if (operation.anchor_id !== undefined) return fail('CONTENT_OPERATION_INVALID', 'Container edge positions do not accept an anchor')
    offset = operation.position === 'start' ? 0 : siblings.length
  } else {
    if (!operation.anchor_id || removed.has(operation.anchor_id)) return fail('CONTENT_ANCHOR_INVALID', 'Before and after positions require a separate live anchor')
    const anchor = contentNode(tree, operation.anchor_id), index = siblings.indexOf(anchor.node_id)
    if (anchor.parent_id !== parent.node_id || index < 0) return fail('CONTENT_ANCHOR_INVALID', 'The anchor must be an immediate child of the requested container')
    offset = index + (operation.position === 'after' ? 1 : 0)
  }
  return { parent_id: parent.node_id, position: operation.position, ...(operation.anchor_id ? { anchor_id: operation.anchor_id } : {}), before_id: siblings[offset - 1] ?? null, after_id: siblings[offset] ?? null }
}
export function contentOperationScope(tree: ContentTree, operations: readonly ContentOperationPlan[]): ContentOperationScope {
  const fields: readonly OperationFields[] = operations
  return { node_ids: [...new Set(fields.flatMap(operation => operation.node_ids ?? []))], gaps: fields.filter(operation => operation.type === 'insert' || operation.type === 'move').map(operation => gap(tree, operation)) }
}

function assertTree(tree: ContentTree, html: string): void {
  const indexed = new Map(tree.nodes.map(node => [node.node_id, node]))
  if (indexed.size !== tree.nodes.length || !indexed.has(tree.root_id)) return invalid('Content snapshot identities are invalid')
  const root = indexed.get(tree.root_id)!
  if (root.parent_id !== null || root.kind !== 'document' || root.span.start !== 0 || root.span.end !== html.length) return invalid('Content snapshot does not match the source boundary')
  for (const node of tree.nodes) {
    if (node.span.start < 0 || node.span.end < node.span.start || node.span.end > html.length || !encloses(node.span, node.inner_span)) return invalid('Content source ranges are invalid')
    if (node.node_id !== root.node_id && !node.parent_id) return invalid('Content has an orphan node')
    if (node.parent_id && !indexed.get(node.parent_id)?.children.includes(node.node_id)) return invalid('Content parent and child relationships differ')
    let previous = node.span.start
    for (const id of node.children) {
      const child = indexed.get(id)
      if (!child || child.parent_id !== node.node_id || !encloses(node.span, child.span) || child.span.start < previous) return invalid('Content children must be contained and ordered without crossing')
      previous = child.span.end
    }
  }
  const reached = new Set<string>(), pending = [tree.root_id]
  while (pending.length) {
    const id = pending.pop()!
    if (reached.has(id)) return invalid('Content parent relationships contain a cycle or repeated child')
    reached.add(id); pending.push(...indexed.get(id)!.children)
  }
  if (reached.size !== tree.nodes.length) return invalid('Content snapshot contains unreachable nodes')
}
function assertBaseline(latest: ContentTree, baseline: ContentTree, operations: OperationFields[]): void {
  for (const operation of operations) {
    for (const id of operation.node_ids ?? []) {
      const previous = contentNode(baseline, id), current = contentNode(latest, id)
      if (previous.revision !== current.revision || previous.position_revision !== current.position_revision || previous.parent_id !== current.parent_id) return fail('CONTENT_BASELINE_STALE', 'The target content or its original position has changed; read the current node before editing')
    }
    if (operation.type === 'insert' || operation.type === 'move') {
      const before = gap(baseline, operation), after = gap(latest, operation)
      const oldParent = contentNode(baseline, before.parent_id), parent = contentNode(latest, after.parent_id)
      if (before.before_id !== after.before_id || before.after_id !== after.after_id || oldParent.position_revision !== parent.position_revision || oldParent.kind !== parent.kind || oldParent.tag !== parent.tag) return fail('CONTENT_POSITION_STALE', 'The requested insertion gap or destination container has changed')
    }
  }
}
function astFor(parsed: Markup, node: ContentNode): Element | undefined {
  return parsed.elements.find(item => sourceSpan(item)?.start === node.span.start && (node.kind === 'section' ? heading(item) > 0 : sourceSpan(item)?.end === node.span.end))
}
function contextElement(tag: string): Element { return defaultTreeAdapter.createElement(tag, htmlNamespace.NS.HTML, []) }
function containerFor(parsed: Markup, tree: ContentTree, node: ContentNode): Element {
  const ast = astFor(parsed, node)
  if (node.kind === 'document') return parsed.elements.find(item => item.tagName === 'body') ?? contextElement('div')
  if (node.kind === 'section') return ast?.parentNode && element(ast.parentNode) ? ast.parentNode : contextElement('div')
  return ast ?? fail('CONTENT_CONTAINER_INVALID', 'A conservative text block can only be replaced as a whole')
}
function validFragment(html: string, context: Element): void {
  const parsed = markup(html, context)
  if (/<\s*(?:html|head|body|!doctype)\b/i.test(html)) return fail('CONTENT_FRAGMENT_INVALID', 'Use a body fragment for a local content operation')
  if (parsed.elements.some(node => sourceSpan(node) && !complete(node))) return fail('CONTENT_FRAGMENT_INVALID', 'The fragment requires parser repairs; submit complete elements for this container')
  let previous = 0
  for (const child of children(parsed.root)) {
    const span = sourceSpan(child)
    if (!span) {
      if (element(child) && !['tbody', 'colgroup'].includes(child.tagName)) return fail('CONTENT_FRAGMENT_INVALID', 'The fragment creates an implicit outer container')
      continue
    }
    if (span.start < previous || html.slice(previous, span.start).trim()) return fail('CONTENT_FRAGMENT_INVALID', 'The parser moved or discarded fragment content outside the intended range')
    previous = span.end
  }
  // Synthetic table wrappers carry no source span, but their descendants do.
  const intervals = children(parsed.root).flatMap(child => sourceSpan(child) ? [sourceSpan(child)!] : children(child).flatMap(item => sourceSpan(item) ? [sourceSpan(item)!] : []))
  if (intervals.length) {
    previous = 0
    for (const span of intervals) {
      if (span.start < previous || html.slice(previous, span.start).trim()) return fail('CONTENT_FRAGMENT_INVALID', 'The fragment is not a complete contiguous range in its container')
      previous = span.end
    }
  }
  if (html.slice(previous).trim()) return fail('CONTENT_FRAGMENT_INVALID', 'The container does not accept this fragment')
  const top = children(parsed.root).filter(node => significant(node))
  const tags: Record<string, string[]> = { ul: ['li'], ol: ['li'], menu: ['li'], table: ['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr'], thead: ['tr'], tbody: ['tr'], tfoot: ['tr'], tr: ['td', 'th'], select: ['option', 'optgroup'] }
  if (tags[context.tagName] && top.some(node => !element(node) || !tags[context.tagName]!.includes(node.tagName))) return fail('CONTENT_CONTAINER_INVALID', `The ${context.tagName} container requires ${tags[context.tagName]!.join(' or ')} elements`)
}
function targetGroup(tree: ContentTree, operation: OperationFields): ContentNode[] {
  const ids = operation.node_ids ?? []
  if (!ids.length || new Set(ids).size !== ids.length) return fail('CONTENT_OPERATION_INVALID', 'The operation requires unique explicit target nodes')
  const nodes = ids.map(id => contentNode(tree, id))
  if (operation.type === 'move' && nodes.length !== 1) return fail('CONTENT_OPERATION_INVALID', 'A move requires exactly one source node')
  if (nodes.length > 1) {
    const parent = nodes[0]!.parent_id
    if (!parent || nodes.some(node => node.parent_id !== parent)) return fail('CONTENT_RANGE_INVALID', 'A single operation requires siblings with the same parent')
    const siblings = contentNode(tree, parent).children, offsets = nodes.map(node => siblings.indexOf(node.node_id)).sort((left, right) => left - right)
    if (offsets.some((offset, index) => offset !== offsets[0]! + index)) return fail('CONTENT_RANGE_INVALID', 'Use separate operations for noncontiguous targets')
  }
  return nodes.sort((left, right) => left.span.start - right.span.start)
}
function insertionPoint(parsed: Markup, tree: ContentTree, operation: OperationFields): { offset: number; context: Element } {
  const parent = contentNode(tree, operation.parent_id!), container = containerFor(parsed, tree, parent)
  if (operation.position === 'before' || operation.position === 'after') {
    const anchor = contentNode(tree, operation.anchor_id!), ast = astFor(parsed, anchor)
    const context = ast?.parentNode && element(ast.parentNode) ? ast.parentNode : container
    return { offset: operation.position === 'before' ? anchor.span.start : anchor.span.end, context }
  }
  return { offset: operation.position === 'start' ? parent.inner_span.start : parent.inner_span.end, context: container }
}
function prepare(html: string, tree: ContentTree, parsed: Markup, operation: OperationFields, index: number): Prepared {
  if (!['replace', 'insert', 'delete', 'move'].includes(operation.type)) return fail('CONTENT_OPERATION_INVALID', 'Unknown content operation')
  const targets = operation.type === 'insert' ? [] : targetGroup(tree, operation)
  if (operation.type !== 'insert' && operation.type !== 'move' && (operation.parent_id !== undefined || operation.position !== undefined || operation.anchor_id !== undefined)) return fail('CONTENT_OPERATION_INVALID', 'Only insertion and move operations accept a destination')
  if (operation.type === 'insert' && operation.node_ids?.length) return fail('CONTENT_OPERATION_INVALID', 'Insertion does not accept source targets')
  if (operation.type === 'replace' || operation.type === 'insert') {
    if (typeof operation.html !== 'string' || !operation.html.trim()) return fail('CONTENT_OPERATION_INVALID', 'Content writes require a nonempty HTML fragment; use delete to remove nodes')
  } else if (operation.html !== undefined) return fail('CONTENT_OPERATION_INVALID', 'Delete and move do not accept replacement HTML')
  if (targets.some(node => node.kind === 'document') && operation.type !== 'replace') return fail('CONTENT_OPERATION_INVALID', 'The document root can only be replaced')
  const prepared: Prepared = { operation, targets, shell: false, edits: [] }
  if (targets.length) {
    const first = targets[0]!, last = targets.at(-1)!
    prepared.span = { start: first.span.start, end: last.span.end }
    if (targets.length > 1) {
      const sourceParents = targets.map(node => astFor(parsed, node)?.parentNode)
      if (sourceParents.some(parent => parent !== sourceParents[0])) return fail('CONTENT_RANGE_INVALID', 'The selected nodes cross actual HTML containers')
    }
    if (operation.type === 'replace') {
      const ast = astFor(parsed, first)
      const shellTag = first.kind === 'cell' ? '(?:td|th)' : first.tag
      if (targets.length === 1 && ['list_item', 'cell'].includes(first.kind) && ast && !new RegExp(`^\\s*<${shellTag}(?:\\s|>)`, 'i').test(operation.html!)) {
        prepared.shell = true; prepared.span = first.inner_span; prepared.context = ast
      } else prepared.context = ast?.parentNode && element(ast.parentNode) ? ast.parentNode : contextElement('div')
      if (first.kind !== 'document') validFragment(operation.html!, prepared.context)
    }
    const inside = first.parent_id ? ancestors(tree, first.parent_id) : []
    if (prepared.shell) inside.unshift(first.node_id)
    prepared.edits.push({ ...prepared.span, text: operation.type === 'replace' ? operation.html! : '', inside, operation: index })
  }
  if (operation.type === 'insert' || operation.type === 'move') {
    prepared.gap = gap(tree, operation)
    if (operation.type === 'move' && contentScopeOverlaps(tree, targets.map(node => node.node_id), [operation.parent_id!]) && ancestors(tree, operation.parent_id!).includes(targets[0]!.node_id)) return fail('CONTENT_MOVE_CYCLE', 'A node cannot be moved into itself or its descendants')
    const point = insertionPoint(parsed, tree, operation)
    const text = operation.type === 'insert' ? operation.html! : html.slice(prepared.span!.start, prepared.span!.end)
    validFragment(text, point.context)
    prepared.edits.push({ start: point.offset, end: point.offset, text, inside: ancestors(tree, operation.parent_id!), operation: index, insertion: true })
  }
  return prepared
}
function assertDisjoint(tree: ContentTree, prepared: Prepared[]): void {
  for (let index = 0; index < prepared.length; index++) {
    const left = prepared[index]!
    if (left.targets.some((node, offset) => left.targets.slice(offset + 1).some(other => contentScopeOverlaps(tree, [node.node_id], [other.node_id])))) return fail('CONTENT_RANGE_OVERLAP', 'A content operation cannot target both an ancestor and its descendant')
    for (const right of prepared.slice(index + 1)) {
      const a = left.targets.map(node => node.node_id), b = right.targets.map(node => node.node_id)
      if (contentScopeOverlaps(tree, a, b)) return fail('CONTENT_RANGE_OVERLAP', 'Operations in one atomic update must not cover the same subtree')
      if (left.gap && right.gap && left.gap.parent_id === right.gap.parent_id && left.gap.before_id === right.gap.before_id && left.gap.after_id === right.gap.after_id) return fail('CONTENT_POSITION_OVERLAP', 'Two operations cannot write the same insertion gap')
      for (const [targetIds, point] of [[a, right.gap], [b, left.gap]] as const) {
        if (point && (targetIds.some(id => ancestors(tree, point.parent_id).includes(id)) || point.anchor_id && contentScopeOverlaps(tree, targetIds, [point.anchor_id]))) return fail('CONTENT_RANGE_OVERLAP', 'An operation cannot remove another operation\'s container or anchor')
      }
    }
  }
}
function applyEdits(html: string, edits: Edit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start || right.end - left.end)
  let boundary = html.length
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end > boundary || edit.end < edit.start) return fail('CONTENT_RANGE_OVERLAP', 'Content source edits overlap or exceed their source')
    html = html.slice(0, edit.start) + edit.text + html.slice(edit.end)
    boundary = edit.start
  }
  return html
}
function shifted(span: Span, id: string, edits: Edit[]): Span {
  let start = span.start, end = span.end
  for (const edit of edits) {
    const delta = edit.text.length - (edit.end - edit.start), insertion = edit.start === edit.end
    if (edit.end < span.start || edit.end === span.start && (!insertion || !edit.inside.includes(id))) start += delta
    if (edit.end < span.end || edit.end === span.end && (!insertion || edit.inside.includes(id))) end += delta
  }
  return { start, end }
}
function finalEditStart(edit: Edit, edits: Edit[]): number {
  // An insertion at a replacement's start precedes its replacement bytes.
  return edit.start + edits.filter(other => other !== edit && (other.end < edit.start || other.end === edit.start && (other.start !== other.end || edit.start !== edit.end))).reduce((sum, other) => sum + other.text.length - (other.end - other.start), 0)
}
function topWithin(tree: ContentTree, span: Span, includeDocument = false): ContentNode[] {
  return tree.nodes.filter(node => (includeDocument || node.kind !== 'document') && encloses(span, node.span) && !tree.nodes.some(parent => parent.node_id === node.parent_id && (includeDocument || parent.kind !== 'document') && encloses(span, parent.span)))
}

/** Apply a complete operation group against the latest source, preserving every byte outside its ranges. */
export function applyContentOperations(input: ContentOperationsInput): ContentOperationsResult {
  const { html, tree } = input
  const operations: OperationFields[] = input.operations
  if (!operations.length) return fail('CONTENT_OPERATION_INVALID', 'An update requires at least one content operation')
  assertTree(tree, html)
  if (input.baseline) assertBaseline(tree, input.baseline, operations)
  const parsed = markup(html), prepared = operations.map((operation, index) => prepare(html, tree, parsed, operation, index))
  assertDisjoint(tree, prepared)
  const edits = prepared.flatMap(item => item.edits), updated = applyEdits(html, edits)
  const oldIds = new Set([...tree.nodes.map(node => node.node_id), ...tree.lineage.map(item => item.previous_node_id)])
  const fresh = (): string => {
    const id = input.nextId?.() ?? `node-${randomUUID()}`
    if (oldIds.has(id)) return fail('CONTENT_ID_INVALID', 'A retired or existing content identity cannot be reused for a new node')
    oldIds.add(id); return id
  }
  const next = buildContentTree(updated, { nextId: fresh, revision: tree.revision + 1 })
  const assigned = new Map<string, ContentNode>(), retired = new Set<string>(), touched = new Set<string>(), moved = new Set<string>()
  const match = (node: ContentNode, span: Span, looseSection = false): ContentNode | undefined => next.nodes.find(candidate => !assigned.has(candidate.node_id) && candidate.kind === node.kind && candidate.tag === node.tag && (sameSpan(candidate.span, span) || looseSection && candidate.kind === 'section' && candidate.span.start === span.start))
  const keep = (old: ContentNode, candidate: ContentNode): void => { assigned.set(candidate.node_id, old) }
  for (const item of prepared) {
    if (item.operation.type === 'move') {
      const source = item.targets[0]!, insertion = item.edits.find(edit => edit.insertion)!, start = finalEditStart(insertion, edits)
      for (const old of descendants(tree, source.node_id)) {
        const range = { start: start + old.span.start - source.span.start, end: start + old.span.end - source.span.start }, candidate = match(old, range)
        if (!candidate) return fail('CONTENT_FRAGMENT_INVALID', 'The destination changes the moved subtree; use an explicit replacement instead')
        keep(old, candidate)
      }
      moved.add(source.node_id)
    } else if (item.operation.type !== 'insert') {
      for (const target of item.targets) descendants(tree, target.node_id).forEach(node => retired.add(node.node_id))
      if (item.operation.type === 'replace' && item.targets.length === 1) {
        const target = item.targets[0]!
        if (item.shell) {
          const candidate = match(target, shifted(target.span, target.node_id, edits))
          if (!candidate) return fail('CONTENT_FRAGMENT_INVALID', 'The fragment escaped its protected list item or cell')
          keep(target, candidate); retired.delete(target.node_id); touched.add(target.node_id)
        } else {
          const edit = item.edits[0]!, start = finalEditStart(edit, edits), end = start + edit.text.length
          const candidates = topWithin(next, { start, end }, target.kind === 'document')
          if (candidates.length === 1 && candidates[0]!.kind === target.kind) {
            keep(target, candidates[0]!); retired.delete(target.node_id); touched.add(target.node_id)
          }
        }
      }
    }
    for (const edit of item.edits) edit.inside.forEach(id => touched.add(id))
  }
  for (const old of tree.nodes) {
    if (retired.has(old.node_id) || [...assigned.values()].some(node => node.node_id === old.node_id)) continue
    const candidate = old.node_id === tree.root_id ? contentNode(next, next.root_id) : match(old, shifted(old.span, old.node_id, edits), old.kind === 'section')
    if (!candidate) return fail('CONTENT_FRAGMENT_INVALID', 'The fragment changes content outside the authorized source ranges')
    keep(old, candidate)
  }
  const identities = new Map(next.nodes.map(node => [node.node_id, assigned.get(node.node_id)?.node_id ?? node.node_id]))
  // Structural placement is checked after parsing, including virtual heading sections.
  for (const item of prepared) {
    if (item.operation.type === 'move') {
      const old = item.targets[0]!, candidate = next.nodes.find(node => assigned.get(node.node_id)?.node_id === old.node_id)!
      if (candidate.parent_id === null || identities.get(candidate.parent_id) !== item.operation.parent_id) return fail('CONTENT_CONTAINER_INVALID', 'The moved heading or block would belong to a different semantic container')
    } else if (item.operation.type === 'insert' || item.operation.type === 'replace') {
      const edit = item.edits.find(edit => item.operation.type === 'insert' ? edit.insertion : !edit.insertion)!, start = finalEditStart(edit, edits), end = start + edit.text.length
      const expected = item.operation.type === 'insert' ? item.operation.parent_id! : item.shell ? item.targets[0]!.node_id : item.targets[0]!.parent_id
      const inserted = topWithin(next, { start, end }, item.targets[0]?.kind === 'document')
      if (inserted.some(node => (node.parent_id === null ? null : identities.get(node.parent_id)) !== expected)) return fail('CONTENT_CONTAINER_INVALID', 'The fragment would belong to a different semantic container; select the containing range explicitly')
    }
  }
  for (const node of next.nodes) {
    const old = assigned.get(node.node_id), parent = node.parent_id === null ? null : identities.get(node.parent_id)!
    if (old && old.parent_id !== parent && !moved.has(old.node_id)) return fail('CONTENT_FRAGMENT_INVALID', 'The fragment reparents content outside the authorized range')
  }
  next.nodes = next.nodes.map(node => {
    const old = assigned.get(node.node_id), parent_id = node.parent_id === null ? null : identities.get(node.parent_id)!
    return { ...node, node_id: identities.get(node.node_id)!, parent_id, children: node.children.map(id => identities.get(id)!), revision: old ? old.revision + (touched.has(old.node_id) ? 1 : 0) : 1, position_revision: old ? old.position_revision + (moved.has(old.node_id) || old.parent_id !== parent_id ? 1 : 0) : 1 }
  })
  next.root_id = identities.get(next.root_id)!
  const lineage: ContentLineage[] = []
  for (const item of prepared.filter(item => item.operation.type === 'replace' || item.operation.type === 'delete')) {
    const edit = item.edits[0]!, start = finalEditStart(edit, edits), end = start + edit.text.length
    const replacement = item.operation.type === 'delete' ? [] : topWithin(next, { start, end })
    const successors = replacement.map(node => node.node_id)
    const selected = item.targets.map(node => node.node_id)
    for (const target of item.targets.flatMap(node => descendants(tree, node.node_id))) {
      if (!retired.has(target.node_id)) continue
      const reason: ContentLineage['reason'] = !successors.length ? 'deleted' : selected.includes(target.node_id) && selected.length > 1 && successors.length === 1 ? 'merge' : selected.includes(target.node_id) && selected.length === 1 && successors.length > 1 ? 'split' : 'replaced'
      lineage.push({ previous_node_id: target.node_id, successor_node_ids: successors, revision: next.revision, reason })
    }
  }
  next.lineage = [...tree.lineage, ...lineage]
  assertTree(next, updated)
  return { html: updated, tree: next, changed_ids: next.nodes.filter(node => !tree.nodes.some(old => old.node_id === node.node_id && old.revision === node.revision && old.position_revision === node.position_revision)).map(node => node.node_id), retired_ids: [...retired] }
}

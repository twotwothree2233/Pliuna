import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import * as css from 'css-tree'
import { randomUUID } from 'node:crypto'
import type { Bundle, ChapterDependency, ChapterManifest, ChapterRegion } from '../../shared/contracts.generated'
import defaults from '../../shared/contracts/development-defaults.json'
import { ContractError, validateBundle } from '../../shared/validation'
import { localResourceName } from '../../shared/branding'
import { checkBundle } from '../managed'
import { checkExportFragments } from '../export-fragments'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
interface Span { start: number; end: number }
interface Markup { root: Node; elements: Element[]; ids: Map<string, Element>; document: boolean }
interface RegionNodes { region: ChapterRegion; title: Element; body: Element; span: Span }
interface Edit extends Span { text: string }
interface CssEntry { text: string; raw: string; span: Span; selectors: string[]; local: boolean }
type ChapterOwnership = ChapterRegion['ownership']

function fail(code: string, message: string): never { throw new ContractError(code, message) }
function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) fail('CHAPTER_MAPPING_INVALID', `Duplicate ${name}`)
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function id(element: Element): string | undefined { return element.attrs.find(attr => attr.name === 'id')?.value }
function text(node: Node): string {
  if ('value' in node && node.nodeName === '#text') return node.value
  return 'childNodes' in node ? node.childNodes.map(text).join('') : ''
}
function span(element: Element): Span {
  const location = element.sourceCodeLocation
  if (!location || !location.startTag || !location.endTag) fail('CHAPTER_MAPPING_INVALID', 'Chapter boundaries require explicit complete elements')
  return { start: location.startOffset, end: location.endOffset }
}
function inside(node: Node, parent: Element): boolean {
  let current: Node | null = node
  while (current) {
    if (current === parent) return true
    current = 'parentNode' in current ? current.parentNode : null
  }
  return false
}
function index(html: string): Markup {
  const document = /<!doctype\s|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html)
  const root = document
    ? parse(html, { sourceCodeLocationInfo: true }) : parseFragment(html, { sourceCodeLocationInfo: true })
  const elements: Element[] = [], ids = new Map<string, Element>()
  function visit(node: Node): void {
    if ('tagName' in node) {
      elements.push(node)
      const value = id(node)
      if (value) {
        if (!/^[A-Za-z][\w-]*$/.test(value) || ids.has(value)) fail('CHAPTER_MAPPING_INVALID', 'Markup contains duplicate or invalid stable element identities')
        ids.set(value, node)
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child)
  }
  visit(root)
  return { root, elements, ids, document }
}
function renderedTag(markup: Markup, element: Element): string { return markup.document && ['html', 'head', 'body'].includes(element.tagName) ? 'div' : element.tagName }
function selectorFor(markup: Markup, element: Element): string {
  const identity = id(element)
  if (identity) return '#' + identity
  const path: string[] = []
  let current = element
  while (current.parentNode && 'childNodes' in current.parentNode) {
    const siblings = current.parentNode.childNodes.filter((node): node is Element => 'tagName' in node)
    path.unshift(`${renderedTag(markup, current)}:nth-child(${siblings.indexOf(current) + 1})`)
    if (current.parentNode === markup.root) return ':scope > ' + path.join(' > ')
    if (!('tagName' in current.parentNode)) break
    current = current.parentNode
  }
  return fail('CHAPTER_MAPPING_INVALID', 'The exact chapter boundary is outside the rendered document')
}
function locate(markup: Markup, selector: string): Element {
  if (/^#[A-Za-z][\w-]*$/.test(selector)) return markup.ids.get(selector.slice(1)) ?? fail('CHAPTER_MAPPING_INVALID', 'Chapter boundary does not exist in the exact source')
  if (!/^:scope(?: > [a-z][a-z0-9-]*:nth-child\([1-9]\d*\))+$/.test(selector)) fail('CHAPTER_MAPPING_INVALID', 'Chapter boundaries require an exact element identity or structural path')
  let current: Node = markup.root
  for (const step of selector.slice(':scope > '.length).split(' > ')) {
    const match = /^([a-z][a-z0-9-]*):nth-child\(([1-9]\d*)\)$/.exec(step)!
    const children = 'childNodes' in current ? current.childNodes.filter((node): node is Element => 'tagName' in node) : []
    const element = children[Number(match[2]) - 1]
    if (!element || renderedTag(markup, element) !== match[1]) fail('CHAPTER_MAPPING_INVALID', 'Chapter structural path no longer matches the exact source')
    current = element
  }
  return current as Element
}
function nodes(bundle: Bundle, chapters: readonly ChapterRegion[]): RegionNodes[] {
  unique(chapters.map(chapter => chapter.region_id), 'chapter identities')
  const markup = index(bundle.html)
  const result = chapters.map(region => {
    const title = locate(markup, region.title_selector), body = locate(markup, region.body_selector)
    if (!/^h[1-6]$/.test(title.tagName) || title.parentNode !== body.parentNode || title === body || !title.parentNode || !('childNodes' in title.parentNode)) fail('CHAPTER_MAPPING_INVALID', 'Chapter title and body require separate sibling boundaries')
    const siblings = title.parentNode.childNodes
    const titleIndex = siblings.indexOf(title), bodyIndex = siblings.indexOf(body)
    if (bodyIndex <= titleIndex || siblings.slice(titleIndex + 1, bodyIndex).some(node => 'tagName' in node || text(node).trim())) fail('CHAPTER_MAPPING_INVALID', 'Chapter body must immediately follow its title')
    const titleSpan = span(title), bodySpan = span(body)
    if (titleSpan.end > bodySpan.start) fail('CHAPTER_MAPPING_INVALID', 'Chapter title and body overlap')
    return { region, title, body, span: { start: titleSpan.start, end: bodySpan.end } }
  })
  const sorted = [...result].sort((left, right) => left.span.start - right.span.start)
  for (let offset = 1; offset < sorted.length; offset++) {
    if (sorted[offset - 1]!.span.end > sorted[offset]!.span.start) fail('CHAPTER_MAPPING_INVALID', 'Independent chapter boundaries overlap')
  }
  return result
}
function emptyOwnership(): ChapterOwnership { return { form_ids: [], behavior_ids: [], reference_ids: [], export_ids: [], css_selectors: [] } }

// The first compound must anchor the subject to the chapter. A sibling of the
// anchor escapes its subtree; subsequent sibling combinators stay inside it.
function scopedSelector(selector: string, roots: readonly string[]): boolean {
  try {
    const parsed = css.parse(selector, { context: 'selector' })
    if (parsed.type !== 'Selector') return false
    const children = parsed.children.toArray()
    const firstCombinator = children.findIndex(child => child.type === 'Combinator')
    const compound = firstCombinator < 0 ? children : children.slice(0, firstCombinator)
    if (!compound.some(child => child.type === 'IdSelector' && roots.includes(child.name))) return false
    if (firstCombinator >= 0 && ![' ', '>'].includes((children[firstCombinator] as css.Combinator).name)) return false
    let safe = true
    css.walk(parsed, node => {
      if (node.type === 'PseudoClassSelector' && ['has', 'host', 'host-context', 'global'].includes(node.name.toLowerCase())) safe = false
      if (node.type === 'PseudoElementSelector' && ['part', 'slotted'].includes(node.name.toLowerCase())) safe = false
    })
    return safe
  } catch { return false }
}
function cssEntries(source: string): CssEntry[] {
  let sheet: css.CssNode
  try { sheet = css.parse(source, { positions: true }) } catch { return fail('CHAPTER_STYLE_INVALID', 'Chapter stylesheet could not be parsed') }
  if (sheet.type !== 'StyleSheet') fail('CHAPTER_STYLE_INVALID', 'Chapter stylesheet is invalid')
  return sheet.children.toArray().map(statement => {
    const selectors: string[] = []
    let local = true
    css.walk(statement, node => {
      if (node.type === 'Rule') {
        if (node.prelude.type !== 'SelectorList') { local = false; return }
        for (const selector of node.prelude.children.toArray()) selectors.push(css.generate(selector))
      }
      if (node.type === 'Atrule' && !['media', 'supports', 'container', 'layer'].includes(node.name.toLowerCase())) local = false
    })
    const location = statement.loc
    if (!location) fail('CHAPTER_STYLE_INVALID', 'Stylesheet source boundaries are unavailable')
    const range = { start: location.start.offset, end: location.end.offset }
    return { text: css.generate(statement), raw: source.slice(range.start, range.end), span: range, selectors, local: local && selectors.length > 0 }
  })
}
function roots(region: ChapterRegion): string[] { return [region.title_selector, region.body_selector].filter(selector => selector.startsWith('#')).map(selector => selector.slice(1)) }
function entryOwned(entry: CssEntry, chapters: readonly ChapterRegion[]): boolean {
  return entry.local && entry.selectors.every(selector => chapters.some(chapter => chapter.ownership.css_selectors.includes(selector) && scopedSelector(selector, roots(chapter))))
}
function ownedStyleElements(bundle: Bundle, chapterNodes: readonly RegionNodes[]): string[] {
  const result: string[] = []
  for (const element of index(bundle.html).elements) {
    if (element.tagName !== 'style') continue
    const source = text(element)
    // Re-indexed nodes differ by object identity; source spans are exact here.
    const position = element.sourceCodeLocation?.startOffset
    if (position === undefined) continue
    const owner = chapterNodes.find(chapter => position >= chapter.span.start && position < chapter.span.end)
    if (!owner) continue
    if (!cssEntries(source).every(entry => entryOwned(entry, [owner.region]))) result.push(source)
  }
  return result
}
function inferOwnership(bundle: Bundle, chapters: ChapterRegion[]): void {
  const markup = index(bundle.html), located = nodes(bundle, chapters)
  const ownerOf = (elementId: string): RegionNodes | undefined => {
    const element = markup.ids.get(elementId)
    if (!element) return undefined
    const location = element.sourceCodeLocation?.startOffset
    return location === undefined ? undefined : located.find(region => location >= region.span.start && location < region.span.end)
  }
  for (const behavior of bundle.behaviors) {
    const owner = ownerOf(behavior.element_id)
    if (owner && !owner.region.ownership.behavior_ids.includes(behavior.element_id)) owner.region.ownership.behavior_ids.push(behavior.element_id)
  }
  for (const form of bundle.forms) {
    const users = bundle.behaviors.filter(behavior => behavior.type === 'submit' && behavior.form_id === form.id || 'field' in behavior && form.fields.includes(behavior.field))
    const owners = users.map(behavior => ownerOf(behavior.element_id))
    if (owners.length && owners[0] && owners.every(owner => owner?.region.region_id === owners[0]!.region.region_id)) owners[0]!.region.ownership.form_ids.push(form.id)
  }
  for (const reference of bundle.references) {
    const users = markup.elements.filter(element => element.attrs.some(attr => attr.name === 'src' && localResourceName(attr.value) === reference.name))
    const owners = users.map(element => ownerOf(id(element) ?? '') ?? located.find(region => {
      const location = element.sourceCodeLocation?.startOffset
      return location !== undefined && location >= region.span.start && location < region.span.end
    }))
    if (owners.length && owners[0] && owners.every(owner => owner?.region.region_id === owners[0]!.region.region_id)) owners[0]!.region.ownership.reference_ids.push(reference.name)
  }
  for (const fragment of bundle.export) {
    if (fragment.source.type !== 'element') continue
    ownerOf(fragment.source.element_id)?.region.ownership.export_ids.push(fragment.id)
  }
  for (const entry of cssEntries(bundle.css)) {
    for (const selector of entry.selectors) {
      const owners = chapters.filter(chapter => scopedSelector(selector, roots(chapter)))
      if (entry.local && owners.length === 1 && !owners[0]!.ownership.css_selectors.includes(selector)) owners[0]!.ownership.css_selectors.push(selector)
    }
  }
  for (const element of markup.elements.filter(element => element.tagName === 'style')) {
    const position = element.sourceCodeLocation?.startOffset
    const owner = located.find(region => position !== undefined && position >= region.span.start && position < region.span.end)
    if (!owner) continue
    for (const entry of cssEntries(text(element))) for (const selector of entry.selectors) {
      if (entry.local && scopedSelector(selector, roots(owner.region)) && !owner.region.ownership.css_selectors.includes(selector)) owner.region.ownership.css_selectors.push(selector)
    }
  }
}

/** Validate the source's exact structural boundaries and local metadata claims. */
export function validateChapterMapping(bundle: Bundle, chapters: readonly ChapterRegion[]): void {
  validateBundle(bundle)
  const markup = index(bundle.html), located = nodes(bundle, chapters)
  const claimed = { form_ids: new Set<string>(), behavior_ids: new Set<string>(), reference_ids: new Set<string>(), export_ids: new Set<string>(), css_selectors: new Set<string>() }
  for (const item of located) {
    const owner = item.region.ownership
    if (item.region.title !== text(item.title).trim()) fail('CHAPTER_MAPPING_INVALID', 'Chapter title metadata must match the published title node')
    for (const key of Object.keys(claimed) as (keyof ChapterOwnership)[]) {
      unique(owner[key], `chapter ${key}`)
      for (const identity of owner[key]) {
        if (claimed[key].has(identity)) fail('CHAPTER_OWNERSHIP_INVALID', 'Local metadata has more than one chapter owner')
        claimed[key].add(identity)
      }
    }
    for (const identity of owner.behavior_ids) {
      const element = markup.ids.get(identity)
      const position = element?.sourceCodeLocation?.startOffset
      if (position === undefined || position < item.span.start || position >= item.span.end || !bundle.behaviors.some(behavior => behavior.element_id === identity)) fail('CHAPTER_OWNERSHIP_INVALID', 'Behavior ownership must name a local target')
    }
    for (const behavior of bundle.behaviors) {
      const element = markup.ids.get(behavior.element_id), position = element?.sourceCodeLocation?.startOffset
      if (position !== undefined && position >= item.span.start && position < item.span.end && !owner.behavior_ids.includes(behavior.element_id)) fail('CHAPTER_OWNERSHIP_INVALID', 'A chapter behavior has no explicit local owner')
    }
    for (const identity of owner.form_ids) {
      const form = bundle.forms.find(form => form.id === identity)
      if (!form) fail('CHAPTER_OWNERSHIP_INVALID', 'Local form is unavailable')
      const users = bundle.behaviors.filter(behavior => behavior.type === 'submit' && behavior.form_id === identity || 'field' in behavior && form.fields.includes(behavior.field))
      if (!users.length || users.some(behavior => !owner.behavior_ids.includes(behavior.element_id))) fail('CHAPTER_OWNERSHIP_INVALID', 'A cross-chapter form is shared metadata')
    }
    for (const name of owner.reference_ids) {
      if (!bundle.references.some(reference => reference.name === name)) fail('CHAPTER_OWNERSHIP_INVALID', 'Local resource reference is unavailable')
      for (const element of markup.elements) if (element.attrs.some(attr => attr.name === 'src' && localResourceName(attr.value) === name)) {
        const position = element.sourceCodeLocation?.startOffset
        if (position === undefined || position < item.span.start || position >= item.span.end) fail('CHAPTER_OWNERSHIP_INVALID', 'A cross-chapter reference is shared metadata')
      }
    }
    for (const identity of owner.export_ids) {
      const fragment = bundle.export.find(fragment => fragment.id === identity)
      if (!fragment || fragment.source.type !== 'element') fail('CHAPTER_OWNERSHIP_INVALID', 'Local export must name a chapter element')
      const element = markup.ids.get(fragment.source.element_id)
      const position = element?.sourceCodeLocation?.startOffset
      if (position === undefined || position < item.span.start || position >= item.span.end) fail('CHAPTER_OWNERSHIP_INVALID', 'Export ownership escapes the chapter')
    }
    if (owner.css_selectors.some(selector => !scopedSelector(selector, roots(item.region)))) fail('CHAPTER_STYLE_SCOPE', 'A local selector can affect content outside its chapter')
  }
}

/**
 * Register reliable existing heading/body pairs without changing source bytes.
 * Existing IDs or exact rendered structural paths locate the boundaries.
 * An unstructured legacy document must first receive an explicit mapping.
 */
export function deriveChapterMapping(bundle: Bundle, identity: { view_id: string }, nextId?: () => string): { bundle: Bundle; chapters: ChapterRegion[] } {
  validateBundle(bundle)
  const markup = index(bundle.html), used = new Set(markup.ids.keys())
  let sequence = 0
  const fresh = (prefix: string): string => {
    const stem = identity.view_id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'view'
    let value: string
    do { value = `${prefix}-${stem}-${++sequence}` } while (used.has(value))
    used.add(value); return value
  }
  const pairs: { title: Element; body: Element }[] = []
  for (const title of markup.elements.filter(element => /^h[1-6]$/.test(element.tagName))) {
    const parent = title.parentNode
    if (!parent || !('childNodes' in parent)) continue
    const children = parent.childNodes, offset = children.indexOf(title)
    const following = children.slice(offset + 1).filter(node => 'tagName' in node || text(node).trim())
    if (!following.length || !('tagName' in following[0]!)) continue
    const body = following[0] as Element
    // A section containing sibling paragraphs has no single established body
    // root. Wrapping it could change CSS, grid layout or form relationships.
    if (!['div', 'section', 'article', 'main', 'p'].includes(body.tagName) || /^h[1-6]$/.test(body.tagName)) continue
    const subsequent = following[1]
    if (subsequent && (!('tagName' in subsequent) || !/^h[1-6]$/.test(subsequent.tagName))) continue
    const titleLocation = title.sourceCodeLocation, bodyLocation = body.sourceCodeLocation
    if (!titleLocation?.endTag || !bodyLocation?.endTag) continue
    pairs.push({ title, body })
  }
  // Prefer independent leaf pairs when a document also has a broad outer title.
  const independent = pairs.filter(pair => !pairs.some(other => other !== pair && inside(other.title, pair.body)))
  if (!independent.length) fail('CHAPTER_MAPPING_REQUIRED', 'The document needs reliable title and body boundaries before an in-place update')
  const chapters = independent.map(pair => ({
    region_id: nextId ? nextId() : fresh('chapter'), revision: 1,
    title: text(pair.title).trim(), title_selector: selectorFor(markup, pair.title), body_selector: selectorFor(markup, pair.body),
    dependencies: [], ownership: emptyOwnership()
  } satisfies ChapterRegion))
  inferOwnership(bundle, chapters)
  validateChapterMapping(bundle, chapters)
  return { bundle, chapters }
}
function applyEdits(source: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((left, right) => right.start - left.start)
  let previous = source.length
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > previous) fail('CHAPTER_MAPPING_INVALID', 'Chapter source edits overlap')
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
    previous = edit.start
  }
  return source
}

export function chapterDependencyValid(dependency: ChapterDependency, manifests: readonly ChapterManifest[]): boolean {
  const manifest = manifests.find(item => item.task_id === dependency.task_id && item.view_id === dependency.view_id)
  return !!manifest && (dependency.region_id
    ? manifest.chapters.some(chapter => chapter.region_id === dependency.region_id && chapter.revision === dependency.revision)
    : manifest.shared_revision === dependency.revision)
}

export interface ChapterAssemblyInput {
  latest: { bundle: Bundle; manifest: ChapterManifest }
  baseline: ChapterManifest
  candidate: Bundle
  replacements: { previous_region_ids: string[]; chapters: ChapterRegion[] }[]
  dependencies: ChapterDependency[]
  dependency_manifests?: ChapterManifest[]
}
export interface ChapterAssemblyResult {
  bundle: Bundle
  chapters: ChapterRegion[]
  kept: ChapterRegion[]
  invalid_kept_region_ids: string[]
  replaced_region_ids: string[]
}

/** Generated bodies use explicit containers; legacy mappings stay unchanged. */
export function validateChapterCandidate(bundle: Bundle, chapters: readonly ChapterRegion[]): void {
  validateChapterMapping(bundle, chapters)
  for (const item of nodes(bundle, chapters)) {
    if (!['div', 'section', 'article', 'main'].includes(item.body.tagName)) fail('CHAPTER_MAPPING_INVALID', 'Each replacement body must use one div, section, article or main container enclosing its complete content')
  }
}

/** Reassemble from current published bytes, never from the candidate's snapshot. */
export function assembleChapterUpdate(input: ChapterAssemblyInput): ChapterAssemblyResult {
  const { latest, baseline, candidate, replacements } = input
  validateChapterMapping(latest.bundle, latest.manifest.chapters)
  if (latest.manifest.task_id !== baseline.task_id || latest.manifest.view_id !== baseline.view_id || latest.manifest.request_id !== baseline.request_id || latest.manifest.intent_revision !== baseline.intent_revision) fail('CHAPTER_BASELINE_CONFLICT', 'The chapter source goal or View has changed')
  if (latest.manifest.shared_revision !== baseline.shared_revision) fail('CHAPTER_DEPENDENCY_CONFLICT', 'Shared chapter structure has changed')
  const previousIds = replacements.flatMap(group => group.previous_region_ids)
  if (!previousIds.length || !replacements.length || replacements.some(group => !group.previous_region_ids.length || !group.chapters.length)) fail('CHAPTER_REPLACEMENT_INVALID', 'Every explicit replacement group needs source and destination chapters')
  unique(previousIds, 'replacement source chapters')
  const nextChapters = replacements.flatMap(group => group.chapters)
  unique(nextChapters.map(chapter => chapter.region_id), 'replacement destination chapters')
  validateChapterMapping(candidate, nextChapters)
  for (const previous of previousIds) {
    const old = baseline.chapters.find(chapter => chapter.region_id === previous)
    const current = latest.manifest.chapters.find(chapter => chapter.region_id === previous)
    if (!old || !current || old.revision !== current.revision) fail('CHAPTER_BASELINE_CONFLICT', 'An updated chapter no longer has its selected baseline')
    for (const dependency of old.dependencies) if (!chapterDependencyValid(dependency, [latest.manifest, ...(input.dependency_manifests ?? [])])) fail('CHAPTER_DEPENDENCY_CONFLICT', 'A selected chapter dependency has changed')
  }
  const currentManifests = [latest.manifest, ...(input.dependency_manifests ?? [])]
  for (const dependency of input.dependencies) if (!chapterDependencyValid(dependency, currentManifests)) fail('CHAPTER_DEPENDENCY_CONFLICT', 'A chapter proposal dependency has changed')
  const kept = latest.manifest.chapters.filter(chapter => !previousIds.includes(chapter.region_id))
  if (nextChapters.some(chapter => kept.some(item => item.region_id === chapter.region_id))) fail('CHAPTER_REPLACEMENT_INVALID', 'A new chapter cannot take an unselected chapter identity')
  for (const group of replacements) {
    for (const chapter of group.chapters) {
      const previous = latest.manifest.chapters.find(item => item.region_id === chapter.region_id)
      if (previous && (!group.previous_region_ids.includes(previous.region_id) || chapter.revision !== previous.revision + 1) || !previous && chapter.revision !== 1) fail('CHAPTER_REPLACEMENT_INVALID', 'Replacement chapter revisions must retain their exact identity lineage')
    }
    if (group.previous_region_ids.length === 1 && group.chapters.length === 1 && group.previous_region_ids[0] !== group.chapters[0]!.region_id) fail('CHAPTER_REPLACEMENT_INVALID', 'A one-to-one revision retains the original chapter identity')
  }
  const oldSelected = latest.manifest.chapters.filter(chapter => previousIds.includes(chapter.region_id))
  const oldNodes = nodes(latest.bundle, latest.manifest.chapters), newNodes = nodes(candidate, nextChapters)
  const edits: Edit[] = []
  const destinations: { region: ChapterRegion; insertion: number; title: number; body: number }[] = []
  for (const group of replacements) {
    const sourceNodes = oldNodes.filter(item => group.previous_region_ids.includes(item.region.region_id)).sort((a, b) => a.span.start - b.span.start)
    let offset = 0
    const replacement = group.chapters.map(chapter => {
      const item = newNodes.find(item => item.region.region_id === chapter.region_id)!
      const fragment = candidate.html.slice(item.span.start, item.span.end)
      destinations.push({ region: chapter, insertion: sourceNodes[0]!.span.start, title: offset, body: offset + span(item.body).start - item.span.start })
      offset += fragment.length + 1
      return fragment
    }).join('\n')
    sourceNodes.forEach((item, offset) => edits.push({ ...item.span, text: offset === 0 ? replacement : '' }))
  }
  // Shared state is never replaced by a local producer. The final controlled
  // View transition still protects the latest user draft and reset consent.
  if (!equal(candidate.state, baselineState(input, candidate))) fail('CHAPTER_SHARED_CONFLICT', 'A local proposal cannot change shared state')
  const mergeOwned = <T>(original: T[], proposed: T[], key: (item: T) => string, ownership: 'form_ids' | 'behavior_ids' | 'reference_ids' | 'export_ids'): T[] => {
    const remove = new Set(oldSelected.flatMap(chapter => chapter.ownership[ownership]))
    const add = new Set(nextChapters.flatMap(chapter => chapter.ownership[ownership]))
    const retained = original.filter(item => !remove.has(key(item)))
    const incoming = proposed.filter(item => add.has(key(item)))
    if (incoming.some(item => retained.some(existing => key(existing) === key(item)))) fail('CHAPTER_OWNERSHIP_INVALID', 'A local metadata identity conflicts with preserved content')
    return [...retained, ...incoming]
  }
  const bundle: Bundle = {
    ...latest.bundle,
    html: applyEdits(latest.bundle.html, edits),
    css: mergeCss(latest.bundle.css, candidate.css, baseline.chapters, oldSelected, nextChapters),
    forms: mergeOwned(latest.bundle.forms, candidate.forms, form => form.id, 'form_ids'),
    behaviors: mergeOwned(latest.bundle.behaviors, candidate.behaviors, behavior => behavior.element_id, 'behavior_ids'),
    references: mergeOwned(latest.bundle.references, candidate.references, reference => reference.name, 'reference_ids'),
    export: mergeOwned(latest.bundle.export, candidate.export, fragment => fragment.id, 'export_ids')
  }
  // Embedded global styles are shared even when physically inside a chapter.
  // They cannot disappear or change as a side effect of a local replacement.
  if (!equal(ownedStyleElements(latest.bundle, nodes(latest.bundle, oldSelected)), ownedStyleElements(candidate, newNodes))) fail('CHAPTER_SHARED_CONFLICT', 'A local update changes an embedded shared stylesheet')
  protectSharedForms(latest.bundle, bundle, oldSelected)
  const positions = index(bundle.html)
  const shifted = (offset: number): number => offset + edits.filter(edit => edit.end <= offset).reduce((total, edit) => total + edit.text.length - (edit.end - edit.start), 0)
  const elementAt = (offset: number): Element => positions.elements.find(element => element.sourceCodeLocation?.startOffset === offset) ?? fail('CHAPTER_MAPPING_INVALID', 'A replaced chapter boundary could not be located in the assembled source')
  const mapped: { region: ChapterRegion; offset: number }[] = kept.map(region => {
    const original = oldNodes.find(item => item.region.region_id === region.region_id)!
    const titleOffset = shifted(span(original.title).start), bodyOffset = shifted(span(original.body).start)
    return { region: { ...region, title_selector: selectorFor(positions, elementAt(titleOffset)), body_selector: selectorFor(positions, elementAt(bodyOffset)) }, offset: titleOffset }
  })
  for (const destination of destinations) {
    const insertion = shifted(destination.insertion)
    mapped.push({ region: { ...destination.region, title_selector: selectorFor(positions, elementAt(insertion + destination.title)), body_selector: selectorFor(positions, elementAt(insertion + destination.body)) }, offset: insertion + destination.title })
  }
  const chapters = mapped.sort((left, right) => left.offset - right.offset).map(item => item.region)
  const mappedKeeps = chapters.filter(chapter => kept.some(item => item.region_id === chapter.region_id))
  validateChapterMapping(bundle, chapters)
  checkExportFragments(bundle)
  if (Buffer.byteLength(JSON.stringify(bundle)) > defaults.surface.inline_bundle_bytes) fail('BUNDLE_SIZE_LIMIT', 'The assembled chapter exceeds the enabled Bundle capacity')
  // This checks the entire assembled HTML/CSS, schema and behavior graph.
  // Resource bytes and task ownership are verified by the Store's real resolver.
  checkBundle(bundle, 'chapter-assembly', () => 'data:image/png;base64,AA==')
  const [first, ...rest] = chapters
  if (!first) fail('CHAPTER_REPLACEMENT_INVALID', 'A replacement cannot remove every chapter')
  const installed: ChapterManifest = { ...latest.manifest, chapters: [first, ...rest] }
  return { bundle, chapters, kept: mappedKeeps, invalid_kept_region_ids: mappedKeeps.filter(chapter => chapter.dependencies.some(dependency => !chapterDependencyValid(dependency, [installed, ...(input.dependency_manifests ?? [])]))).map(chapter => chapter.region_id), replaced_region_ids: previousIds }
}
function baselineState(input: ChapterAssemblyInput, candidate: Bundle): Bundle['state'] {
  // A bounded chapter context may omit unrelated state fields. It must retain
  // every field it does include, and cannot introduce or change shared state.
  const current = input.latest.bundle.state
  if (equal(candidate.state, current)) return candidate.state
  if (candidate.state.compatibility_version !== current.compatibility_version || candidate.state.schema.type !== 'object' || current.schema.type !== 'object') return current
  const { properties: candidateProperties, required: candidateRequired, ...candidateRoot } = candidate.state.schema
  const { properties: currentProperties, required: currentRequired, ...currentRoot } = current.schema
  if (!equal(candidateRoot, currentRoot)) return current
  const properties = candidateProperties ?? {}
  if (!equal(candidateRequired ?? [], (currentRequired ?? []).filter(key => Object.hasOwn(properties, key)))) return current
  if (Object.entries(properties).some(([key, value]) => !equal(currentProperties?.[key], value))) return current
  const initial = candidate.state.initial
  if (!initial || typeof initial !== 'object' || Array.isArray(initial)) return current
  const saved = current.initial as Record<string, unknown>
  if (Object.entries(initial).some(([key, value]) => !Object.hasOwn(properties, key) || !equal(saved[key], value))) return current
  return candidate.state
}
function mergeCss(latestCss: string, candidateCss: string, baseline: readonly ChapterRegion[], selected: readonly ChapterRegion[], next: readonly ChapterRegion[]): string {
  const currentEntries = cssEntries(latestCss), candidateEntries = cssEntries(candidateCss)
  const preserved = currentEntries.filter(entry => !entryOwned(entry, selected))
  const other = baseline.filter(chapter => !selected.some(item => item.region_id === chapter.region_id))
  const additions: string[] = []
  for (const entry of candidateEntries) {
    if (entryOwned(entry, next)) additions.push(entry.raw)
    else if (entryOwned(entry, other)) continue
    else if (!preserved.some(existing => existing.text === entry.text)) fail('CHAPTER_STYLE_SCOPE', 'A proposal introduces or changes CSS outside the selected chapters')
  }
  const retained = applyEdits(latestCss, currentEntries.filter(entry => entryOwned(entry, selected)).map(entry => ({ ...entry.span, text: '' })))
  return retained + (additions.length ? '\n' + additions.join('\n') : '')
}
function protectSharedForms(original: Bundle, result: Bundle, selected: readonly ChapterRegion[]): void {
  const localForms = new Set(selected.flatMap(chapter => chapter.ownership.form_ids))
  const sharedFields = new Set(original.forms.filter(form => !localForms.has(form.id)).flatMap(form => form.fields))
  const touchesShared = (behavior: Bundle['behaviors'][number]): boolean => 'field' in behavior && sharedFields.has(behavior.field)
  for (const behavior of original.behaviors.filter(touchesShared)) {
    if (!result.behaviors.some(current => equal(current, behavior))) fail('CHAPTER_SHARED_CONFLICT', 'A local update changes an input used by a shared form')
  }
}

/** Bounded producer input, without the remainder of the published document. */
export function chapterInput(bundle: Bundle, manifest: ChapterManifest, regionIds: readonly string[], dependencies: readonly ChapterDependency[] = []): { bundle: Bundle; chapters: { region_id: string; revision: number; html: string }[] } {
  validateChapterMapping(bundle, manifest.chapters)
  unique(regionIds, 'context chapter identities')
  const dependencyIds = dependencies.filter(dependency => dependency.task_id === manifest.task_id && dependency.view_id === manifest.view_id && dependency.region_id).map(dependency => dependency.region_id!)
  const selected = [...new Set([...regionIds, ...dependencyIds])].map(regionId => manifest.chapters.find(chapter => chapter.region_id === regionId) ?? fail('CHAPTER_NOT_FOUND', 'Chapter context names an unavailable chapter'))
  for (const dependency of dependencies.filter(item => item.task_id === manifest.task_id && item.view_id === manifest.view_id)) if (!chapterDependencyValid(dependency, [manifest])) fail('CHAPTER_DEPENDENCY_CONFLICT', 'Chapter context dependency is stale')
  const located = nodes(bundle, selected), markup = index(bundle.html)
  const contains = (elementId: string): boolean => {
    const element = markup.ids.get(elementId), position = element?.sourceCodeLocation?.startOffset
    return position !== undefined && located.some(item => position >= item.span.start && position < item.span.end)
  }
  const chapters = located.map(item => ({ region_id: item.region.region_id, revision: item.region.revision, html: bundle.html.slice(item.span.start, item.span.end) }))
  const html = chapters.map(chapter => chapter.html).join('\n')
  const referenceNames = new Set(index(html).elements.flatMap(element => element.attrs.flatMap(attr => attr.name === 'src' && localResourceName(attr.value) ? [localResourceName(attr.value)!] : [])))
  const behaviors = bundle.behaviors.filter(behavior => contains(behavior.element_id))
  const formIds = new Set(behaviors.flatMap(behavior => behavior.type === 'submit' ? [behavior.form_id] : []))
  return {
    bundle: {
      ...bundle, html,
      css: cssEntries(bundle.css).filter(entry => entryOwned(entry, selected) || !entryOwned(entry, manifest.chapters)).map(entry => entry.text).join('\n'),
      forms: bundle.forms.filter(form => formIds.has(form.id)), behaviors,
      references: bundle.references.filter(reference => referenceNames.has(reference.name)),
      export: bundle.export.filter(fragment => fragment.source.type === 'element' && contains(fragment.source.element_id))
    },
    chapters
  }
}

/** A host-built replacement scaffold, separate from the immutable source. */
export function chapterCandidateTemplate(bundle: Bundle, manifest: ChapterManifest, regionIds: readonly string[], dependencies: readonly ChapterDependency[] = []): { bundle: Bundle; chapters: ChapterRegion[] } {
  const input = chapterInput(bundle, manifest, regionIds, dependencies)
  const projected = input.chapters.length === regionIds.length ? input.bundle : chapterInput(bundle, manifest, regionIds).bundle
  const selected = regionIds.map(regionId => manifest.chapters.find(chapter => chapter.region_id === regionId)!)
  const markup = index(bundle.html), used = new Set(markup.ids.keys()), selectors = new Map<string, string>()
  const fresh = (): string => {
    let identity: string
    do { identity = 'chapter-' + randomUUID() } while (used.has(identity))
    used.add(identity); return identity
  }
  const scopeCss = (source: string, owners: readonly ChapterRegion[]): string => {
    const local = cssEntries(source).filter(entry => entryOwned(entry, owners))
    if (!local.some(entry => entry.selectors.some(selector => selectors.has(selector)))) return source
    const edits: Edit[] = []
    css.walk(css.parse(source, { positions: true }), node => {
      if (node.type !== 'Rule' || node.prelude.type !== 'SelectorList') return
      for (const selector of node.prelude.children.toArray()) {
        const replacement = selectors.get(css.generate(selector)), location = selector.loc
        if (replacement && location && local.some(entry => location.start.offset >= entry.span.start && location.end.offset <= entry.span.end)) edits.push({ start: location.start.offset, end: location.end.offset, text: replacement })
      }
    })
    return applyEdits(source, edits)
  }
  const chapters: ChapterRegion[] = []
  const html = nodes(bundle, selected).map(item => {
    const region = structuredClone(item.region), edits: Edit[] = []
    const edit = (start: number, end: number, replacement: string): void => { edits.push({ start: start - item.span.start, end: end - item.span.start, text: replacement }) }
    const ensureId = (element: Element): string => {
      const existing = id(element)
      if (existing) return existing
      const identity = fresh(), location = element.sourceCodeLocation!, attribute = location.attrs?.id
      if (attribute) edit(attribute.startOffset, attribute.endOffset, `id="${identity}"`)
      else {
        const offset = location.startTag!.startOffset + element.tagName.length + 1
        edit(offset, offset, ` id="${identity}"`)
      }
      return identity
    }
    region.title_selector = '#' + ensureId(item.title)
    if (['div', 'section', 'article', 'main'].includes(item.body.tagName)) region.body_selector = '#' + ensureId(item.body)
    else {
      if (item.body.tagName !== 'p') fail('CHAPTER_MAPPING_INVALID', 'A chapter template needs an established body container or paragraph')
      const identity = fresh(), body = span(item.body)
      edit(body.start, body.start, `<div id="${identity}">`)
      edit(body.end, body.end, '</div>')
      region.body_selector = '#' + identity
      region.ownership.css_selectors = region.ownership.css_selectors.map(selector => {
        if (!scopedSelector(selector, roots(item.region).filter(root => root === id(item.body)))) return selector
        const replacement = region.body_selector + ' ' + selector
        selectors.set(selector, replacement); return replacement
      })
    }
    region.revision++
    region.dependencies = structuredClone([...dependencies])
    chapters.push(region)
    for (const element of markup.elements.filter(element => element.tagName === 'style')) {
      const location = element.sourceCodeLocation
      if (!location?.startTag || !location.endTag || location.startOffset < item.span.start || location.endOffset > item.span.end) continue
      const source = bundle.html.slice(location.startTag.endOffset, location.endTag.startOffset)
      if (cssEntries(source).every(entry => entryOwned(entry, [item.region]))) edit(location.startTag.endOffset, location.endTag.startOffset, scopeCss(source, [item.region]))
    }
    return applyEdits(bundle.html.slice(item.span.start, item.span.end), edits)
  }).join('\n')
  const sourceCss = applyEdits(bundle.css, cssEntries(bundle.css).filter(entry => entryOwned(entry, manifest.chapters) && !entryOwned(entry, selected)).map(entry => ({ ...entry.span, text: '' })))
  const candidate = structuredClone({ ...projected, html, css: scopeCss(sourceCss, selected) })
  validateChapterCandidate(candidate, chapters)
  return { bundle: candidate, chapters }
}

export function chapterContext(bundle: Bundle, manifest: ChapterManifest, regionIds: readonly string[], dependencies: readonly ChapterDependency[] = []): Bundle {
  return chapterInput(bundle, manifest, regionIds, dependencies).bundle
}

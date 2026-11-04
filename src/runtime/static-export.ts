import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5'
import type { Bundle } from '../shared/contracts.generated'
import { checkBundle, getField } from './managed'
import { ContractError } from '../shared/validation'
import { checkExportFragments } from './export-fragments'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
export interface StaticView { bundle: Bundle; resolve(name: string): string; fragment_ids?: string[] }
export interface ExportIssue { code: string; view_index: number; answer_index?: number; fragment_id?: string; element_id?: string; node_path?: string; tag?: string }
const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const banned = new Set(['input', 'textarea', 'select', 'button'])
const isolated = (scope: string, html: string, css: string): string => `<section style="contain:layout paint;isolation:isolate;overflow:hidden"><template shadowrootmode="open"><style>${css.replace(/<\/style/gi, '<\\/style')}</style><div data-view="${scope}">${html}</div></template></section>`
export function staticDocument(title: string, views: StaticView[], answers: { value: unknown; label: string; question?: StaticView }[] = [], prefix = 'export', diagnose?: (issue: ExportIssue) => void): { styles: string[]; body: string; html: string; issues: string[] } {
  const issues: string[] = [], pieces: string[] = [], styles: string[] = []
  let imageBytes = 0, outputBytes = 0
  const add = (target: string[], ...values: string[]) => { for (const value of values) { outputBytes += Buffer.byteLength(value); if (outputBytes > 16 * 1024 * 1024) throw new ContractError('EXPORT_SIZE_LIMIT', 'Enabled export size limit is 16 MiB; reduce the selection'); target.push(value) } }
  views.forEach((view, index) => {
    const missing = new Map<string, string>()
    const resolve = (name: string): string => {
      try {
        const url = view.resolve(name); imageBytes += Buffer.byteLength(url)
        if (imageBytes > 16 * 1024 * 1024) throw new ContractError('EXPORT_SIZE_LIMIT', 'Expanded images exceed enabled export limit')
        return url
      } catch (error) {
        if (!(error instanceof ContractError) || !['RESOURCE_MISSING', 'RESOURCE_CORRUPT', 'UNSUPPORTED_IMAGE', 'IMAGE_DIMENSION_LIMIT'].includes(error.code)) throw error
        const marker = 'data:image/png;base64,' + Buffer.from(`omitted-${prefix}-${index}-${missing.size}`).toString('base64')
        missing.set(marker, error.code); return marker
      }
    }
    checkExportFragments(view.bundle)
    const scope = `${prefix}-${index}`, checked = checkBundle(view.bundle, scope, resolve), tree = parseFragment(checked.html)
    if (view.fragment_ids && (new Set(view.fragment_ids).size !== view.fragment_ids.length || view.fragment_ids.some(id => !view.bundle.export.some(f => f.id === id && f.category !== 'unclassified')))) throw new ContractError('EXPORT_SELECTION_INVALID', 'Selected fragments must be classified and present in the fixed bundle')
    const ids = new Map<string, Element>(), parents = new Map<Node, Node>()
    const visit = (node: Node): void => {
      if ('tagName' in node) { const id = node.attrs.find(a => a.name === 'id')?.value; if (id) ids.set(id, node) }
      if ('childNodes' in node) for (const child of node.childNodes) { parents.set(child, node); visit(child) }
    }
    visit(tree)
    for (const behavior of view.bundle.behaviors) if (behavior.type === 'text') {
      const node = ids.get(`${scope}-${behavior.element_id}`)
      if (node) { const value = getField(view.bundle.state.initial as Record<string, unknown>, behavior.field); node.childNodes = [{ nodeName: '#text', value: value == null ? '' : String(value), parentNode: node }] }
    }
    const roots = new Set<Element>()
    for (const f of view.bundle.export) {
      if (f.source.type === 'element') {
        const node = ids.get(`${scope}-${f.source.element_id}`)!
        roots.add(node)
      }
    }
    const covered = (node: Node): boolean => { let n: Node | undefined = node; while (n) { if (roots.has(n as Element)) return true; n = parents.get(n) }; return false }
    let uncovered = false
    const reported = new Set<Node>()
    const coverage = (node: Node, path = ''): void => {
      const omitted = node.nodeName === '#text' && 'value' in node && node.value.trim() || 'tagName' in node && ['img', 'svg', 'math'].includes(node.tagName)
      if (omitted && !covered(node)) {
        uncovered = true
        const location = 'tagName' in node ? node : parents.get(node) ?? node
        if (!reported.has(location)) {
          reported.add(location)
          const id = 'attrs' in location ? location.attrs.find(a => a.name === 'id')?.value : undefined
          diagnose?.({ code: 'UNCLASSIFIED_CONTENT', view_index: index, node_path: 'tagName' in node ? path : path.split('.').slice(0, -1).join('.'), ...('tagName' in location ? { tag: location.tagName } : {}), ...(id ? { element_id: id.slice(scope.length + 1) } : {}) })
        }
      }
      if ('childNodes' in node) node.childNodes.forEach((child, i) => coverage(child, path ? path + '.' + i : String(i)))
    }
    coverage(tree)
    if (!uncovered && !view.bundle.export.length) diagnose?.({ code: 'UNCLASSIFIED_CONTENT', view_index: index, node_path: '' })
    if (uncovered || !view.bundle.export.length) { issues.push(`View ${index + 1}: UNCLASSIFIED_CONTENT`); add(pieces, '<p class="omitted">此区域未导出：存在未分类内容。</p>') }
    const clean = (node: Node): void => {
      if ('tagName' in node) {
        const unavailable = node.tagName === 'img' && missing.get(node.attrs.find(a => a.name === 'src')?.value ?? '')
        if (unavailable) {
          issues.push(`View ${index + 1}: IMAGE_OMITTED_${unavailable}`)
          const id = node.attrs.find(a => a.name === 'id')?.value
          diagnose?.({ code: 'IMAGE_OMITTED_' + unavailable, view_index: index, tag: 'img', ...(id?.startsWith(scope + '-') ? { element_id: id.slice(scope.length + 1) } : {}) })
          node.tagName = 'span'; node.nodeName = 'span'; node.attrs = [{ name: 'class', value: 'omitted' }]
          node.childNodes = [{ nodeName: '#text', value: `此处图片未导出：${unavailable}。`, parentNode: node }]
        }
        node.attrs = node.attrs.filter(a => !['for', 'aria-describedby'].includes(a.name))
        if (banned.has(node.tagName)) { node.tagName = 'span'; node.nodeName = 'span'; node.attrs = []; node.childNodes = [] }
      }
      if ('childNodes' in node) node.childNodes.forEach(clean)
    }
    for (const [fragmentIndex, f] of view.bundle.export.entries()) {
      if (f.category === 'unclassified') { issues.push(`View ${index + 1}: UNCLASSIFIED_FRAGMENT`); diagnose?.({ code: 'UNCLASSIFIED_FRAGMENT', view_index: index, fragment_id: f.id, ...(f.source.type === 'element' ? { element_id: f.source.element_id } : {}) }); add(pieces, '<p class="omitted">此区域未导出：片段未分类。</p>'); continue }
      const selected = view.fragment_ids ? view.fragment_ids.includes(f.id) : f.category === 'learning'
      if (!selected) continue
      if (f.category !== 'learning' && !f.personal_binding) throw new ContractError('PERSONAL_BINDING_REQUIRED', 'Legacy personal fragments cannot be exported without an exact original-question binding')
      if (f.source.type === 'static') {
        const fragmentBundle: Bundle = { ...view.bundle, html: f.source.html, css: f.source.css, forms: [], behaviors: [], state: { schema: { type: 'object', additionalProperties: false, properties: {} }, initial: {}, compatibility_version: 'static' }, export: [] }
        const fragmentScope = `${scope}-static-${fragmentIndex}`, safe = checkBundle(fragmentBundle, fragmentScope, resolve), fragment = parseFragment(safe.html)
        clean(fragment); add(pieces, isolated(fragmentScope, serialize(fragment), safe.css)); add(styles, safe.css)
      } else {
        const source = ids.get(`${scope}-${f.source.element_id}`)!
        const copy = (n: Node, parent: Node | null = null): Node => {
          const result = { ...n } as any
          if ('parentNode' in result) result.parentNode = parent
          if ('attrs' in result) result.attrs = result.attrs.map((a: any) => ({ ...a }))
          if ('childNodes' in result) result.childNodes = result.childNodes.map((child: Node) => copy(child, result))
          return result
        }
        const node = copy(source) as Element
        // Restore only declarative text from published initial state, never the current draft.
        clean(node)
        const container = parseFragment(''); container.childNodes.push(node); node.parentNode = container
        const visible = view.bundle.behaviors.filter(b => b.type === 'visible').map(b => `#${scope}-${b.element_id}{display:block!important}`).join('\n')
        add(pieces, isolated(scope, serialize(container), checked.css + '\n' + visible))
      }
    }
    add(styles, checked.css)
    for (const b of view.bundle.behaviors) if (b.type === 'visible') add(styles, `[data-view="${scope}"] #${scope}-${b.element_id}{display:block!important}`)
  })
  for (const [index, answer] of answers.entries()) {
    if (answer.question) {
      const original = staticDocument(answer.label, [answer.question], [], `${prefix}-answer-${index}`, issue => diagnose?.({ ...issue, answer_index: index }))
      add(pieces, `<section><h2>${escape(answer.label)} · 原题</h2><div class="original-question">${original.body}</div></section>`)
      add(styles, ...original.styles)
      issues.push(...original.issues.map(issue => `Original question ${index + 1}: ${issue}`))
    }
    add(pieces, `<section><h2>${escape(answer.label)}</h2><pre>${escape(JSON.stringify(answer.value, null, 2))}</pre></section>`)
  }
  const omitted = issues.length ? `<aside><h2>部分导出 · 遗漏清单</h2><ul>${issues.map(i => `<li>${escape(i)}</li>`).join('')}</ul></aside>` : ''
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{max-width:960px;margin:40px auto;padding:0 24px;font-family:serif;line-height:1.7}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}.omitted,aside{border:1px solid #976b25;padding:12px}</style></head><body><h1>${escape(title)}</h1>${pieces.join('\n')}${omitted}</body></html>`
  if (Buffer.byteLength(html) > 16 * 1024 * 1024) throw new ContractError('EXPORT_SIZE_LIMIT', 'Enabled export size limit is 16 MiB; reduce the selection')
  return { html, issues, body: pieces.join('\n'), styles }
}

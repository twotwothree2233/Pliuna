import { describe, expect, test } from 'vitest'
import type { ContentNode, ContentOperation, ContentTree } from '../../src/shared/contracts.generated'
import { applyContentOperations, buildContentTree, contentNode, contentOperationScope, contentScopeOverlaps } from '../../src/runtime/runner/content-tree'

const ids = () => { let value = 0; return () => `fresh-${++value}` }
function setup(html: string) { return { html, tree: buildContentTree(html) } }
function node(tree: ContentTree, kind: ContentNode['kind'], index = 0): ContentNode { return tree.nodes.filter(node => node.kind === kind)[index]! }
function run(state: { html: string; tree: ContentTree }, operations: ContentOperation[], baseline?: ContentTree) { return applyContentOperations({ ...state, operations, baseline }) }
function rejects(action: () => unknown, code: string) { expect(action).toThrow(expect.objectContaining({ code })) }

describe('programmatic content parsing', () => {
  test('indexes multi-element sections and nested headings without changing the source', () => {
    const html = '<main><h1>Guide</h1>\n<p>Intro</p><h2>A</h2><p>One</p><p>Two</p><h3>A.1</h3><p>Three</p><h2>B</h2><p>Four</p></main>'
    const tree = buildContentTree(html, { nextId: ids() })
    const [guide, a, child, b] = tree.nodes.filter(node => node.kind === 'section')
    expect(guide?.title).toBe('Guide')
    expect(a?.parent_id).toBe(guide?.node_id)
    expect(child?.parent_id).toBe(a?.node_id)
    expect(b?.parent_id).toBe(guide?.node_id)
    expect(html.slice(a!.span.start, a!.span.end)).toBe('<h2>A</h2><p>One</p><p>Two</p><h3>A.1</h3><p>Three</p>')
    expect(html.slice(a!.inner_span.start, a!.inner_span.end)).toMatch(/^<p>One<\/p>/)
    expect(a?.selector).toBe(':scope > main:nth-child(1) > h2:nth-child(3)')
    expect(a?.end_selector).toBe(':scope > main:nth-child(1) > p:nth-child(7)')
    expect(tree.nodes.filter(node => node.kind === 'paragraph')).toHaveLength(5)
  })

  test('indexes paragraphs, nested lists and complete table cells', () => {
    const html = '<div><p>Plain</p><ul><li>First<ul><li>Nested</li></ul></li><li><p>Second</p></li></ul><table><tr><th>Head</th><td><p>A</p><p>B</p></td></tr></table></div>'
    const tree = buildContentTree(html)
    expect(tree.nodes.filter(node => node.kind === 'list')).toHaveLength(2)
    expect(tree.nodes.filter(node => node.kind === 'list_item')).toHaveLength(3)
    expect(tree.nodes.filter(node => node.kind === 'row')).toHaveLength(1)
    expect(tree.nodes.filter(node => node.kind === 'cell')).toHaveLength(2)
    expect(node(tree, 'cell', 1).children.map(id => contentNode(tree, id).kind)).toEqual(['paragraph', 'paragraph'])
    expect(node(tree, 'row').selector).toContain('tbody:nth-child(1) > tr:nth-child(1)')
    expect(tree.nodes.filter(node => node.kind !== 'section').every(node => node.title === '')).toBe(true)
  })

  test('keeps code, formulas and images atomic', () => {
    const html = '<pre><code>const x = 1</code></pre><div role="math"><span>x</span></div><figure><img src="x.png"><figcaption>Caption</figcaption></figure><svg><path d="M0 0"/></svg>'
    const tree = buildContentTree(html)
    expect(tree.nodes.slice(1).map(node => node.kind)).toEqual(['code', 'formula', 'image', 'image'])
    expect(tree.nodes.slice(1).every(node => !node.children.length)).toBe(true)
  })

  test('handles untitled and long content without length-based splitting', () => {
    const html = `<div><p>${'text '.repeat(10000)}</p><p>Second</p></div>`
    const tree = buildContentTree(html)
    expect(tree.nodes.slice(1).map(node => node.kind)).toEqual(['paragraph', 'paragraph'])
    expect(tree.nodes[1]!.span.end - tree.nodes[1]!.span.start).toBeGreaterThan(50000)
  })

  test('bounds real heading metadata without splitting UTF-8 code points', () => {
    const tree = buildContentTree(`<h2>${'章节🙂'.repeat(100)}</h2><p>Body remains complete</p>`)
    expect(Buffer.byteLength(node(tree, 'section').title)).toBeLessThanOrEqual(256)
    expect(node(tree, 'section').title).not.toContain('\ufffd')
    expect(node(tree, 'paragraph').title).toBe('')
  })

  test('degrades repaired markup and bare text to a complete block', () => {
    for (const html of ['<div><p>One<div>Two</div></div>', 'bare text <em>with emphasis</em>']) {
      const state = setup(html)
      expect(state.tree.nodes.slice(1).map(node => node.kind)).toEqual(['block'])
      const result = run(state, [{ type: 'replace', node_ids: [node(state.tree, 'block').node_id], html: '<p>Repaired</p>' }])
      expect(result.html).toBe('<p>Repaired</p>')
    }
  })

  test('uses body boundaries for root insertion in a complete HTML document', () => {
    const state = setup('<!doctype html><html><head><style>p{color:red}</style></head><body><p>One</p></body></html>')
    const result = run(state, [{ type: 'insert', parent_id: state.tree.root_id, position: 'start', html: '<p>Zero</p>' }])
    expect(result.html).toContain('<body><p>Zero</p><p>One</p></body>')
    expect(result.html).toContain('<head><style>p{color:red}</style></head>')
  })
})

describe('content identity and source assembly', () => {
  test('retains one-to-one identity and exact unrelated source bytes', () => {
    const state = setup('<div class="layout">\n<h2>A</h2> <p data-x="1">Same</p>\n<p data-x="2">Same</p>\n</div>')
    const first = node(state.tree, 'paragraph'), second = node(state.tree, 'paragraph', 1), section = node(state.tree, 'section')
    const result = run(state, [{ type: 'replace', node_ids: [first.node_id], html: '<p>Changed and longer</p>' }])
    expect(result.html).toBe('<div class="layout">\n<h2>A</h2> <p>Changed and longer</p>\n<p data-x="2">Same</p>\n</div>')
    expect(contentNode(result.tree, first.node_id).revision).toBe(2)
    expect(contentNode(result.tree, second.node_id).revision).toBe(1)
    expect(contentNode(result.tree, second.node_id).position_revision).toBe(1)
    expect(contentNode(result.tree, section.node_id).revision).toBe(2)
    expect(result.tree.revision).toBe(2)
    expect(result.retired_ids).toEqual([])
  })

  test('splits, merges and deletes with explicit successor records', () => {
    const state = setup('<p>A</p><p>B</p>'), a = node(state.tree, 'paragraph')
    const split = run(state, [{ type: 'replace', node_ids: [a.node_id], html: '<p>A1</p><p>A2</p>' }])
    const relation = split.tree.lineage.find(item => item.previous_node_id === a.node_id)!
    expect(relation.reason).toBe('split')
    expect(relation.successor_node_ids).toHaveLength(2)
    rejects(() => contentNode(split.tree, a.node_id), 'CONTENT_NODE_RETIRED')
    const merged = run(split, [{ type: 'replace', node_ids: relation.successor_node_ids, html: '<p>A combined</p>' }])
    expect(merged.tree.lineage.filter(item => relation.successor_node_ids.includes(item.previous_node_id)).map(item => item.reason)).toEqual(['merge', 'merge'])
    const combined = node(merged.tree, 'paragraph')
    const removed = run(merged, [{ type: 'delete', node_ids: [combined.node_id] }])
    expect(removed.html).toBe('<p>B</p>')
    expect(removed.tree.lineage.at(-1)).toMatchObject({ previous_node_id: combined.node_id, successor_node_ids: [], reason: 'deleted' })
  })

  test('keeps a rewritten section while retiring ambiguous repeated descendants', () => {
    const state = setup('<h2>A</h2><p>Same</p><p>Same</p><h2>B</h2><p>Keep</p>')
    const section = node(state.tree, 'section'), oldChildren = [...section.children], outside = node(state.tree, 'section', 1)
    const result = run(state, [{ type: 'replace', node_ids: [section.node_id], html: '<h2>A revised</h2><p>Same</p><p>New</p>' }])
    expect(contentNode(result.tree, section.node_id).title).toBe('A revised')
    expect(contentNode(result.tree, section.node_id).children.some(id => oldChildren.includes(id))).toBe(false)
    expect(oldChildren.every(id => result.retired_ids.includes(id))).toBe(true)
    expect(contentNode(result.tree, outside.node_id).revision).toBe(1)
  })

  test('moves a complete subtree while retaining content and descendant identities', () => {
    const state = setup('<h2>A</h2><ul><li><p>One</p></li><li><p>Two</p></li></ul><h2>B</h2><p>End</p>')
    const list = node(state.tree, 'list'), destination = node(state.tree, 'section', 1), original = state.tree.nodes.filter(item => item.node_id === list.node_id || item.kind === 'list_item' || item.kind === 'paragraph' && item.parent_id !== destination.node_id)
    const result = run(state, [{ type: 'move', node_ids: [list.node_id], parent_id: destination.node_id, position: 'start' }])
    expect(result.html).toBe('<h2>A</h2><h2>B</h2><ul><li><p>One</p></li><li><p>Two</p></li></ul><p>End</p>')
    expect(contentNode(result.tree, list.node_id)).toMatchObject({ parent_id: destination.node_id, revision: 1, position_revision: 2 })
    expect(original.every(old => contentNode(result.tree, old.node_id).revision === old.revision)).toBe(true)
    expect(result.retired_ids).toEqual([])
  })

  test.each([false, true])('keeps replacement identity at a shared source boundary with insert (reversed: %s)', reverse => {
    const state = setup('<p>A</p><p>B</p>'), first = node(state.tree, 'paragraph'), replaced = node(state.tree, 'paragraph', 1)
    const operations: ContentOperation[] = [
      { type: 'replace', node_ids: [replaced.node_id], html: '<p>C</p>' },
      { type: 'insert', parent_id: state.tree.root_id, position: 'after', anchor_id: first.node_id, html: '<p>X</p>' }
    ]
    const result = run(state, reverse ? operations.reverse() : operations)
    const retained = contentNode(result.tree, replaced.node_id), inserted = node(result.tree, 'paragraph', 1)
    expect(result.html).toBe('<p>A</p><p>X</p><p>C</p>')
    expect(result.html.slice(retained.span.start, retained.span.end)).toBe('<p>C</p>')
    expect(retained).toMatchObject({ revision: 2, position_revision: 1 })
    expect([first.node_id, replaced.node_id]).not.toContain(inserted.node_id)
    expect(contentNode(result.tree, first.node_id).revision).toBe(1)
    expect(result.retired_ids).toEqual([])
  })

  test.each([false, true])('keeps both identities at a shared source boundary with move (reversed: %s)', reverse => {
    const state = setup('<p>A</p><p>B</p><p>C</p>'), first = node(state.tree, 'paragraph'), replaced = node(state.tree, 'paragraph', 1), moved = node(state.tree, 'paragraph', 2)
    const operations: ContentOperation[] = [
      { type: 'replace', node_ids: [replaced.node_id], html: '<p>Y</p>' },
      { type: 'move', node_ids: [moved.node_id], parent_id: state.tree.root_id, position: 'after', anchor_id: first.node_id }
    ]
    const result = run(state, reverse ? operations.reverse() : operations)
    const retained = contentNode(result.tree, replaced.node_id), destination = contentNode(result.tree, moved.node_id)
    expect(result.html).toBe('<p>A</p><p>C</p><p>Y</p>')
    expect(result.html.slice(retained.span.start, retained.span.end)).toBe('<p>Y</p>')
    expect(result.html.slice(destination.span.start, destination.span.end)).toBe('<p>C</p>')
    expect(retained).toMatchObject({ revision: 2, position_revision: 1 })
    expect(destination).toMatchObject({ revision: 1, position_revision: 2 })
    expect(result.retired_ids).toEqual([])
  })

  test('keeps list item and cell shells when replacing their inner content', () => {
    const state = setup('<ul><li class="retained">Old</li></ul><table><tr><td data-key="cell">Old</td></tr></table>')
    const item = node(state.tree, 'list_item'), cell = node(state.tree, 'cell')
    const result = run(state, [{ type: 'replace', node_ids: [item.node_id], html: '<p>Item</p><p>More</p>' }, { type: 'replace', node_ids: [cell.node_id], html: '<strong>Cell</strong>' }])
    expect(result.html).toBe('<ul><li class="retained"><p>Item</p><p>More</p></li></ul><table><tr><td data-key="cell"><strong>Cell</strong></td></tr></table>')
    expect(contentNode(result.tree, item.node_id).revision).toBe(2)
    expect(contentNode(result.tree, cell.node_id).revision).toBe(2)
  })

  test('inserts at exact edges and in an empty list', () => {
    const state = setup('<div><p>Middle</p><ul></ul></div>'), middle = node(state.tree, 'paragraph'), list = node(state.tree, 'list')
    const result = run(state, [{ type: 'insert', parent_id: state.tree.root_id, position: 'before', anchor_id: middle.node_id, html: '<p>First</p>' }, { type: 'insert', parent_id: list.node_id, position: 'end', html: '<li>Item</li>' }])
    expect(result.html).toBe('<div><p>First</p><p>Middle</p><ul><li>Item</li></ul></div>')
    expect(contentNode(result.tree, middle.node_id).revision).toBe(1)
    expect(node(result.tree, 'list_item').parent_id).toBe(list.node_id)
  })
})

describe('bounded content conflicts and validation', () => {
  test('merges independent stale-snapshot paragraph writes into the latest source', () => {
    const initial = setup('<h2>A</h2><p>One</p><p>Two</p>'), first = node(initial.tree, 'paragraph'), second = node(initial.tree, 'paragraph', 1)
    const latest = run(initial, [{ type: 'replace', node_ids: [second.node_id], html: '<p>Two revised</p>' }])
    const result = run(latest, [{ type: 'replace', node_ids: [first.node_id], html: '<p>One revised</p>' }], initial.tree)
    expect(result.html).toBe('<h2>A</h2><p>One revised</p><p>Two revised</p>')
    rejects(() => run(latest, [{ type: 'replace', node_ids: [second.node_id], html: '<p>Stale</p>' }], initial.tree), 'CONTENT_BASELINE_STALE')
    rejects(() => run(latest, [{ type: 'replace', node_ids: [node(initial.tree, 'section').node_id], html: '<h2>Stale</h2>' }], initial.tree), 'CONTENT_BASELINE_STALE')
  })

  test('checks only the actual insertion gap rather than the whole parent revision', () => {
    const initial = setup('<p>A</p><p>B</p><p>C</p>'), a = node(initial.tree, 'paragraph'), c = node(initial.tree, 'paragraph', 2)
    const latest = run(initial, [{ type: 'insert', parent_id: initial.tree.root_id, position: 'after', anchor_id: c.node_id, html: '<p>D</p>' }])
    const result = run(latest, [{ type: 'insert', parent_id: initial.tree.root_id, position: 'before', anchor_id: a.node_id, html: '<p>Zero</p>' }], initial.tree)
    expect(result.html).toBe('<p>Zero</p><p>A</p><p>B</p><p>C</p><p>D</p>')
    rejects(() => run(latest, [{ type: 'insert', parent_id: initial.tree.root_id, position: 'after', anchor_id: c.node_id, html: '<p>Conflicting</p>' }], initial.tree), 'CONTENT_POSITION_STALE')
  })

  test('exposes subtree and precise gap scopes without a destination parent write lock', () => {
    const state = setup('<h2>A</h2><p>One</p><p>Two</p>'), section = node(state.tree, 'section'), first = node(state.tree, 'paragraph'), second = node(state.tree, 'paragraph', 1)
    expect(contentScopeOverlaps(state.tree, [section.node_id], [first.node_id])).toBe(true)
    expect(contentScopeOverlaps(state.tree, [first.node_id], [second.node_id])).toBe(false)
    const scope = contentOperationScope(state.tree, [{ type: 'move', node_ids: [first.node_id], parent_id: section.node_id, position: 'after', anchor_id: second.node_id }])
    expect(scope.node_ids).toEqual([first.node_id])
    expect(scope.gaps).toEqual([{ parent_id: section.node_id, position: 'after', anchor_id: second.node_id, before_id: second.node_id, after_id: null }])
  })

  test('rejects parent-child overlap and noncontiguous groups atomically', () => {
    const state = setup('<h2>A</h2><p>One</p><p>Two</p><p>Three</p>'), section = node(state.tree, 'section'), first = node(state.tree, 'paragraph'), third = node(state.tree, 'paragraph', 2)
    rejects(() => run(state, [{ type: 'replace', node_ids: [section.node_id, first.node_id], html: '<p>Bad</p>' }]), 'CONTENT_RANGE_INVALID')
    rejects(() => run(state, [{ type: 'replace', node_ids: [section.node_id], html: '<h2>New</h2>' }, { type: 'delete', node_ids: [first.node_id] }]), 'CONTENT_RANGE_OVERLAP')
    rejects(() => run(state, [{ type: 'replace', node_ids: [first.node_id, third.node_id], html: '<p>Bad</p>' }]), 'CONTENT_RANGE_INVALID')
    expect(state.html).toBe('<h2>A</h2><p>One</p><p>Two</p><p>Three</p>')
  })

  test('rejects cycles, invalid anchors and parser repair outside the target', () => {
    const state = setup('<ul><li><p>One</p></li></ul><p>Outside</p>'), list = node(state.tree, 'list'), item = node(state.tree, 'list_item'), paragraph = node(state.tree, 'paragraph')
    rejects(() => run(state, [{ type: 'move', node_ids: [list.node_id], parent_id: item.node_id, position: 'start' }]), 'CONTENT_MOVE_CYCLE')
    rejects(() => run(state, [{ type: 'insert', parent_id: list.node_id, position: 'after', anchor_id: paragraph.node_id, html: '<li>Bad</li>' }]), 'CONTENT_ANCHOR_INVALID')
    rejects(() => run(state, [{ type: 'insert', parent_id: list.node_id, position: 'end', html: '<p>Bad</p>' }]), 'CONTENT_CONTAINER_INVALID')
    rejects(() => run(state, [{ type: 'replace', node_ids: [paragraph.node_id], html: '<p>Unclosed<div>Moved</div>' }]), 'CONTENT_FRAGMENT_INVALID')
  })

  test('rejects headings that capture or reparent unrelated content', () => {
    const state = setup('<p>One</p><p>Outside</p>'), first = node(state.tree, 'paragraph')
    rejects(() => run(state, [{ type: 'replace', node_ids: [first.node_id], html: '<h1>New section</h1>' }]), 'CONTENT_FRAGMENT_INVALID')
    const nested = setup('<h2>A</h2><h3>Sub</h3><p>Inside</p>'), section = node(nested.tree, 'section')
    rejects(() => run(nested, [{ type: 'insert', parent_id: section.node_id, position: 'end', html: '<p>Wrong container</p>' }]), 'CONTENT_CONTAINER_INVALID')
  })

  test('does not revive a previously retired identity', () => {
    const state = setup('<p>One</p>'), target = node(state.tree, 'paragraph')
    const removed = run(state, [{ type: 'delete', node_ids: [target.node_id] }])
    rejects(() => applyContentOperations({ ...removed, operations: [{ type: 'insert', parent_id: removed.tree.root_id, position: 'end', html: '<p>New</p>' }], nextId: () => target.node_id }), 'CONTENT_ID_INVALID')
  })
})

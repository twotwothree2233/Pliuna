import { describe, expect, test } from 'vitest'
import type { Bundle, ChapterDependency, ChapterManifest, ChapterRegion } from '../../src/shared/contracts.generated'
import { assembleChapterUpdate, chapterCandidateTemplate, chapterContext, chapterDependencyValid, chapterInput, deriveChapterMapping, validateChapterCandidate, validateChapterMapping } from '../../src/runtime/runner/chapter-content'
import defaults from '../../src/shared/contracts/development-defaults.json'
import { buildContentTree } from '../../src/runtime/runner/content-tree'

function bundle(html = '<section><h2 id="a-title">Alpha</h2><div id="a-body"><p>Alpha original</p></div></section>\n<section><h2 id="b-title">Beta</h2><div id="b-body"><p>Beta original</p></div></section>'): Bundle {
  return { profile: 'managed-v1', html, css: '/* shared */\np { line-height: 1.5; }\n#a-body p { color: red; }\n#b-body p { color: blue; }', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'v1' }, forms: [], behaviors: [], references: [], export: [] }
}
function chapter(name: string, title: string, revision = 1): ChapterRegion {
  return { region_id: name, revision, title, title_selector: '#' + name + '-title', body_selector: '#' + name + '-body', dependencies: [], ownership: { form_ids: [], behavior_ids: [], reference_ids: [], export_ids: [], css_selectors: [`#${name}-body p`] } }
}
function manifest(chapters = [chapter('a', 'Alpha'), chapter('b', 'Beta')]): ChapterManifest {
  return { task_id: 'task', view_id: 'view', view_revision: 1, state_revision: 1, bundle_resource_id: 'source', manifest_revision: 1, shared_revision: 1, request_id: 'request', intent_revision: 1, chapters: [chapters[0]!, ...chapters.slice(1)] }
}
function revised(original: Bundle, name: string, content: string): Bundle {
  return { ...original, html: original.html.replace(`${name === 'a' ? 'Alpha' : 'Beta'} original`, content) }
}
function update(original: Bundle, current: ChapterManifest, name: string, content: string) {
  return assembleChapterUpdate({ latest: { bundle: original, manifest: current }, baseline: current, candidate: revised(original, name, content), replacements: [{ previous_region_ids: [name], chapters: [{ ...current.chapters.find(item => item.region_id === name)!, revision: 2 }] }], dependencies: [] })
}
function checkError(action: () => unknown, code: string): void {
  expect(action).toThrow(expect.objectContaining({ code }))
}

describe('stable chapter mapping', () => {
  test('registers multiple existing chapter roots without rewriting content or shared metadata', () => {
    const original = bundle('<article><h2>One</h2><div><p>Original <em>text</em></p></div></article><section><h2>Two</h2><div><p>Another chapter</p></div></section>')
    const mapped = deriveChapterMapping(original, { view_id: 'view' })
    expect(mapped.chapters).toHaveLength(2)
    expect(mapped.chapters.map(item => item.title)).toEqual(['One', 'Two'])
    expect(mapped.bundle).toBe(original)
    expect(mapped.chapters[0]!.title_selector).toBe(':scope > article:nth-child(1) > h2:nth-child(1)')
    expect(mapped.chapters[0]!.body_selector).toBe(':scope > article:nth-child(1) > div:nth-child(2)')
    expect(mapped.bundle.state).toBe(original.state)
    expect(mapped.bundle.references).toBe(original.references)
    expect(mapped.bundle.css).toBe(original.css)
    validateChapterMapping(mapped.bundle, mapped.chapters)
  })

  test('retains established element and chapter identities across a title change', () => {
    const source = bundle()
    const mapped = deriveChapterMapping(source, { view_id: 'view' }, (() => { let next = 0; return () => 'stable-' + ++next })())
    expect(mapped.bundle.html).toBe(source.html)
    const changed = { ...source, html: source.html.replace('>Alpha</h2>', '>Renamed</h2>') }
    validateChapterMapping(changed, [{ ...mapped.chapters[0]!, title: 'Renamed' }, mapped.chapters[1]!])
    expect(mapped.chapters[0]!.region_id).toBe('stable-1')
  })

  test('uses a virtual content section for multiple paragraphs while retaining the legacy boundary rule', () => {
    const original = bundle('<section><h2>Title</h2><p>First paragraph</p><p>Second paragraph</p></section>')
    const tree = buildContentTree(original.html), section = tree.nodes.find(node => node.kind === 'section')!
    expect(section.children.map(id => tree.nodes.find(node => node.node_id === id)!.kind)).toEqual(['paragraph', 'paragraph'])
    expect(original.html.slice(section.span.start, section.span.end)).toBe('<h2>Title</h2><p>First paragraph</p><p>Second paragraph</p>')
    checkError(() => deriveChapterMapping(original, { view_id: 'view' }), 'CHAPTER_MAPPING_REQUIRED')
    expect(original.html).toContain('<p>First paragraph</p><p>Second paragraph</p>')
  })

  test('rejects duplicate identities, nonadjacent boundaries and overlapping roots', () => {
    checkError(() => validateChapterMapping(bundle(), [chapter('a', 'Alpha'), chapter('a', 'Alpha')]), 'CHAPTER_MAPPING_INVALID')
    const nonadjacent = bundle('<h2 id="a-title">Alpha</h2><p>Unmapped</p><div id="a-body">Body</div>')
    checkError(() => validateChapterMapping(nonadjacent, [chapter('a', 'Alpha')]), 'CHAPTER_MAPPING_INVALID')
    const nested = bundle('<h2 id="a-title">Alpha</h2><div id="a-body"><h2 id="b-title">Beta</h2><div id="b-body">Body</div></div>')
    checkError(() => validateChapterMapping(nested, [chapter('a', 'Alpha'), chapter('b', 'Beta')]), 'CHAPTER_MAPPING_INVALID')
  })

  test('rejects ambiguous element identities and inaccurate title metadata', () => {
    checkError(() => validateChapterMapping(bundle('<h2 id="a-title">Alpha</h2><div id="a-body"><span id="a-body">duplicate</span></div>'), [chapter('a', 'Alpha')]), 'CHAPTER_MAPPING_INVALID')
    checkError(() => validateChapterMapping(bundle(), [chapter('a', 'Wrong')]), 'CHAPTER_MAPPING_INVALID')
  })

  test('refuses a local stylesheet that escapes through a sibling or relational selector', () => {
    for (const selector of ['#a-body + #b-body', 'p', ':is(#a-body,#b-body)', '#a-body:has(+ #b-body)']) {
      const region = chapter('a', 'Alpha'); region.ownership.css_selectors = [selector]
      checkError(() => validateChapterMapping(bundle(), [region]), 'CHAPTER_STYLE_SCOPE')
    }
  })

  test('rejects claiming another chapter control or a shared form', () => {
    const source = bundle('<h2 id="a-title">Alpha</h2><div id="a-body"><input id="x"></div><h2 id="b-title">Beta</h2><div id="b-body"><button id="submit">Send</button></div>')
    source.state = { schema: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false }, initial: { x: '' }, compatibility_version: 'v1' }
    source.behaviors = [{ type: 'input', element_id: 'x', field: '/x', control: 'text' }, { type: 'submit', element_id: 'submit', form_id: 'shared' }]
    source.forms = [{ id: 'shared', fields: ['/x'] }]
    const regions = [chapter('a', 'Alpha'), chapter('b', 'Beta')]
    regions[0]!.ownership.behavior_ids = ['x']; regions[1]!.ownership.behavior_ids = ['submit']
    validateChapterMapping(source, regions)
    regions[0]!.ownership.form_ids = ['shared']
    checkError(() => validateChapterMapping(source, regions), 'CHAPTER_OWNERSHIP_INVALID')
  })
})

describe('replacement chapter containers', () => {
  test('keeps legacy heading and paragraph mappings readable without rewriting them', () => {
    const source = bundle('<article><h3>Alpha</h3><p>Legacy paragraph</p></article>'), original = structuredClone(source)
    const mapped = deriveChapterMapping(source, { view_id: 'view' }, () => 'legacy')
    expect(mapped.chapters[0]!.body_selector).toBe(':scope > article:nth-child(1) > p:nth-child(2)')
    expect(() => validateChapterMapping(source, mapped.chapters)).not.toThrow()
    expect(source).toEqual(original)
  })

  test('rejects a replacement paragraph that leaves the remaining content outside its boundary', () => {
    const candidate = bundle('<h3 id="a-title">Alpha</h3><p id="a-body">Opening paragraph</p><p>Remaining paragraph</p><table><tbody><tr><td>Remaining table</td></tr></tbody></table>')
    const chapters = [chapter('a', 'Alpha', 2)]
    expect(() => validateChapterMapping(candidate, chapters)).not.toThrow()
    checkError(() => validateChapterCandidate(candidate, chapters), 'CHAPTER_MAPPING_INVALID')
  })

  test.each(['div', 'section', 'article', 'main'])('accepts complete multi-part replacement content inside one %s', container => {
    const body = '<p>Opening paragraph</p><p>Further explanation</p><table><thead><tr><th>Input</th><th>Result</th></tr></thead><tbody><tr><td>2</td><td>4</td></tr></tbody></table><section class="example"><h4>Worked example</h4><ol><li>Choose an input.</li><li>Compare the result.</li></ol></section>'
    const candidate = bundle(`<h3 id="a-title">Alpha</h3><${container} id="a-body">${body}</${container}>`), original = structuredClone(candidate)
    expect(() => validateChapterCandidate(candidate, [chapter('a', 'Alpha', 2)])).not.toThrow()
    expect(candidate).toEqual(original)
  })

  test('does not impose replacement containers on unselected snapshot chapters', () => {
    const source = bundle('<h3 id="a-title">Alpha</h3><div id="a-body"><p>Alpha original</p></div><h3 id="b-title">Beta</h3><p id="b-body">Beta original</p>')
    const baseline = manifest(), replacement = chapter('a', 'Alpha', 2)
    const candidate = revised(source, 'a', 'Alpha revised')
    candidate.html = candidate.html.replace('Beta original', 'Unselected candidate edit')
    expect(() => validateChapterMapping(candidate, [replacement, baseline.chapters[1]!])).not.toThrow()
    expect(() => validateChapterCandidate(candidate, [replacement])).not.toThrow()
    checkError(() => validateChapterCandidate(candidate, [baseline.chapters[1]!]), 'CHAPTER_MAPPING_INVALID')
    const output = assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [replacement] }], dependencies: [] })
    expect(output.bundle.html).toContain('Alpha revised')
    expect(output.bundle.html).toContain('<p id="b-body">Beta original</p>')
    expect(output.bundle.html).not.toContain('Unselected candidate edit')
    expect(source.html).toContain('Alpha original')
  })
})

describe('host chapter candidate templates', () => {
  test('preserves established boundaries and shared content in an isolated selected template', () => {
    const source = bundle(), baseline = manifest(), original = structuredClone({ source, baseline })
    const dependencies: ChapterDependency[] = [{ kind: 'chapter', task_id: 'task', view_id: 'view', revision: 1 }]
    const input = chapterInput(source, baseline, ['a'], dependencies), originalInput = structuredClone(input)
    const template = chapterCandidateTemplate(source, baseline, ['a'], dependencies)
    expect(template.chapters).toEqual([{ ...baseline.chapters[0]!, revision: 2, dependencies }])
    expect(template.bundle.html).toBe(input.chapters[0]!.html)
    expect(template.bundle.html).not.toContain('Beta original')
    expect(template.bundle.css).toContain('/* shared */\np { line-height: 1.5; }')
    expect(template.bundle.css).toContain('#a-body p { color: red; }')
    expect(template.bundle.css).not.toContain('#b-body')
    expect(template.bundle.state).toEqual(source.state)
    expect(template.bundle.state).not.toBe(source.state)
    expect(template.chapters[0]!.ownership).not.toBe(baseline.chapters[0]!.ownership)
    expect(() => validateChapterCandidate(template.bundle, template.chapters)).not.toThrow()
    expect({ source, baseline }).toEqual(original)
    expect(input).toEqual(originalInput)
  })

  test('wraps an entire legacy paragraph and adds boundaries without serializing its markup', () => {
    const heading = '<h3 class="title">Alpha <em>example</em></h3>'
    const paragraph = '<p class="intro" data-note=\'kept\'>Original <em>details</em></p>'
    const prefix = '<article class="source">', suffix = '</article>'
    const source = bundle(prefix + heading + '\n<!-- gap -->\n' + paragraph + suffix)
    source.css = '/* shared */\np { line-height: 1.5; }'
    const mapped = deriveChapterMapping(source, { view_id: 'view' }, () => 'alpha'), baseline = manifest(mapped.chapters)
    const original = structuredClone({ source, baseline }), input = chapterInput(source, baseline, ['alpha'])
    const template = chapterCandidateTemplate(source, baseline, ['alpha'])
    const region = template.chapters[0]!, titleId = region.title_selector.slice(1), bodyId = region.body_selector.slice(1)
    expect(region.title_selector).toMatch(/^#[A-Za-z][\w-]*$/)
    expect(region.body_selector).toMatch(/^#[A-Za-z][\w-]*$/)
    expect(titleId).not.toBe(bodyId)
    expect(template.bundle.html).toBe(`<h3 id="${titleId}" class="title">Alpha <em>example</em></h3>\n<!-- gap -->\n<div id="${bodyId}">${paragraph}</div>`)
    expect(template.bundle.css).toBe(source.css)
    expect(input.chapters[0]!.html).toBe(heading + '\n<!-- gap -->\n' + paragraph)
    const assembled = assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate: template.bundle, replacements: [{ previous_region_ids: ['alpha'], chapters: template.chapters }], dependencies: [] })
    expect(assembled.bundle.html).toBe(prefix + template.bundle.html + suffix)
    expect({ source, baseline }).toEqual(original)
  })

  test.each(['div', 'section', 'article', 'main'])('adds identities to an existing %s without rewriting its content', container => {
    const tag = container.toUpperCase(), content = '<p>First paragraph</p><p>Second paragraph</p><table><tbody><tr><td>Example</td></tr></tbody></table>'
    const source = bundle(`<H3 data-kind="heading">Alpha</H3><${tag} class="chapter">${content}</${tag}>`)
    source.css = 'p { line-height: 1.5; }'
    const mapped = deriveChapterMapping(source, { view_id: 'view' }, () => 'alpha'), baseline = manifest(mapped.chapters), original = structuredClone(source)
    const template = chapterCandidateTemplate(source, baseline, ['alpha']), region = template.chapters[0]!
    expect(template.bundle.html).toBe(`<H3 id="${region.title_selector.slice(1)}" data-kind="heading">Alpha</H3><${tag} id="${region.body_selector.slice(1)}" class="chapter">${content}</${tag}>`)
    expect(() => validateChapterCandidate(template.bundle, template.chapters)).not.toThrow()
    expect(source).toEqual(original)
  })

  test('keeps same-title selections in requested order and excludes explicit dependency chapters', () => {
    const source = bundle('<article><h3>Repeated title</h3><p>First body</p><h3>Repeated title</h3><div><p>Second body</p></div><h3>Reference</h3><p>Dependency body</p><h3>Outside</h3><p>Unselected body</p></article>')
    source.css = 'p { line-height: 1.5; }'
    let next = 0
    const mapped = deriveChapterMapping(source, { view_id: 'view' }, () => ['first', 'second', 'reference', 'outside'][next++]!)
    mapped.chapters.forEach((chapter, index) => { chapter.revision = index + 2 })
    const baseline = manifest(mapped.chapters), dependencies: ChapterDependency[] = [{ kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'reference', revision: 4 }]
    const original = structuredClone({ source, baseline, dependencies }), input = chapterInput(source, baseline, ['second', 'first'], dependencies), originalInput = structuredClone(input)
    const template = chapterCandidateTemplate(source, baseline, ['second', 'first'], dependencies)
    expect(template.chapters.map(chapter => [chapter.region_id, chapter.revision, chapter.title])).toEqual([['second', 4, 'Repeated title'], ['first', 3, 'Repeated title']])
    expect(template.chapters.map(chapter => chapter.dependencies)).toEqual([dependencies, dependencies])
    expect(template.chapters[0]!.dependencies).not.toBe(dependencies)
    expect(template.chapters[0]!.dependencies).not.toBe(template.chapters[1]!.dependencies)
    expect(template.bundle.html.indexOf('Second body')).toBeLessThan(template.bundle.html.indexOf('First body'))
    expect(template.bundle.html).not.toContain('Dependency body')
    expect(template.bundle.html).not.toContain('Unselected body')
    expect(input.chapters.map(chapter => chapter.region_id)).toEqual(['second', 'first', 'reference'])
    expect(input).toEqual(originalInput)
    expect({ source, baseline, dependencies }).toEqual(original)
    const stale = [{ ...dependencies[0]!, revision: 99 }]
    checkError(() => chapterCandidateTemplate(source, baseline, ['first'], stale), 'CHAPTER_DEPENDENCY_CONFLICT')
  })

  test('narrows paragraph-owned CSS while preserving original targets and shared rules during assembly', () => {
    const paragraph = '<p id="a-body" class="intro">Original <span id="a-value">value</span></p>'
    const source = bundle('<h3 id="a-title" class="title">Alpha</h3>' + paragraph + '<h3 id="b-title">Beta</h3><div id="b-body"><p>Beta original</p></div>')
    const sharedCss = '/* shared stays exact */\np { line-height: 1.5; }\n'
    source.css = sharedCss + '#a-body { color: red; }\n#b-body p { color: blue; }'
    source.state = { schema: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false }, initial: { message: 'value' }, compatibility_version: 'v1' }
    source.behaviors = [{ type: 'text', element_id: 'a-value', field: '/message' }]
    source.export = [{ id: 'alpha-export', category: 'learning', source: { type: 'element', element_id: 'a-body' } }, { id: 'beta-export', category: 'learning', source: { type: 'element', element_id: 'b-body' } }]
    const baseline = manifest()
    baseline.chapters[0]!.ownership = { form_ids: [], behavior_ids: ['a-value'], reference_ids: [], export_ids: ['alpha-export'], css_selectors: ['#a-body'] }
    baseline.chapters[1]!.ownership.export_ids = ['beta-export']
    const original = structuredClone({ source, baseline }), template = chapterCandidateTemplate(source, baseline, ['a']), region = template.chapters[0]!
    expect(region.title_selector).toBe('#a-title')
    expect(region.body_selector).not.toBe('#a-body')
    expect(template.bundle.html).toContain(`<div id="${region.body_selector.slice(1)}">${paragraph}</div>`)
    expect(region.ownership).toEqual({ ...baseline.chapters[0]!.ownership, css_selectors: [region.body_selector + ' #a-body'] })
    expect(template.bundle.css).toContain(sharedCss)
    expect(template.bundle.css).toContain(region.body_selector + ' #a-body { color: red; }')
    expect(template.bundle.css).not.toContain('#b-body')
    expect(template.bundle.behaviors).toEqual(source.behaviors)
    expect(template.bundle.export).toEqual([source.export[0]])
    const assembled = assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate: template.bundle, replacements: [{ previous_region_ids: ['a'], chapters: template.chapters }], dependencies: [] })
    expect(assembled.bundle.css).toContain(sharedCss)
    expect(assembled.bundle.css).toContain('#b-body p { color: blue; }')
    expect(assembled.bundle.html).toContain('Beta original')
    expect(assembled.bundle.export).toEqual(expect.arrayContaining(source.export))
    expect(assembled.bundle.export).toHaveLength(source.export.length)
    expect({ source, baseline }).toEqual(original)
  })

  test.each(['owned', 'shared'])('preserves the %s boundary of embedded paragraph styles', kind => {
    const style = (kind === 'shared' ? 'p{line-height:1.5}' : '') + '#a-body{color:red}'
    const source = bundle(`<h3 id="a-title">Alpha</h3><p id="a-body"><style>${style}</style>Alpha original</p>`)
    source.css = '/* global */\np { line-height: 1.5; }'
    const baseline = manifest([chapter('a', 'Alpha')]); baseline.chapters[0]!.ownership.css_selectors = ['#a-body']
    const original = structuredClone(source), template = chapterCandidateTemplate(source, baseline, ['a'])
    const expected = kind === 'shared' ? style : template.chapters[0]!.body_selector + ' ' + style
    expect(template.bundle.html).toContain(`<style>${expected}</style>`)
    expect(() => assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate: template.bundle, replacements: [{ previous_region_ids: ['a'], chapters: template.chapters }], dependencies: [] })).not.toThrow()
    expect(source).toEqual(original)
  })

  test('replaces empty boundary attributes without adding duplicate identities', () => {
    const source = bundle('<h3 id="" class="title">Alpha</h3><div id=\'\' class="body"><p>Original</p></div>')
    source.css = ''
    const mapped = deriveChapterMapping(source, { view_id: 'view' }, () => 'alpha'), baseline = manifest(mapped.chapters), original = structuredClone(source)
    const template = chapterCandidateTemplate(source, baseline, ['alpha'])
    expect(template.bundle.html).toBe(`<h3 id="${template.chapters[0]!.title_selector.slice(1)}" class="title">Alpha</h3><div id="${template.chapters[0]!.body_selector.slice(1)}" class="body"><p>Original</p></div>`)
    expect(() => validateChapterCandidate(template.bundle, template.chapters)).not.toThrow()
    expect(source).toEqual(original)
  })
})

describe('current-base chapter assembly', () => {
  test('takes only the chosen chapter from a full document candidate', () => {
    const source = bundle(), baseline = manifest()
    const candidate = revised(revised(source, 'a', 'Alpha revised'), 'b', 'Unselected malicious edit')
    const output = assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('a', 'Alpha', 2)] }], dependencies: [] })
    expect(output.bundle.html).toContain('Alpha revised')
    expect(output.bundle.html).toContain('Beta original')
    expect(output.bundle.html).not.toContain('Unselected malicious edit')
    expect(output.bundle.state).toBe(source.state)
    expect(output.kept.map(item => item.region_id)).toEqual(['b'])
    expect(output.bundle.css).toContain('/* shared */\np { line-height: 1.5; }')
    expect(output.bundle.css).toContain('#b-body p { color: blue; }')
  })

  test('assembles fresh ID boundaries from a bounded nested chapter without changing outside source', () => {
    const prefix = '<!-- retained prefix -->\n<article class="lesson"><div class="chapters">\n  '
    const selected = '<h3>Alpha</h3>\n  <p>Alpha original <em>details</em></p>'
    const suffix = '\n  <!-- retained separator -->\n  <h3>Beta</h3>\n  <p>Beta original <strong>details</strong></p>\n</div></article>\n<footer>Retained footer</footer>'
    const source = bundle(prefix + selected + suffix); source.css = 'p{line-height:1.5}'
    let next = 0
    const mapped = deriveChapterMapping(source, { view_id: 'view' }, () => ['a', 'b'][next++]!)
    const baseline = manifest(mapped.chapters), context = chapterContext(source, baseline, ['a'])
    expect(context.html).toBe(selected)
    const candidate = { ...context, html: '<h3 id="revised-alpha-title">Alpha revised</h3>\n<div id="revised-alpha-body"><p>First revised paragraph</p><p>Second revised paragraph</p></div>' }
    const original = baseline.chapters[0]!
    const replacement: ChapterRegion = { ...original, revision: original.revision + 1, title: 'Alpha revised', title_selector: '#revised-alpha-title', body_selector: '#revised-alpha-body' }
    checkError(() => assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [{ ...replacement, title_selector: original.title_selector, body_selector: original.body_selector }] }], dependencies: [] }), 'CHAPTER_MAPPING_INVALID')
    const output = assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [replacement] }], dependencies: [] })
    expect(output.bundle.html).toBe(prefix + candidate.html + suffix)
    expect(output.chapters[0]).toEqual(replacement)
    expect(output.chapters[1]).toEqual(baseline.chapters[1])
    expect(output.kept.map(item => item.region_id)).toEqual(['b'])
    expect(chapterContext(output.bundle, manifest(output.chapters), ['a']).html).toBe(candidate.html)
    expect(chapterContext(output.bundle, manifest(output.chapters), ['b']).html).toBe(chapterContext(source, baseline, ['b']).html)
    expect(source.html).toBe(prefix + selected + suffix)
    validateChapterMapping(output.bundle, output.chapters)
  })

  test('merges independently generated chapters in either completion order', () => {
    const source = bundle(), baseline = manifest()
    const first = update(source, baseline, 'a', 'Alpha new')
    const current = { ...manifest(first.chapters), view_revision: 2, manifest_revision: 2, bundle_resource_id: 'new-a' }
    const second = assembleChapterUpdate({ latest: { bundle: first.bundle, manifest: current }, baseline, candidate: revised(source, 'b', 'Beta new'), replacements: [{ previous_region_ids: ['b'], chapters: [chapter('b', 'Beta', 2)] }], dependencies: [] })
    expect(second.bundle.html).toContain('Alpha new')
    expect(second.bundle.html).toContain('Beta new')
    expect(second.chapters.map(item => item.revision)).toEqual([2, 2])
  })

  test('rejects a changed selected chapter, shared revision or actual read dependency', () => {
    const source = bundle(), baseline = manifest()
    const baseInput = { latest: { bundle: source, manifest: baseline }, baseline, candidate: source, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('a', 'Alpha', 2)] }], dependencies: [] }
    checkError(() => assembleChapterUpdate({ ...baseInput, latest: { bundle: source, manifest: { ...baseline, chapters: [chapter('a', 'Alpha', 2), chapter('b', 'Beta')] } } }), 'CHAPTER_BASELINE_CONFLICT')
    checkError(() => assembleChapterUpdate({ ...baseInput, latest: { bundle: source, manifest: { ...baseline, shared_revision: 2 } } }), 'CHAPTER_DEPENDENCY_CONFLICT')
    const dependency: ChapterDependency = { kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'b', revision: 1 }
    checkError(() => assembleChapterUpdate({ ...baseInput, dependencies: [dependency], latest: { bundle: source, manifest: { ...baseline, chapters: [chapter('a', 'Alpha'), chapter('b', 'Beta', 2)] } } }), 'CHAPTER_DEPENDENCY_CONFLICT')
  })

  test('records invalid retained contributions without rewriting them', () => {
    const source = bundle(), baseline = manifest()
    baseline.chapters[1]!.dependencies = [{ kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'a', revision: 1 }]
    const output = update(source, baseline, 'a', 'Alpha changed')
    expect(output.invalid_kept_region_ids).toEqual(['b'])
    expect(output.bundle.html).toContain('Beta original')
  })

  test('keeps one-to-one identity and refuses output omission', () => {
    const source = bundle(), baseline = manifest()
    const input = { latest: { bundle: source, manifest: baseline }, baseline, candidate: source, dependencies: [] }
    checkError(() => assembleChapterUpdate({ ...input, replacements: [{ previous_region_ids: ['a'], chapters: [] }] }), 'CHAPTER_REPLACEMENT_INVALID')
    const candidate = bundle('<h2 id="new-title">New</h2><div id="new-body">New body</div>'); candidate.css = ''
    checkError(() => assembleChapterUpdate({ ...input, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('new', 'New')] }] }), 'CHAPTER_REPLACEMENT_INVALID')
  })

  test('installs a complete split group and retains unselected text', () => {
    const source = bundle(), baseline = manifest()
    const candidate = bundle('<h2 id="one-title">One</h2><div id="one-body"><p>First half</p></div><h2 id="two-title">Two</h2><div id="two-body"><p>Second half</p></div>'); candidate.css = ''
    const output = assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('one', 'One'), chapter('two', 'Two')] }], dependencies: [] })
    expect(output.chapters.map(item => item.region_id)).toEqual(['one', 'two', 'b'])
    expect(output.bundle.html).toContain('Beta original')
    expect(output.bundle.html).not.toContain('Alpha original')
  })

  test('repositions structural selectors after splitting a sibling chapter', () => {
    const source = bundle('<main><h2>Alpha</h2><div><p>Alpha original</p></div><h2>Beta</h2><div><p>Beta original</p></div></main>'); source.css = 'p{line-height:1.5}'
    let number = 0
    const mapping = deriveChapterMapping(source, { view_id: 'view' }, () => ++number === 1 ? 'a' : 'b')
    const baseline = manifest(mapping.chapters)
    const candidate = bundle('<h2>One</h2><div><p>First half</p></div><h2>Two</h2><div><p>Second half</p></div>'); candidate.css = ''
    let next = 0
    const proposed = deriveChapterMapping(candidate, { view_id: 'candidate' }, () => ++next === 1 ? 'one' : 'two')
    const output = assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: proposed.chapters }], dependencies: [] })
    const beta = output.chapters.find(item => item.region_id === 'b')!
    expect(beta.revision).toBe(1)
    expect(beta.title_selector).toBe(':scope > main:nth-child(1) > h2:nth-child(5)')
    expect(beta.body_selector).toBe(':scope > main:nth-child(1) > div:nth-child(6)')
    expect(output.bundle.html).toContain('Beta original')
    validateChapterMapping(output.bundle, output.chapters)
    expect(chapterContext(output.bundle, manifest(output.chapters), ['b']).html).toContain('Beta original')
  })

  test('maps full HTML documents using the rendered wrapper paths', () => {
    const source = bundle('<!doctype html><html><head><style>p{line-height:1.5}</style></head><body><h2>Alpha</h2><div><p>Alpha original</p></div></body></html>'); source.css = ''
    const mapped = deriveChapterMapping(source, { view_id: 'view' })
    expect(mapped.bundle).toBe(source)
    expect(mapped.chapters[0]!.title_selector).toBe(':scope > div:nth-child(1) > div:nth-child(2) > h2:nth-child(1)')
    validateChapterMapping(source, mapped.chapters)
  })

  test('merges an explicit chapter group without accepting an implicit deletion', () => {
    const source = bundle(), baseline = manifest()
    const candidate = bundle('<h2 id="combined-title">Combined</h2><div id="combined-body"><p>Merged body</p></div>'); candidate.css = ''
    const output = assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a', 'b'], chapters: [chapter('combined', 'Combined')] }], dependencies: [] })
    expect(output.chapters.map(item => item.region_id)).toEqual(['combined'])
    expect(output.bundle.html).toContain('Merged body')
    expect(output.bundle.html).not.toContain('Beta original')
    expect(output.bundle.html).not.toContain('Alpha original')
  })

  test('rejects global styling and shared state changes while preserving the original source', () => {
    const source = bundle(), baseline = manifest()
    const input = { latest: { bundle: source, manifest: baseline }, baseline, candidate: { ...source, css: source.css + '\nbody{color:red}' }, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('a', 'Alpha', 2)] }], dependencies: [] }
    checkError(() => assembleChapterUpdate(input), 'CHAPTER_STYLE_SCOPE')
    checkError(() => assembleChapterUpdate({ ...input, candidate: { ...source, state: { ...source.state, compatibility_version: 'changed' } } }), 'CHAPTER_SHARED_CONFLICT')
    expect(source.html).toContain('Alpha original')
  })

  test('refuses a global embedded stylesheet introduced inside a local body', () => {
    const source = bundle(), baseline = manifest()
    const candidate = { ...source, html: source.html.replace('Alpha original', '<style>body{color:red}</style>Alpha updated') }
    checkError(() => assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('a', 'Alpha', 2)] }], dependencies: [] }), 'CHAPTER_SHARED_CONFLICT')
  })

  test('does not carry a proposal over a deleted chapter or a corrected whole goal', () => {
    const source = bundle(), baseline = manifest()
    const input = { latest: { bundle: source, manifest: baseline }, baseline, candidate: source, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('a', 'Alpha', 2)] }], dependencies: [] }
    checkError(() => assembleChapterUpdate({ ...input, latest: { bundle: source, manifest: { ...baseline, chapters: [chapter('b', 'Beta')] } } }), 'CHAPTER_BASELINE_CONFLICT')
    checkError(() => assembleChapterUpdate({ ...input, latest: { bundle: source, manifest: { ...baseline, intent_revision: 2 } } }), 'CHAPTER_BASELINE_CONFLICT')
  })

  test('enforces full assembled capacity rather than just the proposal fragment', () => {
    const source = bundle(), baseline = manifest(), half = defaults.surface.inline_bundle_bytes / 2 + 1024
    source.html = source.html.replace('Beta original', 'b'.repeat(half))
    const candidate = bundle(`<h2 id="a-title">Alpha</h2><div id="a-body"><p>${'a'.repeat(half)}</p></div>`); candidate.css = ''
    expect(Buffer.byteLength(JSON.stringify(source))).toBeLessThan(defaults.surface.inline_bundle_bytes)
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBeLessThan(defaults.surface.inline_bundle_bytes)
    checkError(() => assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('a', 'Alpha', 2)] }], dependencies: [] }), 'BUNDLE_SIZE_LIMIT')
  })

  test('validates the whole shared reference graph after replacing a chapter', () => {
    const source = bundle(), baseline = manifest()
    source.html = '<label for="a-input">Shared prompt</label>' + source.html.replace('Alpha original', '<input id="a-input">')
    const candidate = { ...source, html: source.html.replace('<input id="a-input">', '<p>Revised chapter</p>') }
    checkError(() => assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('a', 'Alpha', 2)] }], dependencies: [] }), 'UNSUPPORTED_BUNDLE')
    expect(source.html).toContain('<input id="a-input">')
  })

  test.each(['<script>active()</script>', '<img src="resource:missing" alt="Missing">'])('rejects unsafe or unresolved local content: %s', html => {
    const source = bundle(), baseline = manifest(), candidate = revised(source, 'a', html)
    checkError(() => assembleChapterUpdate({ latest: { bundle: source, manifest: baseline }, baseline, candidate, replacements: [{ previous_region_ids: ['a'], chapters: [chapter('a', 'Alpha', 2)] }], dependencies: [] }), 'UNSUPPORTED_BUNDLE')
    expect(source.html).toContain('Alpha original')
  })
})

describe('bounded chapter context', () => {
  test('keeps same-title chapter fragments and explicit dependencies bound to their own identities', () => {
    const first = '<h3>Repeated title</h3><p>First chapter text</p>'
    const second = '<h3>Repeated title</h3><p>Second chapter text</p>'
    const reference = '<h3>Reference</h3><p>Explicit dependency text</p>'
    const outside = '<h3>Unselected</h3><p>Unauthorized chapter text</p>'
    const source = bundle('<article><div>' + [first, second, reference, outside].join('\n') + '</div></article>'); source.css = 'p{line-height:1.5}'
    let next = 0
    const mapped = deriveChapterMapping(source, { view_id: 'view' }, () => ['first', 'second', 'reference', 'outside'][next++]!)
    const baseline = manifest(mapped.chapters.map((chapter, index) => ({ ...chapter, revision: index + 2 })))
    const dependency: ChapterDependency = { kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'reference', revision: 4 }
    const input = chapterInput(source, baseline, ['second', 'first'], [dependency])
    expect(input.chapters).toEqual([
      { region_id: 'second', revision: 3, html: second },
      { region_id: 'first', revision: 2, html: first },
      { region_id: 'reference', revision: 4, html: reference }
    ])
    expect(input.bundle.html).toBe([second, first, reference].join('\n'))
    expect(JSON.stringify(input)).not.toContain('Unauthorized chapter text')
    expect(chapterContext(source, baseline, ['second', 'first'], [dependency])).toEqual(input.bundle)
    expect(source.html).toBe('<article><div>' + [first, second, reference, outside].join('\n') + '</div></article>')
  })

  test('includes just selected chapters and explicitly read chapter dependencies', () => {
    const source = bundle(), mapping = manifest()
    const selected = chapterContext(source, mapping, ['a'])
    expect(selected.html).toContain('Alpha original')
    expect(selected.html).not.toContain('Beta original')
    expect(selected.css).not.toContain('#b-body')
    const dependency: ChapterDependency = { kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'b', revision: 1 }
    expect(chapterContext(source, mapping, ['a'], [dependency]).html).toContain('Beta original')
    expect(chapterDependencyValid(dependency, [mapping])).toBe(true)
    expect(chapterDependencyValid({ ...dependency, revision: 2 }, [mapping])).toBe(false)
  })

  test('does not grant unrelated resource references through the bounded bundle', () => {
    const source = bundle('<h2 id="a-title">Alpha</h2><div id="a-body"><p>Alpha original</p></div><h2 id="b-title">Beta</h2><div id="b-body"><img src="resource:private" alt="other"></div>')
    source.references = [{ name: 'private', target: { kind: 'resource', id: 'private-resource' } }]
    const mapping = manifest(); mapping.chapters[1]!.ownership.reference_ids = ['private']
    expect(chapterContext(source, mapping, ['a']).references).toEqual([])
  })
})

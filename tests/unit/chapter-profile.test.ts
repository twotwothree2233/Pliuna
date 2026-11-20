import { describe, expect, it } from 'vitest'
import type { Bundle, ChapterProposal, ChapterUpdate, ContentOperation, ExecutionScope } from '../../src/shared/contracts.generated'
import type { Completion } from '../../src/runtime/model/adapter'
import { createChapterProfile, createContentProfile } from '../../src/runtime/runner/chapter-profile'
import { assembleChapterUpdate, validateChapterMapping } from '../../src/runtime/runner/chapter-content'
import { createChapterRouterProfile } from '../../src/runtime/runner/chapter-router'
import { buildContentTree } from '../../src/runtime/runner/content-tree'
import { assembleContentUpdate, assertContentAuthority, CONTENT_OPERATIONS, treeChapters } from '../../src/runtime/runner/content-tree-host'
import { ContractError } from '../../src/shared/validation'
import type { WorkerGrant } from '../../src/runtime/runner/worker-profile'
import { chapterBundle, chapterManifest, chapterProposal, chapterPublication, chapterRegion, chapterSource, chapterUpdate } from '../helpers/chapters'

const final = (value: unknown): Completion => ({ text: JSON.stringify(value), finish: 'stop', calls: [] })
const readResource = (id: string) => ({ type: 'read', input: { target: { kind: 'resource', id } } })
const createResource = (value: unknown) => ({ type: 'write', input: { type: 'resource.create', display_name: 'Updated content', content: { type: 'json', value } } })
function result(update = chapterUpdate()): Pick<ChapterProposal, 'bundle_resource_id' | 'replacements'> {
  const proposal = chapterProposal(update)
  return { bundle_resource_id: 'created-bundle', replacements: proposal.replacements.map(group => ({ ...group, chapters: group.chapters.map(chapter => ({ ...chapter, dependencies: structuredClone(update.dependencies) })) })) }
}
function owner(update = chapterUpdate()): Extract<ExecutionScope, { purpose: 'production' }> {
  const source = chapterSource(update)
  if (source.purpose !== 'production') throw Error('Production fixture required')
  return source
}
function mappingChecker(loadCandidate: (resourceId: string) => Bundle): (proposal: ChapterProposal) => void {
  return proposal => validateChapterMapping(loadCandidate(proposal.bundle_resource_id), proposal.replacements.flatMap(group => group.chapters))
}

function contentFixture() {
  const bundle = { ...chapterBundle(), html: '<p>First</p><p>Second</p><p>Unchanged</p>' }, tree = buildContentTree(bundle.html)
  const manifest = { ...chapterManifest(), content_tree: tree, chapters: treeChapters(tree) }
  const ids = tree.nodes.filter(node => node.kind === 'paragraph').map(node => node.node_id)
  const update = chapterUpdate('content-merge', ids.slice(0, 2), manifest)
  update.tree_operations = [{ type: 'replace', node_ids: update.region_ids }]
  update.source = owner(update)
  return { bundle, tree, manifest, update, ids }
}

describe('content operation producer', () => {
  it('keeps a router-bound merge intact while the worker supplies only its HTML fragment', () => {
    const s = contentFixture(), route = createChapterRouterProfile([s.manifest]).parseResult(final({ kind: 'update', view_id: s.manifest.view_id, region_ids: s.update.region_ids, tree_operations: s.update.tree_operations }))
    if (route.kind !== 'update') throw Error('Expected an update route')
    s.update.tree_operations = route.tree_operations
    let proposal: ChapterProposal | null = null
    const profile = createContentProfile(s.update, owner(s.update), [], () => proposal)
    const binding = JSON.parse(profile.system.split('Bound scope: ')[1]!)
    expect(binding.operations).toEqual([{ type: 'replace', node_ids: s.update.region_ids }])
    expect(profile.system).not.toContain(s.bundle.html)
    expect(() => profile.parseResult(final('Done'))).toThrow(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    const operation: ContentOperation = { type: 'replace', node_ids: s.update.region_ids, html: '<p>Combined</p>' }
    expect(() => profile.authorize({ type: 'call', input: { capability: CONTENT_OPERATIONS, arguments: { operations: [operation] }, references: [] } })).not.toThrow()
    const assembled = assembleContentUpdate({ bundle: s.bundle, manifest: s.manifest }, s.update, [operation])
    expect(assembled.bundle.html).toBe('<p>Combined</p><p>Unchanged</p>')
    const combined = assembled.tree.nodes.find(node => node.kind === 'paragraph')!
    for (const id of s.update.region_ids) expect(assembled.tree.lineage).toContainEqual({ previous_node_id: id, successor_node_ids: [combined.node_id], revision: assembled.tree.revision, reason: 'merge' })
    expect(assembled.tree.nodes.find(node => node.node_id === s.ids[2])).toMatchObject({ revision: 1, position_revision: 1 })
    proposal = { ...chapterProposal(s.update), replacements: [], tree_operations: [operation] }
    expect(profile.parseResult(final('Done'))).toBe(proposal)
    expect(() => profile.authorize(createResource(s.bundle))).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })

  it('rejects changes to the bound replacement group even when all nodes were granted', () => {
    const s = contentFixture(), [first, second] = s.update.region_ids
    const changed: ContentOperation[][] = [
      [{ type: 'replace', node_ids: [first!], html: '<p>Combined</p>' }, { type: 'delete', node_ids: [second!] }],
      [{ type: 'replace', node_ids: [second!, first!], html: '<p>Combined</p>' }],
      [{ type: 'replace', node_ids: [first!], html: '<p>Partial</p>' }],
      [{ type: 'delete', node_ids: s.update.region_ids }]
    ]
    for (const operations of changed) expect(() => assertContentAuthority(s.update, operations)).toThrow(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => assertContentAuthority(s.update, [{ type: 'replace', node_ids: s.update.region_ids, html: '<p>Corrected complete fragment</p>' }])).not.toThrow()
  })
})

describe('chapter producer templates', () => {
  it('binds an immutable one-to-one replacement without model-supplied boundary metadata', () => {
    const update = chapterUpdate(), template = [{ ...chapterRegion('a', 2), dependencies: structuredClone(update.dependencies) }]
    const expected = structuredClone(template), checked: ChapterProposal[] = []
    const profile = createChapterProfile(update, owner(update), [], proposal => { checked.push(proposal) }, template)
    template[0]!.body_selector = '#mutated'; template[0]!.dependencies.length = 0
    const accepted = profile.parseResult(final({ bundle_resource_id: 'created-bundle' }))
    expect(accepted.replacements).toEqual([{ previous_region_ids: ['a'], chapters: expected }])
    expect(checked).toEqual([accepted])
    accepted.replacements[0]!.chapters[0]!.title = 'Mutated result'
    expect(profile.parseResult(final({ bundle_resource_id: 'created-bundle' })).replacements[0]!.chapters).toEqual(expected)
    expect(profile.system).toContain('chapter_template')
    expect(JSON.parse(profile.system.split('Bound data: ')[1]!).replacements).toEqual([{ previous_region_ids: ['a'], chapters: expected }])
  })

  it.each(['missing', 'unselected', 'duplicate', 'revision', 'dependencies'])('rejects an invalid host template: %s', reason => {
    const update = chapterUpdate(), template = [{ ...chapterRegion('a', 2), dependencies: structuredClone(update.dependencies) }]
    if (reason === 'missing') template.length = 0
    if (reason === 'unselected') template[0]!.region_id = 'b'
    if (reason === 'duplicate') template.push(structuredClone(template[0]!))
    if (reason === 'revision') template[0]!.revision = 1
    if (reason === 'dependencies') template[0]!.dependencies = []
    expect(() => createChapterProfile(update, owner(update), [], undefined, template)).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_PROFILE' }))
  })

  it('keeps explicit split and merge replacements available without inferring deletions', () => {
    const update = chapterUpdate('update-group', ['a', 'b']), template = update.region_ids.map(id => ({ ...chapterRegion(id, 2), dependencies: structuredClone(update.dependencies) }))
    const profile = createChapterProfile(update, owner(update), [], undefined, template)
    const merged = { previous_region_ids: ['a', 'b'], chapters: [{ ...chapterRegion('merged'), dependencies: structuredClone(update.dependencies) }] }
    expect(profile.parseResult(final({ bundle_resource_id: 'created-bundle', replacements: [merged] })).replacements).toEqual([merged])
    const split = { previous_region_ids: ['a'], chapters: ['a-first', 'a-second'].map(id => ({ ...chapterRegion(id), dependencies: structuredClone(update.dependencies) })) }
    const keptB = { previous_region_ids: ['b'], chapters: [template[1]!] }
    expect(profile.parseResult(final({ bundle_resource_id: 'created-bundle', replacements: [split, keptB] })).replacements).toEqual([split, keptB])
    expect(() => profile.parseResult(final({ bundle_resource_id: 'created-bundle', replacements: [split] }))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(() => profile.parseResult(final({ bundle_resource_id: 'created-bundle', replacements: null }))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  })

  it('requires explicit replacements when no template was supplied', () => {
    expect(() => createChapterProfile(chapterUpdate(), owner()).parseResult(final({ bundle_resource_id: 'created-bundle' }))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  })
})

describe('chapter producer authority', () => {
  it.each([
    ['another Task', { ...owner(), task_id: 'other-task' }],
    ['another goal', { ...owner(), request_id: 'other-goal' }],
    ['another goal revision', { ...owner(), intent_revision: 2 }],
    ['another update', { ...owner(), update_id: 'other-update' }],
    ['a whole-goal owner', { task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'producer', purpose: 'production', request_id: 'goal', intent_revision: 1 }],
    ['a publisher', { ...owner(), role: 'lightweight' }],
    ['composition work', { task_id: 'task', run_id: 'run', work_id: 'work', attempt_id: 'attempt', role: 'collator', purpose: 'composition', batch_id: 'batch', composition_version: 1, trigger_request_id: 'goal' }]
  ] satisfies [string, ExecutionScope][])('rejects %s before granting tools', (_reason, source) => {
    expect(() => createChapterProfile(chapterUpdate(), source)).toThrowError(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  })

  it.each(['run_id', 'work_id', 'attempt_id'] as const)('requires the exact persisted producer %s', field => {
    const update = chapterUpdate()
    update.source = owner(update)
    expect(() => createChapterProfile(update, { ...owner(update), [field]: 'another-source' })).toThrowError(expect.objectContaining({ code: 'RUNNER_OWNERSHIP_INVALID' }))
  })

  it('binds the accepted result to a copied update and producer identity', () => {
    const update = chapterUpdate(), source = owner(update), expected = structuredClone(update), expectedOwner = structuredClone(source)
    const profile = createChapterProfile(update, source)
    update.region_ids.push('b'); update.dependencies[0]!.revision = 9; source.attempt_id = 'another-attempt'
    const accepted = profile.parseResult(final(result(expected)))
    expect(accepted).toMatchObject({ task_id: expected.task_id, update_id: expected.update_id, intent_revision: expected.intent_revision, source: expectedOwner, dependencies: expected.dependencies, bundle_resource_id: 'created-bundle' })
    expect(accepted.proposal_id).toBeTruthy()
    accepted.dependencies[0]!.revision = 7; accepted.source.attempt_id = 'mutated-result'
    expect(profile.parseResult(final(result(expected)))).toMatchObject({ source: expectedOwner, dependencies: expected.dependencies })
  })

  it('honors an explicit resource ID allowlist without adding discovery grants', () => {
    const update = chapterUpdate(), profile = createChapterProfile(update, owner(update), [{ type: 'read', kind: 'resource', ids: ['selected-reference', 'material'] }])
    expect(() => profile.authorize(readResource('selected-reference'))).not.toThrow()
    expect(() => profile.authorize(readResource('material'))).not.toThrow()
    for (const id of ['unselected-reference', update.base_manifest.bundle_resource_id]) expect(() => profile.authorize(readResource(id))).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => profile.authorize({ type: 'list', input: { kind: 'resource' } })).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => createChapterProfile(update, owner(update)).authorize(readResource('material'))).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })

  it('accepts explicit resource discovery without an ID allowlist', () => {
    const update = chapterUpdate(), profile = createChapterProfile(update, owner(update), [{ type: 'list', kind: 'resource' }, { type: 'read', kind: 'resource' }])
    expect(() => profile.authorize({ type: 'list', input: { kind: 'resource' } })).not.toThrow()
    for (const id of ['material', 'discovered-reference', update.base_manifest.bundle_resource_id]) expect(() => profile.authorize(readResource(id))).not.toThrow()
  })

  it('reads exact conversation event IDs without granting unrelated history', () => {
    const events = ['history-request', 'history-answer'], profile = createChapterProfile(chapterUpdate(), owner(), [{ type: 'read', kind: 'event', ids: events }])
    for (const id of events) expect(() => profile.authorize({ type: 'read', input: { target: { kind: 'event', id } } })).not.toThrow()
    expect(() => profile.authorize({ type: 'read', input: { target: { kind: 'event', id: 'unrelated-event' } } })).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => profile.authorize({ type: 'list', input: { kind: 'event' } })).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })

  it('accepts supplied data and plugin discovery with exact enabled capability grants', () => {
    const capability = 'plugin:enabled-tool', grants: WorkerGrant[] = [
      { type: 'list', kind: 'task_data' }, { type: 'read', kind: 'task_data' },
      { type: 'list', kind: 'plugin' }, { type: 'read', kind: 'plugin' },
      { type: 'list', kind: 'capability' }, { type: 'read', kind: 'capability', ids: [capability] },
      { type: 'call', capability }
    ]
    const profile = createChapterProfile(chapterUpdate(), owner(), grants)
    for (const kind of ['task_data', 'plugin', 'capability']) expect(() => profile.authorize({ type: 'list', input: { kind } })).not.toThrow()
    for (const [kind, id] of [['task_data', 'task-data'], ['plugin', 'package:enabled-plugin'], ['capability', capability]]) expect(() => profile.authorize({ type: 'read', input: { target: { kind, id } } })).not.toThrow()
    expect(() => profile.authorize({ type: 'call', input: { capability, arguments: {}, references: [] } })).not.toThrow()
    expect(() => profile.authorize({ type: 'read', input: { target: { kind: 'capability', id: 'plugin:ungranted-tool' } } })).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(() => profile.authorize({ type: 'call', input: { capability: 'plugin:ungranted-tool', arguments: {}, references: [] } })).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(profile.tools.map(tool => tool.function.name).sort()).toEqual(['call', 'list', 'read', 'write'])
  })

  it('does not grant supplemental discovery or calls by default', () => {
    const profile = createChapterProfile(chapterUpdate(), owner())
    for (const kind of ['resource', 'event', 'task_data', 'plugin', 'capability']) {
      expect(() => profile.authorize({ type: 'list', input: { kind } })).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
      expect(() => profile.authorize({ type: 'read', input: { target: { kind, id: 'ungranted-object' } } })).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    }
    expect(() => profile.authorize({ type: 'call', input: { capability: 'plugin:enabled-tool', arguments: {}, references: [] } })).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })

  it.each([
    ['Surface writes', { type: 'write', operation: 'surface.update' }],
    ['other mutations', { type: 'write', operation: 'task_data.create' }],
    ['resource creation', { type: 'write', operation: 'resource.create' }]
  ] satisfies [string, WorkerGrant][])('refuses supplemental grants for %s', (_reason, grant) => {
    expect(() => createChapterProfile(chapterUpdate(), owner(), [grant])).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_PROFILE' }))
  })

  it('allows contract discovery and bundle creation while denying Surface publication', () => {
    const profile = createChapterProfile(chapterUpdate(), owner())
    expect(() => profile.authorize({ type: 'list', input: { kind: 'object_type' } })).not.toThrow()
    expect(() => profile.authorize({ type: 'read', input: { target: { kind: 'object_type', id: 'surface.update' } } })).not.toThrow()
    expect(() => profile.authorize(createResource(chapterBundle()))).not.toThrow()
    expect(() => profile.authorize(chapterPublication().request)).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
    expect(profile.tools.map(tool => tool.function.name).sort()).toEqual(['list', 'read', 'write'])
  })
})

describe('chapter producer results', () => {
  it.each(['task_id', 'update_id', 'intent_revision', 'source', 'dependencies', 'proposal_id'])('rejects model-supplied %s instead of accepting forged bindings', field => {
    const profile = createChapterProfile(chapterUpdate(), owner())
    expect(() => profile.parseResult(final({ ...result(), [field]: 'forged' }))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  })

  it.each([
    ['an omitted chapter', ['a']],
    ['an extra chapter', ['a', 'b', 'c']],
    ['a duplicate chapter', ['a', 'a']],
    ['another group', ['a', 'c']]
  ] satisfies [string, string[]][])('rejects %s in the authorized replacement group', (_reason, replaced) => {
    const update = chapterUpdate('group', ['a', 'b']), profile = createChapterProfile(update, owner(update)), output = result(update)
    output.replacements[0]!.previous_region_ids = replaced
    expect(() => profile.parseResult(final(output))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  })

  it('accepts a complete split group without granting another chapter', () => {
    const update = chapterUpdate(), profile = createChapterProfile(update, owner(update)), output = result(update)
    output.replacements[0]!.chapters = ['a-first', 'a-second'].map(id => ({ ...chapterRegion(id), dependencies: structuredClone(update.dependencies) }))
    expect(profile.parseResult(final(output)).replacements).toEqual(output.replacements)
  })

  it.each(['omitted', 'expanded', 'stale'] as const)('rejects %s replacement dependencies', reason => {
    const update = chapterUpdate(), profile = createChapterProfile(update, owner(update)), output = result(update), chapter = output.replacements[0]!.chapters[0]!
    if (reason === 'omitted') chapter.dependencies = []
    else if (reason === 'expanded') chapter.dependencies.push({ kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'b', revision: 1 })
    else chapter.dependencies[0]!.revision = 2
    expect(() => profile.parseResult(final(output))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  })

  it('accepts the same exact dependencies in another array order', () => {
    const update = chapterUpdate()
    update.dependencies.push({ kind: 'chapter', task_id: 'task', view_id: 'view', region_id: 'b', revision: 1 })
    const profile = createChapterProfile(update, owner(update)), output = result(update)
    output.replacements[0]!.chapters[0]!.dependencies.reverse()
    expect(profile.parseResult(final(output)).dependencies).toEqual(update.dependencies)
  })

  it.each([null, '', {}, ['resource'], 42])('requires a returned resource identity instead of %j', bundle_resource_id => {
    const profile = createChapterProfile(chapterUpdate(), owner())
    expect(() => profile.parseResult(final({ ...result(), bundle_resource_id }))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  })

  it('rejects explanatory text, unfinished responses and pending tool calls', () => {
    const profile = createChapterProfile(chapterUpdate(), owner()), response = final(result())
    expect(() => profile.parseResult({ ...response, text: 'The chapter is complete.' })).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(() => profile.parseResult({ ...response, finish: 'tool_calls' })).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(() => profile.parseResult({ ...response, calls: [{ id: 'pending', type: 'function', function: { name: 'read', arguments: '{}' } }] })).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
  })

  it('checks declared chapter boundaries against the exact loaded candidate', () => {
    const update = chapterUpdate(), loaded: string[] = [], candidate = chapterBundle()
    candidate.html = '<h2>A</h2><p>First paragraph</p><p>Second paragraph</p>'
    const profile = createChapterProfile(update, owner(update), [], mappingChecker(resourceId => { loaded.push(resourceId); return candidate }))
    expect(() => profile.authorize(createResource(candidate))).not.toThrow()
    expect(() => profile.parseResult(final(result(update)))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(loaded).toEqual(['created-bundle'])
    expect(profile.resultCorrection).toContain('CHAPTER_MAPPING_INVALID')
    expect(profile.resultCorrection).toContain('Chapter boundary does not exist in the exact source')
    expect(profile.resultCorrection).not.toContain(candidate.html)
  })

  it('accepts a corrected resource and clears the previous candidate diagnostic', () => {
    const update = chapterUpdate(), output = result(update), loaded: string[] = []
    const candidates: Record<string, Bundle> = {
      broken: { ...chapterBundle(), html: '<h2>A</h2><p>First paragraph</p><p>Second paragraph</p>' },
      repaired: { ...chapterBundle(), html: '<h2 id="a-title">A</h2><div id="a-body"><p>First paragraph</p><p>Second paragraph</p></div>' }
    }
    const profile = createChapterProfile(update, owner(update), [], mappingChecker(resourceId => { loaded.push(resourceId); return candidates[resourceId]! }))
    output.bundle_resource_id = 'broken'
    expect(() => profile.parseResult(final(output))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(profile.resultCorrection).toContain('Candidate check: CHAPTER_MAPPING_INVALID')
    output.bundle_resource_id = 'repaired'
    expect(profile.parseResult(final(output))).toMatchObject({ bundle_resource_id: 'repaired', replacements: output.replacements })
    expect(loaded).toEqual(['broken', 'repaired'])
    expect(profile.resultCorrection).not.toContain('Candidate check:')
  })

  it.each(['JSON', 'dependencies'])('clears an earlier candidate diagnostic when the next result fails %s validation', reason => {
    const update = chapterUpdate(), output = result(update), loaded: string[] = []
    const profile = createChapterProfile(update, owner(update), [], mappingChecker(resourceId => {
      loaded.push(resourceId)
      return resourceId === 'broken' ? { ...chapterBundle(), html: '<h2>A</h2><p>Missing boundaries</p>' } : chapterBundle()
    }))
    output.bundle_resource_id = 'broken'
    expect(() => profile.parseResult(final(output))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(profile.resultCorrection).toContain('Candidate check: CHAPTER_MAPPING_INVALID')
    const invalid = result(update)
    invalid.replacements[0]!.chapters[0]!.dependencies = []
    const response = reason === 'JSON' ? { ...final(invalid), text: '{' } : final(invalid)
    expect(() => profile.parseResult(response)).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(profile.resultCorrection).not.toContain('Candidate check:')
    output.bundle_resource_id = 'repaired'
    expect(profile.parseResult(final(output))).toMatchObject({ bundle_resource_id: 'repaired', replacements: output.replacements })
    expect(profile.resultCorrection).not.toContain('Candidate check:')
    expect(loaded).toEqual(['broken', 'repaired'])
  })

  it('rejects ownership claims that escape the loaded replacement chapter', () => {
    const update = chapterUpdate(), output = result(update), candidate = chapterBundle()
    candidate.export = [{ id: 'other-chapter-export', category: 'learning', source: { type: 'element', element_id: 'b-body' } }]
    output.replacements[0]!.chapters[0]!.ownership.export_ids = ['other-chapter-export']
    const profile = createChapterProfile(update, owner(update), [], mappingChecker(() => candidate))
    expect(() => profile.parseResult(final(output))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(profile.resultCorrection).toContain('CHAPTER_OWNERSHIP_INVALID')
    expect(profile.resultCorrection).toContain('Export ownership escapes the chapter')
  })

  it('makes escaping local CSS ownership correctable without accepting it', () => {
    const update = chapterUpdate(), output = result(update), candidate = chapterBundle()
    output.replacements[0]!.chapters[0]!.ownership.css_selectors = ['#b-body']
    candidate.css = '#b-body { color: red; }'
    const profile = createChapterProfile(update, owner(update), [], mappingChecker(() => candidate))
    expect(() => profile.parseResult(final(output))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(profile.resultCorrection).toContain('CHAPTER_STYLE_SCOPE')
  })

  it.each([
    ['global CSS', 'CHAPTER_STYLE_SCOPE'],
    ['shared state', 'CHAPTER_SHARED_CONFLICT'],
    ['replacement revision', 'CHAPTER_REPLACEMENT_INVALID']
  ])('corrects invalid %s through real chapter assembly before accepting the candidate', (reason, code) => {
    const update = chapterUpdate(), output = result(update)
    const latest = { bundle: chapterBundle(), manifest: structuredClone(update.base_manifest) }
    latest.bundle.html = latest.bundle.html.replace('New A', 'Original A')
    latest.bundle.css = 'p { color: #222; }'
    const repaired = { ...chapterBundle(), css: latest.bundle.css }
    repaired.html = repaired.html.replace('Old B', 'Unselected candidate B')
    const candidates: Record<string, Bundle> = { broken: structuredClone(repaired), repaired }
    if (reason === 'global CSS') candidates.broken!.css = 'p { color: #999; }'
    else if (reason === 'shared state') candidates.broken!.state = { ...repaired.state, schema: { type: 'object', properties: { message: { type: 'string' } }, additionalProperties: false }, initial: { message: 'changed' } }
    else output.replacements[0]!.chapters[0]!.revision = 3
    let assembled: ReturnType<typeof assembleChapterUpdate> | undefined
    const profile = createChapterProfile(update, owner(update), [], proposal => {
      assembled = assembleChapterUpdate({ latest, baseline: update.base_manifest, candidate: candidates[proposal.bundle_resource_id]!, replacements: proposal.replacements, dependencies: proposal.dependencies })
    })
    output.bundle_resource_id = 'broken'
    expect(() => profile.parseResult(final(output))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(profile.resultCorrection).toContain(`Candidate check: ${code}`)
    expect(assembled).toBeUndefined()
    output.bundle_resource_id = 'repaired'
    output.replacements[0]!.chapters[0]!.revision = 2
    expect(profile.parseResult(final(output))).toMatchObject({ bundle_resource_id: 'repaired', replacements: output.replacements })
    expect(profile.resultCorrection).not.toContain('Candidate check:')
    expect(assembled?.bundle.css).toBe(latest.bundle.css)
    expect(assembled?.bundle.state).toEqual(latest.bundle.state)
    expect(assembled?.bundle.html).toContain('New A')
    expect(assembled?.bundle.html).toContain('Old B')
    expect(assembled?.bundle.html).not.toContain('Unselected candidate B')
  })

  it.each([
    ['selected baseline', 'CHAPTER_BASELINE_CONFLICT'],
    ['shared dependency', 'CHAPTER_DEPENDENCY_CONFLICT']
  ])('keeps real assembly %s conflicts fatal', (reason, code) => {
    const update = chapterUpdate(), latest = { bundle: chapterBundle(), manifest: structuredClone(update.base_manifest) }
    if (reason === 'selected baseline') latest.manifest.chapters[0]!.revision++
    else latest.manifest.shared_revision++
    const profile = createChapterProfile(update, owner(update), [], proposal => {
      assembleChapterUpdate({ latest, baseline: update.base_manifest, candidate: chapterBundle(), replacements: proposal.replacements, dependencies: proposal.dependencies })
    })
    expect(() => profile.parseResult(final(result(update)))).toThrowError(expect.objectContaining({ code }))
    expect(profile.resultCorrection).not.toContain('Candidate check:')
  })

  it.each([
    new ContractError('RUNNER_OWNERSHIP_INVALID', 'The candidate belongs to another attempt'),
    new ContractError('CHAPTER_DEPENDENCY_CONFLICT', 'The selected chapter authority is stale'),
    new Error('The candidate resource is unavailable')
  ])('preserves checker failures instead of converting them into result corrections: %s', rejection => {
    const update = chapterUpdate(), profile = createChapterProfile(update, owner(update), [], () => { throw rejection })
    let rejected: unknown
    try { profile.parseResult(final(result(update))) } catch (error) { rejected = error }
    expect(rejected).toBe(rejection)
    expect(profile.resultCorrection).not.toContain('Candidate check:')
  })

  it('keeps authorized replacements bounded when the candidate includes an unselected chapter', () => {
    const update = chapterUpdate(), output = result(update), loaded: string[] = []
    const profile = createChapterProfile(update, owner(update), [], mappingChecker(resourceId => { loaded.push(resourceId); return chapterBundle() }))
    const accepted = profile.parseResult(final(output))
    expect(accepted.replacements).toEqual(output.replacements)
    expect(accepted.replacements.flatMap(group => group.previous_region_ids)).toEqual(['a'])
    output.replacements.push({ previous_region_ids: ['b'], chapters: [{ ...chapterRegion('b', 2), dependencies: structuredClone(update.dependencies) }] })
    expect(() => profile.parseResult(final(output))).toThrowError(expect.objectContaining({ code: 'INVALID_WORKER_RESULT' }))
    expect(loaded).toEqual(['created-bundle'])
    expect(() => profile.authorize(readResource(update.base_manifest.bundle_resource_id))).toThrowError(expect.objectContaining({ code: 'WORKER_CAPABILITY_DENIED' }))
  })

  it('validates real Bundle reference fields during resource creation', () => {
    const profile = createChapterProfile(chapterUpdate(), owner()), bundle = chapterBundle()
    const correct = { ...bundle, references: [{ name: 'source', target: { kind: 'resource', id: 'supplied-source' } }] }
    expect(() => profile.authorize(createResource(correct))).not.toThrow()
    const invented = { ...bundle, references: [{ name: 'source', kind: 'resource', id: 'supplied-source' }] }
    expect(() => profile.authorize(createResource(invented))).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })

  it('binds selected chapter identities without leaking full-document boundary coordinates', () => {
    const first = chapterUpdate(), second: ChapterUpdate = { ...chapterUpdate('another-update', ['b']), text: 'A different subject and task' }
    const selected = first.base_manifest.chapters[0]!
    selected.title_selector = ':scope > article:nth-child(1) > section:nth-child(2) > h3:nth-child(1)'
    selected.body_selector = ':scope > article:nth-child(1) > section:nth-child(2) > p:nth-child(2)'
    const profile = createChapterProfile(first, owner(first)), other = createChapterProfile(second, owner(second))
    const [rules, data] = profile.system.split('Bound data: ')
    expect(rules).toEqual(other.system.split('Bound data: ')[0])
    const { region_id, revision, title, dependencies, ownership } = selected
    expect(JSON.parse(data!)).toMatchObject({ update_id: first.update_id, source: owner(first), dependencies: first.dependencies, chapters: [{ region_id, revision, title, dependencies, ownership }] })
    expect(JSON.parse(data!).chapters).toEqual([{ region_id, revision, title, dependencies, ownership }])
    expect(profile.system).not.toContain(selected.title_selector)
    expect(profile.system).not.toContain(selected.body_selector)
    expect(profile.system).not.toContain(first.text)
    expect(profile.system).not.toContain('base_manifest')
    expect(profile.resultCorrection).not.toContain(first.text)
  })
})

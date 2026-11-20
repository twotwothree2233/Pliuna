import { describe, expect, it } from 'vitest'
import { validateRunnerContract } from '../../src/shared/runner-validation'
import { assertContract } from '../../src/shared/validation'
import { chapterManifest, chapterProposal, chapterUpdate } from '../helpers/chapters'
import { contentTree } from '../helpers/content-tree'

describe('content tree contracts', () => {
  it('accepts program-owned trees while retaining chapter-only contracts', () => {
    expect(validateRunnerContract('runner_content_tree', contentTree())).toEqual(contentTree())
    expect(validateRunnerContract('runner_chapter_manifest', chapterManifest())).toEqual(chapterManifest())
    const manifest = { ...chapterManifest(), content_tree: contentTree() }
    expect(validateRunnerContract('runner_chapter_manifest', manifest)).toEqual(manifest)
  })
  it('rejects duplicate identities, orphan children and inconsistent boundaries', () => {
    const duplicate = contentTree(); duplicate.nodes[2]!.node_id = 'node-a'
    expect(() => validateRunnerContract('runner_content_tree', duplicate)).toThrow()
    const orphan = contentTree(); orphan.nodes[0]!.children.pop()
    expect(() => validateRunnerContract('runner_content_tree', orphan)).toThrow()
    const bounds = contentTree(); bounds.nodes[1]!.inner_span.end = 9
    expect(() => validateRunnerContract('runner_content_tree', bounds)).toThrow()
    const crossing = contentTree(); crossing.nodes[2]!.span.start = 7
    expect(() => validateRunnerContract('runner_content_tree', crossing)).toThrow()
  })
  it('retains retired identities with explicit successors and rejects cycles', () => {
    const tree = contentTree()
    tree.lineage = [{ previous_node_id: 'retired', successor_node_ids: ['node-a', 'node-b'], revision: 1, reason: 'split' }]
    expect(validateRunnerContract('runner_content_tree', tree)).toEqual(tree)
    tree.lineage[0]!.successor_node_ids = ['missing']
    expect(() => validateRunnerContract('runner_content_tree', tree)).toThrow()
    tree.lineage = [
      { previous_node_id: 'old-a', successor_node_ids: ['old-b'], revision: 1, reason: 'replaced' },
      { previous_node_id: 'old-b', successor_node_ids: ['old-a'], revision: 1, reason: 'replaced' }
    ]
    expect(() => validateRunnerContract('runner_content_tree', tree)).toThrow()
  })
  it('distinguishes operation planning from publishable HTML and binds positions', () => {
    expect(validateRunnerContract('runner_content_operation_plan', { type: 'replace', node_ids: ['node-a'] })).toEqual({ type: 'replace', node_ids: ['node-a'] })
    expect(() => validateRunnerContract('runner_content_operation', { type: 'replace', node_ids: ['node-a'] })).toThrow()
    expect(validateRunnerContract('runner_content_operation', { type: 'insert', parent_id: 'document', position: 'before', anchor_id: 'node-a', html: '<p>New</p>' }).type).toBe('insert')
    for (const operation of [
      { type: 'insert', parent_id: 'document', position: 'before', html: '<p>New</p>' },
      { type: 'insert', parent_id: 'document', position: 'end', anchor_id: 'node-a', html: '<p>New</p>' },
      { type: 'move', node_ids: ['node-a', 'node-b'], parent_id: 'document', position: 'end' },
      { type: 'delete', node_ids: ['node-a'], html: '<p>Unexpected</p>' }
    ]) expect(() => validateRunnerContract('runner_content_operation', operation)).toThrow()
  })
  it('binds updates to exact baseline node identities', () => {
    const manifest = { ...chapterManifest(), content_tree: contentTree() }
    const update = { ...chapterUpdate('update', ['node-a'], manifest), tree_operations: [{ type: 'replace' as const, node_ids: ['node-a'] }] }
    expect(validateRunnerContract('runner_chapter_update', update)).toEqual(update)
    expect(() => validateRunnerContract('runner_chapter_update', { ...update, tree_operations: [{ type: 'delete', node_ids: ['missing'] }] })).toThrow()
    expect(() => validateRunnerContract('runner_chapter_update', { ...update, base_manifest: chapterManifest() })).toThrow()
  })
  it('allows empty chapter replacements only with complete structural operations', () => {
    const proposal = { ...chapterProposal(), replacements: [] }
    expect(() => validateRunnerContract('runner_chapter_proposal', proposal)).toThrow()
    const structural = { ...proposal, tree_operations: [{ type: 'replace' as const, node_ids: ['node-a'], html: '<p>New</p>' }] }
    expect(validateRunnerContract('runner_chapter_proposal', structural)).toEqual(structural)
  })
  it('exposes structural navigation through existing generic tools', () => {
    for (const kind of ['content_tree', 'content_node']) {
      expect(() => assertContract('list', { kind })).not.toThrow()
      expect(() => assertContract('read', { target: { kind, id: 'view' } })).not.toThrow()
      expect(() => assertContract('model_request', { type: 'read', input: { target: { kind, id: 'view' } } })).not.toThrow()
    }
  })
})

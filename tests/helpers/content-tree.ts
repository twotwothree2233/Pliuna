import type { ContentTree } from '../../src/shared/contracts.generated'

export function contentTree(): ContentTree {
  return {
    version: 1, revision: 1, root_id: 'document', lineage: [],
    nodes: [
      { node_id: 'document', parent_id: null, kind: 'document', revision: 1, position_revision: 1, title: '', children: ['node-a', 'node-b'], selector: ':scope', end_selector: ':scope', tag: '', span: { start: 0, end: 16 }, inner_span: { start: 0, end: 16 } },
      { node_id: 'node-a', parent_id: 'document', kind: 'paragraph', revision: 1, position_revision: 1, title: '', children: [], selector: 'p:nth-of-type(1)', end_selector: 'p:nth-of-type(1)', tag: 'p', span: { start: 0, end: 8 }, inner_span: { start: 3, end: 4 } },
      { node_id: 'node-b', parent_id: 'document', kind: 'paragraph', revision: 1, position_revision: 1, title: '', children: [], selector: 'p:nth-of-type(2)', end_selector: 'p:nth-of-type(2)', tag: 'p', span: { start: 8, end: 16 }, inner_span: { start: 11, end: 12 } }
    ]
  }
}

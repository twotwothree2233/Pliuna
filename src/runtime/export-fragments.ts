import type { DefaultTreeAdapterMap } from 'parse5'
import { presentationFragment } from './markup'
import type { Bundle } from '../shared/contracts.generated'
import { ContractError } from '../shared/validation'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

export function checkExportFragments(bundle: Bundle): void {
  const ids = new Map<string, Element>(), parents = new Map<Node, Node>()
  const visit = (node: Node): void => {
    if ('tagName' in node) {
      const id = node.attrs.find(a => a.name === 'id')?.value
      if (id) {
        if (ids.has(id)) throw new ContractError('EXPORT_FRAGMENT_INVALID', 'Duplicate element ID')
        ids.set(id, node)
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) { parents.set(child, node); visit(child) }
  }
  visit(presentationFragment(bundle.html))
  const fragments = new Set<string>(), roots = new Set<Element>()
  for (const fragment of bundle.export) {
    if (fragments.has(fragment.id)) throw new ContractError('EXPORT_FRAGMENT_INVALID', 'Duplicate export fragment')
    fragments.add(fragment.id)
    if (fragment.source.type === 'element') {
      const node = ids.get(fragment.source.element_id)
      if (!node || roots.has(node)) throw new ContractError('EXPORT_FRAGMENT_INVALID', 'Missing or duplicate export root')
      roots.add(node)
    }
  }
  for (const node of roots) {
    let parent = parents.get(node)
    while (parent) {
      if (roots.has(parent as Element)) throw new ContractError('EXPORT_FRAGMENT_OVERLAP', 'Export roots cannot overlap')
      parent = parents.get(parent)
    }
  }
}

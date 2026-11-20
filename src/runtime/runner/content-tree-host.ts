import type { Bundle, ChapterManifest, ChapterRegion, ChapterUpdate, ContentOperation, ContentOperationPlan, ContentTree } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { applyContentOperations, contentNode, contentOperationScope, contentScopeOverlaps, type ContentOperationScope } from './content-tree'

export const CONTENT_OPERATIONS = 'builtin:content-operations:v1'

export function updateContentScope(update: ChapterUpdate): ContentOperationScope {
  const tree = update.base_manifest.content_tree
  if (!tree) return { node_ids: update.region_ids, gaps: [] }
  return update.tree_operations?.length
    ? contentOperationScope(tree, update.tree_operations as ContentOperation[])
    : { node_ids: treeTargetIds(update.base_manifest, update.region_ids), gaps: [] }
}

export function contentUpdatesOverlap(left: ChapterUpdate, right: ChapterUpdate): boolean {
  const tree = right.base_manifest.content_tree
  if (!tree || !left.base_manifest.content_tree) return left.region_ids.some(id => right.region_ids.includes(id))
  const a = updateContentScope(left), b = updateContentScope(right)
  // An unresolved operation with retired location dependencies needs reconciliation.
  const current = new Set(tree.nodes.map(node => node.node_id))
  if ([...a.node_ids, ...a.gaps.flatMap(gap => [gap.parent_id, gap.before_id, gap.after_id].filter((id): id is string => id !== null))].some(id => !current.has(id))) return true
  if (contentScopeOverlaps(tree, a.node_ids, b.node_ids)) return true
  const crosses = (writes: string[], gaps: ContentOperationScope['gaps']): boolean => gaps.some(gap =>
    writes.some(id => covered(tree, [id], gap.parent_id) || [gap.before_id, gap.after_id].some(anchor => anchor && contentScopeOverlaps(tree, [id], [anchor]))))
  return crosses(a.node_ids, b.gaps) || crosses(b.node_ids, a.gaps) || a.gaps.some(x => b.gaps.some(y => x.parent_id === y.parent_id && x.before_id === y.before_id && x.after_id === y.after_id))
}

export function contentBaselineCurrent(update: ChapterUpdate, manifest: ChapterManifest): boolean {
  const baseline = update.base_manifest.content_tree, tree = manifest.content_tree
  if (!baseline || !tree) return false
  const scope = updateContentScope(update)
  if (scope.node_ids.some(id => {
    const before = baseline.nodes.find(node => node.node_id === id), current = tree.nodes.find(node => node.node_id === id)
    return !before || !current || current.revision !== before.revision || current.position_revision !== before.position_revision
  })) return false
  if (!scope.gaps.length) return true
  try {
    for (const gap of scope.gaps) {
      const before = contentNode(baseline, gap.parent_id), current = contentNode(tree, gap.parent_id)
      if (before.kind !== current.kind || before.tag !== current.tag || before.position_revision !== current.position_revision) return false
    }
    const latest = contentOperationScope(tree, update.tree_operations as ContentOperation[])
    return JSON.stringify(latest.gaps) === JSON.stringify(scope.gaps)
  } catch { return false }
}

/** An old chapter ID remains an alias only when it has one exact tree scope. */
export function treeTargetIds(manifest: ChapterManifest, ids: readonly string[]): string[] {
  const tree = manifest.content_tree
  if (!tree) return [...ids]
  return ids.map(id => {
    if (tree.nodes.some(node => node.node_id === id)) return id
    const chapter = manifest.chapters.find(chapter => chapter.region_id === id)
    const matches = chapter && tree.nodes.filter(node => node.selector === chapter.title_selector || node.selector === chapter.body_selector)
    const section = matches && matches.filter(node => node.kind === 'section')
    if (section?.length === 1) return section[0]!.node_id
    if (matches?.length === 1) return matches[0]!.node_id
    throw new ContractError('CONTENT_NODE_RETIRED', 'Read the current content structure before selecting a target')
  })
}

/** Compatibility projection; the tree remains the authoritative update index. */
export function treeChapters(tree: ContentTree, previous: readonly ChapterRegion[] = []): ChapterRegion[] {
  const root = contentNode(tree, tree.root_id)
  const ids = root.children.length ? root.children : [root.node_id]
  return ids.map(id => {
    const node = contentNode(tree, id)
    const old = previous.find(chapter => chapter.region_id === id)
    return {
      region_id: id, revision: node.revision, title: node.title || old?.title || '内容',
      title_selector: node.selector || ':scope', body_selector: node.selector || ':scope',
      dependencies: old?.dependencies ?? [],
      ownership: old?.ownership ?? { form_ids: [], behavior_ids: [], reference_ids: [], export_ids: [], css_selectors: [] }
    }
  })
}

function covered(tree: ContentTree, allowed: readonly string[], id: string): boolean {
  let node = contentNode(tree, id)
  for (;;) {
    if (allowed.includes(node.node_id)) return true
    if (!node.parent_id) return false
    node = contentNode(tree, node.parent_id)
  }
}

export function assertContentAuthority(update: ChapterUpdate, operations: readonly ContentOperation[]): void {
  const tree = update.base_manifest.content_tree
  if (!tree || !operations.length) throw new ContractError('CONTENT_SCOPE_INVALID', 'A content operation requires an exact bound tree')
  if (update.tree_operations?.length) {
    const shape = (operation: ContentOperation | NonNullable<ChapterUpdate['tree_operations']>[number]) => JSON.stringify({ type: operation.type, node_ids: 'node_ids' in operation ? operation.node_ids : undefined, parent_id: 'parent_id' in operation ? operation.parent_id : undefined, position: 'position' in operation ? operation.position : undefined, anchor_id: 'anchor_id' in operation ? operation.anchor_id : undefined })
    if (operations.length !== update.tree_operations.length || update.tree_operations.some((plan, index) => shape(plan) !== shape(operations[index]!))) {
      const first = update.tree_operations[0]!, id = 'node_ids' in first ? first.node_ids[0]! : first.parent_id
      throw new ContractError(
        'WORKER_CAPABILITY_DENIED',
        `Submitted operations must match the exact authorized group in order. Authorized operations: [${update.tree_operations.map(shape).join(',')}]. Keep these operation fields; provide html for replace/insert.`,
        JSON.stringify({ name: 'read', arguments: { kind: 'content_tree', id, selection: { revision: tree.revision } } })
      )
    }
  }
  const allowed = treeTargetIds(update.base_manifest, update.region_ids)
  for (const operation of operations) {
    if ('html' in operation && /<\s*style(?=[\s/>])/i.test(operation.html) && !allowed.includes(tree.root_id)) throw new ContractError('CONTENT_SHARED_SCOPE_REQUIRED', 'Shared stylesheet changes require an explicit document scope; local blocks can use scoped inline styles')
    if ('node_ids' in operation && operation.node_ids.some(id => !covered(tree, allowed, id))) throw new ContractError('WORKER_CAPABILITY_DENIED', 'Content operation exceeds its authorized nodes')
    if ('parent_id' in operation && !covered(tree, allowed, operation.parent_id)) {
      // An insertion/move may use only the exact gap approved by the router.
      const planned = update.tree_operations?.some(plan => plan.type === operation.type && 'parent_id' in plan && plan.parent_id === operation.parent_id && plan.position === operation.position && ('anchor_id' in plan ? plan.anchor_id : undefined) === ('anchor_id' in operation ? operation.anchor_id : undefined))
      if (!planned) throw new ContractError('WORKER_CAPABILITY_DENIED', 'The destination gap is outside the bound content scope')
    }
  }
}

export function assembleContentUpdate(latest: { bundle: Bundle; manifest: ChapterManifest }, update: ChapterUpdate, operations: ContentOperation[]) {
  assertContentAuthority(update, operations)
  const tree = latest.manifest.content_tree, baseline = update.base_manifest.content_tree
  if (!tree || !baseline) throw new ContractError('CONTENT_TREE_REQUIRED', 'Content operations require a current tree snapshot')
  const result = applyContentOperations({ html: latest.bundle.html, tree, baseline, operations })
  return {
    ...result,
    bundle: { ...latest.bundle, html: result.html },
    chapters: treeChapters(result.tree, latest.manifest.chapters),
    kept: latest.manifest.chapters.filter(chapter => result.tree.nodes.some(node => node.node_id === chapter.region_id && node.revision === chapter.revision)),
    invalid_kept_region_ids: [] as string[]
  }
}

/** Maximal unaffected subtrees retain the earlier request's authority. */
export function remainingContentScope(tree: ContentTree, earlier: readonly string[], takeover: readonly string[], gaps: ContentOperationScope['gaps'] = []): string[] {
  const result: string[] = []
  const visit = (id: string): void => {
    const containsGap = gaps.some(gap => covered(tree, [id], gap.parent_id))
    if (!contentScopeOverlaps(tree, [id], takeover) && !containsGap) { result.push(id); return }
    if (takeover.some(target => covered(tree, [target], id))) return
    for (const child of contentNode(tree, id).children) visit(child)
  }
  for (const id of earlier) visit(id)
  return [...new Set(result)]
}

/** Remainders retain the old input, while their authority names only unfinished scope. */
export function retainedContentScope(previous: ChapterUpdate, takeover: ChapterUpdate): { retained_node_ids: string[]; retained_tree_operations?: ContentOperationPlan[] } {
  const tree = takeover.base_manifest.content_tree
  if (!tree) return { retained_node_ids: [] }
  const next = updateContentScope(takeover)
  if (!previous.tree_operations?.length) return {
    retained_node_ids: remainingContentScope(tree, treeTargetIds(previous.base_manifest, previous.region_ids), next.node_ids, next.gaps)
  }
  const operations: ContentOperationPlan[] = []
  for (const operation of previous.tree_operations) {
    if (!contentUpdatesOverlap({ ...previous, tree_operations: [operation] }, takeover)) {
      operations.push(operation)
      continue
    }
    // Movement keeps its complete source and destination; the scheduler defers conflicts.
    if (operation.type === 'move') {
      operations.push(operation)
      continue
    }
    if (operation.type === 'replace' || operation.type === 'delete') {
      const remaining = remainingContentScope(tree, operation.node_ids, next.node_ids, next.gaps)
      // A single-node group remains valid across conservative DOM wrappers.
      for (const node_id of remaining) operations.push({ type: operation.type, node_ids: [node_id] })
    }
  }
  return {
    retained_node_ids: [...new Set(operations.flatMap(operation => 'node_ids' in operation ? operation.node_ids : [operation.parent_id]))],
    retained_tree_operations: operations
  }
}

/** Replay later intents without granting deferred work a newer position intent. */
export function reconcileRetainedContentScope(previous: ChapterUpdate, later: ChapterUpdate): ReturnType<typeof retainedContentScope> {
  const tree = later.base_manifest.content_tree
  if (!tree || !previous.tree_operations?.length) return retainedContentScope(previous, later)
  const operations = previous.tree_operations.filter(operation => {
    if (operation.type !== 'move') return true
    // Keep the original identities; a retired source or destination cannot be guessed.
    for (const id of operation.node_ids) contentNode(tree, id)
    contentOperationScope(tree, [operation])
    return !later.tree_operations?.some(next => (next.type === 'move' || next.type === 'delete') && next.node_ids.some(id => operation.node_ids.some(source => covered(tree, [id], source))))
  })
  if (!operations.length) return { retained_node_ids: [], retained_tree_operations: [] }
  return retainedContentScope({ ...previous, tree_operations: operations }, later)
}

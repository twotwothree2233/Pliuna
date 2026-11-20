import type { Bundle, ChapterManifest, ChapterRegion, ChapterUpdate, ContentOperation, ContentOperationPlan, ContentTree } from '../../shared/contracts.generated'
import { ContractError } from '../../shared/validation'
import { validateRunnerContract } from '../../shared/runner-validation'
import { applyContentOperations, contentNode, contentOperationScope, contentScopeOverlaps, type ContentOperationScope } from './content-tree'

export const CONTENT_OPERATIONS = 'builtin:content-operations:v1'

export type ContentOperationRequest =
  | { action: 'submit'; operations: ContentOperation[]; read_refs?: string[] }
  | { action: 'register'; operations: ContentOperationPlan[]; read_refs?: string[] }
  | { action: 'query'; operation_id: string }

/** Model arguments contain references, never execution identities or versions. */
export function parseContentRequest(raw: unknown): ContentOperationRequest {
  const invalid = (): never => { throw new ContractError('CONTENT_OPERATION_INVALID', 'Use operations and optional read_refs, action:register, or action:query with operation_id') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid()
  const input = raw as Record<string, unknown>, action = input.action ?? 'submit'
  if (action === 'query') {
    if (Object.keys(input).some(key => !['action', 'operation_id'].includes(key)) || typeof input.operation_id !== 'string' || !input.operation_id) return invalid()
    return { action, operation_id: input.operation_id }
  }
  if (!['submit', 'register'].includes(String(action)) || Object.keys(input).some(key => !['action', 'operations', 'read_refs'].includes(key)) || !Array.isArray(input.operations) || !input.operations.length) return invalid()
  if (input.read_refs !== undefined && (!Array.isArray(input.read_refs) || input.read_refs.some(ref => typeof ref !== 'string' || !ref) || new Set(input.read_refs).size !== input.read_refs.length)) return invalid()
  const read_refs = input.read_refs === undefined ? {} : { read_refs: input.read_refs as string[] }
  if (action === 'register' && input.operations.some(operation => !!operation && typeof operation === 'object' && 'html' in operation)) return invalid()
  try {
    return action === 'register'
      ? { action, operations: input.operations.map(operation => validateRunnerContract('runner_content_operation_plan', operation)), ...read_refs }
      : { action: 'submit', operations: input.operations.map(operation => validateRunnerContract('runner_content_operation', operation)), ...read_refs }
  } catch (error) {
    if (error instanceof ContractError && error.code === 'INVALID_RUNNER_CONTRACT') return invalid()
    throw error
  }
}

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
  return contentScopesOverlap(tree, a, b)
}

function contentScopesOverlap(tree: ContentTree, a: ContentOperationScope, b: ContentOperationScope, historicalLeft = false): boolean {
  if (contentScopeOverlaps(tree, a.node_ids, b.node_ids)) return true
  const crosses = (writes: string[], gaps: ContentOperationScope['gaps'], anchors = true): boolean => gaps.some(gap =>
    writes.some(id => covered(tree, [id], gap.parent_id) || anchors && [gap.before_id, gap.after_id].some(anchor => anchor && contentScopeOverlaps(tree, [id], [anchor]))))
  // Published gaps no longer reserve neighboring anchors' body content.
  return crosses(a.node_ids, b.gaps) || crosses(b.node_ids, a.gaps, !historicalLeft) || a.gaps.some(x => b.gaps.some(y => x.parent_id === y.parent_id && x.before_id === y.before_id && x.after_id === y.after_id))
}

/** Settled history follows retired identities without locking unrelated branches. */
export function completedContentUpdatesOverlap(left: ChapterUpdate, right: ChapterUpdate): boolean {
  if (!['succeeded', 'failed', 'cancelled', 'interrupted', 'superseded'].includes(left.state)) return contentUpdatesOverlap(left, right)
  const baseline = left.base_manifest.content_tree, tree = right.base_manifest.content_tree
  if (!baseline || !tree) return contentUpdatesOverlap(left, right)
  const current = new Map(tree.nodes.map(node => [node.node_id, node]))
  const lineage = new Map(tree.lineage.map(entry => [entry.previous_node_id, entry.successor_node_ids]))
  const resolve = (id: string, visiting = new Set<string>()): string[] => {
    if (current.has(id)) return [id]
    if (visiting.has(id) || !lineage.has(id)) throw new Error('Unresolved historical content identity')
    const next = new Set(visiting).add(id)
    return [...new Set(lineage.get(id)!.flatMap(successor => resolve(successor, next)))]
  }
  const projected: ContentOperationScope = { node_ids: [], gaps: [] }
  // A historical slot is bounded by the nearest surviving original siblings.
  // New nodes inside it belong to that slot, including published insertions.
  const slot = (parentId: string, start: number, end: number): void => {
    const original = contentNode(baseline, parentId), parent = current.get(parentId)
    if (!parent) {
      const successors = resolve(parentId)
      projected.node_ids.push(...successors)
      if (successors.length) return
      if (!original.parent_id) throw new Error('Unresolved historical content container')
      const ancestor = contentNode(baseline, original.parent_id), offset = ancestor.children.indexOf(parentId)
      slot(ancestor.node_id, offset, offset + 1); return
    }
    const boundary = (ids: string[], after: boolean): number => {
      for (const id of ids) {
        const offsets = resolve(id).map(successor => parent.children.indexOf(successor)).filter(offset => offset >= 0)
        if (offsets.length) return after ? Math.max(...offsets) + 1 : Math.min(...offsets)
      }
      return after ? 0 : parent.children.length
    }
    const first = boundary(original.children.slice(0, start).reverse(), true)
    const last = boundary(original.children.slice(end), false)
    if (first > last) throw new Error('Historical content boundaries changed order')
    projected.node_ids.push(...parent.children.slice(first, last))
    for (let offset = first; offset <= last; offset++) {
      const anchor = parent.children[offset]
      projected.gaps.push({ parent_id: parentId, position: anchor ? 'before' : 'end', ...(anchor ? { anchor_id: anchor } : {}), before_id: parent.children[offset - 1] ?? null, after_id: anchor ?? null })
    }
  }
  try {
    const scope = updateContentScope(left)
    for (const id of scope.node_ids) {
      const successors = resolve(id)
      projected.node_ids.push(...successors)
      const moved = left.tree_operations?.some(operation => operation.type === 'move' && operation.node_ids.includes(id))
      if (!successors.length || moved) {
        const original = contentNode(baseline, id)
        if (!original.parent_id) throw new Error('Unresolved historical content root')
        const parent = contentNode(baseline, original.parent_id), offset = parent.children.indexOf(id)
        slot(parent.node_id, offset, offset + 1)
      }
    }
    for (const gap of scope.gaps) {
      const parent = contentNode(baseline, gap.parent_id), offset = gap.after_id ? parent.children.indexOf(gap.after_id) : parent.children.length
      slot(parent.node_id, offset, offset)
    }
    return contentScopesOverlap(tree, projected, updateContentScope(right), true)
  } catch { return true }
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

function sameGap(left: ContentOperationScope['gaps'][number], right: ContentOperationScope['gaps'][number]): boolean {
  return left.parent_id === right.parent_id && left.before_id === right.before_id && left.after_id === right.after_id
}

/** User boundaries are stable across candidate and eligibility revisions. */
export function assertContentBoundary(update: ChapterUpdate, operations: readonly ContentOperationPlan[]): void {
  const tree = update.base_manifest.content_tree
  if (!tree || !operations.length) throw new ContractError('CONTENT_SCOPE_INVALID', 'A content operation requires an exact bound tree')
  const allowed = treeTargetIds(update.base_manifest, update.authorization?.region_ids ?? update.region_ids)
  const legacyGaps = !update.authorization && update.tree_operations?.length ? contentOperationScope(tree, update.tree_operations).gaps : []
  for (const operation of operations) {
    if ('html' in operation && typeof operation.html === 'string' && /<\s*style(?=[\s/>])/i.test(operation.html) && !allowed.includes(tree.root_id)) throw new ContractError('CONTENT_SHARED_SCOPE_REQUIRED', 'Shared stylesheet changes require an explicit document scope; local blocks can use scoped inline styles')
    if ('node_ids' in operation && operation.node_ids.some(id => !covered(tree, allowed, id))) throw new ContractError('WORKER_CAPABILITY_DENIED', 'Content operation exceeds its authorized nodes')
    if ('parent_id' in operation && !covered(tree, allowed, operation.parent_id)) {
      const actual = contentOperationScope(tree, [operation]).gaps
      if (!actual.every(gap => legacyGaps.some(allowed => sameGap(gap, allowed)))) throw new ContractError('WORKER_CAPABILITY_DENIED', 'The destination gap is outside the user-authorized content scope')
    }
  }
  // Container validity and exact adjacency are checked even inside the boundary.
  contentOperationScope(tree, operations)
}

export function assertContentAuthority(update: ChapterUpdate, operations: readonly ContentOperation[]): void {
  assertContentBoundary(update, operations)
  const tree = update.base_manifest.content_tree!
  if (update.scope_revision === 0 || update.scope_active === false) throw new ContractError('CONTENT_SCOPE_UNREGISTERED', 'Register the actual content scope or submit for atomic scope registration')
  if (update.scope_revision === undefined && update.tree_operations?.length) {
    const shape = (operation: ContentOperationPlan) => JSON.stringify({ type: operation.type, ...('node_ids' in operation ? { node_ids: operation.node_ids } : {}), ...('parent_id' in operation ? { parent_id: operation.parent_id, position: operation.position, ...('anchor_id' in operation ? { anchor_id: operation.anchor_id } : {}) } : {}) })
    if (operations.length !== update.tree_operations.length || update.tree_operations.some((plan, index) => shape(plan) !== shape(operations[index]!))) throw new ContractError('WORKER_CAPABILITY_DENIED', 'Legacy content work retains its original exact operation authority')
  }
  const actual = contentOperationScope(tree, operations), registered = updateContentScope(update)
  const allowed = update.scope_revision === undefined ? treeTargetIds(update.base_manifest, update.region_ids) : registered.node_ids
  if (actual.node_ids.some(id => !covered(tree, allowed, id)) || actual.gaps.some(gap => !covered(tree, allowed, gap.parent_id) && !registered.gaps.some(allowed => sameGap(gap, allowed)))) {
    throw new ContractError('CONTENT_SCOPE_INVALID', 'Content operations require a revision covering their actual nodes and destination gaps')
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

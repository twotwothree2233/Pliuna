import { createHash } from 'node:crypto'
import semver from 'semver'
import { ContractError } from '../../shared/validation'
import type { PluginCopy } from './package'

export type Enablement = { digest: string; task_id: string | null }
export type Workflow = { task_id: string; digest: string; contribution_id: string }
export type EnablePlan = { fingerprint: string; task_id: string; root: string; packages: { digest: string; plugin_id: string; version: string; access_level: 'task' | 'global'; executable: boolean; already_enabled: boolean }[] }
const fail = (code: string): never => { throw new ContractError(code, 'Plugin selection cannot be enabled; review dependencies, scope and the exact installed versions') }
export function buildEnablePlan(packages: PluginCopy[], enabled: Enablement[], task: string, root: string, choices: string[] = []): EnablePlan {
  const byDigest = new Map(packages.map(copy => [copy.digest, copy]))
  const selected = [root, ...choices].map(digest => byDigest.get(digest) ?? fail('PLUGIN_NOT_INSTALLED'))
  if (choices.length > 64 || new Set(selected.map(copy => copy.manifest.id)).size !== selected.length) fail('PLUGIN_DEPENDENCY_AMBIGUOUS')
  const explicit = new Map(selected.map(copy => [copy.manifest.id, copy]))
  const used = new Map<string, PluginCopy>(), visiting = new Set<string>()
  function visit(copy: PluginCopy): void {
    const id = copy.manifest.id
    if (visiting.has(id)) fail('PLUGIN_DEPENDENCY_CYCLE')
    if (used.has(id)) { if (used.get(id)!.digest !== copy.digest) fail('PLUGIN_DEPENDENCY_CONFLICT'); return }
    visiting.add(id)
    for (const dependency of copy.manifest.dependencies ?? []) {
      if (!semver.validRange(dependency.version_range)) fail('PLUGIN_DEPENDENCY_RANGE_INVALID')
      if (!dependency.required) continue
      const candidates = packages.filter(p => p.manifest.id === dependency.plugin_id && semver.satisfies(p.manifest.version, dependency.version_range))
      const chosen = explicit.get(dependency.plugin_id) ?? used.get(dependency.plugin_id)
      if (chosen && !candidates.some(candidate => candidate.digest === chosen.digest)) fail('PLUGIN_DEPENDENCY_VERSION')
      if (!chosen && candidates.length !== 1) fail(candidates.length ? 'PLUGIN_DEPENDENCY_AMBIGUOUS' : 'PLUGIN_DEPENDENCY_MISSING')
      visit(chosen ?? candidates[0]!)
    }
    visiting.delete(id); used.set(id, copy)
  }
  visit(selected[0]!)
  if (choices.some(digest => ![...used.values()].some(copy => copy.digest === digest))) fail('PLUGIN_DEPENDENCY_UNUSED_CHOICE')
  const items = [...used.values()].map(copy => ({ digest: copy.digest, plugin_id: copy.manifest.id, version: copy.manifest.version, access_level: copy.manifest.access_level, executable: !!copy.manifest.backend, already_enabled: enabled.some(e => e.digest === copy.digest && e.task_id === (copy.manifest.access_level === 'global' ? null : task)) }))
  const details = { task_id: task, root, packages: items }
  return { fingerprint: createHash('sha256').update(JSON.stringify(details)).digest('hex'), ...details }
}
export function unavailableDependencies(copy: PluginCopy, packages: PluginCopy[], enabled: Enablement[], task: string): string[] {
  return (copy.manifest.dependencies ?? []).filter(dependency => dependency.required && (!semver.validRange(dependency.version_range) || !enabled.some(e => {
    const candidate = packages.find(p => p.digest === e.digest)
    return candidate && (e.task_id === null || e.task_id === task) && candidate.manifest.id === dependency.plugin_id && semver.satisfies(candidate.manifest.version, dependency.version_range)
  }))).map(dependency => dependency.plugin_id)
}

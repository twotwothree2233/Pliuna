import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateRunnerContract } from '../../src/shared/runner-validation'

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`../fixtures/contracts/${name}`, import.meta.url), 'utf8'))

describe('content eligibility contracts', () => {
  it('separates unresolved candidates from immutable authorization and current write scope', () => {
    const value = fixture('25-content-candidates.json')
    expect(validateRunnerContract('runner_chapter_update', value)).toBe(value)
    expect(() => validateRunnerContract('runner_chapter_update', { ...value, region_ids: value.candidate_region_ids })).toThrow()
    expect(() => validateRunnerContract('runner_chapter_update', { ...value, authorization: undefined })).toThrow()
    expect(() => validateRunnerContract('runner_chapter_update', { ...value, scope_active: true })).toThrow()
  })
  it('retains strict legacy scope and exact revision/source/read bindings', () => {
    const legacy = fixture('17-chapter-update.json'), revision = fixture('26-content-scope.json')
    expect(validateRunnerContract('runner_chapter_update', legacy)).toBe(legacy)
    expect(() => validateRunnerContract('runner_chapter_update', { ...legacy, region_ids: [], region_intents: [] })).toThrow()
    expect(validateRunnerContract('runner_content_scope_revision', revision)).toBe(revision)
    expect(() => validateRunnerContract('runner_content_scope_revision', { ...revision, read_refs: ['read-1', 'read-1'] })).toThrow()
    expect(() => validateRunnerContract('runner_content_scope_revision', { ...revision, source: { ...revision.source, update_id: 'other-update' } })).toThrow()
  })
})

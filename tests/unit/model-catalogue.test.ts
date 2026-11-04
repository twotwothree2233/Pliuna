import { expect, it } from 'vitest'
import { ChatAdapter } from '../../src/runtime/model/adapter'

const catalogue = (rows: unknown[]) => {
  const adapter = new ChatAdapter(async () => new Response(JSON.stringify({ data: rows }), { headers: { 'content-type': 'application/json' } }))
  return adapter.catalogue({ base_url: 'https://example.test/v1' }, 'synthetic-only', new AbortController().signal)
}
it('uses explicit service fields and reports retrieval source without returning provider payload', async () => {
  const result = await catalogue([{ id: 'wire', context_length: 240000, max_output_tokens: 8192, private_field: 'not-returned' }])
  expect(result).toEqual({ source: 'service', fetched_at: expect.any(String), models: [{ id: 'wire', context_tokens: 240000, max_output_tokens: 8192, conflicts: [] }] })
  expect(Number.isFinite(Date.parse(result.fetched_at))).toBe(true)
})
it('keeps missing values unknown and never infers capacities from model names', async () => {
  expect((await catalogue([{ id: 'model-1000000' }])).models).toEqual([{ id: 'model-1000000', conflicts: [] }])
})
it('rejects conflicting aliases, duplicate-row conflicts, nonnumeric values and accepts independent input/output capacities', async () => {
  const result = await catalogue([
    { id: 'alias', context_length: 240000, context_tokens: 120000, max_output_tokens: 8192 },
    { id: 'duplicate', context_length: 240000 }, { id: 'duplicate', context_length: 120000 },
    { id: 'invalid', context_length: '240000', max_output_tokens: 0 },
    { id: 'relationship', context_length: 1024, max_output_tokens: 2048 }
  ])
  expect(result.models).toEqual([
    { id: 'alias', max_output_tokens: 8192, conflicts: ['context_tokens'] },
    { id: 'duplicate', conflicts: ['context_tokens'] },
    { id: 'invalid', conflicts: ['context_tokens', 'max_output_tokens'] },
    { id: 'relationship', context_tokens: 1024, max_output_tokens: 2048, conflicts: [] }
  ])
})
it('retains compatible ID-only discovery and exact IDs', async () => {
  const adapter = new ChatAdapter(async () => new Response(JSON.stringify({ data: [{ id: 'vendor/exact' }, { id: 'vendor/exact' }] })))
  expect(await adapter.discover({ base_url: 'https://example.test/v1' }, '', new AbortController().signal)).toEqual(['vendor/exact'])
})

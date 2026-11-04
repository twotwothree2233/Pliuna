import { expect, it } from 'vitest'
import { setup } from '../helpers/compaction'
import { requestEvidence } from '../../src/runtime/model/request-evidence'
import { assertContract } from '../../src/shared/validation'
import { readPermission } from '../../src/runtime/model/read-policy'
it('keeps current read permission unchanged', () => {
  expect(readPermission()).toEqual({ scope: 'current-task', separate_approval: false, dispatch: 'available', object_checks: 'required', user_intent: 'not_inferred' })
})
it('records exactly the supplied messages as internal sources without adding model-visible lineage', async () => {
  const s = setup(); await s.run()
  const messages = s.request.mock.calls[0]![2], before = JSON.stringify(messages)
  const event = requestEvidence(messages, 'request', 'summary')
  assertContract('request_evidence', event)
  expect(event.originals.map(entry => entry.source.id)).toEqual(['user','old','recent','last-response','last-result-a','last-result-b'])
  expect(event.supplements).toEqual([]); expect(event.reviewed_requests).toEqual([])
  expect(JSON.stringify(messages)).toBe(before)
  expect(JSON.stringify(event)).not.toContain('中😀')
})

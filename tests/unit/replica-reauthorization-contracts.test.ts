import { describe, expect, it } from 'vitest'
import { assertContract } from '../../src/shared/validation'

const preview = {
  type: 'maintenance.replica.reauthorize.preview',
  token: '10000000-0000-4000-8000-000000000001',
  operation_id: '20000000-0000-4000-8000-000000000001',
  inputs_saved: true
}
const confirmation = {
  ...preview,
  type: 'maintenance.replica.reauthorize.confirm',
  authorization_id: '30000000-0000-4000-8000-000000000001',
  confirm_reauthorize_replica: true
}
const check = (value: unknown) => assertContract('ipc_request', value)

describe('replica reauthorization IPC authority', () => {
  for (const request of [preview, confirmation]) {
    it(`accepts ${request.type}`, () => expect(() => check(request)).not.toThrow())
    for (const key of Object.keys(request)) it(`${request.type} requires ${key}`, () => {
      const incomplete: Record<string, unknown> = { ...request }
      delete incomplete[key]
      expect(() => check(incomplete)).toThrow()
    })
    for (const field of ['token', 'operation_id', ...('authorization_id' in request ? ['authorization_id'] : [])]) {
      it(`${request.type} rejects invalid ${field}`, () => expect(() => check({ ...request, [field]: 'another-operation' })).toThrow())
    }
    for (const field of ['selected', 'graph', 'members', 'replica_id']) {
      it(`${request.type} rejects client supplied ${field}`, () => expect(() => check({ ...request, [field]: [] })).toThrow())
    }
    it(`${request.type} requires saved inputs`, () => expect(() => check({ ...request, inputs_saved: false })).toThrow())
  }
  it('requires an explicit affirmative confirmation', () => {
    expect(() => check({ ...confirmation, confirm_reauthorize_replica: false })).toThrow()
  })
  it('does not accept the original retirement confirmation as renewed authority', () => {
    const { confirm_reauthorize_replica: _, ...request } = confirmation
    expect(() => check({ ...request, confirm_retire_replica: true })).toThrow()
  })
  it('queries the exact original authorization after an unknown confirmation result', () => {
    const request = { type: 'maintenance.replica.status', operation_id: confirmation.operation_id }
    expect(() => check(request)).not.toThrow()
    expect(() => check({ ...request, authorization_id: confirmation.authorization_id })).not.toThrow()
    expect(() => check({ ...request, authorization_id: 'another-authorization' })).toThrow()
  })
})

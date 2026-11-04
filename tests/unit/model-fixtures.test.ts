import { expect, it } from 'vitest'
import { modelInputFromHost } from '../helpers/model-server'

it('keeps cursor continuation free of implicit view overrides', () => {
  expect(modelInputFromHost('read', { target: { kind: 'resource', id: 'resource' }, cursor: 'cursor' })).toEqual({ kind: 'resource', id: 'resource', cursor: 'cursor' })
  expect(modelInputFromHost('read', { target: { kind: 'resource', id: 'resource' }, cursor: 'cursor', content: { max_chars: 100 } })).toEqual({ kind: 'resource', id: 'resource', cursor: 'cursor', max_chars: 100, selection: { view: 'text' } })
})

it('retains explicit initial views and version selections', () => {
  expect(modelInputFromHost('read', { target: { kind: 'resource', id: 'resource' }, content: { max_chars: 32000 } })).toEqual({ kind: 'resource', id: 'resource', max_chars: 32000, selection: { view: 'text' } })
  expect(modelInputFromHost('read', { target: { kind: 'task_data', id: 'data', expected_revision: 2 } })).toEqual({ kind: 'task_data', id: 'data', selection: { view: 'object', revision: 2 } })
})

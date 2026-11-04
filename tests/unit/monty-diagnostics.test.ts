import { expect, it } from 'vitest'
import { executionDiagnostic } from '../../src/runtime/monty/diagnostics'

it('does not expose arbitrary exception text, paths, frames or unknown exception names', () => {
  for (const typeName of ['ValueError', 'KeyError', 'RuntimeError', '/synthetic/private', 'PermissionError', 'NameError']) {
    const output = executionDiagnostic({typeName, message: '/synthetic/private SECRET_VALUE'}, 'result = 1')
    expect(JSON.stringify(output)).not.toMatch(/synthetic|SECRET_VALUE/)
  }
  expect(executionDiagnostic({typeName:'RuntimeError',message:'allocation failed'}, 'result = 1').error).toBe('MONTY_EXECUTION_FAILED')
  expect(executionDiagnostic({typeName:'SyntaxError',message:'private'}, 'result =', [], 500).message).not.toContain('line')
})

it('maps only frames matching the submitted code and ignores dynamic/generated frames', () => {
  const error = {typeName:'NameError',message:"name 'missing' is not defined"}
  const frame = {filename:'<python-input-0>',line:3,column:1,endLine:3,endColumn:2,sourceLine:'    result = missing'}
  expect(executionDiagnostic(error,'result = missing',[frame]).message).toContain('code line 1')
  for (const change of [{filename:'<string>'},{sourceLine:'generated helper'}, {line:200}]) expect(executionDiagnostic(error,'result = missing',[{...frame,...change}]).message).not.toContain('line')
})

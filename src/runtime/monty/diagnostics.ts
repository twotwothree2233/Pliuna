import type { ExceptionInfo, Frame } from '@pydantic/monty'

export function executionDiagnostic(exception: ExceptionInfo, code: string, frames: Frame[] = [], syntaxLine?: number): { error: string; message: string } {
  const types = ['SyntaxError', 'NameError', 'UnboundLocalError', 'PermissionError', 'MemoryError', 'RecursionError', 'TimeoutError', 'ZeroDivisionError', 'TypeError', 'ValueError', 'IndexError', 'KeyError', 'AttributeError', 'RuntimeError', 'ImportError', 'ModuleNotFoundError', 'NotImplementedError']
  const type = types.includes(exception.typeName) ? exception.typeName : 'ExecutionError'
  const lines = code.split('\n')
  const frame = [...frames].reverse().find(frame => /^<python-input-\d+>$/.test(frame.filename) && frame.line >= 3 && frame.line <= lines.length + 2 && frame.sourceLine === '    ' + lines[frame.line - 3])
  // The wrapper has two lines before the submitted source. Never report generated/eval lines.
  const line = (frame?.line ?? syntaxLine ?? 0) - 2
  const location = Number.isSafeInteger(line) && line >= 1 && line <= lines.length ? ` at code line ${line}` : ''
  let error = 'MONTY_EXECUTION_FAILED', reason = ''
  if (type === 'SyntaxError') { error = 'MONTY_SYNTAX_ERROR'; reason = 'invalid Python syntax' }
  if (['NameError', 'UnboundLocalError'].includes(type)) {
    error = 'MONTY_NAME_ERROR'
    const name = /^name '([A-Za-z_][A-Za-z0-9_]*)' is not defined$/.exec(exception.message)?.[1]
    if (name && code.includes(name)) reason = `${name} is not defined`
  }
  if (type === 'PermissionError') { error = 'MONTY_OPERATION_DENIED'; reason = 'operation denied by the calculation sandbox' }
  if (['MemoryError', 'RecursionError', 'TimeoutError'].includes(type)) { error = 'MONTY_RESOURCE_LIMIT'; reason = 'published calculation resource limit reached' }
  const unsupported = /^'([A-Za-z_][A-Za-z0-9_.]*)' is not supported in this environment$/.exec(exception.message)?.[1]
  if (['ImportError', 'ModuleNotFoundError', 'NotImplementedError'].includes(type) || (type === 'RuntimeError' && unsupported)) {
    error = 'MONTY_OPERATION_UNSUPPORTED'
    reason = unsupported && code.includes(unsupported) ? `${unsupported} is unavailable in this runtime` : 'operation or module unavailable in this runtime'
  }
  return { error, message: type + location + (reason ? ': ' + reason : '') }
}

import { ContractError } from '../../shared/validation'

export const MONTY_ID = 'builtin:monty:v1'
export const montyLimits = Object.freeze({ source_input_bytes: 1048576, memory_bytes: 134217728, execution_ms: 120000, wall_ms: 180000, print_bytes: 1048576, result_bytes: 268435456, feedback_bytes: 32768, recursion: 1000, suspensions: 1000, sleep_seconds: 0, active_app: 4 })
export interface MontyInput { code: string; inputs: Record<string, unknown> }
export const montyContract = {
  id: MONTY_ID, version: 1, runtime: '@pydantic/monty@1.3.0', kind: 'capability',
  description: 'Local restricted Python calculation, text and structured-data transformation. Not CPython or third-party libraries. Set result in code. Each inputs key is a code variable; there is no implicit inputs dictionary. references do not bind variables or load resource content. One fresh execution; no host files/network/callbacks or persistent session.',
  input_schema: { type: 'object', properties: { code: { type: 'string', minLength: 1 }, inputs: { type: 'object' } }, required: ['code', 'inputs'], additionalProperties: false },
  output: 'version1 runtime/contract_version/value(wire_value)/stdout/stderr. Large results are immutable JSON resources; bytes are managed resource references embedded in value. A saved result is not a proof of mathematical correctness. Unsupported or non-faithful encodings fail explicitly, without repr conversion.',
  limits: montyLimits, effect: 'compute-and-save-new-output', approval: 'Default same-task output creation only; existing business mutations require their independent authorization.',
  lifecycle: 'One session, one execution, worker retired. Cancellation revokes commit first and waits for process-group exit. No automatic replay. No host Python/Node/shell fallback.',
  nondeterminism: 'Runtime system clock and random entropy remain available. No extra host callbacks. Real sleep is rejected. Allocator limit is not process RSS.',
  example: { code: 'result = sum(values)', inputs: { values: [2, 3, 5] } }
}
export function validateMontyInput(value: unknown): MontyInput {
  const input = value as MontyInput
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'code,inputs' || typeof input.code !== 'string' || !input.code.trim() || !input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs)) throw new ContractError('MONTY_INPUT_INVALID', 'Expected actual JSON {code,inputs}; assign the calculation output to result')
  if (Buffer.byteLength(JSON.stringify(input)) > montyLimits.source_input_bytes) throw new ContractError('MONTY_INPUT_LIMIT', 'Code and explicit inputs exceed the published calculation input limit')
  return input
}

import Ajv2020 from 'ajv/dist/2020.js'
import schema from './contracts/core.schema.json'
import type { Bundle, IpcRequest, ModelRequest } from './contracts.generated'

const ajv = new Ajv2020({ allErrors: true, strict: false })
ajv.addSchema(schema)
export class ContractError extends Error {
  constructor(readonly code: string, message: string, readonly suggestion?: string) { super(message) }
}
export function assertContract<T>(definition: string, value: unknown): asserts value is T {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${definition}`)!
  if (!check(value)) throw new ContractError('INVALID_REQUEST', ajv.errorsText(check.errors))
}
export const validateIpc = (value: unknown): IpcRequest => { assertContract<IpcRequest>('ipc_request', value); return value }
export const validateBundle = (value: unknown): Bundle => { assertContract<Bundle>('bundle', value); return value }
export const validateModel = (value: unknown): ModelRequest => { assertContract<ModelRequest>('model_request', value); return value }

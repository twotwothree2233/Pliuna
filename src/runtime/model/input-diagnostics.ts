import type { ErrorObject } from 'ajv'
import core from '../../shared/contracts/core.schema.json'

const at = (value: any, pointer: string): any => pointer.replace(/^#/, '').split('/').slice(1).reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], value)

export function inputDiagnostic(errors: ErrorObject[] | null | undefined, input: unknown, schema: unknown = core): string {
  const excluded: { schema: string; instance: string }[] = []
  const resolve = (node: any): any => node?.$ref ? at(core, node.$ref) : node
  const selectedBranch = (branches: any[], value: any) => branches.findIndex(branch => Object.entries(branch.properties ?? {}).some(([key, rule]: [string, any]) => rule.const !== undefined && value?.[key] === rule.const))
  const schemaAt = (pointer: string): any => {
    let node: any = schema, value: any = input
    for (const encoded of pointer.split('/').slice(1)) {
      const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~')
      node = resolve(node)
      if (node?.oneOf) node = node.oneOf[selectedBranch(node.oneOf, value)]
      node = resolve(node?.type === 'array' ? node.items : node?.properties?.[key])
      value = value?.[key]
    }
    return node
  }
  for (const error of errors ?? []) {
    if (error.keyword !== 'oneOf') continue
    const pointer = error.schemaPath.replace(core.$id, '')
    const branches = resolve(schemaAt(error.instancePath))?.oneOf ?? at(schema, pointer) ?? at(core, pointer), value = at(input, error.instancePath)
    if (!Array.isArray(branches)) continue
    const selected = selectedBranch(branches, value)
    if (selected >= 0) for (let index = 0; index < branches.length; index++) if (index !== selected) excluded.push({ schema: `${error.schemaPath}/${index}/`, instance: error.instancePath })
  }
  const first = errors?.find(error => !['oneOf', 'anyOf', 'const', 'if'].includes(error.keyword) && !excluded.some(prefix => error.schemaPath.startsWith(prefix.schema) && (error.instancePath === prefix.instance || error.instancePath.startsWith(prefix.instance + '/'))))
  if (!first) return 'Input does not match the selected operation contract; read its schema'
  const detail = first.keyword === 'required' ? ': ' + first.params.missingProperty : first.keyword === 'additionalProperties' ? ': ' + first.params.additionalProperty : first.keyword === 'enum' ? ': ' + first.params.allowedValues.join(', ') : ''
  return `${first.instancePath || '/'} ${first.message}${detail}`
}

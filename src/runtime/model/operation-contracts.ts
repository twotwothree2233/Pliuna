import core from '../../shared/contracts/core.schema.json'
import { modelTools } from './tools'
import { managedVocabulary } from '../managed'
import type { ReadSelection } from './tool-input'
import { ContractError } from '../../shared/validation'

const examples: Record<string, Record<string, unknown>> = {
  'task_data.create': { data: { schema: { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false }, value: { stage: 'initial' }, references: [] } },
  'task_data.replace': { id: '<对象ID>', expected_revision: 1, value: { stage: 'updated' }, references: [] },
  'task_data.remove': { id: '<对象ID>', expected_revision: 1 },
  'resource.create': { display_name: '说明', content: { type: 'text', text: '正文' } },
  'surface.update': { surface_id: '<Surface ID>', expected_revision: 1, operations: [{ type: 'view.create', client_ref: 'example', slot_id: 'main', bundle: { type: 'inline', bundle: { profile: 'managed-v1', html: '<section id="lesson"><p>内容</p></section>', css: '', state: { schema: { type: 'object', properties: {}, additionalProperties: false }, initial: {}, compatibility_version: 'example-v1' }, forms: [], behaviors: [], references: [], export: [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }] } } }] }
}
const descriptions: Record<string, string> = {
  'task_data.create': '创建固定 schema 的任务数据对象。',
  'task_data.replace': '按精确版本替换任务数据及完整显式引用。',
  'task_data.remove': '按精确版本移除任务数据；宿主核验引用和审批。',
  'resource.create': '创建不可变文本或 JSON 资源。',
  'surface.update': '原子更新 Surface 中的 View 和布局。',
  'tool.list': '目录、元数据筛选与分页参数。',
  'tool.read': '对象、版本、行范围和正文分片读取参数。',
  'tool.call': '能力参数与显式引用；具体能力另按 ID 读取。'
}
export const operationDirectory = Object.keys(descriptions).map(id => ({ id, description: descriptions[id], contract_target: { kind: 'object_type', id } }))

function surfaceExample(type: string): Record<string, unknown> {
  const example = structuredClone(examples['surface.update']!), create = (example.operations as any[])[0]
  if (type === 'view.replace') example.operations = [{ type, view_id: '<View ID>', expected_view_revision: 1, bundle: create.bundle, state_transition: { type: 'preserve', expected_state_revision: 1, compatibility_version: 'example-v1' } }]
  if (type === 'view.remove') example.operations = [{ type, view_id: '<View ID>', expected_view_revision: 1, expected_state_revision: 1 }]
  if (type === 'layout.set') example.operations = [{ type, layout: { slots: [{ slot_id: 'main', groups: [{ id: 'column', mode: 'column', views: [{ type: 'existing', view_id: '<View ID>' }], gap: 'medium', align: 'stretch' }] }] } }]
  return { operation: 'surface.update', input_json: JSON.stringify(example) }
}

export function scopedSchema(root: Record<string, any>): Record<string, unknown> {
  const definitions: Record<string, unknown> = {}, source: Record<string, unknown> = core.$defs
  const include = (value: unknown) => {
    for (const match of JSON.stringify(value).matchAll(/"\$ref":"#\/\$defs\/([^"/]+)"/g)) {
      const key = match[1]!
      if (!Object.hasOwn(definitions, key)) { definitions[key] = source[key]; include(source[key]) }
    }
  }
  include(root)
  return { ...root, ...(Object.keys(definitions).length ? { $defs: definitions } : {}) }
}

export function operationContract(id: string): Record<string, unknown> | undefined {
  const branch = core.$defs.write.oneOf.find(value => value.properties.type.const === id)
  if (branch) {
    const { type: _route, ...properties } = branch.properties
    return { id, operation: id, description: descriptions[id], input_schema: scopedSchema({ ...branch, properties, required: branch.required.filter(key => key !== 'type') }), example: { operation: id, input_json: JSON.stringify(examples[id]) } }
  }
  const tool = modelTools.find(tool => 'tool.' + tool.function.name === id)
  if (tool) return { id, description: descriptions[id], input_schema: tool.function.parameters, example: JSON.parse(tool.function.description.split('示例：')[1]!), ...(id === 'tool.list' ? { directories: core.$defs.list.properties.kind.enum, filters: core.$defs.list.properties.filters } : {}), ...(id === 'tool.read' ? { rules: ['max_chars limits representation code points, default 4000, maximum 32000.', 'Plain UTF-8 resources default to text; metadata selects metadata, object selects the public object. Other originals are not parsed implicitly.', 'lines/pages are one-based inclusive; pages require a saved page index. find is a case-sensitive literal on one text resource; search scan is not body delivery.', 'Cursor continuation needs only kind/id/cursor; repeated selection or max_chars must exactly match. Restart invalidates cursors.', 'guide/schema/example and section apply only to contracts; object preserves the complete public object.'] } : {}) }
  return undefined
}

function targetCapability(contract: Record<string, any>): boolean { return contract.kind === 'capability' || String(contract.id).startsWith('plugin:') || String(contract.id).startsWith('builtin:') }

function fields(schema: any): unknown {
  return Object.entries(schema?.properties ?? {}).map(([name, value]: [string, any]) => ({ name, required: schema.required?.includes(name) ?? false, type: value.type ?? (value.$ref ? value.$ref : value.oneOf ? 'oneOf; read schema' : 'JSON'), ...(value.description ? { description: value.description } : {}), ...Object.fromEntries(Object.entries(value).filter(([key]) => ['enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(key))) }))
}

export function contractRepresentation(contract: Record<string, any>, selection: ReadSelection): unknown {
  const view = selection.view ?? 'guide'
  if (view === 'object') return contract
  const sections = new Map<string, unknown>()
  sections.set('input', contract.input_schema ?? contract.capability?.input_schema)
  const capability = targetCapability(contract)
  const example = capability && contract.example !== undefined ? { capability: contract.id, input_json: JSON.stringify(contract.example) } : contract.example
  sections.set('example', example)
  for (const [key, value] of Object.entries(contract)) if (!['id', 'kind', 'description', 'input_schema', 'example', 'capability'].includes(key)) sections.set(key, value)
  if (contract.capability) for (const [key, value] of Object.entries(contract.capability)) if (!['id', 'description', 'input_schema'].includes(key)) sections.set(key, value)
  if (contract.id === 'surface.update') {
    for (const [key, schema] of Object.entries(contract.input_schema?.$defs ?? {})) sections.set(key, scopedSchema(schema as Record<string, any>))
    const bundle = (core.$defs as any).bundle
    for (const [key, schema] of Object.entries(bundle.properties)) sections.set('bundle.' + key, scopedSchema(schema as Record<string, any>))
    for (const branch of (core.$defs as any).view_op.oneOf) {
      const type = branch.properties.type.const
      sections.set(type, scopedSchema(branch))
      sections.set(type + '.example', surfaceExample(type))
    }
    sections.set('export-rules', {
      categories: { learning: 'General learning/task material, including a generated verification table. Not a submitted personal answer.', answer: 'A formally submitted personal answer; requires its existing answer_id and exact original view_history_id.', feedback: 'Personal feedback on that submitted answer; requires the same exact binding.', mixed_personal: 'Inseparable learning and personal answer/feedback; requires exact binding and explicit personal export selection.', unclassified: 'Unresolved classification; omitted with an issue, never made learning automatically.' },
      roots: 'Element roots must exist and cannot duplicate or overlap. Content outside declared roots is not automatically exported. A single learning root may cover an entirely non-personal View.',
      snapshot_sources: 'Only same-task task_data with exact expected_revision. Immutable resource references belong in bundle.references, not snapshot_sources.',
      check: { kind: 'view', id: '<View ID>', selection: { view: 'export_check', revision: 1 } },
      check_scope: 'Read-only default-learning export diagnosis for one published revision. Does not save a file, infer privacy/classification, select personal content or grant permission.'
    })
    sections.set('state-and-references', {
      draft: 'State initial values and saved drafts use raw control representations: number/integer fields are strings such as "12.5", not JSON numbers. control:"number" uses input type="text" to retain raw text; range uses type="range". Formal answers convert validated raw strings to numbers; their schema remains number/integer.',
      empty: 'A noninteractive View may use state {schema:{type:"object",properties:{},additionalProperties:false},initial:{},compatibility_version:"v1"}, forms:[], behaviors:[].',
      preserve: 'view.replace preserve requires the exact current state revision, unchanged state schema and matching compatibility_version. Read the current View; do not guess versions.',
      references: 'bundle.references names immutable same-task resources. snapshot_sources binds same-task task_data with exact expected_revision. Neither loads contents into state or the model context.',
      history: { kind: 'view_history', id: '<History ID>', selection: { view: 'export_check' } }
    })
    sections.set('html-css', {
      ...managedVocabulary(),
      html: { structure: 'Browser HTML/SVG/MathML, including semantic attributes and inline styles. Unique local IDs; declared behavior targets must exist.', images: 'Declared same-task verified PNG/JPEG references via trellis-resource:<name>. No external or file requests.', local_references: 'label.for and aria-describedby must name existing local IDs.', controls: 'Declared behavior/control/schema types must agree; native submission and navigation are disabled.' },
      css: { structure: 'Browser CSS, including custom properties, fonts, media/container queries, keyframes, nesting, pseudo-elements and functions. Styles are isolated per View.', resources: 'No external stylesheets or URLs; local fragment URLs are supported.' },
      complete_validation: { kind: 'object_type', id: 'surface.update', selection: { view: 'schema', section: 'bundle' } }
    })
  }
  const available = [...sections].filter(([, value]) => value !== undefined)
  sections.set('sections', available.map(([id]) => id))
  const target = { kind: contract.kind === 'capability' || String(contract.id).startsWith('plugin:') || String(contract.id).startsWith('builtin:') ? 'capability' : 'object_type', id: contract.id }
  const rootSections = contract.id === 'surface.update' ? ['input', 'example', 'view_op', 'view.create', 'view.replace', 'view.remove', 'layout.set', 'state_transition', 'bundle', 'state-and-references', 'export-rules', 'html-css', 'sections'] : [...available.map(([id]) => id)]
  const links = rootSections.map(id => ({ id, read: { ...target, selection: { view: id === 'example' ? 'example' : 'schema', section: id } } }))
  if (selection.section !== undefined) {
    if (!sections.has(selection.section) || sections.get(selection.section) === undefined) throw new ContractError('UNKNOWN_CONTRACT_SECTION', 'Unknown contract section; read guide for section IDs')
    const section = sections.get(selection.section)
    if (['export-rules', 'state-and-references'].includes(selection.section)) return section
    const branch = contract.id === 'surface.update' && ['view.create', 'view.replace', 'view.remove', 'layout.set'].includes(selection.section)
    if (view === 'example' && branch) return sections.get(selection.section + '.example')
    return view === 'guide' ? { id: contract.id, section: selection.section, fields: fields(section), ...(branch ? { outer_fields: fields(sections.get('input')), example: surfaceExample(selection.section) } : {}), sections: [...sections.keys()], complete: false, read_schema: { ...target, selection: { view: 'schema', section: selection.section } } } : section
  }
  if (view === 'schema') return sections.get('input') ?? (() => { throw new ContractError('UNSUPPORTED_REPRESENTATION', 'This target has no input schema') })()
  if (view === 'example') {
    if (example === undefined) throw new ContractError('UNSUPPORTED_REPRESENTATION', 'This capability has no declared example; read input schema')
    return example
  }
  return { id: contract.id, description: contract.description ?? contract.capability?.description, fields: fields(sections.get('input')), ...(example !== undefined ? { example } : {}), ...(contract.rules ? { rules: contract.rules } : {}), ...(contract.directories ? { directories: contract.directories, filters: contract.filters } : {}), sections: links, complete: false, complete_contract: { ...target, selection: { view: 'object' } } }
}

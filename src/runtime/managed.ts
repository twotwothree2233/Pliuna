import { localResourceName } from '../shared/branding'
import { serialize, type DefaultTreeAdapterMap } from 'parse5'
import * as css from 'css-tree'
import Ajv2020 from 'ajv/dist/2020.js'
import { ContractError, validateBundle } from '../shared/validation'
import type { Bundle, LocalSchema } from '../shared/contracts.generated'
import defaults from '../shared/contracts/development-defaults.json'
import { presentationFragment } from './markup'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const activeTags = new Set(['script', 'iframe', 'object', 'embed', 'link', 'base'])
export function managedVocabulary() {
  return { html: 'Browser HTML/SVG/MathML presentation without tag or attribute allowlists.', css: 'Browser CSS without property, selector, function or at-rule allowlists; isolated per View.', execution: 'No scripts, event handlers, embedded browsing contexts, external requests or native navigation/submission.', resources: 'Images use declared same-task verified PNG/JPEG references. Local fragment references are supported.' }
}
function checkCss(text: string, scope: string, declarations = false): string {
  const tree = css.parse(text, { context: declarations ? 'declarationList' : 'stylesheet', parseCustomProperty: true })
  css.walk(tree, node => {
    if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') reject('External stylesheets are not enabled')
    if (node.type === 'Url') {
      if (!/^#[a-zA-Z][\w-]*$/.test(node.value)) reject('CSS URLs must reference a local element')
      node.value = '#' + scope + '-' + node.value.slice(1)
    }
    if (node.type === 'IdSelector') node.name = scope + '-' + node.name
    if (node.type === 'AttributeSelector' && node.name.type === 'Identifier' && node.value && node.matcher === '=') {
      const value = node.value.type === 'String' ? node.value.value : node.value.name
      if (['id', 'for'].includes(node.name.name)) Object.assign(node, { value: { type: 'String', value: scope + '-' + value } })
      if (node.name.name === 'href' && value.startsWith('#')) Object.assign(node, { value: { type: 'String', value: '#' + scope + '-' + value.slice(1) } })
    }
    if (node.type === 'TypeSelector' && ['html', 'body'].includes(node.name.toLowerCase()) || node.type === 'PseudoClassSelector' && node.name === 'root') {
      Object.assign(node, { type: 'AttributeSelector', name: { type: 'Identifier', name: 'data-view' }, matcher: '=', value: { type: 'String', value: scope }, flags: null })
    }
    // Raw values may contain syntax the parser does not yet understand. Keep browser
    // extensions, but reject unparsed resource loading rather than guessing URLs.
    if (node.type === 'Raw' && /(?:url|src|image-set|expression)\s*\(|@import|javascript:/i.test(node.value.replace(/\\[0-9a-f]{1,6}\s?/gi, ''))) reject('Unparsed active CSS is not enabled')
    if (node.type === 'Function' && ['expression', 'image-set', '-webkit-image-set', 'src'].includes(node.name.toLowerCase())) reject('External or executable CSS is not enabled')
  })
  return css.generate(tree)
}
const badKeys = new Set(['__proto__', 'prototype', 'constructor'])
const ajv = new Ajv2020({ allErrors: true, strict: false })
function reject(message: string): never { throw new ContractError('UNSUPPORTED_BUNDLE', message) }
const stateGuide = JSON.stringify({ name: 'read', arguments: { kind: 'object_type', id: 'surface.update', selection: { view: 'guide', section: 'state-and-references' } } })
function rejectState(message: string): never { throw new ContractError('UNSUPPORTED_BUNDLE', message, stateGuide) }
const pointerKey = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1')
export function schemaCheck(s: LocalSchema, depth = 0): void {
  if (depth > defaults.data.local_schema_depth) reject('State schema exceeds depth limit')
  if (s.type === 'object') {
    if (s.additionalProperties !== false) reject('Objects require additionalProperties:false')
    if (s.required?.some(key => !(key in (s.properties ?? {})))) reject('Unknown required property')
    for (const [key, child] of Object.entries(s.properties ?? {})) {
      if (badKeys.has(key)) reject('Reserved field name')
      schemaCheck(child, depth + 1)
    }
  } else if (s.properties || s.required || s.additionalProperties !== undefined) reject('Object keywords require an object')
  if (s.type === 'array') { if (!s.items) reject('Array items required'); schemaCheck(s.items, depth + 1) }
  else if (s.items || s.minItems !== undefined || s.maxItems !== undefined) reject('Array keywords require an array')
  if (s.type !== 'string' && (s.minLength !== undefined || s.maxLength !== undefined)) reject('String keywords require a string')
  if (!['number', 'integer'].includes(s.type) && (s.minimum !== undefined || s.maximum !== undefined)) reject('Numeric keywords require a number')
  for (const [min, max] of [[s.minLength, s.maxLength], [s.minItems, s.maxItems], [s.minimum, s.maximum]]) {
    if (min !== undefined && max !== undefined && min > max) reject('Invalid schema bounds')
  }
  if (s.enum) for (const value of s.enum) if (!ajv.validate({ ...s, enum: undefined }, value)) reject('Enum type mismatch')
}
export function pointer(path: string): string[] {
  if (!path.startsWith('/')) reject('Expected fixed JSON Pointer')
  const keys = path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (keys.some(k => badKeys.has(k))) reject('Reserved field path')
  return keys
}
export function fieldSchema(schema: LocalSchema, path: string): LocalSchema {
  let current = schema
  for (const key of pointer(path)) {
    if (current.type !== 'object' || !Object.hasOwn(current.properties ?? {}, key)) reject('Unknown fixed field: ' + path)
    current = current.properties![key]!
  }
  return current
}
export function getField(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value
  for (const key of pointer(path)) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
  return current
}
export function setField(value: Record<string, unknown>, path: string, next: unknown): void {
  const keys = pointer(path)
  let current = value
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {}
    current = current[key] as Record<string, unknown>
  }
  current[keys.at(-1)!] = next
}
export function checkDraft(bundle: Bundle, value: Record<string, unknown>, root = 'draft'): void {
  const check = (s: LocalSchema, v: unknown, path: string): void => {
    const invalid = (expected: string): never => rejectState(`Invalid raw draft types at ${path}: ${expected}`)
    if (s.type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid('expected an object')
      for (const [key, child] of Object.entries(v)) {
        const childPath = `${path}/${pointerKey(key)}`
        if (!Object.hasOwn(s.properties ?? {}, key)) rejectState(`Invalid raw draft types at ${childPath}: this field is not declared in the state schema`)
        check(s.properties![key]!, child, childPath)
      }
    } else if (s.type === 'number' || s.type === 'integer') {
      if (typeof v !== 'string') invalid('use a raw string such as "0" and keep the numeric schema type')
    } else if (s.type === 'array') {
      if (!ajv.validate({ ...s, minItems: undefined }, v)) invalid('expected an array matching the declared items and bounds')
    } else if (s.type === 'null' ? v !== null : typeof v !== s.type) invalid(`expected ${s.type}`)
  }
  check(bundle.state.schema, value, root)
  for (const [index, b] of bundle.behaviors.entries()) {
    if (b.type !== 'input') continue
    const v = getField(value, b.field), s = fieldSchema(bundle.state.schema, b.field)
    if (v === undefined) continue
    if (b.control === 'select' && !s.enum?.includes(v)) {
      rejectState(`Selection outside declared options at ${root}${b.field} (behaviors[${index}].field): use a value in the field schema enum. An empty placeholder requires both "" in the enum and <option value=""> in the select.`)
    }
    if (b.control === 'radio' && !s.enum?.includes(v)) {
      rejectState(`Selection outside declared options at ${root}${b.field} (behaviors[${index}].field): use a declared radio option or omit the initial field for no selection.`)
    }
    if (b.control === 'multiselect' && (!Array.isArray(v) || new Set(v).size !== v.length || v.some(item => !s.items?.enum?.includes(item)))) {
      rejectState(`Selection outside declared options at ${root}${b.field} (behaviors[${index}].field): use an array of distinct values from the field schema items.enum, or [] for no selection.`)
    }
  }
}
export function answerValues(bundle: Bundle, raw: Record<string, unknown>, formId: string): Record<string, unknown> {
  checkDraft(bundle, raw)
  const form = bundle.forms.find(f => f.id === formId)
  if (!form) reject('Unknown form')
  const value: Record<string, unknown> = {}
  for (const path of form.fields) {
    const schema = fieldSchema(bundle.state.schema, path)
    let v = getField(raw, path)
    const keys = pointer(path)
    let parent = bundle.state.schema
    for (const key of keys.slice(0, -1)) parent = parent.properties![key]!
    const required = parent.required?.includes(keys.at(-1)!) ?? false
    if (schema.type === 'number' || schema.type === 'integer') {
      if (typeof v !== 'string') reject('Expected numeric raw text')
      if (v.trim() === '' && !required) continue
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim())) throw new ContractError('INVALID_ANSWER', path + ': complete decimal required')
      v = Number(v.trim())
      if (!Number.isFinite(v) || (schema.type === 'integer' && !Number.isSafeInteger(v))) throw new ContractError('INVALID_ANSWER', path + ': out of range')
    }
    if (v === undefined && !required) continue
    if (!ajv.validate(schema, v)) throw new ContractError('INVALID_ANSWER', path + ': ' + ajv.errorsText(ajv.errors))
    setField(value, path, v)
  }
  return value
}
export interface CheckedBundle { bundle: Bundle; html: string; css: string }
export function checkBundle(input: unknown, scope: string, resolve?: (name: string) => string): CheckedBundle {
  const bundle = validateBundle(input)
  if (new TextEncoder().encode(JSON.stringify(bundle)).byteLength > defaults.surface.inline_bundle_bytes) reject('Inline bundle too large')
  if (bundle.references.length && !resolve) reject('Resource rendering requires a verified resource resolver')
  if (!/^[a-zA-Z0-9_-]+$/.test(scope)) reject('Invalid host scope')
  schemaCheck(bundle.state.schema)
  if (!bundle.state.initial || typeof bundle.state.initial !== 'object' || Array.isArray(bundle.state.initial)) reject('State initial must be an object')
  checkDraft(bundle, bundle.state.initial as Record<string, unknown>, 'state.initial')
  const ids = new Map<string, Element>()
  const elements: Element[] = []
  const fragment = presentationFragment(bundle.html)
  const embeddedStyles: string[] = []
  let count = 0
  function visit(node: Node, depth: number): void {
    if (depth > defaults.surface.view_depth) reject('HTML too deep')
    if ('tagName' in node) {
      elements.push(node)
      if (++count > defaults.surface.view_elements) reject('Too many HTML elements')
      if (activeTags.has(node.tagName.toLowerCase())) reject('Active element is not enabled: ' + node.tagName)
      if (node.tagName === 'meta' && node.attrs.some(a => a.name === 'http-equiv')) reject('Document policy changes are not enabled')
      for (const a of node.attrs) {
        const name = a.name.toLowerCase()
        if (['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor'].includes(name)) throw new ContractError('VIEW_TOP_LAYER_DISABLED', 'Native top-layer controls are not enabled in shared task Views')
        if (name.startsWith('on') || ['srcdoc', 'shadowrootmode', 'is', 'autofocus', 'autoplay', 'formaction', 'action', 'ping', 'download', 'target', 'srcset', 'imagesrcset', 'poster', 'data', 'codebase', 'background', 'manifest'].includes(name)) reject('Active attribute is not enabled: ' + name)
        if (name === 'tabindex' && Number(a.value) > 0) reject('Positive tabindex is not enabled')
        if (name === 'style') a.value = checkCss(a.value, scope, true)
        if (['href', 'src'].includes(name) && !(node.tagName === 'img' && name === 'src')) {
          if (!/^#[a-zA-Z][\w-]*$/.test(a.value)) reject('Only local fragment URLs are enabled')
          a.value = '#' + scope + '-' + a.value.slice(1)
        }
        if (/url\s*\(/i.test(a.value) && name !== 'style') a.value = checkCss('fill:' + a.value, scope, true).slice(5)
        if (a.name === 'id') {
          if (!/^[a-zA-Z][\w-]*$/.test(a.value) || ids.has(a.value)) reject('Invalid or duplicate ID')
          ids.set(a.value, node)
        }
        if (a.name === 'class' && !/^[\w\s-]*$/.test(a.value)) reject('Invalid class')
        if (node.tagName === 'img' && a.name === 'src') {
          const name = localResourceName(a.value)
          if (!name || !bundle.references.some(r => r.name === name) || !resolve) reject('Image requires a declared local resource')
          a.value = resolve(name)
          if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(a.value)) reject('Invalid verified image URL')
        }
        if (node.tagName === 'img' && ['width', 'height'].includes(a.name) && !/^[1-9]\d{0,3}$/.test(a.value)) reject('Invalid image dimensions')
      }
      if (node.tagName === 'button') { node.attrs = node.attrs.filter(a => a.name !== 'type'); node.attrs.push({ name: 'type', value: 'button' }) }
      if (node.tagName === 'style') {
        embeddedStyles.push(checkCss(node.childNodes.filter(child => 'value' in child).map(child => (child as DefaultTreeAdapterMap['textNode']).value).join(''), scope))
        node.childNodes = []
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, depth + 1)
    if ('content' in node && node.tagName === 'template') visit(node.content, depth + 1)
  }
  visit(fragment, 0)
  for (const node of elements) for (const attr of node.attrs) {
    if (attr.name === 'id') attr.value = scope + '-' + attr.value
    if (attr.name === 'for' || attr.name === 'aria-describedby') {
      const refs = attr.value.split(/\s+/)
      if (refs.some(r => !ids.has(r))) reject('Unknown local ID reference')
      attr.value = refs.map(r => scope + '-' + r).join(' ')
    }
  }
  const forms = new Set<string>()
  for (const f of bundle.forms) {
    if (forms.has(f.id)) reject('Duplicate form')
    forms.add(f.id)
    for (const path of f.fields) fieldSchema(bundle.state.schema, path)
  }
  const writers = new Set<string>()
  const radioValues = new Map<string, Set<string>>()
  for (const [index, b] of bundle.behaviors.entries()) {
    const invalidBinding = (message: string): never => rejectState(`behaviors[${index}] (element_id=${JSON.stringify(b.element_id)}): ${message}`)
    const element = ids.get(b.element_id)
    if (!element) return invalidBinding('Missing behavior target; add the matching HTML id or correct element_id')
    const property = b.type === 'input' || b.type === 'text' ? 'value' : b.type === 'class_toggle' ? 'class:' + b.class_name : b.type === 'submit' || b.type === 'toggle' ? 'click' : b.type
    const key = b.element_id + ':' + property
    if (writers.has(key)) reject('Duplicate behavior writer')
    writers.add(key)
    if (b.type === 'submit') { if (!forms.has(b.form_id) || element.tagName !== 'button') invalidBinding('Invalid submit binding; use a button and a form_id declared in bundle.forms'); continue }
    const s = fieldSchema(bundle.state.schema, b.field)
    if (b.type === 'visible' || b.type === 'toggle' || b.type === 'class_toggle') {
      if (s.type !== 'boolean') reject('Boolean behavior requires a boolean field')
      if (b.type === 'toggle' && element.tagName !== 'button') reject('Toggle requires a button')
      if (b.type === 'class_toggle' && !/^[a-zA-Z_][\w-]*$/.test(b.class_name)) reject('Invalid local class')
    }
    if (b.type === 'text') {
      if (!['p', 'span', 'div', 'strong', 'small'].includes(element.tagName)) reject('Unsupported text target')
      if (element.childNodes.some(child => 'tagName' in child)) reject('Text bindings require a text-only target')
    }
    if (b.type === 'input') {
      const controlTags: Record<string, string> = { text: 'input', number: 'input', textarea: 'textarea', checkbox: 'input', radio: 'input', range: 'input', select: 'select', multiselect: 'select' }
      if (controlTags[b.control] !== element.tagName) invalidBinding(`control ${b.control} requires <${controlTags[b.control]}>`)
      const type = element.attrs.find(a => a.name === 'type')?.value ?? 'text'
      const inputType = ['checkbox', 'radio', 'range'].includes(b.control) ? b.control : 'text'
      if (element.tagName === 'input' && type !== inputType) invalidBinding(`Input type mismatch; control ${b.control} requires <input type="${inputType}">`)
      const fieldTypes = ['number', 'range'].includes(b.control) ? ['number', 'integer'] : b.control === 'checkbox' ? ['boolean'] : b.control === 'multiselect' ? ['array'] : ['string']
      if (!fieldTypes.includes(s.type)) invalidBinding(`Field/control mismatch; field ${b.field} requires schema type ${fieldTypes.join(' or ')}`)
      if (b.control !== 'radio' && Object.hasOwn(b, 'option_value')) reject('option_value is only valid on radio controls')
      if (b.control === 'radio') {
        if (typeof b.option_value !== 'string' || !s.enum?.includes(b.option_value)) reject('Radio requires a declared string option')
        const options = radioValues.get(b.field) ?? new Set<string>()
        if (options.has(b.option_value)) reject('Duplicate radio option')
        options.add(b.option_value); radioValues.set(b.field, options)
      }
      if (b.control === 'select' || b.control === 'multiselect') {
        if (element.attrs.some(a => a.name === 'multiple') !== (b.control === 'multiselect')) invalidBinding(`Select multiple mismatch; use <select${b.control === 'multiselect' ? ' multiple' : ''}>`)
        const enumValues = b.control === 'multiselect' ? s.items?.enum : s.enum
        if ((b.control === 'multiselect' && (s.type !== 'array' || s.items?.type !== 'string')) || !enumValues?.length || enumValues.some(v => typeof v !== 'string') || new Set(enumValues).size !== enumValues.length) reject('Selection requires unique declared string options')
        const values: string[] = []
        const options = (node: Node): void => {
          if ('tagName' in node && node.tagName === 'option') {
            const value = node.attrs.find(a => a.name === 'value')?.value
            if (value === undefined || !enumValues.includes(value) || values.includes(value)) return invalidBinding(`Invalid or duplicate select option at HTML option ${values.length + 1}; each option needs a unique explicit value from the enum for ${b.field}`)
            values.push(value)
          }
          if ('childNodes' in node) node.childNodes.forEach(options)
        }
        options(element)
        if (values.length !== enumValues.length) invalidBinding(`Select must declare all schema options for ${b.field}; add an HTML option for every enum value`)
      }
      if (b.control === 'range') {
        const numeric = (name: string, fallback: number): number => {
          const raw = element.attrs.find(a => a.name === name)?.value
          if (raw === undefined) return fallback
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) reject('Invalid range bound')
          return Number(raw)
        }
        const min = numeric('min', 0), max = numeric('max', 100), step = numeric('step', 1)
        if (min > max || step <= 0 || s.minimum === undefined || s.maximum === undefined || min < s.minimum || max > s.maximum || (s.type === 'integer' && [min, max, step].some(n => !Number.isSafeInteger(n)))) reject('Range bounds must fit the numeric schema')
        const initial = getField(bundle.state.initial as Record<string, unknown>, b.field)
        if (typeof initial !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(initial.trim()) || !Number.isFinite(Number(initial)) || Number(initial) < min || Number(initial) > max || Math.abs((Number(initial) - min) / step - Math.round((Number(initial) - min) / step)) > 1e-8) reject('Range initial must be a valid step value')
      }
    }
  }
  const stylesheet = [checkCss(bundle.css, scope), ...embeddedStyles].join('\n')
  const classes = new Set<string>()
  for (const element of elements) for (const a of element.attrs) if (a.name === 'class') a.value.split(/\s+/).filter(Boolean).forEach(name => classes.add(name))
  css.walk(css.parse(stylesheet), node => { if (node.type === 'ClassSelector') classes.add(node.name) })
  for (const b of bundle.behaviors) if (b.type === 'class_toggle' && !classes.has(b.class_name)) reject('Class toggle requires a declared local class')
  return { bundle, html: serialize(fragment), css: `@scope ([data-view="${scope}"]) {${stylesheet}}` }
}

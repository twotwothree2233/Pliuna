import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
export interface ContentMarkup {
  root: Node
  elements: Element[]
  document: boolean
  html: string
  positions: Map<Element, number>
  identities: Map<string, number>
}

/** Shared source-location parsing; identity and edit policies belong to callers. */
export function parseContentMarkup(html: string, context?: Element): ContentMarkup {
  const document = !context && /<!doctype\s|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html)
  const root = context ? parseFragment(context, html, { sourceCodeLocationInfo: true }) : document
    ? parse(html, { sourceCodeLocationInfo: true }) : parseFragment(html, { sourceCodeLocationInfo: true })
  const elements: Element[] = [], positions = new Map<Element, number>(), identities = new Map<string, number>()
  const visit = (node: Node): void => {
    if ('tagName' in node) {
      elements.push(node)
      const id = node.attrs.find(attr => attr.name === 'id')?.value
      if (id) identities.set(id, (identities.get(id) ?? 0) + 1)
    }
    let position = 0
    if ('childNodes' in node) for (const child of node.childNodes) {
      if ('tagName' in child) positions.set(child, ++position)
      visit(child)
    }
  }
  visit(root)
  return { root, elements, document, html, positions, identities }
}

import { parse, parseFragment, type DefaultTreeAdapterMap } from 'parse5'

// A View is embedded content. Preserve document styling without introducing
// another page, head or body into the application's document.
export function presentationFragment(html: string): DefaultTreeAdapterMap['documentFragment'] {
  if (!/<!doctype\s|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html)) return parseFragment(html)
  const document = parse(html), fragment = parseFragment('')
  for (const node of document.childNodes) {
    if (!('tagName' in node)) continue
    const convert = (element: DefaultTreeAdapterMap['element']): void => {
      if (['html', 'head', 'body'].includes(element.tagName)) { element.tagName = 'div'; element.nodeName = 'div' }
      for (const child of element.childNodes) if ('tagName' in child) convert(child)
    }
    convert(node)
    fragment.childNodes.push(node); node.parentNode = fragment
  }
  return fragment
}

export const textSizes = [90, 100, 110, 125, 140] as const
export type TextSize = typeof textSizes[number]
const storageKey = 'trellis-text-size'

export function readTextSize(): TextSize {
  try {
    const value = Number(localStorage.getItem(storageKey))
    return textSizes.find(size => size === value) ?? 100
  } catch { return 100 }
}

export function applyTextSize(size: TextSize): void {
  document.documentElement.style.setProperty('--text-scale', String(size / 100))
  try { localStorage.setItem(storageKey, String(size)) } catch { /* Keep this window usable when storage is unavailable. */ }
}

// Relative units already follow the inherited/root font. Scale only absolute
// font lengths, leaving layout and the stored bundle untouched.
function scaleDeclaration(style: CSSStyleDeclaration): void {
  const value = style.getPropertyValue('font-size')
  const scaled = value.replace(/(?<![\w-])((?:\d*\.)?\d+(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q|vw|vh|vi|vb|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh)\b/gi,
    length => `calc(${length} * var(--text-scale, 1))`)
  if (scaled !== value) style.setProperty('font-size', scaled, style.getPropertyPriority('font-size'))
}

export function managedTextStyles(css: string): string {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  function visit(rules: CSSRuleList) {
    for (const rule of rules) {
      if ('style' in rule && rule.style instanceof CSSStyleDeclaration) scaleDeclaration(rule.style)
      if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules)
    }
  }
  visit(sheet.cssRules)
  return [...sheet.cssRules].map(rule => rule.cssText).join('\n')
}

export function scaleManagedInlineText(host: HTMLElement): void {
  for (const element of host.querySelectorAll<HTMLElement | SVGElement>('[style]')) scaleDeclaration(element.style)
}

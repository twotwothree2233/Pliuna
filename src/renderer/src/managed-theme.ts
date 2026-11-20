const foreground = 'var(--pliuna-content-ink,var(--pliuna-content-fg))'
const surface = 'var(--pliuna-content-surface,var(--pliuna-content-block))'
const line = 'var(--pliuna-content-border,var(--pliuna-content-line))'
const inherited = /^(?:inherit|initial|unset|revert(?:-layer)?|currentcolor)$/i
const transparent = /^(?:transparent|rgba\([^)]*,\s*0(?:\.0*)?\s*\)|rgb\([^)]*\/\s*0(?:%|\.0*)?\s*\))$/i

// Presentation colors belong to the application. Keep the saved bundle and its
// layout intact; SVG remains an authored visual with its own data palette.
function themeDeclarations(source: CSSStyleDeclaration): CSSStyleDeclaration {
  const target = document.createElement('span').style
  const set = (property: string, value: string) => target.setProperty(property, value, 'important')
  const declared = [...source]
  for (const property of ['color', '-webkit-text-fill-color', 'caret-color']) {
    const value = source.getPropertyValue(property)
    if (declared.includes(property) && !inherited.test(value) && !transparent.test(value)) set(property, foreground)
  }
  const color = source.getPropertyValue('background-color')
  if (declared.includes('background-color') && !inherited.test(color) && !transparent.test(color)) set('background-color', surface)
  const image = source.getPropertyValue('background-image')
  if (/gradient\(/i.test(image) && !/url\(/i.test(image)) { set('background-image', 'none'); set('background-color', surface) }
  if (/text/.test(source.getPropertyValue('background-clip') || source.getPropertyValue('-webkit-background-clip'))) { set('color', foreground); set('-webkit-text-fill-color', foreground) }
  // Variable shorthands declare their longhands with empty pending values.
  for (const property of declared.filter(property => property.startsWith('border-') && property.endsWith('-color') || ['outline-color', 'text-decoration-color', 'column-rule-color'].includes(property))) {
    const value = source.getPropertyValue(property)
    if (!inherited.test(value) && !transparent.test(value)) set(property, line)
  }
  if (source.getPropertyValue('box-shadow')) set('box-shadow', 'var(--pliuna-content-elevation)')
  if (source.getPropertyValue('text-shadow')) set('text-shadow', 'none')
  if (source.getPropertyValue('color-scheme')) set('color-scheme', 'inherit')
  return target
}

export function managedThemeStyles(css: string): string {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  function rules(list: CSSRuleList): string {
    return [...list].map(rule => {
      if (rule instanceof CSSStyleRule) {
        const declarations = themeDeclarations(rule.style).cssText
        return declarations ? `${rule.selectorText}{${declarations}}` : ''
      }
      if ('cssRules' in rule) {
        const children = rules((rule as CSSGroupingRule).cssRules)
        return children ? `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${children}}` : ''
      }
      return ''
    }).join('\n')
  }
  // Checked CSS already has the managed view scope. Replace that wrapper so
  // the same root is not searched for again inside a nested scope.
  const checkedScope = sheet.cssRules[0]
  const content = checkedScope && sheet.cssRules.length === 1 && checkedScope.cssText.startsWith('@scope ') && 'cssRules' in checkedScope
    ? (checkedScope as CSSGroupingRule).cssRules : sheet.cssRules
  // The scope boundary excludes SVG subtrees, including CSS currentColor series.
  return `:host{--pliuna-content-fg:var(--fg,CanvasText);--pliuna-content-bg:var(--bg,Canvas);--pliuna-content-block:var(--block,Canvas);--pliuna-content-line:var(--line,GrayText);--pliuna-content-accent:var(--accent,LinkText);--pliuna-content-accent-ink:var(--accent-ink,Canvas);--pliuna-content-selection:var(--sel,Highlight);--pliuna-content-selection-ink:var(--sel-fg,HighlightText);--pliuna-content-elevation:var(--elevation,none);color:${foreground};color-scheme:inherit}
@scope ([data-view]) to (svg){${rules(content)}
a{--pliuna-content-ink:var(--pliuna-content-accent);color:${foreground}!important}
button,input[type=button],input[type=submit]{--pliuna-content-ink:var(--pliuna-content-accent-ink);--pliuna-content-surface:var(--pliuna-content-accent);--pliuna-content-border:var(--pliuna-content-accent);color:${foreground}!important;background-color:${surface}!important;border-color:${line}!important}
input:not([type=button]):not([type=submit]),textarea,select{--pliuna-content-ink:var(--pliuna-content-fg);--pliuna-content-surface:var(--pliuna-content-bg);--pliuna-content-border:var(--pliuna-content-line);color:${foreground}!important;background-color:${surface}!important;border-color:${line}!important;caret-color:var(--pliuna-content-accent)!important;color-scheme:inherit!important}
:is(button,input,textarea,select,summary,a):focus-visible{outline:2px solid var(--pliuna-content-accent)!important;outline-offset:2px}
::selection{color:var(--pliuna-content-selection-ink)!important;background-color:var(--pliuna-content-selection)!important}
}`
}

export function themeManagedInlineStyles(host: HTMLElement): void {
  for (const element of host.querySelectorAll<HTMLElement>('*')) {
    if (element.closest('svg')) continue
    // Gradient clipping and transparent text may be split across several rules.
    const computed = getComputedStyle(element)
    if (/gradient\(/i.test(computed.backgroundImage) && !/url\(/i.test(computed.backgroundImage)) {
      element.style.setProperty('background-image', 'none', 'important')
      element.style.setProperty('background-color', surface, 'important')
    }
    if (/text/.test(computed.backgroundClip || computed.webkitBackgroundClip)) {
      element.style.setProperty('color', foreground, 'important')
      element.style.setProperty('-webkit-text-fill-color', foreground, 'important')
    }
    if (!element.hasAttribute('style')) continue
    const themed = themeDeclarations(element.style)
    for (const property of themed) element.style.setProperty(property, themed.getPropertyValue(property), 'important')
  }
}

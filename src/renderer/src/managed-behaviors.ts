import type { Bundle } from '../../shared/contracts.generated'

function keys(path: string): string[] { return path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~')) }
function read(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value
  for (const key of keys(path)) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
  return current
}
function write(value: Record<string, unknown>, path: string, next: unknown): void {
  const parts = keys(path); let current = value
  for (const key of parts.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== 'object') current[key] = {}
    current = current[key] as Record<string, unknown>
  }
  current[parts.at(-1)!] = next
}

export function bindManagedBehaviors(host: HTMLElement, scope: string, bundle: Bundle, initial: Record<string, unknown>, change: (field: string, value: unknown) => void, held: () => boolean) {
  let values = structuredClone(initial)
  const cleanups: (() => void)[] = []
  const element = (id: string): HTMLElement => host.querySelector<HTMLElement>('#' + scope + '-' + id)!
  const paint = (field?: string): void => {
    for (const b of bundle.behaviors) {
      if (b.type === 'submit' || (field !== undefined && b.field !== field)) continue
      const el = element(b.element_id), value = read(values, b.field)
      if (b.type === 'text') el.textContent = String(value ?? '')
      if (b.type === 'visible') {
        el.hidden = !value
        if (!value) el.style.setProperty('display', 'none', 'important')
        else el.style.removeProperty('display')
      }
      if (b.type === 'class_toggle') el.classList.toggle(b.class_name, value === true)
      if (b.type === 'toggle') el.setAttribute('aria-pressed', String(value === true))
      if (b.type === 'input') {
        const control = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        if (b.control === 'checkbox') (control as HTMLInputElement).checked = value === true
        else if (b.control === 'radio') (control as HTMLInputElement).checked = value === b.option_value
        else if (b.control === 'multiselect') for (const option of (control as HTMLSelectElement).options) option.selected = Array.isArray(value) && value.includes(option.value)
        else if (control.value !== String(value ?? '')) control.value = String(value ?? '')
      }
    }
  }
  const update = (field: string, value: unknown): void => { write(values, field, value); paint(field); change(field, value) }
  for (const b of bundle.behaviors) {
    const el = element(b.element_id)
    if (b.type === 'input') {
      const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      const listener = (): void => {
        if (held() || input.disabled || (b.control === 'radio' && !(input as HTMLInputElement).checked)) return
        const value = b.control === 'checkbox' ? (input as HTMLInputElement).checked : b.control === 'radio' ? b.option_value : b.control === 'multiselect' ? Array.from((input as HTMLSelectElement).selectedOptions, o => o.value) : input.value
        update(b.field, value)
      }
      const event = ['select', 'multiselect', 'radio', 'checkbox'].includes(b.control) ? 'change' : 'input'
      el.addEventListener(event, listener); cleanups.push(() => el.removeEventListener(event, listener))
    }
    if (b.type === 'toggle') {
      const listener = (): void => { if (!held() && !(el as HTMLButtonElement).disabled) update(b.field, read(values, b.field) !== true) }
      el.addEventListener('click', listener); cleanups.push(() => el.removeEventListener('click', listener))
    }
  }
  paint()
  return { sync: (next: Record<string, unknown>) => { values = structuredClone(next); paint() }, dispose: () => cleanups.forEach(cleanup => cleanup()) }
}

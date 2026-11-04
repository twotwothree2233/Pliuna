import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { answerValues, checkBundle, checkDraft } from '../../src/runtime/managed'
import type { Bundle } from '../../src/shared/contracts.generated'
import { managedControls } from '../helpers/managed-controls'
const example = (): Bundle => JSON.parse(readFileSync('tests/fixtures/contracts/01-bundle.json', 'utf8'))
describe('managed-v1 isolated presentation', () => {
  it.each(['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor'])('rejects native top-layer attribute %s without altering source', attribute => {
    const b = example(); b.html += `<button ${attribute}="v-view1-cover">Open</button><div id="cover">Cover</div>`
    const before = JSON.stringify(b)
    expect(() => checkBundle(b, 'v-view1')).toThrow(expect.objectContaining({ code: 'VIEW_TOP_LAYER_DISABLED' }))
    expect(JSON.stringify(b)).toBe(before)
  })
  it('accepts canonical bundle and scopes IDs and CSS', () => {
    const result = checkBundle(example(), 'view1')
    expect(result.html).toContain('id="view1-measurement"')
    expect(result.css).toContain('@scope ([data-view="view1"])')
  })
  for (const html of ['<script>alert(1)</script>', '<img src="https://evil.test/a">', '<input onfocus="x()">', '<iframe></iframe>', '<input autofocus>', '<div id="a"></div><p id="a"></p>']) {
    it('rejects unsafe or unimplemented HTML: ' + html, () => { const b = example(); b.html += html; expect(() => checkBundle(b, 'view1')).toThrow() })
  }
  for (const css of ['@import "https://evil.test";', 'section{background-image:url(https://evil.test)}', 'section{background-image:image-set("https://evil.test" 1x)}']) {
    it('rejects external CSS: ' + css, () => { const b = example(); b.css = css; expect(() => checkBundle(b, 'view1')).toThrow() })
  }
  it('accepts browser presentation syntax without style allowlists', () => {
    const b = example()
    b.html += '<aside role="note" data-label="free" style="font-family:serif;box-shadow:0 2px 8px #0002"><details open><summary>More</summary><meter value="0.7">70%</meter></details></aside><svg><foreignObject><div>HTML in SVG</div></foreignObject></svg>'
    b.css = ':root{--ink:#123456} body{font-family:serif} section{color:var(--ink);position:relative;box-shadow:0 1px 3px #0002;width:calc(100% - 1px);background:linear-gradient(white,#eee);unknown:1!important} @media(max-width:600px){section{font-size:clamp(12px,2vw,20px)}} section:has(input)::before{content:"Before"} section{ & p{letter-spacing:1px}} @keyframes pulse{from{opacity:0}to{opacity:1}}'
    const result = checkBundle(b, 'view1')
    expect(result.html).toContain('role="note"')
    expect(result.html).toContain('font-family:serif')
    expect(result.css).toContain('@media')
    expect(result.css).toContain('--ink:')
    expect(result.css).toContain('font-family:serif')
    expect(result.css).toContain('@keyframes')
  })
  it('normalizes full documents and moves embedded styles into isolated CSS', () => {
    const b = example()
    b.html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{font-family:serif} @media(min-width:100px){p{color:red}}</style></head><body><section id="measurement">Document</section></body></html>'
    b.behaviors = []; b.forms = []
    const result = checkBundle(b, 'document')
    expect(result.html).toContain('Document')
    expect(result.html).not.toContain('<html')
    expect(result.html).not.toContain('font-family')
    expect(result.css).toContain('font-family:serif')
    expect(result.css).toContain('@media')
  })
  it.each([
    '<template><script>bad()</script></template>',
    '<template shadowrootmode="open"><p>Nested context</p></template>',
    '<style>@import "https://evil.test/a";</style>',
    '<div style="--asset:url(https://evil.test/a)">External</div>',
    '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.test"></head><body>Redirect</body></html>',
    '<a href="javascript:bad()">Run</a>',
    '<form action="https://evil.test"><button>Submit</button></form>'
  ])('retains active-content and external-request boundaries: %s', html => {
    const b = example(); b.html += html
    expect(() => checkBundle(b, 'view1')).toThrow()
  })
  it('rewrites local SVG and inline style references without restricting graphics vocabulary', () => {
    const b = example()
    b.html += '<svg><defs><linearGradient id="paint"><stop offset="0%" stop-color="red"></stop></linearGradient></defs><rect style="fill:url(#paint)" width="100%" height="30"></rect></svg>'
    const result = checkBundle(b, 'view1')
    expect(result.html).toContain('id="view1-paint"')
    expect(result.html).toContain('fill:url(#view1-paint)')
    b.css = '[id="measurement"]{color:red} label[for="measurement"]{font-family:serif} a[href="#measurement"]{text-decoration:underline}'
    const styled = checkBundle(b, 'view1')
    expect(styled.css).toContain('[id="view1-measurement"]')
    expect(styled.css).toContain('[for="view1-measurement"]')
    expect(styled.css).toContain('[href="#view1-measurement"]')
  })
  it('rewrites label references even when the label has no ID', () => {
    const b = example(); b.html = '<label for="measurement">数值</label>' + b.html
    expect(checkBundle(b, 'view1').html).toContain('for="view1-measurement"')
  })
  it('rejects unbound and duplicate behavior targets', () => { const b = example(); b.behaviors.push(b.behaviors[0]!); expect(() => checkBundle(b, 'view1')).toThrow() })
  it('preserves numeric raw draft text without prefix parsing', () => {
    const b = example(); expect(() => checkDraft(b, { measurement: '1e' })).not.toThrow()
    for (const raw of ['', '1e', '1kg', '0x10', 'Infinity', '1,000']) expect(() => answerValues(b, { measurement: raw }, 'measurement-form')).toThrow()
    expect(answerValues(b, { measurement: ' 1.2e2 ' }, 'measurement-form')).toEqual({ measurement: 120 })
  })
  it('omits optional empty numbers and rejects unsafe integers', () => {
    const b = example(); b.state.schema.required = []
    expect(answerValues(b, { measurement: '' }, 'measurement-form')).toEqual({})
    b.state.schema.properties!.measurement!.type = 'integer'
    expect(() => answerValues(b, { measurement: '9007199254740992' }, 'measurement-form')).toThrow()
  })
  it('allows incomplete string drafts but validates formal answers', () => {
    const b = example(); b.state.schema.properties!.measurement = { type: 'string', minLength: 3 }
    expect(() => checkDraft(b, { measurement: '' })).not.toThrow()
    expect(() => answerValues(b, { measurement: '' }, 'measurement-form')).toThrow()
  })
})

describe('managed-v1 declared controls', () => {
  it('accepts fixed selections and local boolean behaviors without scripts', () => {
    const bundle = managedControls()
    expect(checkBundle(bundle, 'controls').html).toContain('id="controls-choice"')
    expect(answerValues(bundle, { ...bundle.state.initial, choice: 'b', multi: ['y'], radio: 'b', range: '7', note: 'private draft' }, 'choices')).toEqual({ choice: 'b', multi: ['y'], radio: 'b', range: 7 })
    expect(answerValues(bundle, { ...bundle.state.initial, note: 'my note' }, 'note')).toEqual({ note: 'my note' })
  })
  it('allows incomplete multiselect drafts while enforcing formal minimums', () => {
    const b = managedControls(); b.state.schema.properties!.multi!.minItems = 1
    expect(() => checkBundle(b, 'controls')).not.toThrow()
    expect(() => checkDraft(b, b.state.initial)).not.toThrow()
    expect(() => answerValues(b, b.state.initial, 'choices')).toThrow()
  })
  const invalid: [string, (b: ReturnType<typeof managedControls>) => void][] = [
    ['foreign option', b => { b.html = b.html.replace('value="a"', 'value="foreign"') }],
    ['duplicate option', b => { b.html = b.html.replace('value="b"', 'value="a"') }],
    ['implicit option value', b => { b.html = b.html.replace(' value="a"', '') }],
    ['select multiple mismatch', b => { b.html = b.html.replace('id="choice"', 'id="choice" multiple') }],
    ['radio option outside enum', b => { const v = b.behaviors[2]!; if (v.type === 'input') v.option_value = 'foreign' }],
    ['radio duplicate option', b => { const v = b.behaviors[3]!; if (v.type === 'input') v.option_value = 'a' }],
    ['select option_value', b => { const v = b.behaviors[0]!; if (v.type === 'input') v.option_value = 'a' }],
    ['boolean behavior wrong schema', b => { b.state.schema.properties!.visible = { type: 'string' }; b.state.initial = { ...b.state.initial, visible: 'false' } }],
    ['toggle on non-button', b => { b.html = b.html.replace('<button id="toggle">Toggle details</button>', '<span id="toggle">Toggle details</span>') }],
    ['duplicate click writer', b => { b.behaviors.push({ type: 'submit', element_id: 'toggle', form_id: 'note' }) }],
    ['undeclared class', b => { const v = b.behaviors[8]!; if (v.type === 'class_toggle') v.class_name = 'missing' }],
    ['selector in class', b => { const v = b.behaviors[8]!; if (v.type === 'class_toggle') v.class_name = 'highlight body' }],
    ['range missing schema bounds', b => { delete b.state.schema.properties!.range!.maximum }],
    ['range outside schema', b => { b.html = b.html.replace('max="10"', 'max="11"') }],
    ['range invalid step', b => { b.html = b.html.replace('step="1"', 'step="0"') }],
    ['range fractional integer step', b => { b.html = b.html.replace('step="1"', 'step="0.5"') }],
    ['range invalid initial', b => { b.state.initial = { ...b.state.initial, range: '' } }],
    ['range hexadecimal initial', b => { b.state.initial = { ...b.state.initial, range: '0x2' } }],
    ['range off-step initial', b => { b.html = b.html.replace('step="1"', 'step="3"') }]
  ]
  for (const [name, change] of invalid) it('rejects ' + name, () => { const b = managedControls(); change(b); expect(() => checkBundle(b, 'controls')).toThrow() })
  for (const patch of [{ choice: 'outside' }, { radio: 'outside' }, { multi: ['x', 'x'] }, { multi: ['outside'] }]) it('rejects forged draft selection ' + JSON.stringify(patch), () => {
    const b = managedControls(), raw = { ...b.state.initial, ...patch }
    expect(() => checkDraft(b, raw)).toThrow()
    expect(() => answerValues(b, raw, 'choices')).toThrow()
  })
})

describe('bounded static SVG and MathML', () => {
  const staticBundle = (html: string): Bundle => ({ profile: 'managed-v1', html, css: '', state: { schema: { type: 'object', additionalProperties: false, properties: {} }, initial: {}, compatibility_version: 'static' }, forms: [], behaviors: [], references: [], export: [] })
  it('accepts local bounded geometry and presentation-only formulas', () => {
    const result = checkBundle(staticBundle('<section><svg viewBox="0 0 100 80" width="100" height="80"><g fill="none" stroke="#147654"><path d="M 0 0 L 100 80"></path><circle cx="20" cy="20" r="10"></circle><text x="2" y="15">Diagram</text></g></svg><math display="block"><mfrac><mi>x</mi><msup><mi>y</mi><mn>2</mn></msup></mfrac></math></section>'), 'local')
    expect(result.html).toContain('viewBox="0 0 100 80"'); expect(result.html).toContain('<mfrac>')
  })
  it.each(['<svg><script>bad()</script></svg>', '<svg><use href="https://evil.test/x"></use></svg>', '<svg><circle fill="url(https://evil.test)"></circle></svg>', '<svg><image href="https://evil.test/x"></image></svg>', '<math><annotation-xml encoding="text/html"><img src="x"></annotation-xml></math>', '<math href="https://evil.test"><mi>x</mi></math>'])('rejects active, external or unbounded foreign syntax: %s', html => {
    expect(() => checkBundle(staticBundle(html), 'local')).toThrow()
  })
})

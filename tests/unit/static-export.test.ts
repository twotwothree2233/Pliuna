import { ContractError } from '../../src/shared/validation'
import { describe, expect, it } from 'vitest'
import type { Bundle } from '../../src/shared/contracts.generated'
import { staticDocument } from '../../src/runtime/static-export'

const bundle = (): Bundle => ({ profile: 'managed-v1', html: '<section id="lesson"><p id="question">Original question</p><input id="answer" type="text"><button id="submit">Submit</button></section><p id="feedback">PRIVATE_FEEDBACK</p>', css: '', state: { schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' } } }, initial: { answer: '' }, compatibility_version: 'v1' }, forms: [{ id: 'answer', fields: ['/answer'] }], behaviors: [{ type: 'input', element_id: 'answer', field: '/answer', control: 'text' }, { type: 'submit', element_id: 'submit', form_id: 'answer' }], references: [], export: [{ id: 'lesson', category: 'learning', source: { type: 'element', element_id: 'lesson' } }, { id: 'feedback', category: 'feedback', source: { type: 'element', element_id: 'feedback' } }] })
const view = (b = bundle()) => ({ bundle: b, resolve: () => { throw Error('Unexpected resource') } })
describe('static export boundary', () => {
  it.each(['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor'])('rejects top-layer %s in old content and static fragments', attribute => {
    const b = bundle(); b.html += `<div ${attribute}="target">Cover</div>`
    expect(() => staticDocument('Title', [view(b)])).toThrow(expect.objectContaining({code:'VIEW_TOP_LAYER_DISABLED'}))
    const fragment = bundle()
    fragment.export.push({id:'static',category:'learning',source:{type:'static',html:`<div ${attribute}="target">Cover</div>`,css:''}})
    expect(() => staticDocument('Title', [view(fragment)])).toThrow(expect.objectContaining({code:'VIEW_TOP_LAYER_DISABLED'}))
  })
  it('retains classified learning but no controls, private feedback or executable content', () => {
    const result = staticDocument('<title>', [view()])
    expect(result.issues).toEqual([])
    expect(result.html).toContain('Original question'); expect(result.html).toContain('&lt;title&gt;')
    expect(result.html).not.toMatch(/<input|<button|<script|PRIVATE_FEEDBACK|iframe/)
    expect(result.html).toContain("connect-src 'none'")
  })
  it('reports uncovered text and unclassified content without exporting it', () => {
    const b = bundle(); b.html += '<p>PRIVATE_UNCLASSIFIED</p>'; b.export[0]!.category = 'unclassified'
    const result = staticDocument('Title', [view(b)])
    expect(result.issues).toHaveLength(2); expect(result.html).not.toContain('PRIVATE_UNCLASSIFIED'); expect(result.html).not.toContain('Original question')
    expect(result.html).toContain('遗漏清单')
  })
  it('rejects overlapping and duplicate fragment roots', () => {
    const b = bundle(); b.export.push({ id: 'overlap', category: 'learning', source: { type: 'element', element_id: 'question' } })
    expect(() => staticDocument('Title', [view(b)])).toThrow('overlap')
    b.export.at(-1)!.source = { type: 'element', element_id: 'lesson' }
    expect(() => staticDocument('Title', [view(b)])).toThrow('duplicate')
  })
  it('reports uncovered graphics even without text content', () => {
    const b = bundle(); b.html += '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="2"></circle></svg>'
    const result = staticDocument('Title', [view(b)])
    expect(result.issues).toContain('View 1: UNCLASSIFIED_CONTENT'); expect(result.html).not.toContain('<svg')
  })
  it('attaches selected answer only beside its immutable original question', () => {
    const current = bundle(); current.html = current.html.replace('Original question', 'Current question')
    const result = staticDocument('Title', [view(current)], [{ label: 'Old revision', value: { answer: '<PRIVATE_ANSWER>' }, question: view() }])
    expect(result.html).toContain('Original question'); expect(result.html).toContain('Current question'); expect(result.html).toContain('&lt;PRIVATE_ANSWER&gt;')
    expect(staticDocument('Title', [view(current)]).html).not.toContain('PRIVATE_ANSWER')
  })
  it('uses published text initial state, without serializing unrelated hidden state', () => {
    const b = bundle(); b.state.schema.properties!.prompt = { type: 'string' }; b.state.schema.properties!.secret = { type: 'string' }
    b.state.initial = { answer: '', prompt: 'Published prompt', secret: 'HIDDEN_STATE' }; b.behaviors.push({ type: 'text', element_id: 'question', field: '/prompt' })
    const result = staticDocument('Title', [view(b)])
    expect(result.html).toContain('Published prompt'); expect(result.html).not.toContain('HIDDEN_STATE')
  })
})
it('preserves original-question styles with distinct scopes and no nested document headings', () => {
 const b=bundle(); b.css='#question{color:#123456}'
 const result=staticDocument('Top',[view(b)],[{label:'Revision one',value:{answer:'Saved'},question:view(b)}])
 expect(result.html).toContain('export-answer-0-0-question'); expect(result.html).toContain('export-0-question')
 expect(result.styles.join('\n')).toContain('#export-answer-0-0-question');expect(result.html.match(/<h1>/g)).toHaveLength(1)
})
it('localizes known missing images without losing neighboring learning or weakening reference validation',()=>{
 const b=bundle();b.html=b.html.replace('Original question','Before<img src="trellis-resource:picture" alt="Picture">After');b.references=[{name:'picture',target:{kind:'resource',id:'resource'}}]
 const resolve=()=>{throw new ContractError('RESOURCE_CORRUPT','synthetic')}
 const result=staticDocument('Title',[{bundle:b,resolve}]);expect(result.issues).toContain('View 1: IMAGE_OMITTED_RESOURCE_CORRUPT');expect(result.html).toContain('Before');expect(result.html).toContain('After');expect(result.html).toContain('此处图片未导出');expect(result.html).not.toContain('<img')
 expect(()=>staticDocument('Title',[{bundle:b,resolve:()=>{throw new ContractError('EXPORT_HISTORY_INVALID','untrusted')}}])).toThrow('untrusted')
})
it('binds separate static-fragment class styles to their own data-view scope',()=>{
 const b=bundle();b.export[0]={id:'static',category:'learning',source:{type:'static',html:'<p class="lesson">STATIC_TEXT</p>',css:'.lesson{color:#123456}'}}
 const result=staticDocument('Title',[view(b)]);expect(result.html).toContain('data-view="export-0-static-0"');expect(result.styles.join('')).toContain('[data-view="export-0-static-0"]')
})
it('exports full-document source with embedded styles and isolated browser CSS', () => {
 const b=bundle();b.html='<!doctype html><html><head><style>body{font-family:serif} @media(min-width:1px){p{box-shadow:0 1px 3px #0003}}</style></head><body><article id="lesson" role="note"><p>Full document</p></article></body></html>';b.behaviors=[];b.forms=[];b.export=[{id:'lesson',category:'learning',source:{type:'element',element_id:'lesson'}}]
 const result=staticDocument('Title',[view(b)])
 expect(result.issues).toEqual([])
 expect(result.html).toContain('shadowrootmode="open"')
 expect(result.html).toContain('Full document')
 expect(result.html).toContain('font-family:serif')
 expect(result.html).toContain('@media')
 expect(result.html).toContain('role="note"')
})

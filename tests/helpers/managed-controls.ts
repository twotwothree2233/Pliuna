import type { Bundle } from '../../src/shared/contracts.generated'

export function managedControls(): Bundle & { state: Bundle['state'] & { initial: Record<string, unknown> } } {
  return {
    profile: 'managed-v1',
    html: '<section><label for="choice">Choice</label><select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select><label for="multi">Multiple</label><select id="multi" multiple><option value="x">X</option><option value="y">Y</option></select><label for="radio-a">Radio A</label><input id="radio-a" type="radio"><label for="radio-b">Radio B</label><input id="radio-b" type="radio"><label for="range">Range</label><input id="range" type="range" min="0" max="10" step="1"><span id="range-text"></span><button id="toggle">Toggle details</button><div id="details" class="details">Local details</div><label for="check">Visible checkbox</label><input id="check" type="checkbox"><button id="submit-main">Submit choices</button><label for="note">Note</label><textarea id="note"></textarea><button id="submit-note">Submit note</button></section>',
    css: '.details { display: block; } .highlight { color: red; }',
    state: {
      schema: { type: 'object', additionalProperties: false, required: ['choice', 'multi', 'radio', 'range', 'visible', 'note'], properties: {
        choice: { type: 'string', enum: ['a', 'b'] }, multi: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, maxItems: 2 },
        radio: { type: 'string', enum: ['a', 'b'] }, range: { type: 'integer', minimum: 0, maximum: 10 }, visible: { type: 'boolean' }, note: { type: 'string' }
      } }, initial: { choice: 'a', multi: [], radio: 'a', range: '2', visible: false, note: '' }, compatibility_version: 'controls-v1'
    },
    forms: [{ id: 'choices', fields: ['/choice', '/multi', '/radio', '/range'] }, { id: 'note', fields: ['/note'] }],
    behaviors: [
      { type: 'input', element_id: 'choice', field: '/choice', control: 'select' },
      { type: 'input', element_id: 'multi', field: '/multi', control: 'multiselect' },
      { type: 'input', element_id: 'radio-a', field: '/radio', control: 'radio', option_value: 'a' },
      { type: 'input', element_id: 'radio-b', field: '/radio', control: 'radio', option_value: 'b' },
      { type: 'input', element_id: 'range', field: '/range', control: 'range' },
      { type: 'text', element_id: 'range-text', field: '/range' },
      { type: 'toggle', element_id: 'toggle', field: '/visible' },
      { type: 'visible', element_id: 'details', field: '/visible' },
      { type: 'class_toggle', element_id: 'details', field: '/visible', class_name: 'highlight' },
      { type: 'input', element_id: 'check', field: '/visible', control: 'checkbox' },
      { type: 'submit', element_id: 'submit-main', form_id: 'choices' },
      { type: 'input', element_id: 'note', field: '/note', control: 'textarea' },
      { type: 'submit', element_id: 'submit-note', form_id: 'note' }
    ], references: [], export: []
  }
}

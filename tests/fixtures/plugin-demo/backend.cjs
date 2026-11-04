const readline = require('node:readline')
const pending = new Map()
let sequence = 0, stopped = false
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
function request(method, params) {
  if (stopped || pending.size >= 20) return Promise.reject(Error('unavailable'))
  return new Promise((resolve, reject) => {
    const id = 'fixture:' + ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(Error('timeout')) }, 10000)
    pending.set(id, { resolve, reject, timer }); send({ jsonrpc: '2.0', id, method, params })
  })
}
function bundle(text, compatibility = 'acceptance-1') {
  return { profile: 'managed-v1', html: '<section><h2>Plugin acceptance</h2><label for="answer">Plugin answer</label><textarea id="answer"></textarea></section>', css: '', state: { schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }, initial: { answer: text }, compatibility_version: compatibility }, forms: [], behaviors: [{ type: 'input', element_id: 'answer', field: '/answer', control: 'textarea' }], references: [], export: [] }
}
async function propose(task, input) {
  if (stopped) return
  let mutation
  if (input.operation === 'create_data') mutation = { type: 'task_data.create', data: { schema: { type: 'object', properties: { stage: { type: 'string' } }, required: ['stage'], additionalProperties: false }, value: { stage: input.text }, references: [] } }
  else if (input.operation === 'replace_data') {
    const list = await request('objects.list', { task_id: task, input: { kind: 'task_data' } })
    if (list.items.length !== 1) throw Error('requires exactly one acceptance data object')
    mutation = { type: 'task_data.replace', id: list.items[0].id, expected_revision: list.items[0].revision, value: { stage: input.text }, references: [] }
  } else {
    const list = await request('objects.list', { task_id: task, input: { kind: 'surface' } })
    const surface = list.items[0]
    let operation
    if (input.operation === 'create_view') operation = { type: 'view.create', client_ref: 'fixture', slot_id: 'main', bundle: { type: 'inline', bundle: bundle(input.text) } }
    else {
      const views = await request('objects.list', { task_id: task, input: { kind: 'view' } })
      if (views.items.length !== 1) throw Error('requires exactly one acceptance View')
      const view = views.items[0], reset = input.operation === 'reset', next = bundle(input.text, reset ? 'acceptance-reset' : 'acceptance-1')
      operation = { type: 'view.replace', view_id: view.id, expected_view_revision: view.revision, bundle: { type: 'inline', bundle: next }, state_transition: reset ? { type: 'reset', expected_state_revision: view.state_revision, initial: next.state.initial } : { type: 'preserve', expected_state_revision: view.state_revision, compatibility_version: 'acceptance-1' } }
    }
    mutation = { type: 'surface.update', surface_id: surface.id, expected_revision: surface.revision, operations: [operation] }
    const draft = await request('surface.stage', { task_id: task, mutation })
    await request('actions.submit', { task_id: task, action: { type: 'surface.commit', draft_id: draft.draft_id } }); return
  }
  await request('actions.submit', { task_id: task, mutation })
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { process.exit(2) }
  if (!message.method) {
    const p = pending.get(message.id)
    if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(Error('host rejected')) : p.resolve(message.result) }
    return
  }
  if (!message.id) return
  const { id, method, params } = message
  if (method === 'initialize') { send({ jsonrpc: '2.0', id, result: { protocol_version: '0.1', plugin_id: params.plugin_id, capabilities: params.capabilities } }); return }
  if (method === 'shutdown') { stopped = true; send({ jsonrpc: '2.0', id, result: { accepted: true } }); process.stdin.pause(); return }
  if (method !== 'tools.execute') { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown fixture method' } }); return }
  if (params.capability === 'echo') setTimeout(() => send({ jsonrpc: '2.0', id, result: { text: params.arguments.text.repeat(params.arguments.repeat ?? 1) } }), params.arguments.delay_ms ?? 0)
  else {
    send({ jsonrpc: '2.0', id, result: { scheduled: true, notice: 'Separate action scheduled; not committed. Inspect the original Action and approval. Never replay automatically.' } })
    setTimeout(() => { void propose(params.task_id, params.arguments).catch(() => {}) }, 300)
  }
})

import type { ServerResponse } from 'node:http'
import { synthetic, textStream, toolStream } from './model-server'

export function exportCheckScenario() {
  const requests: any[] = [], pages: { id: string; content: string }[] = [], checks: any[] = []
  let phase = 'directory', serial = 0, failure: string | undefined, guide: any, surface: any, view: any, contractRead: any, template: any, parts = '', contractParts = ''
  const send = (response: ServerResponse, name: string, args: any) => toolStream(response, name, args, '', 'export-check-' + (++serial))
  return {
    requests, pages, checks, get failure() { return failure },
    handle({ body }: { body: any }, response: ServerResponse) {
      try {
        if (synthetic(body, response)) return
        requests.push(body)
        if (body.max_tokens !== undefined || body.max_completion_tokens !== undefined) throw Error('Hidden output ceiling')
        for (const page of pages) if (!body.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === page.id && m.content === page.content)) throw Error('Diagnostic page not delivered intact')
        const last = body.messages.at(-1)
        let result = last.role === 'tool' ? JSON.parse(last.content) : undefined
        if (phase !== 'check-pages' && result?.data?.representation === 'application/json; charset=utf-8') {
          contractParts += result.data.data.text
          if (result.data.next_cursor) return send(response, result.data.next_call.name, result.data.next_call.arguments)
          result = { ...result, data: { ...result.data, data: JSON.parse(contractParts) } }; contractParts = ''
        }
        if (phase === 'directory') { phase = 'contract'; return send(response, 'list', { kind: 'object_type' }) }
        if (phase === 'contract') {
          contractRead = result.data.items.find((x: any) => x.id === 'surface.update').contract_target
          phase = 'guide'; return send(response, 'read', contractRead)
        }
        if (phase === 'guide') {
          guide = result.data.data
          if (!guide.sections.some((x: any) => x.id === 'export-rules')) throw Error('Export semantics not discoverable')
          phase = 'branch'; return send(response, 'read', { ...contractRead, selection: { view: 'guide', section: 'view.create' } })
        }
        if (phase === 'branch') {
          template = result.data.data.example
          if (!result.data.data.outer_fields.some((x: any) => x.name === 'surface_id' && x.required)) throw Error('Outer fields absent')
          phase = 'surface'; return send(response, 'list', { kind: 'surface' })
        }
        if (phase === 'surface') {
          surface = result.data.items[0]
          const example = JSON.parse(template.input_json); delete example.surface_id
          phase = 'bad-write'; return send(response, 'write', { operation: 'surface.update', input_json: JSON.stringify(example) })
        }
        if (phase === 'bad-write') {
          if (result.execution !== 'not_executed' || result.error.code !== 'INVALID_REQUEST') throw Error('Invalid write was not refused')
          const suggestion = JSON.parse(result.error.suggestion)
          phase = 'correct-write'; return send(response, suggestion.name, suggestion.arguments)
        }
        if (phase === 'correct-write') {
          const example = JSON.parse(template.input_json); example.surface_id = surface.id; example.expected_revision = surface.revision
          example.operations[0].bundle.bundle.html = '<section id="lesson"><table><tr><th>编号</th><th>数量</th></tr><tr><td>ROW-1</td><td>13</td></tr><tr><td>ROW-2</td><td>17</td></tr></table><p>合计30</p></section><p id="outside">必须交付的口径说明</p>'
          example.operations[0].bundle.bundle.export[0].category = 'unclassified'
          phase = 'published'; return send(response, 'write', { operation: 'surface.update', input_json: JSON.stringify(example) })
        }
        if (phase === 'published') {
          if (result.execution !== 'success') throw Error('Publication failed')
          phase = 'view'; return send(response, 'list', { kind: 'view' })
        }
        if (phase === 'view') {
          view = result.data.items[0]
          phase = 'check-pages'; return send(response, 'read', { ...view.read_options.export_check, max_chars: 180 })
        }
        if (phase === 'check-pages') {
          if (result.execution !== 'success') throw Error('Export read failed')
          pages.push({ id: last.tool_call_id, content: last.content })
          if (result.data.representation) parts += result.data.data.text
          else parts = JSON.stringify(result.data.data)
          if (result.data.next_cursor) return send(response, result.data.next_call.name, result.data.next_call.arguments)
          const check = JSON.parse(parts); checks.push(check)
          if (check.complete || !check.issues.some((x: any) => x.element_id === 'outside') || !check.issues.some((x: any) => x.code === 'UNCLASSIFIED_FRAGMENT')) throw Error('Missing export diagnostics')
          phase = 'replacement-example'; return send(response, 'read', { ...contractRead, selection: { view: 'example', section: 'view.replace' } })
        }
        if (phase === 'replacement-example') {
          template = result.data.data
          phase = 'latest-surface'; return send(response, 'list', { kind: 'surface' })
        }
        if (phase === 'latest-surface') {
          surface = result.data.items[0]
          const example = JSON.parse(template.input_json), operation = example.operations[0]
          example.surface_id = surface.id; example.expected_revision = surface.revision
          operation.view_id = view.id; operation.expected_view_revision = view.revision; operation.state_transition.expected_state_revision = view.state_revision
          operation.bundle.bundle.html = '<section id="lesson"><h2>完整核对表</h2><table><tr><th>编号</th><th>数量</th></tr><tr><td>ROW-1</td><td>13</td></tr><tr><td>ROW-2</td><td>17</td></tr></table><p>合计30</p><p id="outside">必须交付的口径说明</p></section>'
          phase = 'replaced'; return send(response, 'write', { operation: 'surface.update', input_json: JSON.stringify(example) })
        }
        if (phase === 'replaced') {
          if (result.execution !== 'success') throw Error('Replacement failed')
          phase = 'latest-view'; return send(response, 'list', { kind: 'view' })
        }
        if (phase === 'latest-view') {
          view = result.data.items[0]; phase = 'final-check'
          return send(response, 'read', view.read_options.export_check)
        }
        if (phase === 'final-check') {
          checks.push(result.data.data)
          if (!result.data.data.complete || result.data.data.issues.length) throw Error('Corrected export still incomplete')
          phase = 'done'; return textStream(response, 'EXPORT_CHECK_COMPLETE')
        }
        throw Error('Unexpected request or replay')
      } catch (error) { failure = String(error); response.writeHead(500); response.end() }
    }
  }
}

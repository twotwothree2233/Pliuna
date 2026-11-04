import type { ServerResponse } from 'node:http'
import { synthetic, textStream, toolStream } from './model-server'

// This fixture learns the entry point from the minimal tools and the write from read pages.
export function contractScenario() {
  const requests: any[] = [], pages: { id: string; content: string }[] = []
  let guideParts = ''
  let entry: { kind: string; id: string; selection?: object } | undefined, contract: any, phase = 'discover', failure: unknown
  return {
    requests, pages, get contract() { return contract }, get failure() { return failure },
    handle({ body }: { body: any }, res: ServerResponse) {
      try {
        if (synthetic(body, res)) return
        requests.push(body)
        // Every requested page must survive rebuilding the next and all later model requests.
        for (const page of pages) {
          const supplied = body.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === page.id)
          if (supplied?.content !== page.content) throw Error('Contract page was reduced or lost before model delivery')
        }
        const last = body.messages.at(-1), result = last.role === 'tool' ? JSON.parse(last.content) : null
        const sendRead = (cursor?: string) => toolStream(res, 'read', { ...entry!, ...(cursor ? { cursor } : {}) }, '', (phase === 'guide' ? 'guide-' : 'contract-page-') + pages.length)
        if (phase === 'discover') {
          const description = body.tools.find((tool: any) => tool.function.name === 'list').function.description
          const kind = /kind="([^"]+)"/.exec(description)?.[1]
          if (!kind || !description.includes('contract_target')) throw Error('Contract discovery entry absent from model tools')
          phase = 'directory'; return toolStream(res, 'list', { kind }, '', 'directory')
        }
        if (phase === 'directory') {
          entry = result?.data?.items.find((item: any) => item.id === 'surface.update')?.contract_target
          if (!entry) throw Error('Exact Surface contract target absent')
          phase = 'guide'; return sendRead()
        }
        if (phase === 'guide') {
          if (result?.data?.representation) {
            guideParts += result.data.data.text
            if (result.data.next_cursor) return sendRead(result.data.next_cursor)
          }
          const guide = guideParts ? JSON.parse(guideParts) : result?.data?.data
          if (!guide?.sections) throw Error('Default short contract guide absent')
          entry = { ...entry!, selection: { view: 'object' } }
          phase = 'pages'; return sendRead()
        }
        if (phase === 'pages') {
          if (result?.execution !== 'success' || typeof result.data?.data?.text !== 'string') throw Error('Expected paged contract text')
          pages.push({ id: last.tool_call_id, content: last.content })
          if (result.data.next_cursor) return sendRead(result.data.next_cursor)
          contract = JSON.parse(pages.map(page => JSON.parse(page.content).data.data.text).join(''))
          phase = 'surface'; return toolStream(res, 'list', { kind: 'surface' }, '', 'surface-directory')
        }
        if (phase === 'surface') {
          const surface = result?.data?.items[0]
          if (!surface) throw Error('Surface directory empty')
          const example = structuredClone(contract.example)
          const decoded = JSON.parse(example.input_json)
          decoded.surface_id = surface.id; decoded.expected_revision = surface.revision
          example.input_json = JSON.stringify(decoded)
          phase = 'published'; return toolStream(res, 'write', example, '', 'publish-example')
        }
        if (phase === 'published') {
          if (result?.execution !== 'success') throw Error('Read example failed publication: ' + JSON.stringify(result?.error))
          phase = 'done'; return textStream(res, 'CONTRACT_EXAMPLE_DELIVERED')
        }
        throw Error('Unexpected request or replay')
      } catch (error) { failure = error; res.writeHead(500); res.end() }
    }
  }
}

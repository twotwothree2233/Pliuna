import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
export interface Exchange { body: any; authorization?: string; url?: string }
export async function modelServer(handle: (exchange: Exchange, response: ServerResponse) => void | Promise<void>) {
  const exchanges: Exchange[] = []
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      const exchange = { body, authorization: req.headers.authorization, url: req.url }; exchanges.push(exchange)
      await handle(exchange, res)
    } catch { res.writeHead(500); res.end() }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/v1`, exchanges, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
export function frame(delta: unknown, finish: string | null = null): string { return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n` }
export function textStream(res: ServerResponse, text: string) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(frame({ role: 'assistant', content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n') }
export function toolStream(res: ServerResponse, name: string, args: unknown, text = '', id = 'wire-call-1') {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(frame({ role: 'assistant', content: text, tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n')
}
// Existing execution fixtures express host requests; raw model-wire tests use toolStream.
export function modelInputFromHost(name: string, args: any): unknown {
  if (name === 'write') { const { type, ...input } = args; return { operation: type, input_json: JSON.stringify(input) } }
  if (name === 'call') { const { arguments: input, ...rest } = args; return { ...rest, input_json: JSON.stringify(input) } }
  if (name === 'read') {
    const { target, content, range, cursor } = args
    const max_chars = content?.max_chars
    const selection: Record<string, unknown> = cursor ? {} : { view: 'object' }
    if (content) selection.view = 'text'
    if (content?.offset_bytes !== undefined || content?.end_bytes !== undefined) throw Error('Model fixtures must use lines, pages, find or cursor, not host byte ranges')
    if (content?.pages) Object.assign(selection, { pages: [content.pages.start, content.pages.end] })
    if (range !== undefined) Object.assign(selection, { view: 'object', lines: [range.start_line, range.end_line] })
    if (target.expected_revision !== undefined) selection.revision = target.expected_revision
    return { kind: target.kind, id: target.id, ...(max_chars !== undefined ? { max_chars } : {}), ...(cursor !== undefined ? { cursor } : {}), ...(Object.keys(selection).length ? { selection } : {}) }
  }
  return args
}
export function hostToolStream(res: ServerResponse, name: string, args: unknown, text = '', id = 'wire-call-1') {
  toolStream(res, name, modelInputFromHost(name, args), text, id)
}
export function synthetic(body: any, res: ServerResponse): boolean {
  const prompt = body.messages?.[0]?.content ?? ''
  if (prompt.startsWith('Synthetic capability') && body.messages.at(-1).role === 'tool') { textStream(res, 'TRELLIS_OK'); return true }
  if (prompt.startsWith('Synthetic capability')) { toolStream(res, 'list', { kind: 'capability' }); return true }
  if (prompt.startsWith('Synthetic approval')) { textStream(res, '{"decision":"escalate","reason":"synthetic test"}'); return true }
  return false
}

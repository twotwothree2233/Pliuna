const textExtensions = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'log', 'html', 'htm', 'svg', 'xml', 'css',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'yaml', 'yml', 'toml', 'ini',
  'java', 'kt', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'rb', 'php', 'lua', 'r'
])
const binaryExtensions = new Map([
  ['pdf', 'application/pdf'], ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'], ['webp', 'image/webp']
])
export const binaryPreviewLimit = 8 * 1024 * 1024
export const binaryPreviewChunk = 192 * 1024
export const materialExtension = (name?: string) => name?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? ''
export const isTextMaterialName = (name: string) => textExtensions.has(materialExtension(name))
export function binaryPreviewType(name?: string, mediaType?: string) {
  const mime = binaryExtensions.get(materialExtension(name))
  return mime && (mediaType === 'application/octet-stream' || mediaType === mime) ? mime : undefined
}

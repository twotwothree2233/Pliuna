const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '')

// Summaries are transport-only; originals remain available through task.query.
export function snapshotValue(text: string, source: { kind: string; id: string }, limit = 4096): Record<string, unknown> {
  if (Buffer.byteLength(text) <= limit) return JSON.parse(text)
  return { truncated: true, source, text: '原记录过长，请按原 ID 续读全文。', notice: '不将摘要用于批准或提交。' }
}

export function boundedRecent<T>(items: T[], limit: number): T[] {
  const result: T[] = []; let size = 0
  for (const item of items) { const length = bytes(item); if (size + length > limit) break; result.push(item); size += length }
  return result
}

export interface Provenance {
  input: { id: string; sha256: string; byte_length: number }
  output: { id: string; sha256: string; byte_length: number }
  call_id: string
  capability_id: string
  package_digest: string
  plugin_version: string
  pages: { page: number; start: number; end: number }[]
  partial: boolean
  notice: string
  location_verification: 'tool_reported'
}

export function sourceFacts(value: Provenance): { label: string; value: string }[] {
  return [
    { label: '原件资源 ID', value: value.input.id },
    { label: '原件 SHA256', value: value.input.sha256 },
    { label: '原件字节数', value: String(value.input.byte_length) },
    { label: '结果资源 ID', value: value.output.id },
    { label: '结果 SHA256', value: value.output.sha256 },
    { label: '结果字节数', value: String(value.output.byte_length) },
    { label: '原 Call ID', value: value.call_id },
    { label: '能力 ID', value: value.capability_id },
    { label: '固定包摘要', value: value.package_digest },
    { label: '插件版本', value: value.plugin_version }
  ]
}

export const sourceFieldLocations = [
  { label: '原件 ID / SHA256 / 长度', location: '原件元数据、结果来源导航、material.derived 事件；原 Call 公开字段不包含原件身份。' },
  { label: '结果 ID / SHA256 / 长度', location: '结果元数据及来源导航、原 Call 的 result_data.resources、material.derived 事件；原件的派生目录只列结果 ID。' },
  { label: '能力 / 固定包 / 版本', location: '结果来源导航及 material.derived 事件；原 Call 公开能力 ID，不直接公开固定包摘要和插件版本。' },
  { label: '精确提取参数', location: 'material.derived 原事件的 parameters；当前来源导航不返回参数，不表示参数为空。' },
  { label: '页索引', location: '结果来源导航及 material.derived 事件的 pages；不是原 Call 通用公开字段，也不是原 PDF 字节偏移。' }
] as const

export function extractionCoverage(partial: boolean): string {
  return partial ? '部分结果，不能当作完整材料' : '工具未标记部分结果，不代表语义完整或没有遗漏'
}

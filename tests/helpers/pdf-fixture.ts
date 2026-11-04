export function pdfFixture(texts = ['Trellis PDF text one', 'Trellis PDF text two'], options: { encrypted?: boolean; activityUrl?: string; fontSize?: number; overlapLines?: boolean } = {}): Buffer {
  const objects: string[] = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const pages: number[] = []
  for (const text of texts) {
    const page = objects.length + 1, contentId = page + 1
    pages.push(page)
    const escaped = (value: string) => value.replace(/[\\()]/g, '\\$&')
    const content = !text ? '' : options.overlapLines ? `BT /F1 12 Tf ${Array.from({ length: Math.ceil(text.length / 60) }, (_, i) => `1 0 0 1 50 700 Tm (${escaped(text.slice(i * 60, i * 60 + 60))}) Tj`).join(' ')} ET` : `BT /F1 ${options.fontSize ?? 12} Tf 50 700 Td (${escaped(text)}) Tj ET`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  }
  let activity = ''
  if (options.activityUrl) {
    const js = objects.length + 1, uri = js + 1
    objects.push(`<< /S /JavaScript /JS (throw new Error\\(PDF_SCRIPT_EXECUTED\\)) >>`, `<< /S /URI /URI (${options.activityUrl}) >>`)
    activity = ` /OpenAction ${js} 0 R /AA << /WC ${uri} 0 R >>`
  }
  let encryption = ''
  if (options.encrypted) { const encrypt = objects.length + 1; objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`); encryption = ` /Encrypt ${encrypt} 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>]` }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${activity} >>`
  objects[1] = `<< /Type /Pages /Kids [${pages.map(p => p + ' 0 R').join(' ')}] /Count ${pages.length} >>`
  let body = '%PDF-1.4\n'; const offsets: number[] = []
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body)
}

const rowLimit = 50
const columnLimit = 16

// Parse a prefix without displaying a record that crosses the read boundary.
export function materialTable(text: string, separator: ',' | '\t', partial: boolean) {
  const rows: string[][] = []
  let row: string[] = [], field = '', columns = 0, clipped = partial
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start'

  function endField() {
    if (++columns <= columnLimit) row.push(field)
    else clipped = true
    field = ''; state = 'start'
  }
  function endRow() {
    endField()
    rows.push(row)
    row = []; columns = 0
  }

  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i]!
    if (rows.length === rowLimit) { clipped = true; break }
    if (state === 'quoted') {
      if (char !== '"') field += char
      else if (text[i + 1] === '"') { field += char; i++ }
      else state = 'closed'
    } else if (char === separator) endField()
    else if (char === '\n' || char === '\r') {
      // The next read may begin with the LF of a CRLF record terminator.
      if (char === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else if (state === 'closed') return null
    else if (char === '"') {
      if (state !== 'start') return null
      state = 'quoted'
    } else { field += char; state = 'plain' }
  }
  if (!partial && rows.length < rowLimit) {
    if (state === 'quoted') return null
    if (row.length || state !== 'start') endRow()
  }
  return { rows, clipped }
}

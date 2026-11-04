// Used only after JSON.parse fails; never repairs or returns executable input.
export function jsonFailureOffset(text: string): number {
  let offset = 0
  const space = () => { while (/[ \t\r\n]/.test(text[offset] ?? '') && offset < text.length) offset++ }
  const stop = (): never => { throw offset }
  const string = () => {
    if (text[offset++] !== '"') { offset--; stop() }
    while (offset < text.length) {
      const char = text[offset++]!
      if (char === '"') return
      if (char.charCodeAt(0) < 32) { offset--; stop() }
      if (char === '\\') {
        const escaped = text[offset++]
        if (escaped === 'u') {
          for (let i = 0; i < 4; i++) if (!/[0-9a-f]/i.test(text[offset++] ?? '')) { offset--; stop() }
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) { offset--; stop() }
      }
    }
    stop()
  }
  const value = (): void => {
    space()
    const char = text[offset]
    if (char === '"') return string()
    if (char === '{' || char === '[') {
      const object = char === '{', end = object ? '}' : ']'
      offset++; space()
      if (text[offset] === end) { offset++; return }
      while (offset < text.length) {
        if (object) { string(); space(); if (text[offset] !== ':') stop(); offset++ }
        value(); space()
        if (text[offset] === end) { offset++; return }
        if (text[offset] !== ',') stop()
        offset++; space()
      }
      stop()
    }
    for (const literal of ['true', 'false', 'null']) if (char === literal[0]) {
      for (const expected of literal) if (text[offset++] !== expected) { offset--; stop() }
      return
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset))
    if (!number) stop()
    offset += number![0].length
  }
  try { value(); space(); if (offset !== text.length) stop() } catch { /* Offset alone is safe to disclose. */ }
  return Math.min(offset, text.length)
}

export function jsonDiagnostic(text: string, layer: string): string {
  const offset = jsonFailureOffset(text), lines = text.slice(0, offset).split('\n')
  return `${layer}: invalid JSON at offset ${offset} (zero-based UTF-16 code units), line ${lines.length}, column ${lines.at(-1)!.length + 1} (one-based); no input was executed`
}

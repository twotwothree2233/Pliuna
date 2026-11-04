// Long configured deadlines must not overflow Node's signed 32-bit timer delay.
export function deadline(ms: number | undefined, expire: () => void): () => void {
  if (ms === undefined) return () => {}
  const end = Date.now() + ms
  let timer: ReturnType<typeof setTimeout>
  const next = () => {
    const remaining = end - Date.now()
    if (remaining <= 0) expire()
    else timer = setTimeout(next, Math.min(remaining, 2147483647))
  }
  next()
  return () => clearTimeout(timer)
}

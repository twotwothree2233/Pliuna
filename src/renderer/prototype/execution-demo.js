const dispatchAt = 1200
const transferTime = 900
const readyAt = dispatchAt + transferTime
const layoutTime = 1300
const durations = [1750, 4400, 2750, 3900, 2200, 3400]

export function demoUsage(plan, elapsed) {
  if (!plan) return undefined
  const settled = plan.usageReports.filter(report => report.at <= elapsed)
  if (!settled.length) return null
  return settled.reduce((total, { input, output, cached }) => ({
    input: total.input + input,
    output: total.output + output,
    cached: total.cached + cached
  }), { input: 0, output: 0, cached: 0 })
}

export function planDemo(count, parallelism) {
  const slots = Array(parallelism).fill(readyAt)
  const workers = Array.from({ length: count }, (_, id) => {
    const slot = slots.indexOf(Math.min(...slots))
    const start = slots[slot]
    const accept = start + durations[id]
    slots[slot] = accept
    return { id, start, accept }
  })

  const remaining = [...workers].sort((a, b) => a.accept - b.accept)
  const batches = []
  while (remaining.length) {
    const start = Math.max(remaining[0].accept, batches.at(-1)?.planned ?? 0)
    const inputs = remaining.splice(0, remaining.filter(work => work.accept <= start).length).map(work => work.id)
    const received = start + transferTime
    const planned = received + layoutTime
    batches.push({ id: batches.length + 1, inputs, start, received, planned, publish: planned + transferTime })
  }

  const transfers = [
    { kind: 'dispatch', start: dispatchAt, end: readyAt, workers: workers.map(work => work.id) },
    ...batches.flatMap(batch => [
      { kind: 'index', start: batch.start, end: batch.received, workers: batch.inputs, batch: batch.id },
      { kind: 'layout', start: batch.planned, end: batch.publish, workers: batch.inputs, batch: batch.id }
    ])
  ].sort((a, b) => a.start - b.start)
  const points = [...new Set([0, ...workers.flatMap(work => [work.start, work.accept]), ...transfers.flatMap(t => [t.start, t.end])])].sort((a, b) => a - b)
  // Sample usage is reported when Router dispatches, a Worker is accepted, or Collator finishes a batch.
  const usageReports = [
    { at: dispatchAt, input: 920, output: 120 + count * 80, cached: 0 },
    ...workers.map(({ id, accept }) => ({ at: accept, input: 1720 + id * 180, output: 260 + id * 52, cached: 1024 })),
    ...batches.map(({ inputs, planned }) => ({ at: planned, input: 1440 + inputs.length * 420, output: 210 + inputs.length * 88, cached: 768 }))
  ]
  return { workers, batches, points, transfers, end: points.at(-1), dispatchAt, readyAt, usageReports }
}

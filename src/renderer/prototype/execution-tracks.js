// Route to the actual ports after the map has laid out. This keeps the same
// transfer clock when a panel resizes or the two-column mobile layout takes over.
export function drawExecutionTracks(map, frame, reduceMotion) {
  const layer = map.querySelector('.pf-edges')
  const bounds = layer.getBoundingClientRect()
  if (!bounds.width || !bounds.height) return

  const box = node => {
    const { left, right, top, bottom, width, height } = node.getBoundingClientRect()
    return { l: left - bounds.left, r: right - bounds.left, t: top - bounds.top, b: bottom - bounds.top,
      x: left - bounds.left + width / 2, y: top - bounds.top + height / 2 }
  }
  const step = name => box(map.querySelector(`[data-flow-step="${name}"]`))
  const router = step('router'), collator = step('collator'), host = step('host')
  const horizontal = router.r < collator.l
  const workers = [...map.querySelectorAll('.pf-workers .pf-node')].map(box)
  const paths = workers.flatMap((worker, id) => {
    if (horizontal) {
      const left = (router.r + worker.l) / 2, right = (worker.r + collator.l) / 2
      return [
        { kind: 'dispatch', id, points: [[router.r, router.y], [left, router.y], [left, worker.y], [worker.l, worker.y]] },
        { kind: 'index', id, points: [[worker.r, worker.y], [right, worker.y], [right, collator.y], [collator.l, collator.y]] }
      ]
    }
    const left = worker.x < router.x
    const rail = left ? 8 : bounds.width - 8
    const junction = collator.t - 12
    return [
      { kind: 'dispatch', id, points: [[router.x, router.b], [router.x, worker.y], [left ? worker.r : worker.l, worker.y]] },
      { kind: 'index', id, points: [[left ? worker.l : worker.r, worker.y], [rail, worker.y], [rail, junction], [collator.x, junction], [collator.x, collator.t]] }
    ]
  })
  paths.push({ kind: 'layout', points: horizontal ? [[collator.r, collator.y], [host.l, host.y]] : [[collator.x, collator.b], [host.x, host.t]] })

  function line({ points, kind }, active) {
    let lastAngle = 0
    const legs = points.slice(1).map(([x, y], index) => {
      const [sx, sy] = points[index], dx = x - sx, dy = y - sy
      const length = Math.hypot(dx, dy)
      if (length < .1) return ''
      lastAngle = Math.atan2(dy, dx)
      return `<i class="pf-wire" style="left:${sx}px;top:${sy}px;width:${length}px;rotate:${lastAngle}rad"></i>`
    }).join('')
    const [x, y] = points.at(-1)
    return `<span class="pf-track" data-kind="${kind}"${active ? ' data-live' : ''}>${legs}<i class="pf-arrow" style="left:${x}px;top:${y}px;rotate:${lastAngle}rad"></i></span>`
  }

  const recent = frame.transfers.filter(t => t.start <= frame.elapsed && t.end > frame.elapsed)
  const flying = paths.flatMap(path => recent.filter(transfer => transfer.kind === path.kind && (path.id === undefined || transfer.workers.includes(path.id))).map(transfer => ({ path, transfer })))
  layer.innerHTML = paths.map(path => line(path, false)).join('') + flying.map(({ path }) => line(path, true)).join('')
  for (const { path, transfer } of flying) {
    const token = document.createElement('i')
    token.className = 'pf-packet'
    token.dataset.kind = path.kind
    const pathData = path.points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ')
    token.style.offsetPath = `path('${pathData}')`
    layer.append(token)
    const duration = transfer.end - transfer.start
    const elapsed = frame.elapsed - transfer.start
    if (reduceMotion || !frame.playing) token.style.offsetDistance = `${reduceMotion || elapsed === 0 ? 55 : elapsed / duration * 100}%`
    else {
      const motion = token.animate([{ offsetDistance: '0%' }, { offsetDistance: '100%' }], { duration, fill: 'both' })
      motion.currentTime = elapsed
    }
  }
}

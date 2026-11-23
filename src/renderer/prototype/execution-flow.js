import { demoUsage, planDemo } from './execution-demo.js'
import { drawExecutionTracks } from './execution-tracks.js'

const phases = {
  ready: '待开始', active: '执行中', waiting: '等待成果', queued: '排队中',
  done: '已完成', pending: '未发布', partial: '部分发布', published: '已发布'
}
const idFor = id => `worker-${id}`
const payloads = { dispatch: '任务指令', index: '成果索引', layout: '排版方案' }

function workFor(task) {
  const topics = task.id === 'interviews'
    ? ['提炼共性问题', '整理改进建议', '核对访谈依据', '整理后续行动', '归类分歧意见', '索引访谈材料']
    : [...(task.findings ?? []).map(([title]) => title), '核对材料依据', '整理后续行动', '检查遗漏事项', '索引任务材料', '整理关键结论', '汇总待确认事项']
  return topics.slice(0, 6)
}

function snapshot(demo) {
  const { plan, origin, count } = demo
  const elapsed = plan ? Math.min(plan.end, origin === null ? demo.elapsed : performance.now() - origin) : 0
  const dispatched = Boolean(plan && elapsed >= plan.readyAt)
  const sending = Boolean(plan && elapsed >= plan.dispatchAt && !dispatched)
  const workers = Array.from({ length: count }, (_, id) => {
    const work = plan?.workers[id]
    const state = !dispatched ? sending ? 'active' : 'ready' : elapsed >= work.accept ? 'done' : elapsed >= work.start ? 'active' : 'queued'
    return { ...work, id, state }
  })
  const batches = plan?.batches ?? []
  const composing = batches.find(batch => batch.start <= elapsed && batch.planned > elapsed)
  const assembled = batches.filter(batch => batch.planned <= elapsed).at(-1)
  const delivering = batches.find(batch => batch.planned <= elapsed && batch.publish > elapsed)
  const published = batches.filter(batch => batch.publish <= elapsed).flatMap(batch => batch.inputs).length
  const finished = Boolean(plan && elapsed >= plan.end)
  const stage = !plan ? '未开始' : finished ? '模拟完成' : origin === null ? '已暂停' : '模拟运行中'
  return { elapsed, dispatched, sending, workers, composing, assembled, delivering, published, finished, stage, transfers: plan?.transfers ?? [],
    playing: Boolean(plan && origin !== null && !finished), publication: published === count ? 'published' : published ? 'partial' : 'pending' }
}

export function setupExecutionFlow(root, { icon, escape, onUsage }) {
  const demos = new WeakMap()
  let shown, timer
  let observed
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  const redraw = () => {
    if (observed?.isConnected && shown) drawExecutionTracks(observed, snapshot(shown.demo), motion.matches)
  }
  const size = new ResizeObserver(redraw)
  motion.addEventListener('change', redraw)

  const phase = (state, label = phases[state]) => `<span class="pf-status" data-phase="${state}">${label}</span>`
  const clock = ms => `${(ms / 1000).toFixed(1)} 秒`

  function node(step, selected) {
    return `<button type="button" class="pf-node" data-flow-step="${step.id}" aria-pressed="${selected}" aria-controls="pf-detail">
      <span class="pf-role">${icon(step.icon)}${step.role}</span><strong>${escape(step.title)}</strong>${phase(step.state, step.label)}</button>`
  }

  function stepsFor(task, frame) {
    const titles = workFor(task)
    const router = {
      id: 'router', role: 'Router', icon: 'flow', title: '分派工作', state: frame.dispatched ? 'done' : frame.stage === '未开始' ? 'ready' : 'active',
      label: frame.sending ? '发送指令' : undefined,
      fields: [['请求', task.request ?? `整理「${task.name}」的要点。`], ['交接', frame.dispatched || frame.sending ? `${frame.workers.length} 份任务指令，包含各项工作的目标。` : '开始模拟后分派工作。']]
    }
    const workers = frame.workers.map(({ id, state, start, accept }) => ({
      id: idFor(id), role: 'Worker', icon: 'doc', title: titles[id], state,
      label: !frame.dispatched ? frame.sending ? '接收指令' : '待分派' : state === 'done' ? '已验收' : undefined,
      fields: !frame.dispatched ? [['输入', frame.sending ? '任务指令正在传入。' : '等待 Router 的任务指令。']]
        : [['状态', state === 'queued' ? '等待空闲并发名额。' : state === 'active' ? '正在处理本项工作。' : '成果索引可用于排版。'],
          ...(state === 'queued' ? [] : [['开始于', clock(start)]]), ...(state === 'done' ? [['交付', `成果索引 · ${titles[id]}`], ['验收于', clock(accept)]] : [])]
    }))
    const { composing, assembled, delivering, finished, elapsed } = frame
    const batch = composing ?? assembled
    const receiving = composing && elapsed < composing.received
    const label = receiving ? '接收索引' : composing ? `第 ${composing.id} 批排版` : finished ? '排版完成' : delivering ? '移交方案' : undefined
    const collator = {
      id: 'collator', role: 'Collator', icon: 'split', title: '编排成果', state: composing ? 'active' : finished ? 'done' : 'waiting', label,
      fields: batch ? [['批次', `第 ${batch.id} 批`], ['索引', batch.inputs.map(id => `「${titles[id]}」`).join('、')],
        ['状态', receiving ? '正在接收本批已验收索引。' : composing ? '正在按索引生成排版方案。' : delivering ? '排版方案正在移交宿主。' : finished ? '排版方案已全部移交。' : '此批已移交，等待后续成果。']]
        : [['状态', '收到首份已验收成果后开始排版。']]
    }
    const host = {
      id: 'host', role: 'Host', icon: 'check', title: '发布内容', state: delivering ? 'active' : finished ? 'published' : 'waiting',
      label: delivering ? '接收方案' : finished ? '发布完成' : '等待方案',
      fields: [['输入', delivering ? `第 ${delivering.id} 批排版方案正在传入。` : assembled ? `已接收第 ${assembled.id} 批排版方案。` : '等待 Collator 的排版方案。'],
        ['已发布', `${frame.published}/${workers.length} 份成果`]]
    }
    return [router, ...workers, collator, host]
  }

  function recentTransfers(task, frame) {
    const events = frame.transfers.filter(t => t.start <= frame.elapsed).slice(-3).reverse()
    if (!events.length) return '<p>暂无数据交接</p>'
    const titles = workFor(task)
    return `<ol>${events.map(event => {
      const route = event.kind === 'dispatch' ? `Router → ${event.workers.length} 个 Worker` : event.kind === 'index'
        ? `${event.workers.length === 1 ? titles[event.workers[0]] : 'Worker'} → Collator` : 'Collator → Host'
      const amount = event.kind === 'layout' ? `第 ${event.batch} 批` : `${event.workers.length} 份${event.batch ? ` · 第 ${event.batch} 批` : ''}`
      const live = frame.elapsed < event.end
      return `<li><b data-kind="${event.kind}">${payloads[event.kind]}</b><span class="pf-trace-route">${escape(route)}</span><span class="pf-trace-meta">${amount}</span><span class="pf-trace-state"${live ? ' data-live' : ''}>${live ? '传输中' : '已送达'}</span></li>`
    }).join('')}</ol>`
  }

  function content(task, demo, frame) {
    const steps = stepsFor(task, frame)
    const collator = steps.at(-2), host = steps.at(-1)
    const selected = steps.find(step => step.id === demo.selection) ?? (!frame.dispatched ? steps[0] :
      frame.composing ? collator : frame.delivering || frame.finished ? host : steps.find(step => step.role === 'Worker' && step.state === 'active') ?? collator)
    const renderNode = step => node(step, step === selected)
    const active = frame.workers.filter(work => work.state === 'active').length
    const queued = frame.workers.filter(work => work.state === 'queued').length
    const accepted = frame.workers.length - active - queued
    return {
      '[data-flow-state]': `${frame.stage}${demo.plan ? ` · ${clock(frame.elapsed)}` : ''}`,
      '[data-flow-publish]': phase(frame.publication, `${phases[frame.publication]} ${frame.published}/${demo.count}`),
      '[data-flow-counts]': frame.dispatched ? `执行中 ${active} · 排队 ${queued} · 已验收 ${accepted}` : frame.sending ? `发送 ${demo.count} 份任务指令` : `${demo.count} 项待分派`,
      '.pf-router': renderNode(steps[0]),
      '.pf-workers': steps.slice(1, -2).map(renderNode).join(''),
      '.pf-collator': renderNode(collator),
      '.pf-host': renderNode(host),
      '[data-flow-trace]': recentTransfers(task, frame),
      '#pf-detail': `<div class="pf-detail-head"><div><span class="pf-role">${selected.role}</span><h3 id="pf-step-title">${escape(selected.title)}</h3></div>${phase(selected.state, selected.label)}</div>
        <dl>${selected.fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`
    }
  }

  function refresh() {
    clearTimeout(timer)
    const flow = root.querySelector('.pf-flow')
    if (!flow) { size.disconnect(); observed = undefined }
    if (!shown) return
    const { task, demo, previous } = shown
    const frame = snapshot(demo)
    onUsage(task, demoUsage(demo.plan, frame.elapsed))
    if (frame.playing) {
      const next = demo.plan.points.find(point => point > frame.elapsed)
      timer = setTimeout(refresh, Math.ceil(next - frame.elapsed) + 2)
    }
    if (!flow) return
    const currentStep = document.activeElement.dataset.flowStep
    for (const [selector, html] of Object.entries(content(task, demo, frame))) {
      if (previous[selector] === html) continue
      flow.querySelector(selector).innerHTML = html
      previous[selector] = html
    }
    const map = flow.querySelector('.pf-map')
    if (map !== observed) {
      size.disconnect()
      observed = map
      size.observe(map)
    }
    drawExecutionTracks(map, snapshot(demo), motion.matches)
    if (currentStep && !document.activeElement.dataset.flowStep) flow.querySelector(`[data-flow-step="${currentStep}"]`)?.focus({ preventScroll: true })
    const control = name => flow.querySelector(`[data-flow-command="${name}"]`)
    control('play').textContent = !demo.plan ? '开始模拟' : frame.finished ? '重新运行' : frame.playing ? '暂停' : '继续运行'
    control('step').disabled = frame.playing || frame.finished
    control('reset').disabled = !demo.plan
    flow.querySelectorAll('select').forEach(select => { select.disabled = Boolean(demo.plan && !frame.finished) })
  }

  root.addEventListener('click', event => {
    const button = event.target.closest('button[data-flow-step], button[data-flow-command]')
    if (!button || !shown) return
    const { demo } = shown
    const command = button.dataset.flowCommand
    if (command) {
      const frame = snapshot(demo)
      if (command === 'reset') Object.assign(demo, { plan: null, origin: null, elapsed: 0, selection: null })
      else if (!demo.plan || frame.finished) {
        Object.assign(demo, { plan: planDemo(demo.count, demo.parallelism), origin: command === 'play' ? performance.now() : null, elapsed: 0, selection: null })
      } else if (command === 'step') demo.elapsed = demo.plan.points.find(point => point > frame.elapsed) ?? demo.plan.end
      else if (frame.playing) Object.assign(demo, { origin: null, elapsed: frame.elapsed })
      else demo.origin = performance.now() - demo.elapsed
    } else demo.selection = button.dataset.flowStep
    refresh()
    if (button.disabled) button.closest('.pf-actions')?.querySelector('[data-flow-command="play"]').focus({ preventScroll: true })
  })

  root.addEventListener('change', event => {
    const key = event.target.dataset.flowConfig
    if (!key || !shown) return
    Object.assign(shown.demo, { [key]: Number(event.target.value), plan: null, origin: null, elapsed: 0, selection: null })
    refresh()
  })

  return {
    usage(task) {
      const demo = demos.get(task)
      return demo?.plan ? demoUsage(demo.plan, snapshot(demo).elapsed) : undefined
    },
    show(task) {
      if (shown?.task !== task) {
        const demo = demos.get(task)
        shown = demo ? { task, demo, previous: {} } : undefined
      }
      refresh()
    },
    render(task) {
      const demo = demos.get(task) ?? { count: 4, parallelism: 2, plan: null, origin: null, elapsed: 0, selection: null }
      demos.set(task, demo)
      const frame = snapshot(demo)
      shown = { task, demo, previous: content(task, demo, frame) }
      const html = shown.previous
      const options = (n, current) => Array.from({ length: n }, (_, index) => `<option${index + 1 === current ? ' selected' : ''}>${index + 1}</option>`).join('')
      return `<div class="p-view-body pf-flow"><div class="pf-overview"><h2>执行流程</h2><div class="pf-publish"><span>模拟发布</span><span data-flow-publish>${html['[data-flow-publish]']}</span></div></div>
        <div class="pf-toolbar" aria-label="模拟运行控制">
          <div class="pf-config"><label>Worker 数量 <select data-flow-config="count">${options(6, demo.count)}</select></label><label>并发上限 <select data-flow-config="parallelism">${options(3, demo.parallelism)}</select></label></div>
          <div class="pf-actions"><button type="button" class="primary" data-flow-command="play">开始模拟</button><button type="button" data-flow-command="step">单步</button><button type="button" class="p-quiet-button" data-flow-command="reset">重置</button></div>
        </div>
        <div class="pf-readout"><span data-flow-state>${html['[data-flow-state]']}</span><span data-flow-counts>${html['[data-flow-counts]']}</span></div>
        <div class="pf-map" role="group" aria-label="数据流向：Router、Worker、Collator、Host">
          <div class="pf-edges" aria-hidden="true"></div>
          <div class="pf-stage pf-router">${html['.pf-router']}</div>
          <div class="pf-workers" role="group" aria-label="Worker 工作列表">${html['.pf-workers']}</div>
          <div class="pf-stage pf-collator">${html['.pf-collator']}</div>
          <div class="pf-stage pf-host">${html['.pf-host']}</div>
        </div>
        <div class="pf-legend" aria-label="数据类型">${Object.entries(payloads).map(([kind, label]) => `<span data-kind="${kind}">${label}</span>`).join('')}</div>
        <section class="pf-trace" aria-label="最近交接"><h3>最近交接</h3><div data-flow-trace>${html['[data-flow-trace]']}</div></section>
        <section class="pf-detail" id="pf-detail" aria-labelledby="pf-step-title">${html['#pf-detail']}</section>
      </div>`
    }
  }
}

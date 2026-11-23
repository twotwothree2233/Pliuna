import { paneSlot, setupSidePanes } from './side-panes.js'
import { setupSettings } from './settings.js'
import { setupExecutionFlow } from './execution-flow.js'

const states = { review: '待确认', ready: '就绪', running: '执行中', archived: '已归档' }
const filters = { all: '全部', review: '待确认', running: '执行中', archived: '已归档' }
const iconPaths = {
  plus: '<path d="M8 3v10M3 8h10"/>', search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/>',
  doc: '<path d="M4 2h5l3 3v9H4zM9 2v4h3M6 9h4m-4 2h4"/>', list: '<path d="M3 4h10M3 8h10M3 12h10"/>',
  chat: '<path d="M2.5 3.5h11v7h-6l-3 2v-2h-2zM5 6h6m-6 2h4"/>', clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1"/>',
  file: '<path d="M3 3h4l2 2h4v8H3z"/>', settings: '<circle cx="8" cy="8" r="2"/><path d="m6.5 2-.5 2-2 .5-1.5 2 1 1.5-1 1.5 1.5 2 2 .5.5 2h3l.5-2 2-.5 1.5-2-1-1.5 1-1.5-1.5-2-2-.5-.5-2z"/>',
  right: '<path d="m6 4 4 4-4 4"/>', send: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  check: '<path d="m4 8 3 3 5-6"/>', close: '<path d="m4 4 8 8m0-8-8 8"/>', split: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M9 3v10"/>',
  download: '<path d="M8 2v8M5 7l3 3 3-3M3 11v2h10v-2"/>',
  pin: '<path d="m9.5 2 4.5 4.5-2.8 1.1-1.4 3.4-4.9-4.9 3.4-1.4zM7.3 8.7 3 13"/>',
  archive: '<rect x="2" y="3" width="12" height="3" rx=".7"/><path d="M3 6v7h10V6M6.5 9h3"/>',
  restore: '<path d="M5.5 4 2.5 7l3 3M2.5 7h6.75a3.5 3.5 0 0 1 0 7H8"/>',
  flow: '<path d="M5 8h3m3-4H8v8h3"/><rect x="2" y="6.5" width="3" height="3" rx=".5"/><rect x="11" y="2.5" width="3" height="3" rx=".5"/><rect x="11" y="10.5" width="3" height="3" rx=".5"/>'
}
const icon = (name, css = '') => `<svg class="glyph ${css}" aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${iconPaths[name]}</svg>`
const escape = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const archiveSampleDate = daysAgo => {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  return date.getTime()
}

const tasks = [
  {
    id: 'interviews', name: '产品访谈归纳', state: 'review', time: '今天 14:32', result: '产品访谈纪要',
    sampleUsage: { input: 10580, output: 1830, cached: 6940 },
    request: '把三份访谈归纳成纪要，先列共性问题，再给出改进建议。',
    summary: '三份访谈都提到了任务切换后的恢复成本。用户希望打开上次的任务时，直接回到工作位置，并知道 Agent 是否还在执行。',
    findings: [['难以找回工作位置', '切回任务后要重新找章节或上下文。'], ['执行状态不够明确', '离开任务后，很难确认 Agent 是否仍在运行。'], ['确认入口分散', '收到更新提示后，还要去记录里找变更内容。']],
    next: '切换任务时保留阅读位置，并把待确认的更新放到任务标题附近。',
    previous: { summary: '三份访谈都提到了任务切换后的恢复成本。', next: '继续收集任务切换相关的反馈。' },
    files: ['访谈记录 · 林同学.md', '访谈记录 · 周同学.md', '访谈记录 · 陈同学.md']
  },
  {
    id: 'release', name: '桌面端发布检查', state: 'running', time: '今天 13:48', result: '发布检查清单',
    sampleUsage: { input: 5840, output: 960, cached: 3072 },
    request: '整理桌面端发布前需要完成的检查。',
    summary: '先完成安装、启动和本地数据读取验证，再检查导出及升级后的工作区恢复。',
    findings: [['安装与启动', '从安装包进行一次全新安装。'], ['数据恢复', '重启后重新打开上一次的任务。']],
    next: '记录各平台的验证结论和仍待处理的项目。', files: ['桌面端发布清单.md']
  },
  {
    id: 'onboarding', name: '新手引导文案', state: 'ready', time: '昨天 16:20', result: '引导文案草稿',
    sampleUsage: { input: 2200, output: 470, cached: 0 },
    request: '整理首次使用时的模型配置和任务创建文案。',
    summary: '先说明工作区如何保存，再引导用户配置模型并创建第一个任务。',
    findings: [['模型配置', '检查连接后再进入任务。'], ['首个任务', '解释如何发送指令和查看结果。']],
    next: '用一次全新启动验证文案顺序。', files: ['首次启动流程.md']
  },
  {
    id: 'learning', name: '学习资料整理', state: 'ready', time: '昨天 11:06', result: '学习资料目录',
    sampleUsage: { input: 3650, output: 680 },
    request: '把阅读材料按主题和优先级整理成目录。',
    summary: '将基础概念放在目录前面，再按专题列出后续阅读材料。',
    findings: [['基础阅读', '先完成概念概览。'], ['专题阅读', '按主题查找对应章节。']],
    next: '为每一组材料补充建议阅读顺序。', files: ['阅读计划.md', '材料目录.md']
  },
  {
    id: 'retro', name: '迭代复盘', state: 'ready', time: '周二 17:42', result: '迭代复盘纪要',
    sampleUsage: { input: 4780, output: 880, cached: 2048 },
    request: '归纳上一次迭代的交付内容和遗留问题。',
    summary: '以交付结论、遗留问题和后续行动三个部分记录本轮迭代。',
    findings: [['交付内容', '更新任务工作区和记录入口。'], ['遗留问题', '评估窄窗口下的面板切换。']],
    next: '明确后续行动的负责人和确认时间。', files: ['迭代记录.md']
  },
  {
    id: 'first-run', name: '首次启动体验走查', state: 'ready', time: '上周', archived: true, archivedAt: archiveSampleDate(3),
    result: '首次启动走查记录', request: '走查从安装到发送第一条请求的过程。',
    summary: '首次启动可直接创建任务。发送请求前，模型设置会提示尚未连接的渠道。',
    findings: [['首次配置', '建议在连接失败时保留已填写的服务地址。']],
    next: '把连接失败的提示加入下轮走查。', files: ['首次启动测试记录.md']
  },
  {
    id: 'support', name: '试用反馈整理', state: 'ready', time: '上周', archived: true, archivedAt: archiveSampleDate(7),
    result: '试用反馈清单', request: '按使用场景整理本轮试用反馈。',
    summary: '本轮反馈集中在任务切换和导出内容。',
    findings: [['导出内容', '用户希望在导出前预览文件名。']],
    next: '在下一次试用中验证导出流程。', files: ['试用反馈.md']
  }
]

const query = new URLSearchParams(location.search)
const state = { taskId: tasks[0].id, view: query.get('view') === 'flow' ? 'flow' : 'result', assistant: 'chat', pane: 'result', filter: '', statusFilter: 'all', drafts: new Map(), reading: new Map() }
const root = document.querySelector('#root')
const sidePanes = setupSidePanes(root)
const dialog = document.querySelector('#dialog')
let dialogTrigger
let readingKey
let pinOrder = 0
const current = () => tasks.find(task => task.id === state.taskId)
const settings = setupSettings(document.querySelector('#prototype-settings'), {
  icon, escape, current,
  archivedTasks: () => tasks.filter(task => task.archived).sort((a, b) => b.archivedAt - a.archivedAt),
  restoreTask: id => arrangeTask('restore-task', id, { source: 'settings' })
})
const executionFlow = setupExecutionFlow(root, { icon, escape, onUsage(task, usage) {
  const stats = root.querySelector('.p-agent-usage')
  const html = agentUsage(task, usage)
  if (stats.innerHTML !== html) stats.innerHTML = html
} })
function visibleTasks() {
  const name = state.filter.trim().toLocaleLowerCase()
  const filter = state.statusFilter
  const items = tasks.filter(task => task.name.toLocaleLowerCase().includes(name) &&
    (filter === 'archived' ? task.archived : !task.archived && (filter === 'all' || task.state === filter)))
  return filter === 'archived' ? items : items.sort((a, b) => (b.pinOrder ?? 0) - (a.pinOrder ?? 0))
}
const draft = () => state.drafts.get(state.taskId) ?? ''
const published = task => task.state === 'review' ? task.previous : task
const version = task => task.previous && task.state !== 'review' ? 2 : 1
const tabs = { result: ['内容', 'doc'], files: ['材料', 'file'], records: ['记录', 'clock'], flow: ['执行流程', 'flow'] }
const status = task => {
  const phase = task.archived ? 'archived' : task.state
  return `<span class="p-status" data-state="${phase}"><i></i>${states[phase]}</span>`
}
const taskMeta = task => `${status(task)}<span>${task.time}</span>`
const button = (label, symbol, action, css = '', attrs = '') => `<button type="button" class="${css}" data-action="${action}" ${attrs}>${icon(symbol)}<span>${label}</span></button>`

function taskItems() {
  const items = visibleTasks()
  if (!items.length && !state.filter.trim() && state.statusFilter === 'archived') return '<p class="p-no-results">暂无已归档任务</p>'
  if (!items.length && !state.filter.trim() && state.statusFilter === 'all') return '<p class="p-no-results">暂无任务</p>'
  if (!items.length) return '<p class="p-no-results">没有匹配的任务</p><button class="p-quiet-button p-reset" data-action="reset-filter">清除筛选</button>'
  return items.map(task => {
    const name = escape(task.name)
    const tools = task.archived
      ? button('恢复', 'restore', `restore-task:${task.id}`, 'p-icon p-task-tool', `aria-label="恢复「${name}」" title="恢复任务"`)
      : button('置顶', 'pin', `pin:${task.id}`, 'p-icon p-task-tool', `aria-label="置顶「${name}」" aria-pressed="${Boolean(task.pinOrder)}" title="${task.pinOrder ? '取消置顶' : '置顶任务'}"`) +
        button('归档', 'archive', `archive:${task.id}`, 'p-icon p-task-tool', `aria-label="归档「${name}」" title="归档任务"`)
    return `<div class="p-task-row" data-archived="${Boolean(task.archived)}"><button type="button" class="p-task" data-action="task:${task.id}" aria-pressed="${task.id === state.taskId}" title="${name}">
      ${icon('doc')}<span class="p-task-copy"><strong>${name}</strong><span class="p-task-subline">${taskMeta(task)}</span></span>
      </button><div class="p-task-tools">${tools}</div></div>`
  }).join('')
}

function taskSearch() {
  return `<label class="p-search">${icon('search')}<input type="search" placeholder="筛选任务" aria-label="筛选任务" value="${escape(state.filter)}"></label>`
}

function taskList() {
  return `<aside class="p-pane p-sidebar" id="tasks-pane" aria-label="任务列表"><div class="p-side-head"><h2>任务</h2>${button('新建任务', 'plus', 'create', 'p-new-task')}</div>
    ${taskSearch()}<nav class="p-task-filters" aria-label="任务状态筛选">${Object.entries(filters).map(([id, label]) => `<button data-action="filter:${id}" aria-pressed="${state.statusFilter === id}">${label}</button>`).join('')}</nav>
    <div class="p-task-items">${taskItems()}</div>
    <div class="p-sidebar-foot">${button('设置', 'settings', 'settings', 'p-quiet-button')}</div></aside>`
}

function viewTabs(task) {
  return `<nav class="p-tabs" aria-label="任务详情">${Object.entries(tabs).map(([id, [label, glyph]]) => button(label + (id === 'files' ? ` <small>${task.files.length}</small>` : ''), glyph, `view:${id}`, '', `aria-current="${state.view === id}"`)).join('')}</nav>`
}

function taskHeading(task) {
  return `<header class="p-task-head"><div><h1>${escape(task.name)}</h1><div class="p-task-meta">${taskMeta(task)}</div></div>
    ${task.result ? button('导出内容', 'download', 'export', 'p-export', 'aria-label="导出内容" title="导出内容"') : ''}</header>`
}

function records(task) {
  if (!task.request) return []
  const entries = [{ label: '已发送请求', detail: task.request, mark: 'send' }]
  if (task.files.length) entries.push({ label: '已读取材料', detail: `已读取 ${task.files.length} 份任务材料。`, mark: 'file' })
  if (task.result) entries.push({ label: task.previous ? '已提交内容更新' : task.state === 'running' ? '正在整理内容' : '已生成任务内容', detail: task.result, mark: 'doc' })
  if (version(task) === 2) entries.push({ label: '已确认内容更新', detail: `${task.result} · 版本 2`, mark: 'check' })
  if (task.messages?.length) entries.push({ label: '原型已收到补充请求', detail: task.messages.at(-1), mark: 'chat' })
  return entries
}

function viewBody(task) {
  if (state.view === 'flow') return executionFlow.render(task)
  if (state.view === 'files') return `<div class="p-view-body"><h2>任务材料</h2>${task.files.length ? task.files.map((name, index) => `<button class="p-detail-row" data-action="file:${index}">${icon('doc')}<span>${name}</span>${icon('right')}</button>`).join('') : '<p class="p-empty-text">这项任务还没有材料。</p>'}</div>`
  if (state.view === 'records') return `<div class="p-view-body"><h2>任务记录</h2>${records(task).map((entry, index) => `<button class="p-detail-row" data-action="event:${index}">${icon(entry.mark)}<span>${entry.label}</span>${icon('right')}</button>`).join('') || '<p class="p-empty-text">发送请求后，执行记录会显示在这里。</p>'}</div>`
  if (!task.result) return '<div class="p-view-body p-empty-view"><h2>暂无内容</h2><p>在 Agent 对话中发送请求，生成的内容会显示在这里。</p><button class="p-quiet-button" data-action="focus-agent">打开 Agent 对话</button></div>'
  const findingsTitle = task.id === 'interviews' ? '共性问题' : '要点'
  const content = published(task)
  return `<article class="p-view-body p-document"><header id="doc-overview" tabindex="-1"><div class="p-doc-title"><h2>${task.result}</h2><span>${task.state === 'running' ? '草稿' : `版本 ${version(task)}`}</span></div>
    <nav class="p-outline" aria-label="内容目录"><a href="#doc-overview">概览</a><a href="#doc-findings">${findingsTitle}</a><a href="#doc-next">下一步</a></nav></header>
    <p class="p-intro">${content.summary}</p>
    <h3 id="doc-findings" tabindex="-1">${findingsTitle}</h3>
    <dl class="p-findings">${task.findings.map(([name, detail]) => `<div><dt>${name}</dt><dd>${detail}</dd></div>`).join('')}</dl>
    <h3 id="doc-next" tabindex="-1">下一步</h3><p class="p-next">${content.next}</p></article>`
}

function review(task) {
  if (task.state !== 'review') return ''
  return `<div class="p-review"><div class="p-review-copy">${icon('doc')}<div><strong>内容更新待确认</strong><span>版本 2 · 概览、下一步</span></div></div><button data-action="review">对照变更</button></div>`
}

function reviewContent(task) {
  const changes = [['概览', 'summary'], ['下一步', 'next']]
  return `<div class="p-version-pair"><span>${task.result}</span><span>版本 1 → 版本 2</span></div>
    ${changes.map(([label, key]) => `<section class="p-diff"><h3>${label}</h3><div class="p-diff-body"><div><strong>当前版本</strong><p>${task.previous[key]}</p></div><div><strong>待确认版本</strong><p>${task[key]}</p></div></div></section>`).join('')}
    <div class="p-dialog-actions"><button data-action="close">稍后处理</button><button class="primary" data-action="approve">确认更新</button></div>`
}

function message(author, text, glyph) {
  return `<div class="p-message"><div class="p-message-author"><span>${icon(glyph)}</span><strong>${author}</strong></div><p>${escape(text)}</p></div>`
}

function agentFeed(task) {
  if (state.assistant === 'runs') return `<div class="p-run-list"><button type="button" class="p-run-item pf-agent-link" data-action="view:flow">${icon('flow')}<span><b>查看执行流程</b></span>${icon('right')}</button>${records(task).map((entry, index) => `<button class="p-run-item" data-action="event:${index}">${icon(entry.mark)}<span><b>${entry.label}</b><small>${escape(entry.detail)}</small></span>${icon('right')}</button>`).join('') || '<p class="p-empty-text">暂无执行记录。</p>'}</div>`
  return `<div class="p-messages">${task.request ? message('你', task.request, 'chat') : '<p class="p-empty-text">发送你的第一个请求。</p>'}
    ${task.result ? message('Agent', task.state === 'review' ? '三份访谈的反馈集中在工作位置、执行状态和确认入口。我已把建议整理到版本 2。' : task.state === 'running' ? '已整理安装与启动检查，正在补充数据恢复步骤。' : `《${task.result}》可在内容页查看。`, 'split') : ''}
    ${task.received ? message('Agent', '已收到请求。原型不会调用模型。', 'split') : ''}
    ${(task.messages ?? []).map(text => message('你', text, 'chat') + message('Agent', '已收到请求。原型不会调用模型。', 'split')).join('')}</div>`
}

function composer(task) {
  const shortcut = /Mac/.test(navigator.platform) ? '⌘ ↵' : 'Ctrl + Enter'
  return `<form class="p-composer" data-form="send"><textarea aria-label="给 Agent 的请求" name="request" rows="2" placeholder="给 Agent 的请求…" required>
${escape(draft())}</textarea>
    <div class="p-composer-foot"><dl class="p-agent-usage" aria-label="模型用量">${agentUsage(task, executionFlow.usage(task))}</dl>
    <div><kbd>${shortcut}</kbd><button type="submit" class="primary p-icon" aria-label="发送请求" title="发送请求（${shortcut}）" ${draft().trim() ? '' : 'disabled'}>${icon('send')}</button></div></div></form>`
}

const tokens = new Intl.NumberFormat('zh-CN')
const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 })

function agentUsage(task, demo) {
  const usage = demo === undefined ? task.sampleUsage : demo
  const total = usage ? tokens.format(usage.input + usage.output) : '—'
  const ratio = usage?.input > 0 && usage.cached != null ? percent.format(usage.cached / usage.input) : '—'
  const totalDetail = usage ? `输入 ${tokens.format(usage.input)} · 输出 ${tokens.format(usage.output)}` : '暂无用量数据'
  const ratioDetail = ratio === '—' ? '暂无缓存比例' : `命中 ${tokens.format(usage.cached)} / ${tokens.format(usage.input)} 个输入 Token`
  return `<div><dt><span class="p-sr-only">本轮 </span>Token</dt><dd title="${totalDetail}">${total}</dd></div><div><dt>缓存<span class="p-sr-only">命中率</span></dt><dd title="${ratioDetail}">${ratio}</dd></div>`
}

function agentPanel(task) {
  const activity = task.state === 'review' ? '等待确认内容更新' : task.state === 'running' ? '正在整理发布检查清单' : task.result ? '本轮执行已结束' : task.request ? '已收到模拟请求' : '尚未发送请求'
  return `<section class="p-pane p-assistant" id="agent-pane" aria-label="Agent"><header class="p-agent-head"><h2>Agent</h2>
    <nav class="p-ag-tabs" aria-label="Agent 视图"><button data-action="assistant:chat" aria-current="${state.assistant === 'chat'}">对话</button><button data-action="assistant:runs" aria-current="${state.assistant === 'runs'}">执行记录</button></nav></header>
    <div class="p-agent-activity" data-state="${task.state}">${icon(task.state === 'ready' && task.result ? 'check' : 'clock')}<span>${activity}</span>
    ${task.state === 'review' ? '<button data-action="review" class="p-quiet-button">对照变更</button>' : ''}</div>
    <div class="p-feed p-scroll" aria-live="polite">${agentFeed(task)}</div>${composer(task)}</section>`
}

function contentPane(task) {
  return `<main class="p-pane p-main p-result" id="workbench">${taskHeading(task)}${viewTabs(task)}${state.view === 'result' ? review(task) : ''}<div class="p-scroll p-reading">${viewBody(task)}</div></main>`
}

function render() {
  const focusedAction = root.contains(document.activeElement) ? document.activeElement.dataset.action : null
  const previousReading = root.querySelector('.p-reading')
  if (readingKey && previousReading?.getClientRects().length) state.reading.set(readingKey, previousReading.scrollTop)
  const task = current()
  const mobileNav = `<nav class="p-mobile-nav" aria-label="工作区视图">${button('任务', 'list', 'mobile:tasks', '', `aria-current="${state.pane === 'tasks'}"`)}${button('内容', 'doc', 'mobile:result', '', `aria-current="${state.pane === 'result'}"`)}${button('Agent', 'chat', 'mobile:agent', '', `aria-current="${state.pane === 'agent'}"`)}</nav>`
  root.innerHTML = `<div class="p-shell app-frame" data-active-pane="${state.pane}">
    <header class="p-titlebar"><div class="p-top-tools"><b class="p-brand">Pliuna</b>
    ${button('任务', 'list', 'toggle-pane:tasks', 'p-toggle-pane', 'aria-controls="tasks-pane"')}</div>
    <div class="p-top-tools"><span class="p-preview-label">演示数据</span>${button('设置', 'settings', 'settings', 'p-quiet-button p-top-settings')}${button('Agent', 'split', 'toggle-pane:agent', 'p-toggle-pane', 'aria-controls="agent-pane"')}</div></header>
    <div class="p-workspace">${paneSlot('tasks', taskList())}${contentPane(task)}${paneSlot('agent', agentPanel(task))}</div>
    ${mobileNav}
  </div>`
  sidePanes.refresh()
  executionFlow.show(task)
  readingKey = `${task.id}:${state.view}`
  root.querySelector('.p-reading').scrollTop = state.reading.get(readingKey) ?? 0
  if (focusedAction) [...root.querySelectorAll('[data-action]')].find(node => node.dataset.action === focusedAction && node.getClientRects().length)?.focus({ preventScroll: true })
}

function selectTask(id) {
  state.taskId = id
  state.view = 'result'
  state.assistant = 'chat'
  state.pane = 'result'
  render()
}

function arrangeTask(action, id, { source = 'sidebar' } = {}) {
  const task = tasks.find(item => item.id === id)
  if (!task || (action === 'restore-task') !== Boolean(task.archived)) return
  const index = visibleTasks().indexOf(task)
  let text
  if (action === 'pin') {
    task.pinOrder = task.pinOrder ? 0 : ++pinOrder
    text = task.pinOrder ? '已置顶' : '已取消置顶'
  } else {
    task.archived = action === 'archive'
    task.archivedAt = task.archived ? Date.now() : null
    text = task.archived ? '已归档' : '已恢复'
  }
  const list = root.querySelector('.p-task-items')
  list.innerHTML = taskItems()
  if (task.id === state.taskId) root.querySelector('.p-task-meta').innerHTML = taskMeta(task)
  if (source === 'settings') return task
  if (action === 'pin') list.querySelector(`[data-action="pin:${id}"]`)?.focus()
  else (list.querySelectorAll('.p-task')[Math.min(index, visibleTasks().length - 1)] ?? root.querySelector('.p-task-filters [aria-pressed="true"]'))?.focus()
  document.querySelector('#feedback').textContent = `${text}「${task.name}」`
}

function openDialog(title, content, kind = '') {
  dialogTrigger = document.activeElement
  dialog.dataset.kind = kind
  dialog.innerHTML = `<header><h2 id="dialog-title">${title}</h2>${button('关闭', 'close', 'close', 'p-icon')}</header><div class="p-dialog-content">${content}</div>`
  dialog.showModal()
}

function download(task) {
  const content = published(task)
  const markdown = `# ${task.result}\n\n${content.summary}\n\n${task.findings.map(([title, detail]) => `- **${title}**：${detail}`).join('\n')}\n\n## 下一步\n\n${content.next}\n`
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${task.result}.md`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

document.addEventListener('click', event => {
  const sectionLink = event.target.closest('.p-outline a')
  if (sectionLink) {
    const section = root.querySelector(sectionLink.hash)
    if (section) {
      event.preventDefault()
      section.scrollIntoView({ block: 'start' })
      section.focus({ preventScroll: true })
    }
    return
  }
  const target = event.target.closest('button[data-action]')
  if (!target) return
  const [action, value] = target.dataset.action.split(':')
  const task = current()
  if (action === 'task') selectTask(value)
  if (action === 'pin' || action === 'archive' || action === 'restore-task') arrangeTask(action, value)
  if (action === 'filter') { state.statusFilter = value; render() }
  if (action === 'reset-filter') {
    state.filter = ''
    if (state.statusFilter !== 'archived') state.statusFilter = 'all'
    render()
    root.querySelector('input[type="search"]').focus()
  }
  if (action === 'view') {
    state.view = value
    state.pane = 'result'
    render()
    if (target.matches('.pf-agent-link')) root.querySelector('.p-tabs [data-action="view:flow"]').focus({ preventScroll: true })
  }
  if (action === 'assistant') { state.assistant = value; render() }
  if (action === 'toggle-pane') sidePanes.toggle(value)
  if (action === 'mobile' || action === 'focus-agent') {
    state.pane = value ?? 'agent'
    if (state.pane === 'agent') sidePanes.show('agent')
    if (action === 'focus-agent') state.assistant = 'chat'
    render()
    if (action === 'focus-agent') root.querySelector('.p-composer textarea')?.focus()
  }
  if (action === 'settings') settings.open()
  if (action === 'create') openDialog('新建任务', '<form class="p-create-form" data-form="create"><label>任务名称<input name="title" required maxlength="80" autofocus></label><div class="p-dialog-actions"><button type="button" data-action="close">取消</button><button class="primary" type="submit">创建任务</button></div></form>')
  if (action === 'close' && dialog.open) dialog.close()
  if (action === 'export') download(task)
  if (action === 'file') openDialog(task.files[Number(value)], `<p>来自任务「${escape(task.name)}」。</p><p>${task.findings[Number(value)]?.[1] ?? task.summary}</p>`)
  if (action === 'event') { const entry = records(task)[Number(value)]; if (entry) openDialog(entry.label, `<p>${escape(entry.detail)}</p>`) }
  if (action === 'review') openDialog('内容变更', reviewContent(task), 'review')
  if (action === 'approve') {
    task.state = 'ready'
    task.time = '刚刚'
    dialog.close()
    state.view = 'result'
    state.pane = 'result'
    render()
    root.querySelector('#doc-overview').focus({ preventScroll: true })
    root.querySelector('.p-reading').scrollTop = 0
    document.querySelector('#feedback').textContent = '已确认更新，当前显示版本 2。'
  }
})

root.addEventListener('input', event => {
  const field = event.target
  if (field.matches('input[type="search"]')) {
    state.filter = field.value
    root.querySelector('.p-task-items').innerHTML = taskItems()
  }
  if (field.matches('.p-composer textarea')) {
    state.drafts.set(state.taskId, field.value)
    field.form.querySelector('button[type="submit"]').disabled = !field.value.trim()
  }
})

document.addEventListener('submit', event => {
  const form = event.target
  if (!form.matches('[data-form]')) return
  event.preventDefault()
  const values = new FormData(form)
  if (form.dataset.form === 'create') {
    const name = values.get('title').trim()
    if (!name) return
    const id = `new-${tasks.length}`
    tasks.unshift({ id, name, state: 'ready', time: '刚刚', files: [] })
    state.filter = ''
    state.statusFilter = 'all'
    dialog.close()
    selectTask(id)
  } else {
    const request = values.get('request').trim()
    if (!request) return
    const task = current()
    if (!task.request) { task.request = request; task.messages = []; task.received = true }
    else { task.messages ??= []; task.messages.push(request) }
    state.drafts.delete(task.id)
    state.assistant = 'chat'
    render()
    const feed = root.querySelector('.p-feed')
    feed.scrollTop = feed.scrollHeight
    root.querySelector('.p-composer textarea').focus({ preventScroll: true })
  }
})

document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.isComposing || !event.target.matches('.p-composer textarea')) return
  event.preventDefault()
  if (event.target.value.trim()) event.target.form.requestSubmit()
})

dialog.addEventListener('close', () => dialogTrigger?.focus({ preventScroll: true }))
render()
if (query.has('settings')) settings.open(query.get('settings'))
document.documentElement.dataset.ready = 'true'

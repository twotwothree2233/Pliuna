const sections = {
  appearance: ['外观', 'split'], models: ['模型服务', 'chat'], approval: ['权限与审批', 'check'],
  plugins: ['插件与主流程', 'list'], archive: ['归档', 'archive'], storage: ['存储与恢复', 'file']
}
const themes = { graphite: '石墨', paper: '暖纸', midnight: '深夜', dusk: '暮色', moss: '苔原', blueprint: '蓝图' }
const sizes = [90, 100, 110, 125, 140]
const key = 'pliuna-prototype-appearance'
const getAppearance = () => {
  try { return JSON.parse(localStorage.getItem(key)) ?? {} } catch { return {} }
}
const validTheme = value => value === 'system' || Object.hasOwn(themes, value)

export function setupSettings(dialog, { icon, escape, current, archivedTasks, restoreTask }) {
  const system = matchMedia('(prefers-color-scheme: dark)')
  const archiveDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' })
  const stored = getAppearance()
  const queryTheme = new URLSearchParams(location.search).get('theme')
  const appearance = { theme: validTheme(queryTheme) ? queryTheme : validTheme(stored.theme) ? stored.theme : 'graphite', size: sizes.includes(stored.size) ? stored.size : 100 }
  const channels = [{ id: 'sample', name: '本地示例渠道', endpoint: 'http://127.0.0.1:11434/v1' }]
  const enabledTasks = new Set()
  const workflows = new Set()
  const approval = { saved: 'manual', mode: 'manual', model: '', consent: false }
  let page = 'appearance', returnFocus, editor, recoveryPoint, confirming = false
  const selected = (a, b) => a === b ? ' selected' : ''
  const checked = value => value ? ' checked' : ''

  dialog.innerHTML = `<header class="ps-toolbar"><h1 id="ps-title">设置</h1><button class="ps-return" type="button" data-setting="close">返回工作台 <kbd>Esc</kbd></button></header>
    <div class="ps-layout"><nav class="ps-nav" aria-label="设置分类">${Object.entries(sections).map(([id, [label, glyph]]) => `<button type="button" data-section="${id}">${icon(glyph)}<span>${label}</span></button>`).join('')}</nav>
    <div class="ps-scroll"><section class="ps-content" aria-labelledby="ps-heading"></section></div></div>`
  const content = dialog.querySelector('.ps-content')
  const scroll = dialog.querySelector('.ps-scroll')
  const header = (description, action = '') => `<header class="ps-heading"><div><h2 id="ps-heading" tabindex="-1">${sections[page][0]}</h2><p>${description}</p></div>${action}</header>`
  const status = '<p class="ps-status" role="status"></p>'
  const action = (label, name, primary = false) => `<button type="button" ${primary ? 'class="primary" ' : ''}data-setting="${name}">${label}</button>`
  const note = text => `<p class="ps-note">${text}</p>`
  const row = (title, detail, control) => `<div class="ps-row"><div><h4>${title}</h4><p>${detail}</p></div>${control}</div>`

  function resolveTheme() { return appearance.theme === 'system' ? (system.matches ? 'dusk' : 'graphite') : appearance.theme }

  function applyAppearance(save = false) {
    const theme = resolveTheme()
    document.documentElement.dataset.theme = theme
    document.documentElement.style.setProperty('--text-scale', appearance.size / 100)
    for (const tile of content.querySelectorAll('[data-theme-choice]')) tile.setAttribute('aria-pressed', tile.dataset.themeChoice === theme)
    if (save) {
      try { localStorage.setItem(key, JSON.stringify(appearance)) } catch { /* keep the current preview */ }
      const url = new URL(location.href)
      if (url.searchParams.has('theme')) { url.searchParams.delete('theme'); history.replaceState(null, '', url) }
    }
  }

  function appearancePage() {
    return `${header('调整工作台的配色和阅读字号。')}
      <section class="ps-group"><div class="ps-group-head"><h3>主题</h3>
        <label class="ps-check"><input type="checkbox" name="follow-theme"${checked(appearance.theme === 'system')}>跟随系统</label></div>
        <div class="ps-themes" role="group" aria-label="选择主题">${Object.entries(themes).map(([id, label]) => `<button type="button" class="ps-theme" data-theme-choice="${id}" aria-pressed="${resolveTheme() === id}">
          <span class="ps-mini" aria-hidden="true"><i></i><span><b></b><i></i><i></i></span><i></i></span>
          <span class="ps-theme-label">${label}${icon('check')}</span></button>`).join('')}</div>
      </section>
      <section class="ps-group"><h3>文字大小</h3><p>应用到正文和 Agent 对话，选择后立即生效。</p>
        <fieldset class="ps-sizes"><legend class="p-sr-only">文字大小</legend>${sizes.map(size => `<label><input type="radio" name="reading-size" value="${size}"${checked(size === appearance.size)}><span>${size}%</span></label>`).join('')}</fieldset>
        <div class="ps-sample"><strong>产品访谈纪要</strong><p>切回任务时，继续阅读上次查看的章节。</p></div>
      </section>`
  }

  function modelsPage() {
    const list = channels.map(channel => `<article class="ps-channel"><div class="ps-row"><div><h4>${escape(channel.name)}</h4><p class="ps-endpoint">${escape(channel.endpoint)}</p></div><div class="ps-actions">${action('模拟测试', `test:${channel.id}`)}${action('编辑渠道', `edit:${channel.id}`)}</div></div>
      ${channel.id === 'sample' ? '<div class="ps-model"><span>示例模型</span><small>主模型</small></div>' : '<div class="ps-model">未配置模型</div>'}</article>`).join('')
    const form = editor ? `<form class="ps-form" data-settings-form="channel"><h3 tabindex="-1" id="ps-editor-heading">${editor.id ? '编辑渠道' : '添加渠道'}</h3>
      <label>渠道名称<input name="channel-name" required maxlength="60" value="${escape(editor.name)}"></label>
      <label>API 地址<input name="channel-endpoint" type="url" required maxlength="300" value="${escape(editor.endpoint)}"></label>
      <label>API Key<input disabled value="原型不接收密钥"></label>
      <div class="ps-actions">${action('取消', 'cancel-edit')}<button type="submit" class="primary">保存渠道</button></div></form>` : ''
    return `${header('按渠道管理连接，同一渠道的模型共用连接配置。', action('添加渠道', 'add', true))}
      ${note('演示数据。渠道暂存在此页面，测试不会发送网络请求。')}${form}
      <section class="ps-group"><h3>模型渠道</h3><div class="ps-channels">${list}</div>${status}</section>`
  }

  function approvalPage() {
    const assist = approval.mode === 'assisted'
    return `${header('设置额外权限请求的处理方式。')}${note('演示设置。保存后不会改变 Agent 的实际权限。')}
      <section class="ps-group"><h3>审批方式</h3><p>当前：${approval.saved === 'manual' ? '手动审批' : '独立辅助审批'}</p>
      <form class="ps-approval" data-settings-form="approval"><fieldset><legend class="p-sr-only">选择审批方式</legend>
        <label class="ps-option"><input type="radio" name="approval-mode" value="manual"${checked(!assist)}><span><strong>手动审批</strong><small>每项权限请求都由你确认。</small></span></label>
        <label class="ps-option"><input type="radio" name="approval-mode" value="assisted"${checked(assist)}><span><strong>独立辅助审批</strong><small>由单独的模型判断操作权限。删除和授予信任仍需你确认。</small></span></label>
        </fieldset>
        <div class="ps-approval-extra"${assist ? '' : ' hidden'}><label>审批模型<select name="approval-model"><option value="">选择审批模型</option><option value="sample"${selected(approval.model, 'sample')}>示例审批模型</option></select></label>
        <label class="ps-check"><input type="checkbox" name="approval-consent"${checked(approval.consent)}>我了解正式使用时，必要的任务信息会发送给所选服务。</label></div>
        <button type="submit" class="primary"${assist && (!approval.model || !approval.consent) ? ' disabled' : ''}>保存审批方式</button></form>${status}</section>`
  }

  function pluginsPage() {
    const task = current()
    const enabled = enabledTasks.has(task.id)
    return `${header('按任务管理插件启用状态。')}
      <section class="ps-group"><h3>当前任务</h3><p class="ps-task-name">${escape(task.name)}</p>
      <div class="ps-channels"><article class="ps-channel">${row('访谈纪要模板', `示例插件 · 仅提供内容模板 · ${enabled ? '已启用' : '未启用'}`, action(enabled ? '停用插件' : '启用插件', 'plugin'))}</article></div>
      ${status}</section>
      <section class="ps-group"><h3>主流程</h3>${row('任务默认流程', enabled ? '控制当前任务使用的演示流程。' : '启用示例插件后可选择流程。',
        `<select name="workflow" aria-label="任务默认流程"${enabled ? '' : ' disabled'}><option value="default">使用默认流程</option><option value="sample"${selected(workflows.has(task.id), true)}>访谈纪要模板</option></select>`)}</section>`
  }

  function archivePage() {
    return `${header('恢复任务后，它会重新出现在工作台任务列表中。')}
      <section class="ps-group" aria-labelledby="ps-archive-heading">
        <div class="ps-group-head"><div class="ps-archive-heading"><h3 id="ps-archive-heading" tabindex="-1">已归档任务</h3><span class="ps-archive-count"></span></div>
          <label class="p-search ps-archive-search">${icon('search')}<input name="archive-search" type="search" aria-label="搜索归档任务" placeholder="按任务名称搜索"></label></div>
        <div class="ps-archive-results"></div>${status}
      </section>`
  }

  function renderArchive() {
    const archived = archivedTasks()
    const search = content.querySelector('[name="archive-search"]')
    search.parentElement.hidden = !archived.length
    const query = search.value.trim().toLocaleLowerCase()
    const results = archived.filter(task => task.name.toLocaleLowerCase().includes(query))
    content.querySelector('.ps-archive-count').textContent = query && results.length !== archived.length
      ? `${results.length} / ${archived.length} 项` : `${archived.length} 项`
    content.querySelector('.ps-archive-results').innerHTML = results.length
      ? `<ul class="ps-archive-list" aria-label="归档任务">${results.map(task => {
        const name = escape(task.name)
        const date = new Date(task.archivedAt)
        return `<li class="ps-row ps-archive-row"><div class="ps-archive-item">${icon('doc')}<div><strong>${name}</strong>
          <p>归档于 <time datetime="${date.toISOString()}">${archiveDate.format(date)}</time></p></div></div>
          <button type="button" data-setting="restore-task:${task.id}" aria-label="恢复任务：${name}">${icon('restore')}恢复任务</button></li>`
      }).join('')}</ul>`
      : archived.length
        ? `<div class="ps-archive-empty"><strong>未找到匹配的任务</strong>${action('清除搜索', 'clear-archive-search')}</div>`
        : '<div class="ps-archive-empty"><strong>暂无已归档任务</strong><p>在工作台归档的任务会出现在这里。</p></div>'
  }

  function storagePage() {
    return `${header('管理本地任务数据和恢复点。')}${note('以下操作仅演示流程，不读写真实任务或文件。')}
      <section class="ps-group"><h3>本地数据</h3><p>工作台的数据保存在这台设备。</p>
      <details class="ps-data"><summary>查看数据范围</summary><p>包括任务、正文、材料和执行记录。连接凭据单独管理。</p></details></section>
      <section class="ps-group"><h3>恢复点</h3><p>恢复点保留已保存的数据，不包含未发送的输入。</p>
      ${row(recoveryPoint ? '最近的演示恢复点' : '尚未创建恢复点', recoveryPoint ?? '需要时可用恢复点替换工作台的数据。', action(recoveryPoint ? '更新恢复点' : '创建恢复点', 'point'))}
      ${recoveryPoint ? `<div class="ps-actions">${action('预览恢复', 'preview-recovery')}</div>` : ''}
      ${confirming ? `<div class="ps-review"><h4 tabindex="-1" id="ps-restore-heading">恢复到 ${escape(recoveryPoint)}？</h4><p>正式恢复会替换任务数据。恢复点之后新增的内容将不再显示，连接凭据会保留。</p><div class="ps-actions">${action('取消', 'cancel-recovery')}${action('模拟恢复', 'restore', true)}</div></div>` : ''}
      ${status}</section>`
  }

  const views = { appearance: appearancePage, models: modelsPage, approval: approvalPage, plugins: pluginsPage, archive: archivePage, storage: storagePage }
  function render(focus = '#ps-heading') {
    for (const tab of dialog.querySelectorAll('[data-section]')) {
      if (tab.dataset.section === page) tab.setAttribute('aria-current', 'page')
      else tab.removeAttribute('aria-current')
    }
    content.innerHTML = views[page]()
    if (page === 'archive') renderArchive()
    if (focus === '#ps-heading') scroll.scrollTop = 0
    content.querySelector(focus)?.focus({ preventScroll: true })
  }
  function report(text) { content.querySelector('.ps-status').textContent = text }

  function open(section) {
    if (dialog.open || document.querySelector('dialog[open]')) return
    if (Object.hasOwn(sections, section)) page = section
    returnFocus = document.activeElement
    render()
    dialog.showModal()
    content.querySelector('#ps-heading').focus({ preventScroll: true })
  }

  dialog.addEventListener('click', event => {
    const tab = event.target.closest('[data-section]')
    if (tab) { page = tab.dataset.section; render(); return }
    const theme = event.target.closest('[data-theme-choice]')
    if (theme) {
      appearance.theme = theme.dataset.themeChoice
      content.querySelector('[name="follow-theme"]').checked = false
      applyAppearance(true)
      return
    }
    const button = event.target.closest('[data-setting]')
    if (!button) return
    const [kind, id] = button.dataset.setting.split(':')
    if (kind === 'close') dialog.close()
    if (kind === 'restore-task') {
      const restoreButtons = () => [...content.querySelectorAll('.ps-archive-row button')]
      const index = restoreButtons().indexOf(button)
      const task = restoreTask(id)
      if (!task) return
      renderArchive()
      const remaining = restoreButtons()
      const next = remaining[Math.min(index, remaining.length - 1)]
        ?? content.querySelector('.ps-archive-search:not([hidden]) input') ?? content.querySelector('#ps-archive-heading')
      next.focus()
      report(`已恢复「${task.name}」。`)
    }
    if (kind === 'clear-archive-search') {
      const search = content.querySelector('[name="archive-search"]')
      search.value = ''
      renderArchive()
      search.focus()
      report('')
    }
    if (kind === 'add' || kind === 'edit') {
      editor = kind === 'edit' ? { ...channels.find(channel => channel.id === id) } : { name: '', endpoint: '' }
      render('#ps-editor-heading')
      content.querySelector('[name="channel-name"]').focus()
    }
    if (kind === 'cancel-edit') { const previous = editor.id; editor = null; render(previous ? `[data-setting="edit:${previous}"]` : '[data-setting="add"]') }
    if (kind === 'test') report('模拟连接测试完成，未连接服务。')
    if (kind === 'plugin') {
      const task = current().id
      const enabled = enabledTasks.has(task)
      if (enabled) { enabledTasks.delete(task); workflows.delete(task) }
      else enabledTasks.add(task)
      render('[data-setting="plugin"]')
      report(enabled ? '已停用示例插件。' : '已为当前任务启用示例插件。')
    }
    if (kind === 'point') {
      recoveryPoint = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date())
      confirming = false
      render('[data-setting="point"]')
      report('已创建演示恢复点。')
    }
    if (kind === 'preview-recovery') { confirming = true; render('#ps-restore-heading'); content.querySelector('#ps-restore-heading').scrollIntoView({ block: 'nearest' }) }
    if (kind === 'cancel-recovery' || kind === 'restore') {
      confirming = false
      render('[data-setting="preview-recovery"]')
      if (kind === 'restore') report('恢复流程演示完成，任务数据未改动。')
    }
  })

  dialog.addEventListener('input', ({ target: field }) => {
    if (field.name === 'archive-search') { renderArchive(); report('') }
    if (editor && field.name === 'channel-name') editor.name = field.value
    if (editor && field.name === 'channel-endpoint') { editor.endpoint = field.value; field.setCustomValidity('') }
  })
  dialog.addEventListener('change', ({ target: field }) => {
    if (field.name === 'follow-theme') { appearance.theme = field.checked ? 'system' : resolveTheme(); applyAppearance(true) }
    if (field.name === 'reading-size') { appearance.size = Number(field.value); applyAppearance(true) }
    if (field.name === 'workflow') {
      const task = current().id
      if (field.value === 'sample' && enabledTasks.has(task)) workflows.add(task)
      else workflows.delete(task)
      report('已更新当前任务的演示流程。')
    }
    if (field.name === 'approval-mode') approval.mode = field.value
    if (field.name === 'approval-model') { approval.model = field.value; approval.consent = false; content.querySelector('[name="approval-consent"]').checked = false }
    if (field.name === 'approval-consent') approval.consent = field.checked
    if (field.name.startsWith('approval-')) {
      const assist = approval.mode === 'assisted'
      content.querySelector('.ps-approval-extra').hidden = !assist
      content.querySelector('.ps-approval button[type="submit"]').disabled = assist && (!approval.model || !approval.consent)
    }
  })
  dialog.addEventListener('submit', event => {
    event.preventDefault()
    if (event.target.dataset.settingsForm === 'approval') {
      if (approval.mode === 'assisted' && (!approval.model || !approval.consent)) return
      approval.saved = approval.mode
      render('.ps-approval button[type="submit"]')
      report('已保存演示审批方式。')
    }
    if (event.target.dataset.settingsForm === 'channel') {
      const name = event.target.elements['channel-name']
      const endpoint = event.target.elements['channel-endpoint']
      if (!name.value.trim()) { name.value = ''; name.reportValidity(); return }
      if (!/^https?:\/\//i.test(endpoint.value)) { endpoint.setCustomValidity('请输入以 http:// 或 https:// 开头的地址。'); endpoint.reportValidity(); return }
      const existing = channels.find(channel => channel.id === editor.id)
      const channel = { id: existing?.id ?? `channel-${channels.length}`, name: name.value.trim(), endpoint: endpoint.value }
      if (existing) Object.assign(existing, channel)
      else channels.push(channel)
      editor = null
      render(`[data-setting="edit:${channel.id}"]`)
      report('渠道已保存在原型中。')
    }
  })
  dialog.addEventListener('close', () => returnFocus?.focus({ preventScroll: true }))
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === ',' && !event.isComposing && (dialog.open || !document.querySelector('dialog[open]'))) {
      event.preventDefault()
      if (dialog.open) dialog.close()
      else open()
    }
  })
  system.addEventListener('change', () => { if (appearance.theme === 'system') applyAppearance() })
  applyAppearance()
  return { open }
}

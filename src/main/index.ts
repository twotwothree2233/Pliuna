import { app, BrowserWindow, ipcMain, Menu, dialog, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HostResponse } from '../shared/types'
import defaults from '../shared/contracts/development-defaults.json'
import { validateIpc, assertContract } from '../shared/validation'
import { StorageInspections } from './storage-inspections'
import { MaterialSources } from './material-sources'
import { ModelDirectory } from './model-directory'
import { FileModelStore } from './file-model-store'
import { applicationDirectory, prepareApplicationDirectory } from './application-data'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { saveExport, exportTargetIdentity, reconcileExport } from './export-save'

const dataDirectory = applicationDirectory(homedir(), process.env.TRELLIS_TEST_DATA)
prepareApplicationDirectory(dataDirectory)
app.setPath('userData', dataDirectory)
mkdirSync(join(dataDirectory, 'browser-state'), { recursive: true, mode: 0o700 })
app.setPath('sessionData', join(dataDirectory, 'browser-state'))
app.setAppLogsPath(join(dataDirectory, 'logs'))
app.setPath('crashDumps', join(dataDirectory, 'crashes'))
app.commandLine.appendSwitch('disk-cache-dir', join(dataDirectory, 'cache', 'http'))
const directory = new ModelDirectory(dataDirectory)
const inspections = new StorageInspections(() => utilityProcess.fork(join(__dirname, 'inspection.js'), [app.getPath('userData')], { serviceName: 'Trellis Read-only Inspection', stdio: 'pipe' }))
let runtime: UtilityProcess | undefined
let closing = false
let quitReady = false
let shutdownRequest: string | undefined
let restartTimes: number[] = []
const pending = new Map<string, { resolve: (value: HostResponse) => void; timer?: ReturnType<typeof setTimeout> }>()
function runtimeRequest(request: unknown): Promise<any> {
  if (!runtime) return Promise.reject(Error('OFFLINE'))
  if (pending.size >= defaults.queues.model_pending_app) return Promise.reject(Error('BUSY'))
  return new Promise((resolve, reject) => {
    const id=randomUUID(), timer=setTimeout(()=>{pending.delete(id);reject(Error('UNKNOWN_RESULT'))},defaults.tool.execution_ms)
    pending.set(id,{timer,resolve:response=>response.ok?resolve(response.data):reject(Error(response.error.code))})
    runtime!.postMessage({id,request})
  })
}
function startRuntime(): void {
  const child = utilityProcess.fork(join(__dirname, 'runtime.js'), [app.getPath('userData'), process.execPath], { serviceName: 'Trellis Runtime', stdio: 'pipe' })
  runtime = child
  const vault = new FileModelStore(app.getPath('userData'))
  child.on('message', (message: { id: string; response: HostResponse; vault?: 'load' | 'save'; records?: import('../runtime/model/persistence').SavedConnection[]; channels?: import('../runtime/model/channels').SavedChannel[] }) => {
    if (message.vault) {
      try {
        const data = message.vault === 'load' ? vault.load() : vault.save(message.records!, message.channels)
        child.postMessage({ vault_response: message.id, ok: true, data })
      } catch (error) { const code = (error as Error).message; child.postMessage({ vault_response: message.id, ok: false, error: /^SETTINGS_[A-Z_]+$/.test(code) ? code : 'SETTINGS_WRITE_FAILED' }) }
      return
    }
    const p = pending.get(message.id); if (!p) return
    clearTimeout(p.timer); pending.delete(message.id); p.resolve(message.response)
  })
  runtime.on('exit', () => {
    runtime = undefined
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: { code: 'CONNECTION_LOST', message: 'Runtime disconnected; result may be unknown. Do not automatically resend.' } }) }
    pending.clear()
    restartTimes = restartTimes.filter(t => Date.now() - t < defaults.runtime.restart_window_ms)
    if (!closing && restartTimes.length < defaults.runtime.restart_max) { restartTimes.push(Date.now()); setTimeout(startRuntime, 1000) }
  })
}
app.whenReady().then(() => {
  startRuntime()
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : [{ label: '文件', submenu: [{ role: 'quit' as const }] }]),
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]))
  const window = new BrowserWindow({ title: 'Trellis', width: 1320, height: 860, minWidth: 390, minHeight: 600, show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 16 } } : {}),
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  const materials = new MaterialSources(runtimeRequest, async () => { const selected=await dialog.showOpenDialog(window,{title:'添加任务材料',properties:['openFile','multiSelections']});return selected.canceled?[]:selected.filePaths })
  let exportSaving = false
  ipcMain.handle('trellis:request', (event, request: unknown): Promise<HostResponse> | HostResponse => {
    if (closing) return { ok: false, error: { code: 'SHUTTING_DOWN', message: 'Host is shutting down' } }
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: { code: 'FORBIDDEN', message: 'Untrusted frame' } }
    if (Buffer.byteLength(JSON.stringify(request) ?? '') > defaults.transport.rpc_message_bytes) return { ok: false, error: { code: 'INPUT_TOO_LARGE', message: 'IPC message too large' } }
    if (typeof (request as any)?.type === 'string' && (request as any).type.startsWith('export.')) {
      const r = request as any
      if (r.type.startsWith('export.internal.')) return { ok: false, error: { code: 'FORBIDDEN', message: 'Host-only export state' } }
      if (r.type === 'export.resolve') {
        if (exportSaving || Object.keys(r).sort().join(',') !== 'acknowledge,operation_id,task_id,type' || typeof r.acknowledge !== 'boolean' || typeof r.task_id !== 'string' || typeof r.operation_id !== 'string') return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid export resolution' } }
        exportSaving = true
        return (async (): Promise<HostResponse> => {
          try {
            const job = await runtimeRequest({ type: 'export.internal.inspect', task_id: r.task_id, operation_id: r.operation_id })
            const phase = await reconcileExport(job, r.acknowledge)
            return { ok: true, data: await runtimeRequest({ type: 'export.internal.resolve', task_id: r.task_id, operation_id: r.operation_id, phase }) }
          } catch { return { ok: false, error: { code: 'EXPORT_UNRESOLVED', message: 'Unable to verify or safely clean this original export; protection remains' } } }
          finally { exportSaving = false }
        })()
      }
      if (r.type === 'export.save') {
        if (exportSaving || Object.keys(r).sort().join(',') !== 'operation_id,partial,task_id,type' || typeof r.task_id !== 'string' || typeof r.operation_id !== 'string' || typeof r.partial !== 'boolean') return { ok: false, error: { code: 'EXPORT_BUSY', message: 'Invalid or active save' } }
        exportSaving = true
        return (async (): Promise<HostResponse> => {
          try {
            const status = await runtimeRequest({ type: 'export.status', task_id: r.task_id, operation_id: r.operation_id })
            if (status.phase !== 'preview') throw Error('EXPORT_STATE_CHANGED')
            const selected = await dialog.showSaveDialog(window, { title: '保存离线学习材料', defaultPath: 'Trellis-learning.html', filters: [{ name: 'HTML', extensions: ['html'] }], properties: ['showOverwriteConfirmation'] })
            if (selected.canceled || !selected.filePath) return { ok: true, data: { cancelled: true } }
            const expected = await exportTargetIdentity(selected.filePath)
            if (expected && (await dialog.showMessageBox(window, { type: 'warning', message: '覆盖已存在的 HTML 文件？', detail: '只覆盖你刚选择的文件；失败时不会自动重试。', buttons: ['取消', '确认覆盖'], defaultId: 0, cancelId: 0 })).response !== 1) return { ok: true, data: { cancelled: true } }
            const data = await saveExport(selected.filePath, expected, {
              begin: temporary => runtimeRequest({ type: 'export.internal.begin', task_id: r.task_id, operation_id: r.operation_id, partial: r.partial, target: selected.filePath, temporary }),
              created: identity => runtimeRequest({ type: 'export.internal.created', task_id: r.task_id, operation_id: r.operation_id, identity }),
              valid: () => runtimeRequest({ type: 'export.internal.valid', task_id: r.task_id, operation_id: r.operation_id }),
              finish: (phase, reason) => runtimeRequest({ type: 'export.internal.finish', task_id: r.task_id, operation_id: r.operation_id, phase, reason })
            })
            return { ok: true, data }
          } catch { return { ok: false, error: { code: 'EXPORT_SAVE_UNRESOLVED', message: 'Query the original export result; no automatic replay' } } }
          finally { exportSaving = false }
        })()
      }
    }
    if ((request as any)?.type === 'host.directory.clear') {
      if (Object.keys(request as object).length !== 1) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unexpected directory fields' } }
      try { directory.clear(); return { ok: true, data: { cleared: true } } } catch { return { ok: false, error: { code: 'DIRECTORY_CLEAR_FAILED', message: 'Public cache clear failed' } } }
    }
    if ((request as any)?.type === 'host.directory.lookup') {
      const r = request as any
      if (Object.keys(r).sort().join(',') !== 'base_url,provider_id,refresh,type,wire_model_id' || typeof r.refresh !== 'boolean' || [r.base_url, r.provider_id, r.wire_model_id].some(x => typeof x !== 'string' || x.length > 2048)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid directory query' } }
      return directory.lookup(r.base_url, r.provider_id, r.wire_model_id, r.refresh).then(data => ({ ok: true as const, data })).catch(() => ({ ok: false as const, error: { code: 'DIRECTORY_UNAVAILABLE', message: 'Public directory unavailable; saved configuration retained' } }))
    }
    if ((request as any)?.type === 'host.cache.clear') {
      if (Object.keys(request as object).length !== 1) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unexpected cache request fields' } }
      return window.webContents.session.clearCache().then(() => ({ ok: true as const, data: { cleared: true } })).catch(() => ({ ok: false as const, error: { code: 'CACHE_CLEAR_FAILED', message: 'Cache clear failed; settings and business resources were not changed' } }))
    }
    if (typeof (request as any)?.type === 'string' && (request as any).type.startsWith('plugin.')) {
      try {
        assertContract<import('../shared/contracts.generated').HostPluginRequest>('host_plugin_request', request)
        if (request.type === 'plugin.internal.install') return { ok: false, error: { code: 'FORBIDDEN', message: 'Host-only plugin source' } }
        if (request.type === 'plugin.pick') return dialog.showOpenDialog(window, { title: '导入固定插件包', properties: ['openDirectory'] }).then(async selected => {
          if (selected.canceled || selected.filePaths.length !== 1) return { ok: true as const, data: { cancelled: true } }
          try { return { ok: true as const, data: await runtimeRequest({ type: 'plugin.internal.install', source: selected.filePaths[0] }) } }
          catch { return { ok: false as const, error: { code: 'PLUGIN_IMPORT_FAILED', message: 'Plugin was not enabled; inspect the installed list before importing again' } } }
        })
      } catch { return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid plugin request' } } }
    }
    if (typeof (request as any)?.type==='string' && (request as any).type.startsWith('material.')) {
      try {
        const r=validateIpc(request)
        if(r.type.startsWith('material.internal.'))return {ok:false,error:{code:'FORBIDDEN',message:'Host-only transfer'}}
        if(r.type==='material.pick'||r.type==='material.text')return materials.start(r).then(data=>({ok:true as const,data})).catch(error=>({ok:false as const,error:{code:/^IMPORT_[A-Z_]+$/.test(error.message)||['UNKNOWN_RESULT','CONNECTION_LOST','OFFLINE'].includes(error.message)?error.message:'IMPORT_UNAVAILABLE',message:'Material import unavailable; query original operations'}}))
      }catch{return {ok:false,error:{code:'INVALID_REQUEST',message:'Invalid material request'}}}
    }
    if (request && typeof request === 'object' && typeof (request as any).type === 'string' && (request as any).type.startsWith('storage.inspect.')) {
      try { return { ok: true, data: inspections.handle(validateIpc(request)) } }
      catch (error) { const code = (error as Error).message; return { ok: false, error: { code: /^INSPECT_[A-Z_]+$/.test(code) ? code : 'INVALID_REQUEST', message: 'Read-only inspection unavailable; data and protections were not changed' } } }
    }
    if (!runtime) return { ok: false, error: { code: 'OFFLINE', message: 'Runtime unavailable' } }
    if (pending.size >= defaults.queues.model_pending_app) return { ok: false, error: { code: 'BUSY', message: 'Too many pending requests' } }
    return new Promise(resolve => {
      const id = randomUUID()
      // Model operations own request deadlines; queueing remains cancellable without an extra cap.
      const modelOperation = ['model.test', 'model.probe', 'model.discover', 'model.channel.discover'].includes((request as any)?.type)
      const timer = modelOperation ? undefined : setTimeout(() => { pending.delete(id); resolve({ ok: false, error: { code: 'UNKNOWN_RESULT', message: 'Response timeout. Query current state before deciding whether to submit again.' } }) }, defaults.tool.execution_ms)
      pending.set(id, { resolve, timer }); runtime!.postMessage({ id, request })
    })
  })
  window.once('ready-to-show', () => window.show())
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(join(__dirname, '../renderer/index.html'))
})
// A renderer may still veto quitting to retain unsaved input or an unknown result.
app.on('will-quit', event => {
  if (quitReady) { runtime?.kill(); return }
  event.preventDefault()
  closing = true; inspections.close()
  if (!runtime) { quitReady = true; app.quit(); return }
  if (shutdownRequest) { const previous = pending.get(shutdownRequest); if (previous) clearTimeout(previous.timer); pending.delete(shutdownRequest) }
  const id = randomUUID()
  shutdownRequest = id
  const unresolved = () => { dialog.showErrorBox('清理尚未确认', '应用尚未确认所有受管理进程退出，未强制结束运行时。请保留现场，稍后再次选择退出以重试清理；不会重新执行任务。') }
  const timer = setTimeout(unresolved, defaults.cleanup.cancel_grace_ms + 1000)
  pending.set(id, { timer, resolve: response => {
    shutdownRequest = undefined
    if (response.ok && (response.data as { closed?: boolean })?.closed === true) { quitReady = true; runtime?.kill(); app.quit() }
    else unresolved()
  } }); runtime.postMessage({ id, shutdown: true })
})
app.on('window-all-closed', () => app.quit())

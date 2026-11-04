import { contextBridge, ipcRenderer } from 'electron'
import type { HostRequest } from '../shared/types'
contextBridge.exposeInMainWorld('trellis', Object.freeze({ request: (request: HostRequest) => ipcRenderer.invoke('trellis:request', request) }))

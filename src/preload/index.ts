import { contextBridge, ipcRenderer } from 'electron'
import type { HostRequest } from '../shared/types'
contextBridge.exposeInMainWorld('pliuna', Object.freeze({ platform: process.platform, request: (request: HostRequest) => ipcRenderer.invoke('pliuna:request', request) }))

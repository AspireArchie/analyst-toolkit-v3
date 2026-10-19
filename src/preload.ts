import { contextBridge, ipcRenderer } from 'electron';
import type { BecApi, NoteApi } from './contracts';

// Expose named operations only; the page cannot execute arbitrary PowerShell.
const api: BecApi = {
  importHistory: (browser) => ipcRenderer.invoke('bec:history-import', browser),
  queryHistory: (query) => ipcRenderer.invoke('bec:history-query', query),
  copyHistory: (query, mode, visitId) => ipcRenderer.invoke('bec:history-copy', { query, mode, visitId }),
  clearHistory: () => ipcRenderer.invoke('bec:history-clear'),
  openReport: (provider, indicator) => ipcRenderer.invoke('bec:open-report', { provider, indicator }),
  osint: (indicator) => ipcRenderer.invoke('bec:osint', indicator),
  keyStatus: () => ipcRenderer.invoke('bec:key-status'),
  saveKeys: (changes) => ipcRenderer.invoke('bec:save-keys', changes),
  audit: (event) => ipcRenderer.invoke('bec:audit', event),
  logInfo: () => ipcRenderer.invoke('bec:log-info'),
  state: () => ipcRenderer.invoke('bec:state'),
  install: () => ipcRenderer.invoke('bec:install'),
  connect: (tenant, mode) => ipcRenderer.invoke('bec:connect', { tenant, mode }),
  conditionalAccess: (ids) => ipcRenderer.invoke('bec:conditional-access', ids),
  exchange: (mode) => ipcRenderer.invoke('bec:exchange', mode),
  reset: () => ipcRenderer.invoke('bec:reset'),
  collect: (query) => ipcRenderer.invoke('bec:collect', query),
  collectAudits: (query) => ipcRenderer.invoke('bec:collect-audits', query),
  collectUal: (query) => ipcRenderer.invoke('bec:collect-ual', query),
  viewUal: (filters, page) => ipcRenderer.invoke('bec:view-ual', { filters, page }),
  exportUal: (format, scope, filters) => ipcRenderer.invoke('bec:export-ual', { format, scope, filters }),
  collectIdentity: (kind, query) => ipcRenderer.invoke('bec:collect-identity', { kind, query }),
  exportIdentity: (kind, format) => ipcRenderer.invoke('bec:export-identity', { kind, format }),
  reviewApp: (key, review) => ipcRenderer.invoke('bec:review-app', { key, review }),
  exportAudits: (format) => ipcRenderer.invoke('bec:export-audits', format),
  export: (format) => ipcRenderer.invoke('bec:export', format),
  onLog: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('bec:log', listener);
    return () => ipcRenderer.removeListener('bec:log', listener);
  },
};
contextBridge.exposeInMainWorld('bec', api);

const notes: NoteApi = {
  state:()=>ipcRenderer.invoke('notes:state'),
  add:()=>ipcRenderer.invoke('notes:add'),
  update:edit=>ipcRenderer.invoke('notes:update',edit),
  save:(id,revision)=>ipcRenderer.invoke('notes:save',{id,revision}),
  close:(id,revision,discard)=>ipcRenderer.invoke('notes:close',{id,revision,discard}),
  openSaved:id=>ipcRenderer.invoke('notes:open-saved',id),
  forgetSaved:id=>ipcRenderer.invoke('notes:forget-saved',id),
  popOut:id=>ipcRenderer.invoke('notes:popout',id),
  onChange:callback=>{const listener=(_event:Electron.IpcRendererEvent,state:Parameters<typeof callback>[0])=>callback(state);ipcRenderer.on('notes:changed',listener);return()=>ipcRenderer.removeListener('notes:changed',listener);},
};
contextBridge.exposeInMainWorld('notes',notes);

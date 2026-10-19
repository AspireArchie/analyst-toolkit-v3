import { contextBridge, ipcRenderer } from 'electron';
import type { NoteApi } from './contracts';
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

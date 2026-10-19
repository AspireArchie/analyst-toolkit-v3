import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NotepadStore } from './notepad-store';
import type { NoteEdit, NoteState, Reply } from './contracts';

export function registerNotepad(): void {
  const store=new NotepadStore(path.join(app.getPath('userData'),'notepad.json'));
  let popup: BrowserWindow | null=null;
  let focusId: string | undefined;
  const mainUrl=pathToFileURL(path.join(__dirname,'../ui/index.html')).href;
  const popupUrl=pathToFileURL(path.join(__dirname,'../ui/notepad.html')).href;
  const snapshot=():NoteState=>({...store.state(),detached:Boolean(popup),focusId});
  const broadcast=()=>{
    const state=snapshot();
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && [mainUrl,popupUrl].includes(window.webContents.getURL())) window.webContents.send('notes:changed',state);
  };
  // Separate from the investigation wrapper: note text must never enter transcripts.
  for (const action of ['state','add','update','save','close','open-saved','forget-saved','popout']) {
    ipcMain.handle(`notes:${action}`, (event,value):Reply<NoteState>=>{
      if (event.senderFrame!==event.sender.mainFrame || ![mainUrl,popupUrl].includes(event.senderFrame?.url??'')) return {ok:false,error:'Untrusted notepad request.'};
      try {
        if (popup && event.sender!==popup.webContents && !['state','popout'].includes(action)) throw Error('Edit notes in the pop-out window.');
        switch(action){
          case 'add':store.add();break;
          case 'update':store.update(value as NoteEdit);break;
          case 'save':store.save(value?.id,value?.revision);break;
          case 'close':store.close(value?.id,value?.revision,value?.discard);break;
          case 'open-saved':if(typeof value!=='string')throw Error('Invalid note.');store.openSaved(value);break;
          case 'forget-saved':if(typeof value!=='string')throw Error('Invalid note.');store.forgetSaved(value);break;
          case 'popout':
            if(popup){popup.show();popup.focus();break;}
            focusId=typeof value==='string'&&store.state().notes.some(n=>n.id===value)?value:undefined;
            popup=new BrowserWindow({width:850,height:700,minWidth:480,minHeight:400,title:'Notepad',backgroundColor:'#101010',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'notepad-preload.js'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
            popup.webContents.setWindowOpenHandler(()=>({action:'deny'}));
            popup.webContents.on('will-navigate',event=>event.preventDefault());
            popup.on('closed',()=>{popup=null;broadcast();});
            void popup.loadFile(path.join(__dirname,'../ui/notepad.html'));
            break;
        }
        if(action!=='state')broadcast();
        return {ok:true,data:snapshot()};
      }catch(error){return {ok:false,error:error instanceof Error?error.message:String(error)};}
    });
  }
}

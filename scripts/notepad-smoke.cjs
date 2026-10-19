const assert=require('node:assert/strict');
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'bec-notepad-smoke-'));
app.setPath('userData',directory);
const file=path.join(directory,'notepad.json');
const saved='NOTEPAD_SAVED_SNAPSHOT_9817',unsaved='NOTEPAD_UNSAVED_DRAFT_2751',second='NOTEPAD_POPOUT_DRAFT_5419';
let started=false;
const timeout=setTimeout(()=>{console.error('Notepad smoke timed out');app.exit(1);},40000);
const wait=async p=>{for(let i=0;i<200;i++){if(await p())return;await new Promise(r=>setTimeout(r,20));}throw Error('Test wait timed out');};
app.on('browser-window-created',(_,window)=>{
  if(started)return;started=true;
  window.webContents.once('did-finish-load',async()=>{
    const run=code=>window.webContents.executeJavaScript(code);
    try{
      const ids=await run(`(async()=>{
        const wait=async p=>{for(let i=0;i<200;i++){if(await p())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI wait: '+document.getElementById('note-status').textContent);};
        await wait(()=>!document.getElementById('connect').disabled);
        document.querySelector('[data-page="notepad"]').click();await wait(()=>!document.getElementById('notepad-module').hidden);
        await wait(()=>document.querySelectorAll('.note-tab').length===1);
        const change=(id,value)=>{const el=document.getElementById(id);el.value=value;el.dispatchEvent(new Event('input'));};
        change('note-title','Incident');change('note-text','${saved}');
        await wait(async()=>((await window.notes.state()).data.notes[0].text==='${saved}'));
        const first=(await window.notes.state()).data.notes[0].id;
        document.getElementById('note-save').click();await wait(()=>document.getElementById('note-save-state').textContent==='Saved locally');
        change('note-text','${unsaved}');await wait(async()=>((await window.notes.state()).data.notes[0].text==='${unsaved}'));
        document.getElementById('note-add').click();await wait(()=>document.querySelectorAll('.note-tab').length===2);
        change('note-title','Second tab');change('note-text','second draft');await wait(async()=>(await window.notes.state()).data.notes[1].text==='second draft');
        const second=(await window.notes.state()).data.notes[1].id;
        document.querySelector('[data-note-id="'+first+'"]').click();
        if(document.getElementById('note-text').value!=='${unsaved}')throw Error('Draft lost switching tabs');
        document.querySelector('[data-note-id="'+second+'"]').click();document.getElementById('note-popout').click();
        await wait(()=>document.getElementById('note-text').readOnly);
        return {first,second};
      })()`);
      let disk=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(disk.notes.length,1);assert.equal(disk.notes[0].text,saved);
      await wait(()=>BrowserWindow.getAllWindows().some(w=>w!==window&&w.webContents.getURL().endsWith('notepad.html')));
      const popup=BrowserWindow.getAllWindows().find(w=>w!==window);
      if(popup.webContents.isLoading())await new Promise(r=>popup.webContents.once('did-finish-load',r));
      const popupResult=await popup.webContents.executeJavaScript(`(async()=>{
        for(let i=0;i<200;i++){if(document.getElementById('note-text')?.value==='second draft')break;await new Promise(r=>setTimeout(r,20));}
        const text=document.getElementById('note-text'),correct=text.value==='second draft'&&!text.readOnly;
        text.value='${second}';text.dispatchEvent(new Event('input'));
        for(let i=0;i<200;i++){if((await window.notes.state()).data.notes.find(n=>n.id==='${ids.second}').text==='${second}')break;await new Promise(r=>setTimeout(r,20));}
        return {correct,node:typeof require,bec:typeof window.bec};
      })()`);
      assert.deepEqual(popupResult,{correct:true,node:'undefined',bec:'undefined'});
      popup.close();await wait(()=>popup.isDestroyed());
      await wait(()=>run(`!document.getElementById('note-text').readOnly && document.getElementById('note-text').value==='${second}'`));
      disk=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(disk.notes.length,1);assert.equal(disk.notes[0].text,saved);
      const final=await run(`(async()=>{
        const wait=async p=>{for(let i=0;i<200;i++){if(await p())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI wait');};
        document.getElementById('note-save').click();await wait(()=>document.getElementById('note-save-state').textContent==='Saved locally');
        document.querySelector('[data-note-id="${ids.first}"]').click();document.getElementById('note-forget').click();document.getElementById('note-confirm-yes').click();
        await wait(async()=>(await window.notes.state()).data.saved.length===1);
        const remains=document.getElementById('note-text').value==='${unsaved}';
        document.querySelector('.note-tab-close').click();document.getElementById('note-confirm-yes').click();await wait(()=>document.querySelectorAll('.note-tab').length===1);
        document.querySelector('.note-tab-close').click();await wait(()=>document.querySelectorAll('.note-tab').length===0);
        const select=document.getElementById('note-open');select.value='${ids.second}';select.dispatchEvent(new Event('change'));
        await wait(()=>document.getElementById('note-text').value==='${second}');
        return {remains,reopened:document.getElementById('note-save-state').textContent,log:(await window.bec.logInfo()).data.file};
      })()`);
      assert.ok(final.remains);assert.equal(final.reopened,'Saved locally');
      disk=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(disk.notes.length,1);assert.equal(disk.notes[0].text,second);
      const log=fs.readFileSync(final.log,'utf8');assert.ok(!log.includes(saved)&&!log.includes(unsaved)&&!log.includes(second));
      console.log('Notepad UI smoke passed: tabs, explicit snapshots, pop-out handoff, retained drafts, local-copy removal, reopening, isolation and transcript privacy');clearTimeout(timeout);app.exit(0);
    }catch(error){console.error(error);clearTimeout(timeout);app.exit(1);}
  });
});
require('../dist/main.js');

const assert=require('node:assert/strict');
const {app,dialog,clipboard}=require('electron');
const path=require('node:path');
const {fixture,temp,cleanup}=require('../tests/helpers/history.cjs');
const dir=temp(),chrome=path.join(dir,'History'),firefox=path.join(dir,'places.sqlite');
fixture(chrome,'chrome',101).close();fixture(firefox,'firefox',2).close();
let choice=chrome;
dialog.showOpenDialog=async()=>choice===null?{canceled:true,filePaths:[]}:{canceled:false,filePaths:[choice]};
const timeout=setTimeout(()=>{console.error('History smoke timed out');app.exit(1);},45000);
app.on('browser-window-created',(_,window)=>{
  window.webContents.once('did-finish-load',async()=>{
    const run=code=>window.webContents.executeJavaScript(code);
    try{
      const result=await run(`(async()=>{
        const wait=async p=>{for(let i=0;i<300;i++){if(p())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout: '+document.getElementById('history-status').textContent);};
        await wait(()=>!document.getElementById('connect').disabled);
        document.querySelector('[data-page="browser-history"]').click();
        await wait(()=>!document.getElementById('history-module').hidden);
        document.getElementById('history-browser').value='edge';document.getElementById('history-import').click();
        await wait(()=>document.getElementById('history-source').textContent.includes('101 visits'));
        await wait(()=>document.querySelectorAll('#history-body tr').length===100);
        const safe=!document.querySelector('#history-body img');
        const viewport=document.querySelector('#history-module .table-scroll');
        viewport.scrollTop=viewport.scrollHeight;
        viewport.scrollLeft=80;
        document.getElementById('history-next').scrollIntoView({block:'end'});
        await new Promise(r=>setTimeout(r,80));
        const scrollBefore=window.scrollY, horizontalBefore=viewport.scrollLeft;
        if(scrollBefore<10)throw Error('Scroll regression test must start down the page');
        document.getElementById('history-next').click();
        await wait(()=>document.getElementById('history-page').textContent==='101–101 of 101');
        await new Promise(r=>setTimeout(r,80));
        if(Math.abs(window.scrollY-scrollBefore)>2)throw Error('Next page moved document scroll: '+scrollBefore+' -> '+window.scrollY);
        if(viewport.scrollLeft!==horizontalBefore)throw Error('Horizontal position changed');
        if(viewport.scrollTop!==0)throw Error('New visit page should start at its first row');
        document.getElementById('history-previous').click();
        await wait(()=>document.querySelectorAll('#history-body tr').length===100);
        await new Promise(r=>setTimeout(r,80));
        if(Math.abs(window.scrollY-scrollBefore)>2)throw Error('Previous page moved document scroll');
        document.getElementById('history-next').click();
        await wait(()=>document.getElementById('history-page').textContent==='101–101 of 101');
        const page=document.getElementById('history-page').textContent;
        document.querySelector('#history-body button:last-child').click();
        const details=document.getElementById('history-record-json').textContent;
        document.getElementById('history-search').value='EXAMPLE.ORG';document.getElementById('history-search').dispatchEvent(new Event('input'));
        await wait(()=>document.getElementById('history-summary').textContent.startsWith('1 visits'));
        document.getElementById('history-copy-visits').click();
        await wait(()=>document.getElementById('history-status').textContent==='Copied 1 visit(s).');
        return {safe,page,details,shared:document.querySelector('.shared-session').hidden,source:document.getElementById('history-source').textContent};
      })()`);
      assert.ok(result.safe&&result.shared);assert.match(result.page,/101–101/);assert.match(result.details,/rawTime/);assert.match(result.details,/sha256/);assert.match(result.source,/Edge/);
      assert.match(await clipboard.readText(),/Time \(UTC\).*URL/);assert.match(await clipboard.readText(),/'=@test Title/);
      choice=null;
      await run(`document.getElementById('history-import').click()`);
      await new Promise(r=>setTimeout(r,150));
      assert.match(await run(`document.getElementById('history-source').textContent`),/101 visits/);
      choice=firefox;
      const firefoxResult=await run(`(async()=>{
        const wait=async p=>{for(let i=0;i<300;i++){if(p())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout');};
        document.getElementById('history-browser').value='auto';document.getElementById('history-import').click();
        await wait(()=>document.getElementById('history-source').textContent.includes('Firefox'));
        await wait(()=>document.querySelectorAll('#history-body tr').length===2);
        const count=document.getElementById('history-summary').textContent;
        document.getElementById('history-copy-urls').click();await wait(()=>document.getElementById('history-status').textContent==='Copied 1 URL(s).');
        return count;
      })()`);
      assert.match(firefoxResult,/2 visits/);assert.equal(await clipboard.readText(),'https://example.com/login');
      const cleared=await run(`(async()=>{
        document.getElementById('history-clear').click();
        for(let i=0;i<100;i++){if(document.getElementById('history-status').textContent==='History cleared.')break;await new Promise(r=>setTimeout(r,20));}
        return {rows:document.querySelectorAll('#history-body tr').length,disabled:document.getElementById('history-copy-urls').disabled};
      })()`);
      assert.deepEqual(cleared,{rows:0,disabled:true});
      cleanup(dir);console.log('History UI smoke passed: production SQLite imports, Edge/Firefox, pagination, search, clipboard, provenance, safe rendering, cancel and clear');clearTimeout(timeout);app.exit(0);
    }catch(error){console.error(error);clearTimeout(timeout);app.exit(1);}
  });
});
require('../dist/main.js');

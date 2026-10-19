const assert=require('node:assert/strict');
const {app,clipboard}=require('electron');
const timeout=setTimeout(()=>{console.error('Data Tools smoke timed out');app.exit(1);},30000);
app.on('browser-window-created',(_,window)=>{
  window.webContents.once('did-finish-load',async()=>{
    try{
      const result=await window.webContents.executeJavaScript(`(async()=>{
        const wait=async p=>{for(let i=0;i<200;i++){if(p())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout: '+document.getElementById('data-status').textContent);};
        await wait(()=>!document.getElementById('connect').disabled);
        document.querySelector('[data-page="data-tools"]').click();await wait(()=>!document.getElementById('data-module').hidden);
        const input=document.getElementById('data-input'),output=document.getElementById('data-output'),operation=document.getElementById('data-operation');
        input.value='https://example.com';input.dispatchEvent(new Event('input'));await wait(()=>output.value==='hxxps[:]//example[.]com');
        const defanged=output.value;
        document.getElementById('data-use-output').click();operation.value='refang';operation.dispatchEvent(new Event('change'));
        const restored=output.value;document.getElementById('data-use-output').click();
        operation.value='base64-encode';operation.dispatchEvent(new Event('change'));const encoded=output.value;
        document.getElementById('data-use-output').click();operation.value='base64-decode';operation.dispatchEvent(new Event('change'));const decoded=output.value;
        input.value='not base64!';input.dispatchEvent(new Event('input'));await wait(()=>document.getElementById('data-status').dataset.tone==='failure');
        const invalid=document.getElementById('data-copy').disabled&&output.value==='';
        operation.value='json';input.value='{"id":900719925474099312345,"name":"<img src=x>"}';operation.dispatchEvent(new Event('change'));
        const json=output.value;document.getElementById('data-copy').click();await wait(()=>document.getElementById('data-copy').textContent==='Copied');
        document.querySelector('[data-page="toolkit"]').click();await wait(()=>!document.getElementById('toolkit-module').hidden);
        document.querySelector('[data-page="data-tools"]').click();await wait(()=>!document.getElementById('data-module').hidden);
        const retained=output.value===json;
        const shared=document.querySelector('.shared-session').hidden;
        const safe=!document.querySelector('#data-module img');
        document.getElementById('data-clear').click();
        return {defanged,restored,encoded,decoded,invalid,json,retained,shared,safe,cleared:input.value===''&&output.value===''&&document.getElementById('data-copy').disabled};
      })()`);
      assert.equal(result.defanged,'hxxps[:]//example[.]com');assert.equal(result.restored,'https://example.com');assert.equal(result.decoded,result.restored);
      assert.equal(result.encoded,Buffer.from(result.restored).toString('base64'));
      assert.ok(result.invalid&&result.retained&&result.shared&&result.safe&&result.cleared);
      assert.match(result.json,/900719925474099312345/);assert.equal((await clipboard.readText()).replace(/\r\n/g,'\n'),result.json);
      console.log('Data Tools UI smoke passed: transformations, invalid input, precise JSON, clipboard, navigation and clear');clearTimeout(timeout);app.exit(0);
    }catch(error){console.error(error);clearTimeout(timeout);app.exit(1);}
  });
});
require('../dist/main.js');

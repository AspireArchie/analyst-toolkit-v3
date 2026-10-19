const assert = require('node:assert/strict');
const { app, clipboard } = require('electron');
const { mkdtempSync } = require('node:fs');
const path = require('node:path');
app.setPath('userData', mkdtempSync(path.join(require('node:os').tmpdir(), 'bec-kql-smoke-')));
const timeout = setTimeout(() => { console.error('KQL smoke timed out'); app.exit(1); }, 30000);
app.on('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    const run = code => window.webContents.executeJavaScript(code);
    try {
      const initial = await run(`(async () => {
        const wait = async p => { for(let i=0;i<100;i++){if(p())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout'); };
        await wait(()=>!document.getElementById('connect').disabled);
        document.querySelector('[data-page="kql-library"]').click();
        await wait(()=>!document.getElementById('kql-module').hidden);
        const change = (id,value) => { const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event('input')); };
        change('kql-name','Signin investigation');
        change('kql-template', 'SigninLogs\\n| where UserPrincipalName == "{User}" or Identity == "{User}"\\n| where IPAddress == "{IP}"\\n| where TimeGenerated > ago({Lookback})');
        const count = document.querySelectorAll('[data-parameter]').length;
        const left = document.getElementById('kql-template').getBoundingClientRect();
        const right = document.getElementById('kql-final').getBoundingClientRect();
        if (Math.abs(left.top - right.top) > 1 || Math.abs(left.height - right.height) > 1) throw Error('Query boxes are not aligned');
        const blocked = document.getElementById('kql-copy').disabled;
        for(const [key,value] of [['User','analyst$&@example.com'],['IP','5.101.157.184'],['Lookback','7d']]) {
          const field=document.querySelector('[data-parameter="'+key+'"]');field.value=value;field.dispatchEvent(new Event('input'));
        }
        document.getElementById('kql-save').click();
        const final=document.getElementById('kql-final').value;
        document.getElementById('kql-copy').click();
        await wait(()=>document.getElementById('kql-copy').textContent === 'Copied');
        document.getElementById('kql-new').click();
        change('kql-name','Second query');change('kql-template','SecurityEvent | take 10');document.getElementById('kql-save').click();
        document.querySelector('.kql-query').click();
        change('kql-name','Edited query');document.getElementById('kql-save').click();
        change('kql-template',document.getElementById('kql-template').value+'\\n// draft');
        document.querySelector('[data-page="toolkit"]').click();
        await wait(()=>!document.getElementById('toolkit-module').hidden);
        document.querySelector('[data-page="kql-library"]').click();
        await wait(()=>!document.getElementById('kql-module').hidden);
        const draft=document.getElementById('kql-template').value.endsWith('// draft');
        document.getElementById('kql-save').click();
        return {count,blocked,final,draft,stored:JSON.parse(localStorage.getItem('bec.kql-library.v1')),shared:document.querySelector('.shared-session').hidden};
      })()`);
      assert.equal(initial.count,3); assert.ok(initial.blocked && initial.draft && initial.shared);
      assert.equal(initial.stored.queries.length,2); assert.equal(initial.stored.queries[0].name,'Edited query');
      assert.ok(!initial.stored.queries[0].values);
      assert.equal((initial.final.match(/analyst\$&@example.com/g)||[]).length,2);
      assert.equal((await clipboard.readText()).replace(/\r\n/g, '\n'),initial.final);
      await window.webContents.reload();
      await new Promise(resolve=>window.webContents.once('did-finish-load',resolve));
      const persisted = await run(`(async () => {
        const wait = async p => { for(let i=0;i<100;i++){if(p())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout'); };
        await wait(()=>!document.getElementById('connect').disabled);
        document.querySelector('[data-page="kql-library"]').click();
        await wait(()=>!document.getElementById('kql-module').hidden);
        const restored=document.getElementById('kql-name').value === 'Edited query' && document.getElementById('kql-template').value.endsWith('// draft');
        const valuesEmpty=[...document.querySelectorAll('[data-parameter]')].every(i=>i.value === '');
        const template=document.getElementById('kql-template');template.focus();template.setSelectionRange(template.value.length,template.value.length);
        document.getElementById('kql-placeholder').value='PH2';document.getElementById('kql-insert').click();
        const inserted=template.value.endsWith('{PH2}') && !!document.querySelector('[data-parameter="PH2"]');
        document.getElementById('kql-delete').click();document.getElementById('kql-delete-cancel').click();
        const cancelled=document.querySelectorAll('.kql-query').length === 2;
        document.getElementById('kql-delete').click();document.getElementById('kql-delete-confirm').click();
        document.getElementById('kql-delete').click();document.getElementById('kql-delete-confirm').click();
        return {restored,valuesEmpty,inserted,cancelled,saved:JSON.parse(localStorage.getItem('bec.kql-library.v1')).queries.length};
      })()`);
      assert.deepEqual(persisted,{restored:true,valuesEmpty:true,inserted:true,cancelled:true,saved:0});
      console.log('KQL UI smoke passed: multiple/repeated placeholders, literal substitution, clipboard, editing, local persistence, drafts, insertion and deletion');
      clearTimeout(timeout); app.exit(0);
    } catch(error){ console.error(error);clearTimeout(timeout);app.exit(1); }
  });
});
require('../dist/main.js');

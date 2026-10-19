const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, dialog } = require('electron');
const { PowerShellSession } = require('../dist/powershell');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bec-audit-ui-'));
let fail = false, format = 'csv', cancelled = false;
dialog.showSaveDialog = async () => ({ canceled: cancelled, filePath: path.join(folder, `audits.${format}`) });
PowerShellSession.prototype.run = async function(action, query) {
  if (action === 'connect') return { graph: true, exchange: false, tenant: query.tenant, account: 'analyst@contoso.com' };
  assert.equal(action, 'collect-audits');
  if (fail) throw new Error('Simulated audit retrieval failure');
  const activity = ['Reset password', 'Update authentication method', 'Add member to role', 'Consent to application', 'Register device', 'Add member to group'];
  return { userId: 'affected-id', rows: Array.from({length: 106}, (_, i) => ({
    id: `audit-event-${i}`, activityDateTime: new Date(Date.parse(query.start) + i * 1000).toISOString(), activityDisplayName: activity[i] ?? 'Other activity',
    category: 'UserManagement', result: i === 1 ? 'failure' : 'success',
    initiatedBy: i === 1 ? { app: { displayName: '<img src=x onerror=alert(1)>' } } : { user: { id: 'affected-id', userPrincipalName: query.user } },
    targetResources: [{ id: 'affected-id', modifiedProperties: i === 1 ? [{ displayName: 'StrongAuthenticationMethod', oldValue: 'before-value', newValue: 'mfa-marker' }] : [] }],
  })) };
};
const timer = setTimeout(() => { console.error('Audit smoke timed out'); app.exit(1); }, 25000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const wait = async predicate => { for (let i=0;i<150;i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,20)); } throw new Error('Audit UI timed out: '+document.getElementById('operation-status').textContent); };
        await wait(()=>!document.getElementById('connect').disabled);
        const log = (await window.bec.logInfo()).data.file;
        document.getElementById('tenant').value='11111111-1111-1111-1111-111111111111';
        document.getElementById('auth-mode').value='device'; document.getElementById('connect').click();
        await wait(()=>!document.getElementById('audit-collect').disabled);
        document.querySelector('[data-page="audit-logs"]').click();
        await wait(()=>!document.getElementById('audit-module').hidden);
        document.getElementById('audit-user').value='user@contoso.com';
        document.getElementById('audit-range').value='custom'; document.getElementById('audit-range').dispatchEvent(new Event('change'));
        await wait(()=>!document.getElementById('audit-custom-range').hidden);
        document.getElementById('audit-start').value='2026-01-01T00:00'; document.getElementById('audit-end').value='2026-01-02T00:00';
        document.getElementById('audit-form').requestSubmit();
        await wait(()=>!document.getElementById('audit-export-csv').disabled);
        const count=document.getElementById('audit-heading').textContent, firstPage=document.querySelectorAll('#audit-body tr').length;
        document.getElementById('audit-next').click(); await wait(()=>document.getElementById('audit-page-info').textContent.startsWith('101'));
        const secondPage=document.querySelectorAll('#audit-body tr').length;
        document.getElementById('audit-category').value='mfa'; document.getElementById('audit-category').dispatchEvent(new Event('input'));
        await wait(()=>document.querySelectorAll('#audit-body tr').length===1 && document.querySelector('#audit-body button:not(.cell-expand)'));
        const red=document.querySelector('#audit-body .status-badge').dataset.tone;
        const safe=!document.querySelector('#audit-body img');
        document.querySelector('#audit-body button:not(.cell-expand)').click(); await wait(()=>document.getElementById('audit-record-json').textContent.includes('mfa-marker'));
        const raw=document.getElementById('audit-record-json').textContent;
        document.querySelector('[data-page="sign-ins"]').click(); await wait(()=>!document.getElementById('sign-in-module').hidden);
        const signIns=document.getElementById('results-heading').textContent;
        document.querySelector('[data-page="audit-logs"]').click(); await wait(()=>!document.getElementById('audit-module').hidden);
        return {log,count,firstPage,secondPage,red,safe,raw,signIns,retained:document.getElementById('audit-heading').textContent};
      })()`);
      assert.equal(result.count, 'Audit logs · 106 events'); assert.equal(result.retained, result.count);
      assert.equal(result.firstPage, 100); assert.equal(result.secondPage, 6);
      assert.equal(result.red, 'failure'); assert.equal(result.safe, true);
      assert.match(result.raw, /before-value/); assert.equal(result.signIns, 'Sign-ins · 0 records');
      const csv = await window.webContents.executeJavaScript(`window.bec.exportAudits('csv')`);
      assert.equal(csv.ok, true); assert.ok(fs.readFileSync(csv.data,'utf8').includes('audit-event-105'));
      format='json';
      const json = await window.webContents.executeJavaScript(`window.bec.exportAudits('json')`);
      assert.equal(JSON.parse(fs.readFileSync(json.data,'utf8')).records.length, 106);
      cancelled=true;
      const cancel=await window.webContents.executeJavaScript(`window.bec.exportAudits('csv')`); assert.equal(cancel.data,null);
      const transcript=fs.readFileSync(result.log,'utf8');
      for (const event of ['AUDIT_COLLECTION_BEGIN','AUDIT_COLLECTION_COMPLETE','AUDIT_RECORD_EXPANDED','AUDIT_EXPORT_COMPLETE','AUDIT_EXPORT_CANCELLED','audit_results_view']) assert.ok(transcript.includes(event),event);
      fail=true;
      const failure=await window.webContents.executeJavaScript(`(async()=>{
        document.getElementById('audit-form').requestSubmit();
        for(let i=0;i<150;i++){if(document.getElementById('operation-status').textContent.includes('Simulated'))break;await new Promise(r=>setTimeout(r,20));}
        return {heading:document.getElementById('audit-heading').textContent,disabled:document.getElementById('audit-export-csv').disabled};
      })()`);
      assert.equal(failure.heading,'Audit logs · 0 events'); assert.equal(failure.disabled,true);
      const oldExport=await window.webContents.executeJavaScript(`window.bec.exportAudits('csv')`);assert.equal(oldExport.ok,false);
      console.log('PASS: audit collection, custom range, pagination, categories, safe raw inspection, separate evidence, complete CSV/JSON exports, cancellation, transcript and failed-query cleanup');
      clearTimeout(timer); fs.rmSync(folder,{recursive:true,force:true}); app.quit();
    } catch(error) { console.error(error);clearTimeout(timer);app.exit(1); }
  });
});
require('../dist/main');

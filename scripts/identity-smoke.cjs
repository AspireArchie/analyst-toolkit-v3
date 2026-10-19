const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, dialog } = require('electron');
const { PowerShellSession } = require('../dist/powershell');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bec-identity-ui-'));
let failKind = '', cancelled = false, riskOnly = false;
dialog.showSaveDialog = async options => ({ canceled: cancelled, filePath: path.join(folder, path.basename(options.defaultPath)) });
PowerShellSession.prototype.run = async function(action, request) {
  if (action === 'connect') return { graph:true,exchange:false,tenant:request.tenant,account:'analyst@contoso.com' };
  assert.equal(action, 'collect-identity');
  if (failKind === request.kind) throw new Error('Simulated identity collection failure');
  this.audit('POWERSHELL_QUERY', { command:'Invoke-MgGraphRequest', parameters:{kind:request.kind,user:request.user} });
  const time = request.allRetained ? '2026-01-01T01:00:00Z' : request.start;
  if (request.kind==='risk-detections' && riskOnly) return {userId:'u',rows:[],riskyUser:{id:'u',userPrincipalName:'user@contoso.com',riskState:'atRisk',riskLevel:'high',riskLastUpdatedDateTime:'2020-01-01T00:00:00Z'},riskHistory:[],riskySignIns:[],riskSources:[{source:'detections',ok:true,count:0},{source:'risky-user',ok:true,count:1},{source:'risk-history',ok:false,error:'Simulated risk history permission denied'},{source:'risky-signins',ok:true,count:0}]};
  if (request.kind==='risk-detections') return {userId:'u',rows:[{id:'risk-one',userId:'u',riskEventType:'unfamiliarFeatures',riskLevel:'high',detectedDateTime:time,ipAddress:'192.0.2.1',source:'activeDirectory',requestId:'linked-signin'},{id:'risk-two',userId:'u',riskEventType:'leakedCredentials',riskLevel:'medium',detectedDateTime:time}],relatedAudits:[]};
  const history = [{id:'history-event',activityDateTime:time,activityDisplayName:request.kind==='devices'?'Delete device':'Consent to application',result:'success',targetResources:[{id:'u'}]}];
  if(request.kind==='devices') return {userId:'u',rows:Array.from({length:106},(_,i)=>({id:'device-'+i,deviceId:'guid-'+i,displayName:i===0?'<img src=x onerror=alert(1)>':'Device '+i,operatingSystem:'Windows',registrationDateTime:time,isCompliant:i===0?null:false,trustType:'AzureAd'})),relatedAudits:history};
  return {userId:'u',userPrincipalName:'returned@contoso.com',rows:[
    {grant:{id:'grant-one',clientId:'client',resourceId:'api',consentType:'Principal',principalId:'u',scope:'Mail.Read '+ 'scope-marker-'.repeat(20)},client:{displayName:'Example app',appId:'app-guid'},resource:{displayName:'Microsoft Graph'}},
    {grant:{id:'grant-two',clientId:'client',resourceId:'api',consentType:'AllPrincipals',scope:'Contacts.Read Mail.ReadWrite'},client:{displayName:'Example app',appId:'app-guid'},resource:{displayName:'Microsoft Graph'}},
  ],relatedAudits:history};
};
const timer=setTimeout(()=>{console.error('Identity UI timed out');app.exit(1);},30000);
app.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',async()=>{
  try {
    const initial=await window.webContents.executeJavaScript(`(async()=>{
      const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw new Error('Wait timed out: '+document.getElementById('operation-status').textContent);};
      await wait(()=>!document.getElementById('connect').disabled);
      const log=(await window.bec.logInfo()).data.file;
      document.getElementById('tenant').value='11111111-1111-1111-1111-111111111111';document.getElementById('auth-mode').value='device';document.getElementById('connect').click();
      await wait(()=>!document.querySelector('#devices-module [data-field="collect"]').disabled);
      const results={};
      for(const kind of ['risk-detections','devices','app-consents']){
        document.querySelector('[data-page="'+kind+'"]').click();await wait(()=>!document.getElementById(kind+'-module').hidden);
        const root=document.getElementById(kind+'-module'),field=name=>root.querySelector('[data-field="'+name+'"]');
        field('user').value='user@contoso.com';field('form').requestSubmit();await wait(()=>!field('csv').disabled);
        results[kind]=field('heading').textContent;
        if(kind==='risk-detections'){
          if(!field('info').textContent.includes('All retained'))throw new Error('All retained range missing');
          field('filter').value='high';field('filter').dispatchEvent(new Event('input'));await wait(()=>field('body').querySelectorAll('tr').length===1);
          field('body').querySelector('button').click();await wait(()=>field('raw').textContent.includes('linked-signin'));
        }else if(kind==='devices'){
          if(field('body').querySelector('img'))throw new Error('Unsafe device name rendered');
          field('next').click();await wait(()=>field('page').textContent.startsWith('101'));
          results.deviceSecondPage=field('body').querySelectorAll('tr').length;
          field('filter').value='history';field('filter').dispatchEvent(new Event('input'));await wait(()=>field('body').querySelectorAll('tr').length===1&&field('body').textContent.includes('Delete device'));
        }else{
          const headings=[...field('head').querySelectorAll('th')].map(th=>th.textContent);
          if(headings.includes('Review')||headings.includes('Flags / review'))throw Error('Consent review columns remain');
          if(!headings.includes('UPN')||!field('body').textContent.includes('returned@contoso.com'))throw Error('Returned UPN missing');
          const expand=field('body').querySelector('.cell-expand');
          if(!expand||expand.previousElementSibling.textContent.length>61)throw Error('Scope preview not limited');
          expand.click();await wait(()=>expand.getAttribute('aria-expanded')==='true');
          if(!expand.previousElementSibling.textContent.endsWith('scope-marker-'))throw Error('Full scope value missing');
          expand.click();await wait(()=>expand.getAttribute('aria-expanded')==='false');
          if(expand.previousElementSibling.textContent.length>61)throw Error('Scope did not collapse');

        }
      }
      return {log,results};
    })()`);
    assert.equal(initial.results['risk-detections'],'Risk Detections · 2 records');
    assert.equal(initial.results.devices,'Devices · 107 records');assert.equal(initial.results.deviceSecondPage,7);
    assert.equal(initial.results['app-consents'],'App Consents · 3 records');
    for(const kind of ['risk-detections','devices','app-consents']){
      for(const format of ['csv','json']){
        const saved=await window.webContents.executeJavaScript(`window.bec.exportIdentity(${JSON.stringify(kind)},${JSON.stringify(format)})`);
        assert.equal(saved.ok,true,saved.error);const content=fs.readFileSync(saved.data,'utf8');
        if(format==='json'){
          const snapshot=JSON.parse(content);assert.equal(snapshot.kind,kind);
          if(kind==='devices')assert.equal(snapshot.rows.length,107);
          if(kind==='app-consents'){assert.equal(snapshot.rows.find(row=>row.key==='grant:grant-one').values.UPN,'returned@contoso.com');assert.ok(snapshot.rows.find(row=>row.key==='grant:grant-one').values.Scopes.length>200);}
        }else assert.ok(content.includes('rawJson'));
      }
    }
    cancelled=true;const cancellation=await window.webContents.executeJavaScript(`window.bec.exportIdentity('devices','csv')`);assert.equal(cancellation.data,null);
    riskOnly=true;cancelled=false;
    const riskState=await window.webContents.executeJavaScript(`(async()=>{
      const root=document.getElementById('risk-detections-module'),field=name=>root.querySelector('[data-field="'+name+'"]');
      const wait=async f=>{for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,20))}throw Error('Risk state UI timeout')};
      document.querySelector('[data-page="risk-detections"]').click();await wait(()=>!root.hidden);
      field('filter').value='all';field('form').requestSubmit();await wait(()=>field('coverage').textContent.includes('UNAVAILABLE'));
      await wait(()=>!field('csv').disabled);
      const result={text:field('body').textContent,tone:field('coverage').dataset.tone,status:document.getElementById('operation-status').dataset.tone};
      field('filter').value='risk-user';field('filter').dispatchEvent(new Event('input'));await wait(()=>field('body').querySelectorAll('tr').length===1);
      field('body').querySelector('button:not(.cell-expand)').click();await wait(()=>field('raw').textContent.includes('atRisk'));
      return result;
    })()`);
    assert.match(riskState.text,/Current user risk/);assert.match(riskState.text,/atRisk/);assert.equal(riskState.tone,'warning');assert.equal(riskState.status,'warning');
    const riskExport=await window.webContents.executeJavaScript(`window.bec.exportIdentity('risk-detections','json')`);
    const riskSnapshot=JSON.parse(fs.readFileSync(riskExport.data,'utf8'));assert.equal(riskSnapshot.rows.length,1);assert.equal(riskSnapshot.riskSources.find(s=>s.source==='risk-history').ok,false);
    cancelled=false;
    const riskCsv=await window.webContents.executeJavaScript(`window.bec.exportIdentity('risk-detections','csv')`);
    assert.ok(fs.existsSync(riskCsv.data+'.metadata.json'));
    failKind='risk-detections';
    const failed=await window.webContents.executeJavaScript(`(async()=>{
      document.querySelector('[data-page="risk-detections"]').click();
      for(let i=0;i<150&&document.getElementById('risk-detections-module').hidden;i++)await new Promise(r=>setTimeout(r,20));
      document.querySelector('#risk-detections-module [data-field="form"]').requestSubmit();
      for(let i=0;i<150;i++){if(document.getElementById('operation-status').textContent.includes('Simulated'))break;await new Promise(r=>setTimeout(r,20));}
      return {heading:document.querySelector('#risk-detections-module [data-field="heading"]').textContent,disabled:document.querySelector('#risk-detections-module [data-field="csv"]').disabled};
    })()`);
    assert.equal(failed.heading,'Risk Detections · 0 records');assert.equal(failed.disabled,true);
    const blocked=await window.webContents.executeJavaScript(`window.bec.exportIdentity('risk-detections','csv')`);assert.equal(blocked.ok,false);
    const transcript=fs.readFileSync(initial.log,'utf8');
    for(const event of ['IDENTITY_COLLECTION_BEGIN','IDENTITY_COLLECTION_COMPLETE','IDENTITY_RECORD_EXPANDED','TABLE_CELL_TOGGLE','IDENTITY_EXPORT_COMPLETE','IDENTITY_EXPORT_CANCELLED','identity_results_view'])assert.ok(transcript.includes(event),event);
    const reset=await window.webContents.executeJavaScript(`window.bec.reset()`);assert.equal(reset.ok,true);
    const oldDevices=await window.webContents.executeJavaScript(`window.bec.exportIdentity('devices','csv')`);assert.equal(oldDevices.ok,false);
    console.log('PASS: all identity tabs, individual-user collection, retained risk range, device pagination/history, safe rendering, scope previews, expansion/collapse, consent UPN and simplified columns, complete exports, cancellation, risky user without detections, source failures, metadata, failure cleanup, logging and reset');
    clearTimeout(timer);fs.rmSync(folder,{recursive:true,force:true});app.quit();
  }catch(error){console.error(error);clearTimeout(timer);app.exit(1);}
}));
require('../dist/main');

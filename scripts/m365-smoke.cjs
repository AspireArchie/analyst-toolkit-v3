const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {app,dialog}=require('electron');const {PowerShellSession}=require('../dist/powershell');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bec-m365-ui-'));assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('bec-m365-ui-'));
let fail=false,lastQuery,empty=false;
dialog.showSaveDialog=async options=>({canceled:false,filePath:path.join(folder,path.basename(options.defaultPath))});
PowerShellSession.prototype.run=async function(action,request){
 if(action==='connect')return{graph:true,exchange:false,tenant:request.tenant,account:'analyst@contoso.com'};
 if(action==='exchange')return{graph:true,exchange:true,tenant:'11111111-1111-1111-1111-111111111111',account:'analyst@contoso.com'};
 assert.equal(action,'collect-m365');lastQuery=request;if(fail)throw Error('Simulated M365 worker failure');
 const source=(name,rows=[],extra={})=>({name,ok:true,rows,checkedAt:new Date().toISOString(),...extra});
 const mailbox=source('mailbox',[{PrimarySmtpAddress:request.user,ForwardingSmtpAddress:'smtp:external@example.net',DeliverToMailboxAndForward:true}]);
 if(empty)return{aliases:[request.user],sources:[source('trace',[],{ok:false,error:'Trace unavailable'})]};
 if(request.kind==='inbox-rules')return{aliases:[request.user],sources:[mailbox,source('inbox-rules',[{Name:'Hide replies',Enabled:true,DeleteMessage:true,From:['fraud@example.net'],Description:'rule-description-'.repeat(20)}]),source('rule-history',[],{metadata:{retrieval:{highCompleteness:true}}})]};
 if(request.kind.startsWith('trace-'))return{aliases:[request.user],sources:[mailbox,source('trace',Array.from({length:106},(_,i)=>({MessageTraceId:'message-1',Received:request.start,SenderAddress:request.kind==='trace-inbound'?'fraud@example.net':request.user,RecipientAddress:request.kind==='trace-inbound'?request.user:`user${i}@example.net`,MessageId:`id-${i}`,Subject:`Invoice ${i}`,Status:'Delivered',FromIP:'203.0.113.8'}))),source('inbox-rules',[{Name:'Hide replies',Enabled:true,DeleteMessage:true}])]};
 if(request.kind==='forwarding')return{aliases:[request.user],sources:[mailbox,source('transport-rules',[{Name:'BCC',BlindCopyTo:['external@example.net'],State:'Enabled',Mode:'Enforce',Description:'Tenant-wide candidate'}])]};
 return{aliases:[request.user],sources:[mailbox,source('quarantine',[{Identity:'q-1',ReceivedTime:request.start,Subject:'<img src=x onerror=alert(1)>',Type:'Phish'}]),source('EmailEvents',[{Timestamp:request.start,Subject:'Lure',RecipientEmailAddress:request.user,SenderFromAddress:'trusted@example.net',ThreatTypes:'Phish',DetectionMethods:'URL detonation'}]),source('UrlClickEvents',[],{ok:false,error:'Table not licensed'})]};
};
const timer=setTimeout(()=>{console.error('Microsoft 365 UI timeout');app.exit(1)},35000);
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 try{
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const el=id=>document.getElementById(id),wait=async f=>{for(let i=0;i<200;i++){if(f())return;await new Promise(r=>setTimeout(r,20))}throw Error('M365 wait timed out: '+el('operation-status').textContent)};
   await wait(()=>!el('connect').disabled);const log=(await window.bec.logInfo()).data.file;
   const root=k=>el(k+'-module'),field=(k,n)=>root(k).querySelector('[data-field="'+n+'"]');
   const disconnected=field('inbox-rules','collect').disabled;el('tenant').value='11111111-1111-1111-1111-111111111111';el('auth-mode').value='device';el('connect').click();await wait(()=>!el('exchange').disabled);el('exchange').click();await wait(()=>!field('inbox-rules','collect').disabled);
   const counts={};
   for(const kind of ['inbox-rules','trace-outbound','trace-inbound','defender-review','forwarding']){
    document.querySelector('[data-page="'+kind+'"]').click();await wait(()=>!root(kind).hidden);
    if(kind==='defender-review'&&field(kind,'range').value!=='672')throw Error('Defender lookback must default to 28 days');
    field(kind,'user').value='user@contoso.com';if(kind.startsWith('trace-'))field(kind,'party').value='fraud@example.net';field(kind,'form').requestSubmit();await wait(()=>!field(kind,'csv').disabled);counts[kind]=field(kind,'heading').textContent;
    if(kind==='inbox-rules'){const expand=field(kind,'body').querySelector('.cell-expand');if(!expand)throw Error('Rule preview missing');expand.click();await wait(()=>expand.getAttribute('aria-expanded')==='true');expand.click();await wait(()=>expand.getAttribute('aria-expanded')==='false');}
    if(kind==='trace-outbound'){field(kind,'next').click();await wait(()=>field(kind,'page').textContent.startsWith('101'));if(field(kind,'body').querySelectorAll('tr').length!==6)throw Error('Trace pagination failed');field(kind,'search').value='Invoice 105';field(kind,'apply').click();await wait(()=>field(kind,'page').textContent.includes('1 matching'));}
    if(kind==='trace-inbound'&&!field(kind,'body').textContent.includes('Hide replies'))throw Error('Rule candidates missing');
    if(kind==='defender-review'){
      if(field(kind,'body').querySelector('img'))throw Error('Unsafe Defender text');if(!field(kind,'sources').textContent.includes('Table not licensed'))throw Error('Source error hidden');
      field(kind,'url').value='https://suspected.example/aitm';field(kind,'verdict').value='malicious';const now=new Date();field(kind,'observed').value=new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,16);field(kind,'reference').value='Defender report evidence-1.png';field(kind,'capture-notes').value='Observed redirect chain, trusted third party sender';field(kind,'detonation').requestSubmit();await wait(()=>field(kind,'body').textContent.includes('Manual detonation capture'));
    }
    field(kind,'body').querySelector('button:not(.cell-expand)').click();await wait(()=>field(kind,'raw').textContent.includes('raw'));
   }
   return{log,counts,disconnected,bodyWidth:document.body.scrollWidth,width:innerWidth};
  })()`);
  assert.ok(result.disconnected);assert.match(result.counts['inbox-rules'],/1 records/);assert.match(result.counts['trace-outbound'],/106 records/);assert.match(result.counts['forwarding'],/2 records/);assert.ok(result.bodyWidth<=result.width);
  const call=code=>win.webContents.executeJavaScript(code),filters={search:'',source:'all',flagged:false};
  for(const kind of ['inbox-rules','trace-outbound','trace-inbound','defender-review','forwarding'])for(const format of ['csv','json']){
    const reply=await call(`window.bec.exportM365('${kind}','${format}','all',${JSON.stringify(filters)})`);assert.ok(reply.ok,reply.error);const text=fs.readFileSync(reply.data,'utf8');
    if(format==='csv'){assert.ok(text.includes('rawJson'));assert.ok(fs.existsSync(reply.data+'.metadata.json'));}else{const c=JSON.parse(text);assert.equal(c.kind,kind);if(kind==='defender-review'){assert.ok(c.records.some(r=>r.source==='Manual detonation capture'));assert.ok(c.sources.some(s=>!s.ok));}}
  }
  const filtered=await call(`window.bec.exportM365('trace-outbound','json','filtered',${JSON.stringify({...filters,search:'Invoice 105'})})`);assert.equal(JSON.parse(fs.readFileSync(filtered.data,'utf8')).records.length,1);
  empty=true;await call(`(async()=>{const r=await window.bec.collectM365('trace-outbound',${JSON.stringify({user:'user@contoso.com',start:new Date(Date.now()-86400000).toISOString(),end:new Date().toISOString(),party:''})});if(!r.ok)throw Error(r.error)})()`);
  const emptyExport=await call(`window.bec.exportM365('trace-outbound','csv','all',${JSON.stringify(filters)})`);assert.equal(JSON.parse(fs.readFileSync(emptyExport.data+'.metadata.json','utf8')).exportedCount,0);
  fail=true;const failure=await call(`window.bec.collectM365('trace-outbound',${JSON.stringify({user:'user@contoso.com',start:new Date(Date.now()-86400000).toISOString(),end:new Date().toISOString(),party:''})})`);assert.equal(failure.ok,false);assert.equal((await call(`window.bec.exportM365('trace-outbound','json','all',${JSON.stringify(filters)})`)).ok,false);
  const transcript=fs.readFileSync(result.log,'utf8');for(const action of ['M365_COLLECTION_BEGIN','M365_COLLECTION_COMPLETE','M365_RESULTS_VIEW','M365_RECORD_INSPECTION','M365_EXPORT_COMPLETE','M365_DETONATION_CAPTURE'])assert.ok(transcript.includes(action),action);
  assert.ok((await call('window.bec.reset()')).ok);assert.equal((await call(`window.bec.viewM365('forwarding',${JSON.stringify(filters)},0)`)).ok,false);
  clearTimeout(timer);console.log('PASS: all five Microsoft 365 tabs, shared connections, collection, rule candidates, traces, filtering/pagination, safe expandable text, source gaps, manual detonation capture, full/filtered exports, metadata, failures, reset and logging');fs.rmSync(folder,{recursive:true,force:true});app.quit();
 }catch(error){console.error(error);clearTimeout(timer);app.exit(1)}
}));
require('../dist/main');

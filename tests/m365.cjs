const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildM365Collection,validateM365Query,validateM365Filters,filterM365,m365Csv,validateDetonation}=require('../dist/m365-evidence');
const run=require('./helpers/powershell.cjs');
const {spawnSync}=require('node:child_process');
const query={user:'user@contoso.com',start:new Date(Date.now()-86400000).toISOString(),end:new Date().toISOString(),party:''};
const source=(name,rows=[],extra={})=>({name,ok:true,rows,checkedAt:new Date().toISOString(),...extra});
const filters={search:'',source:'all',flagged:false};
test('Microsoft 365 validation enforces trace retention, counterparties, filters and manual evidence provenance',()=>{
 assert.throws(()=>validateM365Query('trace-outbound',{...query,start:'2020-01-01'}),/90 days/);
 assert.throws(()=>validateM365Query('forwarding',{...query,party:'person@example.net'}));
 assert.throws(()=>validateM365Filters({...filters,flagged:'true'}));
 assert.throws(()=>validateDetonation({url:'javascript:alert(1)',verdict:'unknown',observedAt:query.start,reference:'report',notes:''}));
 assert.equal(validateDetonation({url:'https://lure.example/',verdict:'suspicious',observedAt:query.start,reference:'Defender report 1',notes:'chain observed'}).verdict,'suspicious');
});
test('inbox rules preserve current state, missing creation/IP, dangerous actions, and admin-targeted UAL changes',()=>{
 const audit=(id,target)=>({Identity:id,AuditData:JSON.stringify({Id:id,CreationTime:query.start,Operation:'New-InboxRule',UserId:'admin@contoso.com',ObjectId:target,ClientIP:'203.0.113.8',Parameters:[{Name:'DeleteMessage',Value:'True'}]})});
 const c=buildM365Collection('inbox-rules',query,'t',{aliases:[],sources:[source('inbox-rules',[{Name:'Hide replies',Enabled:true,From:['fraud@example.net'],DeleteMessage:true,RedirectTo:['evil@example.net']}]),source('rule-history',[audit('yes','user@contoso.com/rule'),audit('no','other@contoso.com/rule')])]});
 assert.equal(c.records.length,2);assert.equal(c.records[0].values['Created UTC'],'Not returned');assert.ok(!c.records[0].values['Source IP']);assert.equal(c.records[1].values['Source IP'],'203.0.113.8');assert.ok(c.records[1].findings.includes('Deletes mail'));assert.match(c.notes.join(' '),/1 returned records could not be attributed/);
});
test('trace deduplicates recipient rows, respects end boundary, highlights observed bulk/subject candidates, and exports every match',()=>{
 const rows=Array.from({length:106},(_,i)=>({MessageTraceId:'same-msg',Received:query.start,RecipientAddress:`user${i}@contoso.com`,SenderAddress:query.user,Subject:'Invoice payment'}));
 const c=buildM365Collection('trace-outbound',query,'t',{aliases:[],sources:[source('trace',[...rows,rows[0],{...rows[0],Received:query.end}]),source('accepted-domains',[{DomainName:'contoso.com'}])]});
 assert.equal(c.records.length,106);assert.ok(c.records[0].findings.some(f=>f.includes('106 unique')));assert.ok(c.records[0].findings.some(f=>f.includes('Internal recipient')));
 const matching=filterM365(c,{...filters,search:'user105@'});assert.equal(matching.length,1);assert.equal(m365Csv(c,c.records,'all',filters).split('\r\n').length,107);
});
test('inbound rules are candidates, disabled rules excluded, and forwarding inventory stays explicitly tenant-wide',()=>{
 const c=buildM365Collection('trace-inbound',query,'t',{aliases:[],sources:[source('trace',[{MessageTraceId:'a',Received:query.start,SenderAddress:'fraud@example.net'}]),source('inbox-rules',[{Name:'Hide',Enabled:true,MoveToFolder:'Archive'},{Name:'Disabled',Enabled:false,DeleteMessage:true}])]});
 assert.match(c.records[0].values['Rule candidates'],/Hide/);assert.doesNotMatch(c.records[0].values['Rule candidates'],/Disabled/);assert.match(c.notes.join(' '),/not proof/);
 const forwarding=buildM365Collection('forwarding',query,'t',{aliases:[],sources:[source('mailbox',[{ForwardingAddress:{Identity:'internal'},DeliverToMailboxAndForward:true}]),source('transport-rules',[{Name:'Copy',BlindCopyTo:['evil@example.net'],Mode:'Audit',State:'Disabled'}])]});
 assert.equal(forwarding.records.length,2);assert.ok(forwarding.records[0].findings.length);assert.match(forwarding.records[1].findings[0],/Tenant-wide/);assert.equal(forwarding.records[1].values.Mode,'Audit');
});
test('real PowerShell M365 collectors log safe commands, resolve aliases, collect all modules and retain licensed-source errors',async()=>{
 const kinds=['inbox-rules','trace-outbound','trace-inbound','defender-review','forwarding'];
 const {results,queries}=await run([{action:'connect',tenant:'11111111-1111-1111-1111-111111111111',mode:'device'},{action:'exchange',mode:'device'},...kinds.map(kind=>({action:'collect-m365',kind,...query}))],'tests/m365-session-fixture.ps1');
 for(const result of results)assert.ok(result.ok,result.error);
 for(const result of results.slice(2))assert.ok(result.data.sources.some(s=>s.ok));
 assert.ok(results[2].data.sources.find(s=>s.name==='rule-history').ok);
 assert.ok(results[3].data.sources.find(s=>s.name==='trace').ok,JSON.stringify(results[3]));
 const defender=results[5].data;assert.equal(defender.sources.find(s=>s.name==='EmailUrlInfo').ok,false);assert.equal(defender.sources.find(s=>s.name==='quarantine').rows.length,1);assert.ok(defender.sources.find(s=>s.name==='EmailEvents').ok,JSON.stringify(defender));
 assert.ok(queries.some(q=>q.command==='Get-MessageTraceV2'));assert.ok(queries.some(q=>q.command==='Get-TransportRule'));assert.ok(queries.some(q=>q.parameters.Uri?.endsWith('/runHuntingQuery')&&q.parameters.Method==='POST'));
 assert.ok(!queries.some(q=>/ContentSearch|ComplianceSearch|Export-Quarantine|Release-|Set-|New-InboxRule/.test(q.command)));
});
test('trace and hunting saturation split time ranges without losing boundary records; quarantine exhausts pages',()=>{
 const result=spawnSync('pwsh.exe',['-NoProfile','-File','tests/m365-range-fixture.ps1'],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(result.status,0,result.stderr);
 const data=JSON.parse(result.stdout.split(/\r?\n/).find(line=>line.startsWith('TEST_RESULT:')).slice(12));assert.equal(data.traceIds.length,9);assert.equal(data.huntIds.length,9);assert.equal(data.quarantine,1001);assert.equal(data.bulkRecipients,1001);assert.ok(data.calls>6);
});

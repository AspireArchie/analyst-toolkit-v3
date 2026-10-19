const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildUalCollection, normalizeIP, filterUal, validateUalQuery, validateUalFilters, ualCsv } = require('../dist/ual-evidence');
const run = require('./helpers/powershell.cjs');
const { spawnSync } = require('node:child_process');
const query = {user:'user@contoso.com',start:'2026-01-01T00:00:00Z',end:'2026-01-02T00:00:00Z',operations:[]};
const filters = {search:'',includeIPs:'',excludeIPs:'',ipMode:'all',operation:'all',workload:'all',result:'all'};
const row = (id, ip, extra={}) => ({Identity:id,AuditData:JSON.stringify({Id:id,CreationTime:'2026-01-01T02:00:00',Operation:'Send',UserId:query.user,ClientIP:ip,...extra})});
test('UAL keeps original evidence, deduplicates, enforces end-exclusive time, and preserves malformed records', () => {
  const original=row('a','203.0.113.4:5000');
  const c=buildUalCollection(query,'tenant',{rows:[original,original,row('end',null,{CreationTime:query.end}),{Identity:'bad',AuditData:'invalid JSON'}]});
  assert.equal(c.records.length,2);assert.equal(c.records[0].time,'2026-01-01T02:00:00.000Z');assert.deepEqual(c.records[0].raw,original);assert.ok(c.records[1].parseError);
});
test('IP normalization and CIDR filters support IPv4/IPv6, ports, mapped IPs and exclusion precedence',()=>{
  assert.equal(normalizeIP('[2001:0db8::1]:443'),'2001:db8::1');assert.equal(normalizeIP('::ffff:203.0.113.4'),'203.0.113.4');assert.equal(normalizeIP('203[.]0[.]113[.]4:123'),'203.0.113.4');assert.equal(normalizeIP('unknown'),null);
  const c=buildUalCollection(query,'tenant',{rows:[row('v4','203.0.113.4:123'),row('v6','[2001:db8::1]:443'),row('none',undefined),row('bad','internal')]});
  assert.equal(filterUal(c.records,{...filters,excludeIPs:'203.0.113.0/24'}).length,3);
  assert.deepEqual(filterUal(c.records,{...filters,includeIPs:'203.0.113.0/24, 2001:db8::/32',excludeIPs:'203.0.113.4'}).map(r=>r.id),['v6']);
  assert.equal(filterUal(c.records,{...filters,ipMode:'unknown'}).length,2);
  assert.throws(()=>validateUalFilters({...filters,includeIPs:'203.0.113.0/50'}));
  assert.throws(()=>validateUalQuery({...query,operations:['Send;evil']}));
});
test('UAL empty-source auditing checks report disabled and unknown; global enabled overrides mailbox AuditEnabled',()=>{
  const checks=[{check:'organization',ok:true,data:{AuditDisabled:true}},{check:'ingestion',ok:true,data:{UnifiedAuditLogIngestionEnabled:false}},{check:'bypass',ok:false,error:'denied'}];
  const c=buildUalCollection(query,'t',{rows:[],auditChecks:checks});assert.equal(c.evidenceGaps.length,3);
  const enabled=buildUalCollection(query,'t',{rows:[],auditChecks:[{check:'organization',ok:true,data:{AuditDisabled:false}},{check:'mailbox',ok:true,data:{AuditEnabled:false}}]});
  assert.ok(!enabled.evidenceGaps.some(x=>x.includes('AuditEnabled is false')));
});
test('UAL full filtered exports include all matching records, raw fields, query scope and safe CSV cells',()=>{
  const c=buildUalCollection(query,'t',{rows:Array.from({length:106},(_,i)=>row(String(i),i%2?'203.0.113.4':'198.51.100.4',{ObjectId:'=HYPERLINK("x")',ResultStatus:i%2?'Failed':'Success'}))});
  const selected=filterUal(c.records,{...filters,includeIPs:'203.0.113.4',result:'failure'});assert.equal(selected.length,53);
  const csv=ualCsv(c,selected,'filtered',filters);assert.equal(csv.split('\r\n').length,54);assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('rawRecordJson'));assert.ok(csv.includes(query.user));
});
test('UAL PowerShell session pages beyond 5000, audits every page and current settings; failures never produce partial success', async()=>{
  const base={...query,action:'collect-ual',operations:['Send']};
  const {results,queries}=await run([{action:'connect',tenant:'11111111-1111-1111-1111-111111111111',mode:'device'},{action:'exchange',mode:'device'},base,{...base,user:'empty@contoso.com'},{...base,user:'error@contoso.com'},{...base,user:'incomplete@contoso.com'},{...base,user:'repeated@contoso.com'},{...base,user:'malformed@contoso.com'}],'tests/ual-session-fixture.ps1');
  assert.ok(results[1].ok,results[1].error);assert.ok(results[2].ok,results[2].error);assert.equal(results[2].data.rows.length,5001);assert.equal(results[2].data.retrieval.pages,3);
  assert.equal(results[3].data.rows.length,0);assert.equal(results[3].data.auditChecks.length,4);assert.equal(results[3].data.auditChecks.find(x=>x.check==='bypass').ok,false);
  for(const result of results.slice(4,7)) assert.equal(result.ok,false);
  assert.ok(results[7].ok,results[7].error);assert.equal(results[7].data.rows[0].Identity,'missing-data');
  const pages=queries.filter(x=>x.command==='Search-UnifiedAuditLog');assert.equal(pages[0].parameters.SessionId,pages[1].parameters.SessionId);assert.ok(queries.some(x=>x.command==='Get-Mailbox'));
});
test('UAL range saturation splits and recollects with fresh sessions and overlapping boundaries',()=>{
  const child=spawnSync('pwsh.exe',['-NoProfile','-File','tests/ual-range-fixture.ps1'],{encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(child.status,0,child.stderr);
  const result=JSON.parse(child.stdout.split(/\r?\n/).find(line=>line.startsWith('TEST_RESULT:')).slice(12));
  assert.equal(result.stats.splits,1);assert.equal(result.stats.windows,3);assert.equal(result.ids.length,9);
  assert.equal(new Set(result.queries.map(q=>q.SessionId)).size,3);
  const starts=new Set(result.queries.map(q=>q.StartDate));assert.equal(starts.size,2);
});

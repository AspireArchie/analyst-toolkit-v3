const {test}=require('node:test');
const assert=require('node:assert/strict');
const run=require('./helpers/powershell.cjs');
const tenant='11111111-1111-1111-1111-111111111111', other='22222222-2222-2222-2222-222222222222';
const fixture='tests/independent-session-fixture.ps1';
test('Exchange connects first and remains usable when Graph consent fails; Graph can be added later',async()=>{
 const {results,queries}=await run([
  {action:'exchange',tenant}, {action:'connect',tenant:other}, {action:'connect',tenant},
  {action:'collect-m365',kind:'forwarding',user:'user@contoso.com',start:'2026-01-01T00:00:00Z',end:'2026-01-02T00:00:00Z'},
  {action:'connect',tenant}
 ],fixture);
 assert.equal(results[0].ok,true);assert.equal(results[0].data.graph,false);assert.equal(results[0].data.exchange,true);assert.equal(results[0].data.exchangeAccount,'exchange@contoso.com');
 assert.equal(results[1].ok,false);assert.match(results[1].error,/tenant/);
 assert.equal(results[2].ok,false);assert.match(results[2].error,/consent denied/);
 assert.equal(results[3].ok,true);assert.ok(results[3].data.sources.every(s=>s.ok));
 assert.equal(results[4].ok,true);assert.equal(results[4].data.graph,true);assert.equal(results[4].data.exchange,true);
 assert.equal(results[4].data.graphAccount,'graph@contoso.com');assert.equal(results[4].data.exchangeAccount,'exchange@contoso.com');
 assert.equal(queries.filter(q=>q.command==='Connect-MgGraph').length,2,'Cross-tenant request must fail before Graph authentication');
});
test('Graph-first and failed Exchange tenant verification preserve the appropriate connection',async()=>{
 const {results,queries}=await run([{action:'exchange',tenant:other},{action:'connect',tenant},{action:'exchange',tenant:other},{action:'exchange',tenant}],fixture);
 assert.equal(results[0].ok,false);assert.match(results[0].error,/tenant/);assert.equal(results[1].data.exchange,false);assert.equal(results[1].data.tenant,tenant);
 assert.equal(results[1].ok,true);assert.equal(results[2].ok,false);assert.equal(results[3].ok,true);
 assert.equal(results[3].data.graph,true);assert.equal(results[3].data.exchange,true);
 assert.equal(queries.filter(q=>q.command==='Disconnect-ExchangeOnline').length,1);
 assert.equal(queries.filter(q=>q.command==='Connect-ExchangeOnline').length,2);
});
test('missing audit command gives tenant-specific role guidance and preserves current inbox rules',async()=>{
 const query={user:'user@contoso.com',start:'2026-01-01T00:00:00Z',end:'2026-01-02T00:00:00Z'};
 const {results,queries}=await run([{action:'exchange',tenant},{action:'collect-m365',kind:'inbox-rules',...query},{action:'collect-ual',...query,operations:[]}],fixture);
 assert.equal(results[0].ok,true);assert.equal(results[1].ok,true);
 const sources=results[1].data.sources;
 assert.equal(sources.find(s=>s.name==='inbox-rules').rows.length,1);
 const history=sources.find(s=>s.name==='rule-history');assert.equal(history.ok,false);
 for(const text of [tenant,'exchange@contoso.com','View-Only Audit Logs','access-package','New / disconnect','has not been searched']) assert.ok(history.error.includes(text),text);
 assert.equal(results[2].ok,false);assert.match(results[2].error,/Audit history unavailable/);
 assert.ok(!queries.some(q=>q.command==='Search-UnifiedAuditLog'),'No audit search should be recorded as executed when the command is missing');
});

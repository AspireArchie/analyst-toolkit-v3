const {test}=require('node:test');
const assert=require('node:assert/strict');
const run=require('./helpers/powershell.cjs');
const fixture='tests/delegated-session-fixture.ps1';
const target='11111111-1111-1111-1111-111111111111',home='22222222-2222-2222-2222-222222222222';
test('guest Exchange targets customer organization while authenticating in home tenant; Graph can join same target',async()=>{
 const {results,queries}=await run([
  {action:'exchange',tenant:target,access:'delegated'},
  {action:'collect-m365',kind:'forwarding',user:'user@customer.example',start:'2026-01-01T00:00:00Z',end:'2026-01-02T00:00:00Z'},
  {action:'connect',tenant:target}
 ],fixture);
 assert.ok(results.every(r=>r.ok),JSON.stringify(results));
 assert.equal(results[0].data.tenant,target);assert.equal(results[0].data.exchangeAuthTenant,home);assert.equal(results[0].data.exchangeAccess,'delegated');
 assert.equal(results[2].data.graph,true);assert.equal(results[2].data.exchange,true);assert.equal(results[2].data.tenant,target);
 const exchange=queries.find(q=>q.command==='Connect-ExchangeOnline');assert.equal(exchange.parameters.DelegatedOrganization,target);assert.equal(exchange.parameters.Device,true);
 const graph=queries.find(q=>q.command==='Connect-MgGraph');assert.equal(graph.parameters.TenantId,target);assert.equal(graph.parameters.ContextScope,'Process');
});
test('wrong or missing delegated organization is rejected even when sign-in succeeds',async()=>{
 for(const tenant of ['33333333-3333-3333-3333-333333333333','00000000-0000-0000-0000-000000000000']){
  const {results,queries}=await run([{action:'exchange',tenant,access:'delegated'}],fixture);
  assert.equal(results[0].ok,false);assert.ok(results[0].error.includes(tenant));assert.match(results[0].error,/Connection closed/);
  assert.ok(queries.some(q=>q.command==='Disconnect-ExchangeOnline'));
 }
});
test('direct connections retain strict tenant verification; invalid access does not authenticate',async()=>{
 const {results,queries}=await run([{action:'exchange',tenant:target,access:'direct'},{action:'exchange',tenant:target,access:'anything'},{action:'exchange',tenant:home,access:'direct'}],fixture);
 assert.equal(results[0].ok,false);assert.match(results[0].error,/Guest \/ delegated/);
 assert.equal(results[1].ok,false);assert.equal(results[2].ok,true);assert.equal(results[2].data.tenant,home);
 const connections=queries.filter(q=>q.command==='Connect-ExchangeOnline');assert.equal(connections.length,2);assert.ok(connections.every(q=>!q.parameters.DelegatedOrganization));
});
test('Graph mismatch reports requested and actual tenant and disconnects Graph',async()=>{
 const tenant='33333333-3333-3333-3333-333333333333';
 const {results,queries}=await run([{action:'connect',tenant}],fixture);
 assert.equal(results[0].ok,false);assert.ok(results[0].error.includes(tenant));assert.ok(results[0].error.includes(home));
 assert.ok(queries.some(q=>q.command==='Disconnect-MgGraph'));
});

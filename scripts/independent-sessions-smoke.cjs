// Production UI / IPC with offline authentication responses.
const assert=require('node:assert/strict');
const {app}=require('electron');
const {PowerShellSession}=require('../dist/powershell');
const tenant='11111111-1111-1111-1111-111111111111';
let graph=false,exchange=false,denyGraph=true,attempts=0;
const stop=PowerShellSession.prototype.stop;
PowerShellSession.prototype.stop=function(...args){graph=false;exchange=false;return stop.apply(this,args);};
PowerShellSession.prototype.run=async function(action,args){
 assert.equal(args.tenant,tenant);attempts++;
 if(action==='exchange'){assert.equal(args.access,'delegated');exchange=true;}
 else if(action==='connect'){if(denyGraph){denyGraph=false;throw Error('Graph consent denied by tenant');}graph=true;}
 else throw Error('Unexpected fixture action');
 return {graph,exchange,tenant,account:graph?'graph@contoso.com':'exchange@contoso.com',graphAccount:graph?'graph@contoso.com':'',exchangeAccount:exchange?'exchange@contoso.com':'',exchangeAccess:'delegated',exchangeAuthTenant:'22222222-2222-2222-2222-222222222222'};
};
const timeout=setTimeout(()=>{console.error('Independent session UI timed out');app.exit(1);},25000);
app.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',async()=>{
 try{
  const result=await window.webContents.executeJavaScript(`(async()=>{
   const el=id=>document.getElementById(id);
   const wait=async p=>{for(let i=0;i<200;i++){if(p())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout');};
   await wait(()=>!el('exchange').disabled);
   if(el('exchange-access').value!=='delegated')throw Error('Guest access should be the default');
   const invalidAccess=await window.bec.exchange('device','${tenant}','invalid');
   if(invalidAccess.ok)throw Error('Invalid Exchange access was accepted');
   el('tenant').value='${tenant}';el('auth-mode').value='device';el('exchange').click();
   await wait(()=>el('exchange-connection').textContent==='Exchange: connected'&&!el('connect').disabled);
   const exchangeOnly={graph:el('graph-connection').textContent,exchange:el('exchange-card-status').textContent,tenantLocked:el('tenant').disabled,graphToolsDisabled:el('collect').disabled,exchangeToolsEnabled:!document.querySelector('#inbox-rules-module [data-field="collect"]').disabled,targetInfo:el('exchange-card').title,accessLocked:el('exchange-access').disabled};
   el('connect').click();await wait(()=>el('graph-connection').textContent==='Graph: failed'&&!el('connect').disabled);
   const afterFailure=await window.bec.state();
   const mismatch=await window.bec.connect('22222222-2222-2222-2222-222222222222','device');
   el('connect').click();await wait(()=>el('graph-connection').textContent==='Graph: connected'&&!el('auth-mode').disabled);
   return {exchangeOnly,afterFailure,mismatch,both:await window.bec.state(),graphLabel:el('graph-card-status').textContent,exchangeLabel:el('exchange-card-status').textContent};
  })()`);
  assert.equal(result.exchangeOnly.graph,'Graph: disconnected');assert.match(result.exchangeOnly.exchange,/exchange@contoso.com/);
  assert.ok(result.exchangeOnly.tenantLocked && result.exchangeOnly.graphToolsDisabled && result.exchangeOnly.exchangeToolsEnabled);
  assert.ok(result.exchangeOnly.accessLocked);assert.ok(result.exchangeOnly.targetInfo.includes(tenant));assert.ok(result.exchangeOnly.targetInfo.includes('22222222-2222-2222-2222-222222222222'));
  assert.equal(result.afterFailure.data.graph,false);assert.equal(result.afterFailure.data.exchange,true);
  assert.equal(result.mismatch.ok,false);assert.equal(attempts,3);
  assert.equal(result.both.data.graph,true);assert.equal(result.both.data.exchange,true);
  assert.match(result.graphLabel,/graph@contoso.com/);assert.match(result.exchangeLabel,/exchange@contoso.com/);
  console.log('Independent session UI passed: Exchange-only, failed Graph consent, tenant guard and both account indicators');clearTimeout(timeout);app.exit(0);
 }catch(error){console.error(error);clearTimeout(timeout);app.exit(1);}
}));
require('../dist/main');

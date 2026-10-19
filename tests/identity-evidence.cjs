const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildIdentityCollection, identityCsv } = require('../dist/identity-evidence');
const runPowerShell = require('./helpers/powershell.cjs');
const query = { user: 'user@contoso.com', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' };
test('risk detections include delayed/offline detections and preserve missing sign-in references', () => {
  const result = { userId: 'u', rows: [
    { id: 'late', userId: 'u', activityDateTime: '2025-12-31T23:00:00Z', detectedDateTime: query.start, riskLevel: 'high', requestId: 'signin' },
    { id: 'activity', userId: 'u', activityDateTime: query.start, detectedDateTime: '2026-01-03T00:00:00Z' },
    { id: 'outside', userId: 'u', activityDateTime: query.end }, { id: 'wrong', userId: 'other', activityDateTime: query.start },
  ] };
  const filtered = buildIdentityCollection('risk-detections', query, 'tenant', result, [{ id: 'signin', userPrincipalName: query.user }]);
  assert.deepEqual(filtered.rows.map(r=>r.key), ['risk:late', 'risk:activity']);
  assert.equal(filtered.rows[0].values['Captured sign-in IDs'], 'signin');
  assert.equal(filtered.rows[1].values['Sign-in request ID'], '');
  assert.equal(buildIdentityCollection('risk-detections', {...query, allRetained:true}, 'tenant', result).rows.length,3);
});
test('devices preserve current state, unknown compliance, incident-window flags and historical deletions', () => {
  const result = { userId:'u', rows:[{id:'d', registrationDateTime:query.start, isCompliant:null, trustType:'Workplace'}, {id:'old',registrationDateTime:'2020-01-01T00:00:00Z',isCompliant:false}], relatedAudits:[{id:'deleted',activityDateTime:query.start,activityDisplayName:'Delete device'}] };
  const report=buildIdentityCollection('devices',query,'tenant',result);
  assert.equal(report.rows.length,3); assert.equal(report.rows[0].values['Compliance (current)'],'Unknown');
  assert.ok(report.rows[0].flags.includes('Registered during incident window'));
  assert.ok(!report.rows[1].flags.includes('Registered during incident window'));
  assert.equal(report.rows[2].source,'audit'); assert.equal(report.rows[2].values['Registered UTC'],'');
});
test('consents include applicable tenant grants, flag exact sensitive scopes, and preserve raw evidence in CSV', () => {
  const client={displayName:'=HYPERLINK("bad")',appId:'app'};
  const result={userId:'u',rows:[
    {grant:{id:'one',consentType:'Principal',principalId:'u',clientId:'c',scope:'Mail.ReadWrite User.Read'},client},
    {grant:{id:'all',consentType:'AllPrincipals',clientId:'c',scope:'Contacts.Read'},client},
    {grant:{id:'other',consentType:'Principal',principalId:'x',clientId:'c',scope:'Mail.Read'},client},
  ]};
  const report=buildIdentityCollection('app-consents',query,'tenant',result);
  assert.equal(report.rows.length,2); assert.ok(report.rows[0].flags.some(f=>f.includes('Mail.ReadWrite')));
  assert.equal(report.rows[0].values.Review,'Unreviewed'); assert.equal(report.rows[0].values['Audit time UTC'],'');
  const text=identityCsv(report); assert.ok(text.includes(`"'=HYPERLINK(""bad"")"`)); assert.ok(text.includes('rawJson')); assert.ok(text.includes('tenant'));
});
test('real PowerShell identity collectors paginate risk/devices and include user/tenant grants and related history', async () => {
  const {results,queries}=await runPowerShell([{action:'connect',tenant:'11111111-1111-1111-1111-111111111111'},...['risk-detections','devices','app-consents'].map(kind=>({action:'collect-identity',kind,...query}))]);
  for(const result of results)assert.equal(result.ok,true,result.error);
  assert.equal(results[1].data.rows.length,2);
  assert.equal(results[1].data.riskyUser.riskState,'atRisk');
  assert.equal(results[1].data.riskHistory.length,2);
  assert.equal(results[1].data.riskySignIns.length,4);
  assert.ok(results[1].data.riskSources.every(s=>s.ok));
  assert.ok(results[2].data.rows.length>=1); assert.equal(results[2].data.rows[0].deviceId,'device-guid');
  assert.equal(results[2].data.relatedAudits[0].activityDisplayName,'Delete device');
  assert.equal(results[3].data.rows.length,2); assert.equal(results[3].data.rows[0].client.displayName,'Example client');
  assert.equal(results[3].data.userPrincipalName,'user@contoso.com');
  assert.equal(results[3].data.relatedAudits[0].activityDisplayName,'Consent to application');
  assert.ok(queries.some(q=>q.parameters.Uri?.includes('risk-next=2')));
  assert.equal(queries.filter(q=>q.parameters.Uri?.includes('/servicePrincipals/')).length,2,'application metadata cached across grants');
});

test('risky user remains visible without detections and outside the incident window; history and sign-ins keep their scope',()=>{
  const result={userId:'u',rows:[],riskyUser:{id:'u',riskLevel:'high',riskState:'atRisk',riskLastUpdatedDateTime:'2020-01-01T00:00:00Z'},riskHistory:[{id:'h',userId:'u',riskLastUpdatedDateTime:query.start,riskState:'dismissed',initiatedBy:'admin'},{id:'old',userId:'u',riskLastUpdatedDateTime:'2020-01-01'}],riskySignIns:[{id:'s',userId:'u',createdDateTime:query.start,riskLevelDuringSignIn:'high',riskLevelAggregated:'none',signInEventTypes:['nonInteractiveUser']},{id:'safe',userId:'u',createdDateTime:query.start,riskLevelDuringSignIn:'none'},{id:'other',userId:'wrong',createdDateTime:query.start,riskLevelDuringSignIn:'high'},{id:'hidden',userId:'u',createdDateTime:query.start,riskLevelAggregated:'hidden'}]};
  const report=buildIdentityCollection('risk-detections',query,'tenant',result);
  assert.deepEqual(report.rows.map(r=>r.source),['risk-user','risk-history','risky-signin','risky-signin']);
  assert.equal(report.rows[0].values['Risk state'],'atRisk');assert.equal(report.rows[2].values['Risk level'],'high');
  assert.equal(report.rows[3].tone,'neutral');assert.ok(report.rows[3].flags.some(f=>f.includes('cannot be inferred')));
  assert.ok(identityCsv(report).includes('nonInteractiveUser'));
  assert.equal(buildIdentityCollection('risk-detections',{...query,allRetained:true},'t',result).rows.length,5);
});

test('risk source errors remain explicit and other successful sources survive',async()=>{
  const {results,queries}=await runPowerShell([{action:'connect',tenant:'11111111-1111-1111-1111-111111111111'},{action:'collect-identity',kind:'risk-detections',...query,user:'riskfail@contoso.com'}]);
  const result=results[1];assert.ok(result.ok,result.error);assert.equal(result.data.riskyUser.riskState,'atRisk');
  assert.equal(result.data.riskHistory.length,0);assert.equal(result.data.riskSources.find(s=>s.source==='risk-history').ok,false);
  const snapshot=buildIdentityCollection('risk-detections',query,'t',result.data);assert.match(snapshot.coverage,/UNAVAILABLE/);
  assert.match(JSON.stringify(snapshot),/permission denied/);
  assert.ok(queries.find(q=>q.command==='Connect-MgGraph').parameters.Scopes.includes('IdentityRiskyUser.Read.All'));
});

test('consent UPN comes from returned identity, never inferred from query; tenant-wide grants remain explicit', () => {
  const result = { userId: 'u', userPrincipalName: 'returned@contoso.com', rows: [
    {grant:{id:'one',principalId:'u',consentType:'Principal',scope:'Mail.Read'}},
    {grant:{id:'all',consentType:'AllPrincipals',scope:'User.Read'}},
  ], relatedAudits:[{id:'event',activityDateTime:query.start,targetResources:[{id:'u',userPrincipalName:'event@contoso.com'}]}] };
  const report = buildIdentityCollection('app-consents',query,'tenant',result);
  assert.equal(report.rows[0].values.UPN,'returned@contoso.com');
  assert.equal(report.rows[1].values.UPN,'All users (tenant-wide)');
  assert.equal(report.rows[2].values.UPN,'event@contoso.com');
  assert.equal(report.rows[0].raw.principal.userPrincipalName,'returned@contoso.com');
  const unknown = buildIdentityCollection('app-consents',query,'tenant',{...result,userPrincipalName:undefined});
  assert.equal(unknown.rows[0].values.UPN,'');
});

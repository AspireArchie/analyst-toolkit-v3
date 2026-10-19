const { test } = require('node:test');
const assert = require('node:assert/strict');
const { auditRecords, auditCsv } = require('../dist/directory-audits');
const runPowerShell = require('./helpers/powershell.cjs');
const query = { user: 'user@contoso.com', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' };
test('directory audit matching covers actors, targets, UPNs, multiple targets and exclusive dates', () => {
  const base = { activityDateTime: query.start };
  const rows = [
    { ...base, id: 'a', activityDisplayName: 'Reset user password', initiatedBy: { user: { id: 'user-id' } } },
    { ...base, id: 'b', activityDisplayName: 'Update user', initiatedBy: { app: { displayName: 'Service' } }, targetResources: [{ id: 'group' }, { id: 'user-id', modifiedProperties: [{ displayName: 'StrongAuthenticationMethod', oldValue: 'old', newValue: 'new' }] }] },
    { ...base, id: 'c', activityDisplayName: 'Add member to role', initiatedBy: { user: { userPrincipalName: 'USER@CONTOSO.COM' } }, targetResources: [{ id: 'user-id' }] },
    { ...base, id: 'd', activityDisplayName: 'Consent to application', targetResources: [{ userPrincipalName: query.user }] },
    { ...base, id: 'e', activityDisplayName: 'Add device', initiatedBy: { user: { id: 'user-id' } } },
    { ...base, id: 'f', activityDisplayName: 'Add member to group', targetResources: [{ id: 'user-id' }] },
    { ...base, id: 'unknown', activityDisplayName: 'Novel activity', targetResources: [{ id: 'user-id' }] },
    { ...base, id: 'excluded', targetResources: [{ id: 'someone-else' }] },
    { ...base, id: 'boundary', activityDateTime: query.end, targetResources: [{ id: 'user-id' }] },
  ];
  const before = JSON.stringify(rows);
  const records = auditRecords([...rows, rows[0]], query, 'user-id');
  assert.equal(records.length, 7);
  assert.equal(records.find(r => r.event.id === 'c').relation, 'both');
  assert.equal(records.find(r => r.event.id === 'b').relation, 'target');
  for (const [id, tag] of [['a','password'],['b','mfa'],['c','roles'],['d','consent'],['e','devices'],['f','groups'],['unknown','other']]) assert.ok(records.find(r => r.event.id === id).tags.includes(tag));
  assert.equal(JSON.stringify(rows), before);
});
test('audit CSV includes nested changes, attribution, provenance and formula escaping', () => {
  const event = { id: 'x', activityDateTime: query.start, activityDisplayName: '=HYPERLINK("bad")', targetResources: [{ id: 'user-id', modifiedProperties: [{ displayName: 'Property', oldValue: 'before', newValue: 'after' }] }] };
  const content = auditCsv({ query, tenant: 'tenant', userId: 'user-id', collectedAt: 'timestamp', records: auditRecords([event], query, 'user-id') });
  assert.ok(content.startsWith('\uFEFF'));
  assert.ok(content.includes(`"'=HYPERLINK(""bad"")"`));
  for (const field of ['before', 'after', 'tenant', 'user-id', 'target', 'rawJson']) assert.ok(content.includes(field));
});
test('PowerShell audit collector resolves identity, scans every page and rejects partial results', async () => {
  const { results, queries } = await runPowerShell([
    { action: 'connect', tenant: '11111111-1111-1111-1111-111111111111' },
    { action: 'collect-audits', ...query },
    { action: 'collect-audits', ...query, user: 'failaudit@contoso.com' },
  ]);
  assert.equal(results[1].ok, true, results[1].error);
  assert.equal(results[1].data.userId, 'affected-user-id');
  assert.deepEqual(results[1].data.rows.map(r => r.id).sort(), ['actor-only', 'both', 'target-only', 'upn-only']);
  assert.equal(queries.filter(q => q.parameters.Uri?.includes('/auditLogs/directoryAudits')).length, 4);
  assert.equal(results[2].ok, false);
  assert.match(results[2].error, /second-page failure/);
});

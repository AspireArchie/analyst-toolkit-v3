const { test } = require('node:test');
const assert = require('node:assert/strict');
const { conditionalAccessReport, selectedSignIns } = require('../dist/conditional-access');
const row = (id, extra = {}) => ({ id, createdDateTime: '2026-01-01T00:00:00Z', userPrincipalName: 'user@contoso.com', appDisplayName: 'Exchange', ipAddress: '192.0.2.1', isInteractive: true, ...extra });
const collection = { tenant: 'tenant', collectedAt: 'timestamp', query: {}, rows: [
  row('one', { conditionalAccessStatus: 'success', appliedConditionalAccessPolicies: [
    { id: 'same-policy', displayName: 'MFA', result: 'success', enforcedGrantControls: ['Mfa'] },
    { id: 'report', displayName: 'Test policy', result: 'reportOnlyFailure' },
  ] }),
  row('two', { conditionalAccessStatus: 'failure', appliedConditionalAccessPolicies: [{ id: 'same-policy', displayName: 'MFA', result: 'failure' }, { id: 'other', result: 'notApplied' }, { result: 'futureResultValue' }] }),
  row('missing'), row('empty', { appliedConditionalAccessPolicies: [] }), row('null', { appliedConditionalAccessPolicies: null }),
] };
test('CA report uses only selected captured records and preserves per-event outcomes', () => {
  const before = JSON.stringify(collection);
  const report = conditionalAccessReport(collection, ['two', 'one', 'two']);
  assert.equal(report.events.length, 2);
  assert.equal(report.events[0].policies[0].result, 'failure');
  assert.equal(report.events[1].policies[0].result, 'success');
  assert.equal(report.events[1].policies[1].result, 'reportOnlyFailure');
  assert.equal(report.events[0].policies[1].result, 'notApplied');
  assert.equal(report.events[0].policies[2].result, 'futureResultValue');
  assert.equal(report.events[0].overallStatus, 'failure');
  assert.equal(report.tenant, 'tenant');
  assert.equal(JSON.stringify(collection), before);
});
test('omitted/null policy details remain distinct from explicitly empty arrays and notApplied', () => {
  const report = conditionalAccessReport(collection, ['missing', 'empty', 'null']);
  assert.deepEqual(report.events.map(event => event.availability), ['unavailable', 'empty', 'unavailable']);
  assert.ok(report.events.every(event => event.overallStatus === 'unknown'));
});
test('selection rejects IDs outside current evidence, empty selections and no collection', () => {
  for (const value of [[], ['not-present'], [123], 'one']) assert.throws(() => conditionalAccessReport(collection, value));
  assert.throws(() => selectedSignIns(null, ['one']), /Collect/);
});

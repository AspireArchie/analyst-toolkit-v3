const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { validateQuery, csv } = require('../dist/evidence');

test('query validation rejects invalid ranges, future dates and malformed users', () => {
  const valid = { user: 'user@contoso.com', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' };
  assert.equal(validateQuery(valid).start, '2026-01-01T00:00:00.000Z');
  for (const patch of [{ user: 'bad' }, { start: valid.end }, { end: 'bad' }, { end: '2099-01-01' }]) assert.throws(() => validateQuery({ ...valid, ...patch }));
});
test('CSV escapes quotes, neutralizes formulas and preserves raw records and provenance', () => {
  const result = csv({ query: { user: 'user@contoso.com', start: 'start', end: 'end' }, tenant: 'tenant-id', collectedAt: 'timestamp', rows: [
    { id: '1', createdDateTime: 'time', userPrincipalName: 'user@contoso.com', appDisplayName: '=HYPERLINK("evil")', ipAddress: '1.2.3.4', isInteractive: false, status: { errorCode: 0 }, extra: 'retained' },
  ] });
  assert.ok(result.startsWith('\uFEFF'));
  assert.ok(result.includes(`"'=HYPERLINK(""evil"")"`));
  assert.ok(result.includes('nonInteractiveUser'));
  assert.ok(result.includes('tenant-id'));
  assert.ok(result.includes('retained'));
});
test('real PowerShell collector follows both event-type page chains and rejects tenant mismatch/errors', async () => {
  const commands = [
    { action: 'connect', tenant: '11111111-1111-1111-1111-111111111111' },
    { action: 'exchange' },
    { action: 'collect', user: 'user@contoso.com', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
    { action: 'collect', user: 'fail@contoso.com', start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
  ];
  const { results, output, queries } = await new Promise((resolve, reject) => {
    const worker = spawn('pwsh.exe', ['-NoProfile', '-File', 'tests/session-fixture.ps1'], { windowsHide: true });
    const results = [], queries = []; let output = '', error = '';
    const timeout = setTimeout(() => { worker.kill(); reject(new Error('PowerShell test timed out')); }, 15000);
    worker.on('error', reject);
    worker.stderr.on('data', chunk => { error += chunk; });
    createInterface({ input: worker.stdout }).on('line', line => {
      output += line + '\n';
      if (line.startsWith('BEC_AUDIT:')) {
        queries.push(JSON.parse(line.slice(10)));
        worker.stdin.write('BEC_AUDIT_OK\n');
      }
      if (line.startsWith('BEC_RESULT:')) {
        results.push(JSON.parse(line.slice(11)));
        if (results.length < commands.length) worker.stdin.write(JSON.stringify(commands[results.length]) + '\n');
        else worker.stdin.end();
      }
    });
    worker.on('exit', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(error || 'Worker exited with ' + code));
      else resolve({ results, output, queries });
    });
    worker.stdin.write(JSON.stringify(commands[0]) + '\n');
  });
  assert.equal(results.length, 4, output);
  assert.match(output, /enter the code TESTCODE1/);
  assert.match(output, /enter code TESTCODE2/);
  assert.match(output, /TEST_SCOPES:AuditLog.Read.All,Policy.Read.ConditionalAccess/);
  assert.equal(queries.filter(q => q.command === 'Invoke-MgGraphRequest').length, 5);
  assert.ok(queries.some(q => q.parameters.Uri?.includes('next=noninteractive')));
  assert.equal(results[0].data.graph, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /tenant/);
  assert.equal(results[2].ok, true, results[2].error);
  assert.equal(results[2].data.rows.length, 4);
  assert.equal(results[2].data.rows.filter(r => r.isInteractive).length, 2);
  assert.equal(results[3].ok, false);
  assert.match(results[3].error, /permission/);
});

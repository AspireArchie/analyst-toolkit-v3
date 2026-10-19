const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InvestigationLog } = require('../dist/investigation-log');
const { PowerShellSession } = require('../dist/powershell');

test('separate logs preserve ordered, escaped events and redact credentials', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'bec-logs-'));
  try {
    const first = new InvestigationLog(folder);
    first.write('QUERY', { user: 'user@contoso.com', query: 'line1\nSESSION_END fake', accessToken: 'secret', message: 'enter the code TESTCODE1', output: 'Bearer abc123' });
    first.end('New investigation');
    const second = new InvestigationLog(folder); second.end('Application closed');
    assert.notEqual(first.file, second.file);
    const text = readFileSync(first.file, 'utf8');
    const lines = text.trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /\| 1 \| SESSION_BEGIN/);
    assert.match(lines[1], /user@contoso.com/);
    assert.match(lines[2], /\| 3 \| SESSION_END/);
    assert.ok(!text.includes('TESTCODE1'));
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes('abc123'));
    assert.throws(() => first.write('LATE'), /closed/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('unwritable log blocks further activity', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'bec-logs-'));
  try {
    const log = new InvestigationLog(folder);
    // Point this test logger at a directory to simulate an unavailable log target.
    log.file = folder;
    assert.throws(() => log.write('QUERY'), /logging failed; action blocked/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('PowerShell operation does not start when its audit write fails', async () => {
  const session = new PowerShellSession(() => {}, () => {}, () => { throw new Error('Disk full'); });
  assert.throws(() => session.run('collect'), /Disk full/);
  assert.equal(session.child, undefined);
});

test('PowerShell query is terminated before module access if its durable audit fails', async () => {
  const queries = [];
  const session = new PowerShellSession(() => {}, () => {}, (event, details) => {
    if (event === 'POWERSHELL_QUERY') { queries.push(details); throw new Error('Simulated audit disk failure'); }
  });
  try {
    await assert.rejects(session.run('connect', { tenant: '11111111-1111-1111-1111-111111111111', mode: 'device' }), /Simulated audit disk failure/);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].command, 'Get-Module');
    assert.equal(session.child, undefined);
  } finally { session.stop(); }
});

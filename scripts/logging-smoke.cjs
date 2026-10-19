const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, dialog } = require('electron');
const { PowerShellSession } = require('../dist/powershell');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bec-export-test-'));
let cancelExport = true;
let currentLog;
let passed = false;
let remoteRuns = 0;
dialog.showSaveDialog = async () => cancelExport ? { canceled: true } : { canceled: false, filePath: path.join(folder, 'evidence.csv') };
PowerShellSession.prototype.run = async function (action, args) {
  remoteRuns++;
  this.audit('POWERSHELL_OPERATION_BEGIN', { action, parameters: args });
  if (action === 'connect') return { graph: true, exchange: false, tenant: args.tenant, account: 'analyst@contoso.com' };
  if (action === 'exchange') throw new Error('Simulated Exchange authentication failure');
  if (action === 'collect') {
    this.audit('POWERSHELL_QUERY', { command: 'Invoke-MgGraphRequest', parameters: { Uri: 'https://graph.microsoft.com/beta/auditLogs/signIns?$filter=test', user: args.user } });
    const base = { createdDateTime: args.start, userPrincipalName: args.user, appDisplayName: 'Exchange', ipAddress: '192.0.2.1', isInteractive: true, status: { errorCode: 0 } };
    return { rows: [
      { ...base, id: 'record-audit-1', authenticationRequirement: 'multiFactorAuthentication', conditionalAccessStatus: 'success', appliedConditionalAccessPolicies: [
        { id: 'policy-mfa', displayName: '<img src=x onerror=alert(1)> MFA', result: 'success', enforcedGrantControls: ['Mfa'] },
        { id: 'policy-report', displayName: 'Report policy', result: 'reportOnlyFailure' },
      ] },
      { ...base, id: 'record-audit-2', status: { errorCode: 50076, failureReason: 'MFA required' }, isInteractive: false, conditionalAccessStatus: 'failure', appliedConditionalAccessPolicies: [
        { id: 'policy-mfa', displayName: 'MFA', result: 'failure' }, { id: 'policy-other', displayName: 'Other policy', result: 'notApplied' },
      ] },
      { ...base, id: 'record-audit-3', status: { errorCode: 50126, failureReason: 'Invalid credentials' } },
      { ...base, id: 'record-audit-4', status: { errorCode: 500121, failureReason: 'MFA authentication failed' }, appliedConditionalAccessPolicies: [] },
    ] };
  }
  throw new Error('Unexpected action');
};
const timeout = setTimeout(() => { console.error('Logging smoke timed out'); app.exit(1); }, 20000);
app.on('quit', () => {
  if (!passed) return;
  try {
    const finalText = fs.readFileSync(currentLog, 'utf8');
    assert.match(finalText.trim().split('\n').at(-1), /SESSION_END/);
    console.log('PASS: normal shutdown finishes the investigation log');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const collected = await window.webContents.executeJavaScript(`(async () => {
        const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('UI wait timed out'); };
        await wait(() => !document.getElementById('connect').disabled);
        const log = (await window.bec.logInfo()).data;
        document.getElementById('auth-mode').value = 'device';
        document.getElementById('tenant').value = '11111111-1111-1111-1111-111111111111';
        document.getElementById('connect').click();
        await wait(() => !document.getElementById('collect').disabled);
        if (document.getElementById('graph-connection').dataset.tone !== 'success') throw new Error('Graph connection success indicator missing');
        document.getElementById('exchange').click();
        await wait(() => document.getElementById('exchange-connection').dataset.tone === 'failure');
        if (document.getElementById('graph-connection').dataset.tone !== 'success') throw new Error('Exchange failure incorrectly changed Graph status');
        if (document.getElementById('operation-status').dataset.tone !== 'failure') throw new Error('Connection failure message is not red');
        document.querySelector('[data-page="sign-ins"]').click();
        await wait(() => !document.getElementById('sign-in-module').hidden);
        document.getElementById('user').value = 'target@contoso.com';
        document.getElementById('query-form').requestSubmit();
        await wait(() => !document.getElementById('export-csv').disabled);
        const tones = [...document.querySelectorAll('#results-body tr')].map(row => row.dataset.tone);
        if (tones.join(',') !== 'success,warning,failure,failure') throw new Error('Incorrect sign-in status colours: ' + tones);
        document.querySelector('#results-body button:not(.cell-expand)').click();
        await wait(() => document.getElementById('record-json').textContent.includes('record-audit-1'));
        document.querySelector('[data-page="audit-logs"]').click();
        await wait(() => document.getElementById('page-title').textContent === 'Audit Logs');
        return log;
      })()`);
      const beforeCa = remoteRuns;
      const ca = await window.webContents.executeJavaScript(`(async () => {
        const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('CA UI wait timed out'); };
        document.querySelector('[data-page="sign-ins"]').click();
        await wait(() => document.getElementById('page-title').textContent === 'Sign in Exports');
        document.querySelector('[data-select-signin="record-audit-1"]').click();
        await wait(() => document.getElementById('selection-count').textContent.startsWith('1 '));
        document.getElementById('type-filter').value = 'noninteractive';
        document.getElementById('type-filter').dispatchEvent(new Event('input'));
        await wait(() => document.querySelectorAll('[data-select-signin]').length === 1);
        document.querySelector('[data-select-signin="record-audit-2"]').click();
        await wait(() => document.getElementById('selection-count').textContent.startsWith('2 '));
        document.getElementById('inspect-ca').click();
        await wait(() => !document.getElementById('ca-panel').hidden);
        const selectedEvents = document.querySelectorAll('.ca-event').length;
        const partial = document.getElementById('ca-events').textContent;
        document.querySelector('#ca-events button:not(.cell-expand)').click();
        await wait(() => document.getElementById('ca-policy-json').textContent.includes('policy-mfa'));
        const raw = document.getElementById('ca-policy-json').textContent;
        document.getElementById('type-filter').value = 'all';
        document.getElementById('type-filter').dispatchEvent(new Event('input'));
        await wait(() => document.querySelectorAll('[data-select-signin]').length === 4);
        document.getElementById('select-page').click();
        await wait(() => document.getElementById('selection-count').textContent.startsWith('4 '));
        document.getElementById('inspect-ca').click();
        await wait(() => document.querySelectorAll('.ca-event').length === 4);
        return { selectedEvents, partial, raw, full: document.getElementById('ca-events').textContent, safe: !document.querySelector('#ca-events img') };
      })()`);
      assert.equal(ca.selectedEvents, 2);
      for (const outcome of ['success', 'failure', 'notApplied', 'reportOnlyFailure']) assert.ok(ca.partial.includes(outcome));
      assert.match(ca.raw, /policy-mfa/);
      assert.match(ca.full, /Policy details were not returned/);
      assert.match(ca.full, /empty policy list/);
      assert.equal(ca.safe, true);
      assert.equal(remoteRuns, beforeCa, 'CA view must not perform additional remote queries');
      let text = fs.readFileSync(collected.file, 'utf8');
      for (const event of ['SESSION_BEGIN', 'GRAPH_CONNECTED', 'SIGNIN_COLLECTION_BEGIN', 'POWERSHELL_QUERY', 'SIGNIN_COLLECTION_COMPLETE', 'RECORD_EXPANDED', 'results_view', 'navigate']) assert.ok(text.includes(event), event);
      assert.ok(text.includes('target@contoso.com'));
      assert.ok(text.includes('record-audit-1'));
      for (const event of ['CONDITIONAL_ACCESS_VIEW', 'CONDITIONAL_ACCESS_POLICY_EXPANDED', 'sign_in_selection']) assert.ok(text.includes(event), event);
      const invalid = await window.webContents.executeJavaScript(`window.bec.conditionalAccess(['outside-current-evidence'])`);
      assert.equal(invalid.ok, false);
      const cancelled = await window.webContents.executeJavaScript(`window.bec.export('csv')`);
      assert.equal(cancelled.ok, true); assert.equal(cancelled.data, null);
      cancelExport = false;
      const saved = await window.webContents.executeJavaScript(`window.bec.export('csv')`);
      assert.equal(saved.ok, true);
      assert.ok(fs.readFileSync(saved.data, 'utf8').includes('record-audit-1'));
      text = fs.readFileSync(collected.file, 'utf8');
      assert.ok(text.includes('EXPORT_CANCELLED'));
      assert.ok(text.includes('EXPORT_WRITE_COMPLETE'));
      assert.match(text, /"sha256":"[a-f0-9]{64}"/);
      const reset = await window.webContents.executeJavaScript(`window.bec.reset()`);
      assert.equal(reset.ok, true);
      const next = await window.webContents.executeJavaScript(`window.bec.logInfo()`);
      assert.notEqual(next.data.id, collected.id);
      assert.match(fs.readFileSync(collected.file, 'utf8').trim().split('\n').at(-1), /SESSION_END/);
      assert.ok(!fs.readFileSync(next.data.file, 'utf8').includes('record-audit-1'));
      currentLog = next.data.file;
      console.log('PASS: production logging, exports, rotation, selected-sign-in CA view, per-event outcomes, missing/empty detail, raw policy expansion, safe text and no extra remote queries');
      passed = true; clearTimeout(timeout); app.quit();
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
require('../dist/main');

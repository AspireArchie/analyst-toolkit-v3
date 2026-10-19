// Exercise the real Electron window, including navigation and renderer isolation.
const assert = require('node:assert/strict');
const { app, ipcMain } = require('electron');
let mockState = { graph: false, exchange: false, tenant: '', account: '' };
let mockQuery;
let failCollection = false;

const timeout = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 20000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const wait = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('UI wait timed out'); };
        await wait(() => !document.getElementById('connect').disabled);
        const title = () => document.getElementById('page-title').textContent;
        const initial = title();
        document.querySelector('[data-page="audit-logs"]').click();
        await wait(() => title() === 'Audit Logs');
        const audit = title();
        const activeCount = document.querySelectorAll('[aria-current="page"]').length;
        document.querySelector('[data-page="sign-ins"]').click();
        await wait(() => title() === 'Sign in Exports');
        return { initial, audit, returned: title(), activeCount, nodeAccess: typeof require };
      })()`);
      assert.deepEqual(result, {
        initial: 'Session', audit: 'Audit Logs', returned: 'Sign in Exports',
        activeCount: 1, nodeAccess: 'undefined',
      });
      const workflow = await window.webContents.executeJavaScript(`(async () => {
        const wait = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('UI wait timed out'); };
        await wait(() => !document.getElementById('connect').disabled);
        document.getElementById('open-session').click();
        await wait(() => !document.getElementById('session-module').hidden);
        document.getElementById('tenant').value = '11111111-1111-1111-1111-111111111111';
        document.getElementById('connect').click();
        await wait(() => !document.getElementById('collect').disabled);
        document.querySelector('[data-page="sign-ins"]').click();
        await wait(() => !document.getElementById('sign-in-module').hidden);
        document.getElementById('user').value = 'user@contoso.com';
        document.getElementById('query-form').requestSubmit();
        await wait(() => !document.getElementById('export-csv').disabled);
        if (document.querySelector('#results-body tr:nth-child(2) .status-badge').dataset.tone !== 'warning') throw new Error('MFA interrupt badge should be yellow');
        const count = document.getElementById('results-heading').textContent;
        const safe = !document.querySelector('#results-body img');
        document.querySelector('#results-body button:not(.cell-expand)').click();
        await wait(() => document.getElementById('record-json').textContent.includes('test-record'));
        const raw = document.getElementById('record-json').textContent;
        document.getElementById('type-filter').value = 'noninteractive';
        document.getElementById('type-filter').dispatchEvent(new Event('input'));
        await wait(() => document.querySelectorAll('#results-body tr').length === 1);
        const filtered = document.querySelectorAll('#results-body tr').length;
        document.getElementById('range').value = 'custom';
        document.getElementById('range').dispatchEvent(new Event('change'));
        await wait(() => !document.getElementById('custom-range').hidden);
        const custom = !document.getElementById('custom-range').hidden;
        document.querySelector('[data-page="audit-logs"]').click();
        await wait(() => document.getElementById('page-title').textContent === 'Audit Logs');
        document.getElementById('open-session').click();
        await wait(() => !document.getElementById('session-module').hidden);
        const sessionRetained = document.getElementById('session-status').textContent.includes('analyst@contoso.com');
        document.querySelector('[data-page="sign-ins"]').click();
        await wait(() => document.getElementById('page-title').textContent === 'Sign in Exports');
        const retained = document.getElementById('results-heading').textContent;
        return { count, safe, raw, filtered, custom, retained, sessionRetained, sessionHidden: document.getElementById('session-module').hidden };
      })()`);
      assert.equal(workflow.count, 'Sign-ins · 2 records');
      assert.equal(workflow.retained, workflow.count);
      assert.equal(workflow.safe, true);
      assert.match(workflow.raw, /test-record/);
      assert.equal(workflow.filtered, 1);
      assert.equal(workflow.custom, true);
      assert.equal(workflow.sessionRetained, true);
      assert.equal(workflow.sessionHidden, true);
      assert.equal(mockQuery.user, 'user@contoso.com');
      assert.ok(Math.abs(Date.parse(mockQuery.end) - Date.parse(mockQuery.start) - 86400000) < 1000);
      failCollection = true;
      const failure = await window.webContents.executeJavaScript(`(async () => {
        document.getElementById('range').value = '24';
        document.getElementById('range').dispatchEvent(new Event('change'));
        for (let i = 0; i < 100 && !document.getElementById('custom-range').hidden; i++) await new Promise(r => setTimeout(r, 20));
        document.getElementById('query-form').requestSubmit();
        for (let i = 0; i < 100; i++) {
          if (document.getElementById('operation-status').textContent.includes('Simulated')) break;
          await new Promise(r => setTimeout(r, 20));
        }
        return { count: document.getElementById('results-heading').textContent, disabled: document.getElementById('export-csv').disabled, error: document.getElementById('operation-status').textContent };
      })()`);
      assert.equal(failure.count, 'Sign-ins · 0 records');
      assert.equal(failure.disabled, true);
      assert.match(failure.error, /Simulated/);
      console.log('PASS: navigation, isolation, preload bridge, connection UI, collection rendering, type filter, raw record, date preset, persistence across tabs and failure cleanup');
      clearTimeout(timeout);
      app.exit(0);
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    }
  });
});
require('../dist/main.js');
// Replace only IPC handlers in this test process; no real authentication takes place.
void app.whenReady().then(() => {
  const handlers = {
    audit: () => ({ ok: true, data: null }),
    state: () => ({ ok: true, data: mockState }),
    connect: (_event, { tenant, mode }) => {
      assert.equal(mode, 'browser');
      mockState = { graph: true, exchange: false, tenant, account: 'analyst@contoso.com' };
      return { ok: true, data: mockState };
    },
    collect: (_event, query) => {
      mockQuery = query;
      if (failCollection) return { ok: false, error: 'Simulated permission failure' };
      return { ok: true, data: { query, tenant: mockState.tenant, collectedAt: new Date().toISOString(), rows: [
        { id: 'test-record-1', createdDateTime: query.start, userPrincipalName: query.user, appDisplayName: '<img src=x onerror=alert(1)>', ipAddress: '192.0.2.1', isInteractive: true, status: { errorCode: 0 } },
        { id: 'test-record-2', createdDateTime: query.end, userPrincipalName: query.user, appDisplayName: 'Exchange', ipAddress: '192.0.2.2', isInteractive: false, status: { errorCode: 50076, failureReason: 'MFA required' } },
      ] } };
    },
  };
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler('bec:' + name);
    ipcMain.handle('bec:' + name, handler);
  }
});

// Exercise the production IPC + browser handoff without Microsoft authentication.
const assert = require('node:assert/strict');
const { app, shell } = require('electron');
const { PowerShellSession } = require('../dist/powershell');
let opened = [];
let runs = 0;
shell.openExternal = async url => { opened.push(url); };
PowerShellSession.prototype.run = async function (action, args) {
  assert.equal(action, 'connect');
  runs++;
  this.log('To sign in, open https://microsoft.com/devicelogin and enter the code TESTCODE1');
  this.log('Repeat: https://microsoft.com/devicelogin');
  return { graph: true, exchange: false, tenant: args.tenant, account: 'analyst@contoso.com' };
};
const timeout = setTimeout(() => { console.error('Auth smoke timed out'); app.exit(1); }, 15000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const browser = await window.webContents.executeJavaScript(`(async () => {
        const result = await window.bec.connect('11111111-1111-1111-1111-111111111111', 'browser');
        await new Promise(resolve => setTimeout(resolve, 30));
        return { result, output: document.getElementById('session-output').textContent, expanded: document.getElementById('session-output').parentElement.open };
      })()`);
      assert.equal(browser.result.ok, true);
      assert.match(browser.output, /TESTCODE1/);
      assert.equal(browser.expanded, true);
      assert.deepEqual(opened, ['https://microsoft.com/devicelogin']);
      await window.webContents.executeJavaScript(`window.bec.reset()`);
      const manual = await window.webContents.executeJavaScript(`window.bec.connect('11111111-1111-1111-1111-111111111111', 'device')`);
      assert.equal(manual.ok, true);
      assert.equal(opened.length, 1, 'Manual device mode must not launch a browser');
      await window.webContents.executeJavaScript(`window.bec.reset()`);
      const invalid = await window.webContents.executeJavaScript(`window.bec.connect('11111111-1111-1111-1111-111111111111', 'invalid')`);
      assert.equal(invalid.ok, false);
      assert.equal(runs, 2);
      console.log('PASS: production auth IPC, visible instructions, single browser launch, manual fallback, invalid mode rejection');
      clearTimeout(timeout); app.exit(0);
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
require('../dist/main');

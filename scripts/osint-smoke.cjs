const assert = require('node:assert/strict');
const { app, ipcMain, shell } = require('electron');
let fixtureMode = 'threat', opened;
shell.openExternal = async url => { opened = url; };
const timeout = setTimeout(() => { console.error('OSINT UI smoke timed out'); app.exit(1); }, 30000);
app.on('browser-window-created', (_, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const wait = async (p) => { for(let i=0;i<100;i++){if(p())return;await new Promise(r=>setTimeout(r,20));}throw Error('timeout'); };
        document.querySelector('[data-page="settings"]').click();
        await wait(()=>document.getElementById('key-status-virustotal').textContent === 'Not configured');
        document.getElementById('key-virustotal').value = 'test-key';
        document.getElementById('keys-form').requestSubmit();
        await wait(()=>document.getElementById('keys-status').textContent.includes('saved securely'));
        const cleared = document.getElementById('key-virustotal').value === '';
        document.querySelector('[data-page="toolkit"]').click();
        await wait(()=>!document.getElementById('toolkit-module').hidden);
        document.getElementById('indicator').value = '8.8.8.8';
        document.getElementById('osint-form').requestSubmit();
        await wait(()=>document.querySelectorAll('.osint-card').length === 3);
        return { cleared, hidden: document.querySelector('.shared-session').hidden, tone: document.querySelector('.osint-card').dataset.tone, expanded: document.querySelectorAll('#osint-results details[open]').length, text: document.getElementById('osint-results').textContent, injection: !!document.querySelector('#osint-results img') };
      })()`);
      assert.ok(result.cleared && result.hidden && !result.injection);
      assert.match(result.text, /AS15169/); assert.match(result.text, /quota/); assert.match(result.text, /Trojan.Test/); assert.ok(!result.text.includes('AT A GLANCE'));
      assert.equal(result.tone, 'failure'); assert.equal(result.expanded, 0);
      await window.webContents.executeJavaScript(`document.querySelector('.report-link').click()`);
      await new Promise(r => setTimeout(r, 150));
      assert.equal(opened, 'https://www.virustotal.com/gui/ip-address/8.8.8.8/detection');
      const { writeFileSync } = require('node:fs');
      if (process.env.BEC_SMOKE_SCREENSHOT === '1') {
        try { writeFileSync(require('node:path').join(__dirname, '../osint-preview.png'), (await window.webContents.capturePage()).toPNG()); } catch (error) { console.log('Screenshot unavailable:', error.message); }
      }
      for (const mode of ['clear', 'unknown', 'reports', 'suspicious', 'blocklist']) {
        fixtureMode = mode;
        const tone = await window.webContents.executeJavaScript(`(async () => {
          document.getElementById('osint-form').requestSubmit();
          for(let i=0;i<100;i++){if(!document.getElementById('lookup').disabled)break;await new Promise(r=>setTimeout(r,20));}
          const reports = [...document.querySelectorAll('.all-abuse-reports')];
          if (reports.length) {
            const card = reports[0].closest('.osint-card');
            const snippets = card.querySelectorAll(':scope > .abuse-reports .abuse-report');
            if (snippets.length !== 3 || !snippets[0].textContent.includes('newest')) throw Error('Recent reports not sorted/limited');
            if (card.querySelector('img')) throw Error('Unsafe report comment');
            reports[0].open = true;
            await new Promise(r=>setTimeout(r,50));
            if (reports[0].querySelectorAll('.abuse-report').length !== 4) throw Error('Full report list missing');
          }
          return document.querySelector('.osint-status-bar').dataset.tone;
        })()`);
        assert.equal(tone, mode === 'clear' ? 'success' : mode === 'unknown' ? 'neutral' : 'failure');
      }
      fixtureMode = 'md5';
      const hashResult = await window.webContents.executeJavaScript(`(async () => {
        document.getElementById('indicator').value = 'a'.repeat(32);
        document.getElementById('osint-form').requestSubmit();
        for(let i=0;i<100;i++){if(!document.getElementById('lookup').disabled)break;await new Promise(r=>setTimeout(r,20));}
        const link = document.querySelector('.report-link'); link.click();
        return { cards: document.querySelectorAll('.osint-card').length, url: link.href, text: document.getElementById('osint-results').textContent };
      })()`);
      assert.equal(hashResult.cards, 1); assert.match(hashResult.text, /Publisher/);
      assert.equal(hashResult.url, 'https://www.virustotal.com/gui/file/'+'a'.repeat(32)+'/detection');
      await new Promise(r=>setTimeout(r,100)); assert.equal(opened, hashResult.url);
      const styles = await window.webContents.executeJavaScript(`(async () => {
        const styles = [];
        for (const button of document.querySelectorAll('[data-page]')) {
          button.click();
          for(let i=0;i<100;i++){if(button.classList.contains('active'))break;await new Promise(r=>setTimeout(r,20));}
          const css = getComputedStyle(button); styles.push([css.backgroundColor,css.borderColor,css.color]);
        }
        return styles;
      })()`);
      assert.equal(styles.length, 13); assert.ok(styles.every(style => JSON.stringify(style) === JSON.stringify(styles[0])));
      console.log('OSINT UI smoke passed'); clearTimeout(timeout); app.exit(0);
    } catch(e) { console.error(e); clearTimeout(timeout); app.exit(1); }
  });
});
require('../dist/main.js');
app.whenReady().then(() => {
  const handlers = {
    'key-status': () => ({virustotal:false, abuseipdb:false, ipdata:false}),
    'save-keys': (_, value) => { assert.deepEqual(value, {virustotal:'test-key'}); return {virustotal:true, abuseipdb:false, ipdata:false}; },
    osint: () => {
      if (fixtureMode === 'md5') return { indicator:'a'.repeat(32), kind:'md5', queriedAt:new Date().toISOString(), results: [
        {provider:'virustotal',status:'ok',data:{meaningful_name:'sample.exe',signature_info:{verified:'Signed',signers:'Publisher'},last_analysis_stats:{malicious:0,suspicious:0,undetected:70}}},
        {provider:'abuseipdb',status:'skipped'}, {provider:'ipdata',status:'skipped'}
      ]};
      const base = { indicator: '8.8.8.8', kind: 'ip', queriedAt: new Date().toISOString() };
      if (fixtureMode === 'threat') return { ...base, results: [
        {provider:'virustotal',status:'ok',data:{as_owner:'<img src=x>',asn:15169,country:'US',last_analysis_stats:{malicious:2},last_analysis_results:{Engine:{category:'malicious',result:'Trojan.Test'}}}},
        {provider:'abuseipdb',status:'error',message:'Rate limit or quota exceeded.'},
        {provider:'ipdata',status:'ok',data:{asn:{asn:'AS15169',name:'Google'},country_name:'United States',threat:{is_threat:false}}}
      ]};
      return { ...base, results: ['virustotal', 'abuseipdb', 'ipdata'].map(provider => {
        const data = fixtureMode === 'unknown' ? {} : {last_analysis_stats:{malicious:0,suspicious:0,undetected:70},abuseConfidenceScore:0,totalReports:0,threat:{is_threat:false}};
        if (fixtureMode === 'reports' && provider === 'abuseipdb') {
          data.totalReports = 4;
          data.reports = [1,4,2,3].map(day => ({ reportedAt: '2026-10-0'+day+'T12:00:00Z', reporterId: day, reporterCountryCode: 'GB', categories:[18,22], comment: day === 4 ? 'newest <img src=x> SSH brute force' : 'Attempted login' }));
        }
        if (fixtureMode === 'suspicious' && provider === 'virustotal') data.last_analysis_stats.suspicious = 1;
        if (fixtureMode === 'blocklist' && provider === 'ipdata') data.threat.blocklists = [{name:'Test list'}];
        return {provider,status:'ok',data};
      })};
    }
  };
  for(const [name, handler] of Object.entries(handlers)){ipcMain.removeHandler('bec:'+name);ipcMain.handle('bec:'+name,(...args)=>({ok:true,data:handler(...args)}));}
});

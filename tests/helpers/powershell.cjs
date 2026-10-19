const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
module.exports = function runPowerShell(commands, fixture = 'tests/session-fixture.ps1') {
  return new Promise((resolve, reject) => {
    const worker = spawn('pwsh.exe', ['-NoProfile', '-File', fixture], { windowsHide: true });
    const results = [], queries = []; let output = '', error = '';
    const timer = setTimeout(() => { worker.kill(); reject(new Error('PowerShell test timed out')); }, 20000);
    worker.on('error', e => { clearTimeout(timer); reject(e); });
    worker.stderr.on('data', chunk => { error += chunk; });
    createInterface({ input: worker.stdout }).on('line', line => {
      output += line + '\n';
      if (line.startsWith('BEC_AUDIT:')) { queries.push(JSON.parse(line.slice(10))); worker.stdin.write('BEC_AUDIT_OK\n'); }
      if (line.startsWith('BEC_RESULT:')) {
        results.push(JSON.parse(line.slice(11)));
        if (results.length < commands.length) worker.stdin.write(JSON.stringify(commands[results.length]) + '\n'); else worker.stdin.end();
      }
    });
    worker.on('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(error || String(code))); else resolve({ results, queries, output }); });
    worker.stdin.write(JSON.stringify(commands[0]) + '\n');
  });
};

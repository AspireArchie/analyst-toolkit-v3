import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

// One long-lived PowerShell 7 process shares authentication across app modules.
export class PowerShellSession {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  constructor(private log: (message: string) => void, private closed: () => void,
    private audit: (event: string, details: unknown) => void) {}

  run(action: string, args: object = {}): Promise<unknown> {
    if (this.pending) return Promise.reject(new Error('Another session operation is still running.'));
    this.audit('POWERSHELL_OPERATION_BEGIN', { action, parameters: args });
    if (!this.child) {
      const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-File', path.join(__dirname, '../powershell/session.ps1')], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        if (this.child !== child) return;
        try {
          if (line.startsWith('BEC_AUDIT:')) {
            this.audit('POWERSHELL_QUERY', JSON.parse(line.slice(10)));
            // The script must wait for durable logging before executing the query.
            child.stdin.write('BEC_AUDIT_OK\n');
            return;
          }
          if (!line.startsWith('BEC_RESULT:')) { if (line.trim()) this.log(line); return; }
          const result = JSON.parse(line.slice(11));
          this.audit('POWERSHELL_OPERATION_END', { action, ok: result.ok, error: result.error });
          const pending = this.pending;
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending = undefined;
          if (result.ok) pending.resolve(result.data);
          else pending.reject(new Error(result.error));
        } catch (error) { this.stop(`PowerShell stopped to preserve investigation logging: ${error instanceof Error ? error.message : error}`); }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (this.child !== child) return;
        try { this.log(chunk.toString('utf8')); }
        catch (error) { this.stop(String(error)); }
      });
      child.on('error', (error) => {
        if (this.child === child) this.stop(`PowerShell 7 could not start: ${error.message}. Install PowerShell 7 and put pwsh.exe on PATH.`);
      });
      child.on('exit', () => { if (this.child === child) this.stop('PowerShell session ended. Please reconnect.'); });
      child.stdin.on('error', () => { if (this.child === child) this.stop('PowerShell input closed. Please reconnect.'); });
    }
    return new Promise((resolve, reject) => {
      const minutes = ['collect-ual', 'collect-m365'].includes(action) ? 60 : 15;
      const timer = setTimeout(() => this.stop(`Operation timed out after ${minutes} minutes. Session cleared; reconnect to retry.`), minutes * 60_000);
      this.pending = { resolve, reject, timer };
      this.child!.stdin.write(JSON.stringify({ action, ...args }) + '\n');
    });
  }

  stop(reason = 'Session reset.'): void {
    const child = this.child;
    this.child = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error(reason));
      this.pending = undefined;
    }
    child?.kill();
    try { this.closed(); } catch { /* A failed log must never prevent stopping the worker. */ }
  }
}

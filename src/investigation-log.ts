import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Keep credentials out of a permanent investigation transcript.
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED TOKEN]')
    .replace(/(\b(?:enter(?:\s+the)?|use(?:\s+the)?)\s+code\s*[:=]?\s*)[A-Z0-9-]{6,}/gi, '$1[REDACTED CODE]')
    .replace(/((?:access_token|refresh_token|id_token|device_code|user_code|client_secret|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:access_?token|refresh_?token|id_?token|device_?code|user_?code|client_?secret|password|authorization)$/i.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}

export class InvestigationLog {
  readonly id = randomUUID();
  readonly file: string;
  private sequence = 0;
  private ended = false;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, `investigation_${new Date().toISOString().replace(/[:.]/g, '-')}_${this.id}.txt`);
    const fd = openSync(this.file, 'wx'); closeSync(fd);
    this.write('SESSION_BEGIN', { investigationId: this.id, pid: process.pid, format: 'UTC timestamp | sequence | event | JSON details' });
  }

  write(event: string, details: unknown = {}): void {
    if (this.ended) throw new Error('Investigation log is already closed.');
    try {
      const line = `${new Date().toISOString()} | ${++this.sequence} | ${event} | ${JSON.stringify(redact(details))}\r\n`;
      const fd = openSync(this.file, 'a');
      try {
        const data = Buffer.from(line, 'utf8');
        let offset = 0;
        while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    } catch (error) {
      throw new Error(`Investigation logging failed; action blocked. ${error instanceof Error ? error.message : error}`);
    }
  }

  end(reason: string): void {
    if (this.ended) return;
    this.write('SESSION_END', { reason }); this.ended = true;
  }
}

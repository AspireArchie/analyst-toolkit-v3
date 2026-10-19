import { safeStorage } from 'electron';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { providers } from './osint';
import type { Provider } from './contracts';
export class ApiKeyStore {
  constructor(private file: string) {}
  async read(): Promise<Partial<Record<Provider, string>>> {
    let bytes: Buffer;
    try { bytes = await readFile(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Could not read API key settings.'); }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure API key storage is unavailable.');
    try { return JSON.parse(safeStorage.decryptString(bytes)); } catch { throw new Error('Could not decrypt API keys for this Windows account.'); }
  }
  async status(): Promise<Record<Provider, boolean>> {
    const keys = await this.read();
    return Object.fromEntries(providers.map(p => [p, Boolean(keys[p])])) as Record<Provider, boolean>;
  }
  async update(value: unknown): Promise<Record<Provider, boolean>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid API key settings.');
    const changes = value as Record<string, unknown>;
    for (const [name, key] of Object.entries(changes)) {
      if (!providers.includes(name as Provider) || typeof key !== 'string' || key.length > 1024 || /[^\x21-\x7e]/.test(key)) throw new Error('Invalid API key. Use a key without spaces.');
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure API key storage is unavailable.');
    const keys = { ...await this.read(), ...changes };
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file + '.tmp', safeStorage.encryptString(JSON.stringify(keys)));
    await rename(this.file + '.tmp', this.file);
    return this.status();
  }
}

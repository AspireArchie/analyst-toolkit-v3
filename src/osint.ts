import { isIP } from 'node:net';
import type { OsintReport, Provider, ProviderResult } from './contracts';
export const providers: Provider[] = ['virustotal', 'abuseipdb', 'ipdata'];
export function validateIndicator(value: unknown): { indicator: string; kind: 'ip' | 'md5' | 'sha1' | 'sha256' } {
  if (typeof value !== 'string') throw new Error('Enter an IPv4, IPv6, MD5, SHA-1 or SHA-256 indicator.');
  // Restore common defanging delimiters, then validate the entire result as an IP.
  // Never extract an address from surrounding prose or silently drop invalid octets.
  let indicator = value.trim();
  if (indicator.length > 512) throw new Error('Indicator is too long.');
  indicator = indicator.replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[\uff0e\u3002\uff61]/g, '.')
    .replace(/\[\s*(?:\.|dot)\s*\]|\(\s*(?:\.|dot)\s*\)|\{\s*(?:\.|dot)\s*\}|\\\./gi, '.')
    .replace(/\[\s*(?::|colon)\s*\]|\(\s*(?::|colon)\s*\)|\{\s*(?::|colon)\s*\}/gi, ':')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s*([.:])\s*/g, '$1');
  if ((indicator.startsWith('"') && indicator.endsWith('"')) || (indicator.startsWith("'") && indicator.endsWith("'")) || (indicator.startsWith('`') && indicator.endsWith('`'))) indicator = indicator.slice(1, -1).trim();
  if (indicator.startsWith('[') && indicator.endsWith(']')) indicator = indicator.slice(1, -1).trim();
  if (!indicator.includes('%') && isIP(indicator)) return { indicator, kind: 'ip' };
  if (/^[a-f\d]+$/i.test(indicator)) {
    const kind = ({ 32: 'md5', 40: 'sha1', 64: 'sha256' } as const)[indicator.length as 32 | 40 | 64];
    if (kind) return { indicator: indicator.toLowerCase(), kind };
  }
  throw new Error('Enter a valid IP address or hexadecimal MD5 (32), SHA-1 (40) or SHA-256 (64) hash.');
}
export async function lookup(value: unknown, keys: Partial<Record<Provider, string>>, request: typeof fetch = fetch): Promise<OsintReport> {
  const { indicator, kind } = validateIndicator(value);
  const results = await Promise.all(providers.map(async (provider): Promise<ProviderResult> => {
    if (kind !== 'ip' && provider !== 'virustotal') return { provider, status: 'skipped', message: 'IP addresses only; not applicable to a file hash.' };
    const key = keys[provider];
    if (!key) return { provider, status: 'skipped', message: 'Add an API key in Settings.' };
    const encoded = encodeURIComponent(indicator);
    let url: string;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (provider === 'virustotal') { url = `https://www.virustotal.com/api/v3/${kind === 'ip' ? 'ip_addresses' : 'files'}/${encoded}`; headers['x-apikey'] = key; }
    else if (provider === 'abuseipdb') { url = `https://api.abuseipdb.com/api/v2/check?ipAddress=${encoded}&maxAgeInDays=90&verbose=true`; headers.Key = key; }
    else url = `https://api.ipdata.co/${encoded}?api-key=${encodeURIComponent(key)}`;
    try {
      const response = await request(url, { headers, signal: AbortSignal.timeout(20000), redirect: 'error' });
      if (!response.ok) {
        const messages: Record<number, string> = { 401: 'API key rejected.', 403: 'Access denied; check API key and plan.', 404: 'No report found.', 429: 'Rate limit or quota exceeded. Try again later.' };
        return { provider, status: 'error', message: messages[response.status] ?? `Provider returned HTTP ${response.status}.` };
      }
      const body = await response.json() as any;
      const data = provider === 'virustotal' ? body?.data?.attributes : provider === 'abuseipdb' ? body?.data : body;
      if (!data || typeof data !== 'object' || Array.isArray(data) || body.error || body.message) throw new Error();
      return { provider, status: 'ok', data };
    } catch { return { provider, status: 'error', message: 'Lookup failed: network, timeout or invalid provider response. Try again.' }; }
  }));
  return { indicator, kind, queriedAt: new Date().toISOString(), results };
}

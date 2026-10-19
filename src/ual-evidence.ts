import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { validateQuery } from './evidence';
import type { UalCollection, UalFilters, UalQuery, UalRecord } from './contracts';

export const becOperations = ['MailItemsAccessed', 'Send', 'SendAs', 'SendOnBehalf', 'HardDelete', 'SoftDelete', 'MoveToDeletedItems', 'New-InboxRule', 'Set-InboxRule', 'Remove-InboxRule', 'UpdateInboxRules', 'Set-Mailbox', 'Add-MailboxPermission'];
export function validateUalQuery(value: unknown): UalQuery {
  const base = validateQuery(value), ops = (value as UalQuery).operations;
  if (!Array.isArray(ops) || ops.length > 100 || !ops.every(op => typeof op === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(op))) throw new Error('Operations must be names separated by commas; leave blank for all operations.');
  return { ...base, operations: [...new Set(ops)] };
}

export function normalizeIP(value: string): string | null {
  let ip = value.trim().replace(/\[\.\]|\(\.\)/g, '.').replace(/\[:\]|\(:\)/g, ':');
  const bracket = ip.match(/^\[([^\]]+)\](?::\d{1,5})?$/);
  if (bracket) ip = bracket[1];
  const v4port = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/);
  if (v4port) ip = v4port[1];
  ip = ip.replace(/%[^:]+$/, '');
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family === 6) {
    const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1).toLowerCase();
    if (canonical.startsWith('::ffff:')) {
      const pieces = canonical.slice(7).split(':');
      if (pieces.length === 2) { const number = parseInt(pieces[0], 16) * 65536 + parseInt(pieces[1], 16); return [24, 16, 8, 0].map(shift => (number >>> shift) & 255).join('.'); }
    }
    return canonical;
  }
  return null;
}
function numericIP(ip: string): { bits: number; value: bigint } {
  if (isIP(ip) === 4) return { bits: 32, value: ip.split('.').reduce((value, part) => value * 256n + BigInt(part), 0n) };
  const halves = ip.split('::'), left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return { bits: 128, value: parts.reduce((value, part) => value * 65536n + BigInt(parseInt(part, 16)), 0n) };
}
function networks(text: string) {
  return text.split(/[\s,;]+/).filter(Boolean).map(token => {
    const parts = token.split('/'), ip = normalizeIP(parts[0]);
    if (!ip || parts.length > 2) throw new Error(`Invalid IP address or CIDR: ${token}`);
    const numeric = numericIP(ip), prefix = parts.length === 2 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : parts.length === 1 ? numeric.bits : -1;
    if (prefix < 0 || prefix > numeric.bits) throw new Error(`Invalid CIDR prefix: ${token}`);
    return { ...numeric, prefix };
  });
}
export function validateUalFilters(value: unknown): UalFilters {
  const filters = value as UalFilters;
  if (!filters || !['search', 'includeIPs', 'excludeIPs', 'operation', 'workload'].every(key => typeof (filters as any)[key] === 'string' && (filters as any)[key].length <= 10000) || !['all', 'known', 'unknown'].includes(filters.ipMode) || !['all', 'success', 'failure', 'other'].includes(filters.result)) throw new Error('Invalid UAL filters.');
  networks(filters.includeIPs); networks(filters.excludeIPs); return filters;
}
export function filterUal(records: UalRecord[], filters: UalFilters): UalRecord[] {
  const include = networks(filters.includeIPs), exclude = networks(filters.excludeIPs), search = filters.search.toLowerCase();
  const matches = (ips: string[], ranges: ReturnType<typeof networks>) => ips.some(ip => {
    const numeric = numericIP(ip);
    return ranges.some(range => range.bits === numeric.bits && (numeric.value >> BigInt(numeric.bits - range.prefix)) === (range.value >> BigInt(range.bits - range.prefix)));
  });
  return records.filter(row => (!include.length || matches(row.normalizedIPs, include)) && !matches(row.normalizedIPs, exclude) &&
    (filters.ipMode === 'all' || filters.ipMode === 'known' && row.normalizedIPs.length > 0 || filters.ipMode === 'unknown' && row.normalizedIPs.length === 0) &&
    (!filters.operation || filters.operation === 'all' || row.operation === filters.operation) &&
    (!filters.workload || filters.workload === 'all' || row.workload === filters.workload) &&
    (filters.result === 'all' || filters.result === 'other' && row.tone === 'neutral' || filters.result === row.tone) &&
    (!search || JSON.stringify(row).toLowerCase().includes(search)));
}
function utc(value: unknown): string {
  if (!value) return '';
  let text = String(value); if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(text) && !/(?:Z|[+-]\d\d:\d\d)$/.test(text)) text += 'Z';
  const time = Date.parse(text); return Number.isFinite(time) ? new Date(time).toISOString() : '';
}
export function buildUalCollection(query: UalQuery, tenant: string, result: { rows: Record<string, any>[]; retrieval?: Record<string, any>; auditChecks?: Record<string, any>[] }): UalCollection {
  const records: UalRecord[] = [], seen = new Set<string>();
  for (const raw of result.rows) {
    let data: Record<string, any> | null = null, parseError: string | undefined;
    try { const parsed = typeof raw.AuditData === 'string' ? JSON.parse(raw.AuditData) : raw.AuditData; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); data = parsed; }
    catch { parseError = 'AuditData could not be parsed; original record retained.'; }
    const id = String(data?.Id ?? raw.Identity ?? createHash('sha256').update(typeof raw.AuditData === 'string' ? raw.AuditData : JSON.stringify(raw)).digest('hex'));
    if (seen.has(id)) continue;
    const time = utc(data?.CreationTime ?? raw.CreationDate);
    if (time && (Date.parse(time) < Date.parse(query.start) || Date.parse(time) >= Date.parse(query.end))) continue;
    seen.add(id);
    const ipValues = ['ClientIP', 'ClientIPAddress', 'IPAddress', 'ActorIpAddress', 'ActorIP'].flatMap(key => data?.[key] === undefined ? [] : Array.isArray(data[key]) ? data[key].map(String) : [String(data[key])]);
    const normalizedIPs = [...new Set(ipValues.flatMap(ip => ip.split(/[,;\s]+/).map(normalizeIP).filter((value): value is string => Boolean(value))))];
    const resultText = String(data?.ResultStatus ?? ''), status = resultText.toLowerCase();
    const tone = ['success', 'succeeded', 'true'].includes(status) ? 'success' as const : ['failed', 'failure', 'false'].includes(status) ? 'failure' as const : 'neutral' as const;
    records.push({ id, time, operation: String(data?.Operation ?? (Array.isArray(raw.Operations) ? raw.Operations.join('; ') : raw.Operations ?? '')), user: String(data?.UserId ?? (Array.isArray(raw.UserIds) ? raw.UserIds.join('; ') : raw.UserIds ?? query.user)), workload: String(data?.Workload ?? ''), recordType: String(data?.RecordType ?? raw.RecordType ?? ''), clientIP: ipValues.join('; '), normalizedIPs, result: resultText, tone, object: String(data?.ObjectId ?? data?.OfficeObjectId ?? ''), parseError, auditData: data, raw });
  }
  records.sort((a, b) => b.time.localeCompare(a.time));
  const auditChecks = result.auditChecks ?? [], evidenceGaps: string[] = [];
  const check = (name: string) => auditChecks.find(item => item.check === name);
  if (!records.length) {
    if (check('organization')?.data?.AuditDisabled === true) evidenceGaps.push('Organization-wide mailbox auditing is disabled (current configuration).');
    if (check('ingestion')?.data?.UnifiedAuditLogIngestionEnabled === false) evidenceGaps.push('Unified audit ingestion is disabled (current configuration).');
    if (check('bypass')?.data?.AuditBypassEnabled === true) evidenceGaps.push('Audit bypass is enabled for the specified account (current configuration).');
    if (check('mailbox')?.data?.AuditEnabled === false && check('organization')?.data?.AuditDisabled !== false) evidenceGaps.push('Mailbox AuditEnabled is false; effective auditing could not be confirmed.');
    const failed = auditChecks.filter(item => !item.ok).map(item => item.check);
    if (failed.length) evidenceGaps.push(`Auditing configuration could not be verified for: ${failed.join(', ')}.`);
    const missing = [['organization', 'AuditDisabled'], ['ingestion', 'UnifiedAuditLogIngestionEnabled'], ['mailbox', 'AuditEnabled'], ['bypass', 'AuditBypassEnabled']].filter(([name, field]) => check(name)?.ok && typeof check(name)?.data?.[field] !== 'boolean').map(([name]) => name);
    if (missing.length) evidenceGaps.push(`Auditing settings were not returned for: ${missing.join(', ')}.`);
    if (!auditChecks.length) evidenceGaps.push('No matching events; mailbox/organization auditing configuration was not verified.');
  }
  const notes = ['Audit metadata only.', 'Search-UnifiedAuditLog UserIds scopes the audited user/actor. Actions by other administrators or delegates targeting this mailbox can require separate searches.', 'View IP filters apply to captured ClientIP/ClientIPAddress/IPAddress/ActorIpAddress/ActorIP fields. Missing or unparseable IPs remain visible unless an include-IP or known-IP filter removes them.'];
  if (!records.length) notes.push('No matching events were returned. Current auditing checks do not prove that auditing was enabled during the incident; retention, ingestion delay, query scope and audited operations also affect coverage.');
  if (result.retrieval?.highCompleteness !== true) notes.push('HighCompleteness was unavailable for this connection; Microsoft search completeness limitations may apply.');
  if (records.some(row => row.parseError || !row.time)) notes.push('Some records have missing timestamps or unparseable AuditData. They are retained for inspection.');
  return { query, tenant, collectedAt: new Date().toISOString(), records, retrieval: result.retrieval ?? {}, auditChecks, evidenceGaps, notes };
}
export function ualCsv(collection: UalCollection, records: UalRecord[], scope: string, filters: UalFilters): string {
  const headers = ['id','timeUtc','operation','user','workload','recordType','clientIP','normalizedIPs','result','object','parseError','queryUser','rangeStartUtc','rangeEndUtc','queryOperations','tenant','collectedAtUtc','exportScope','viewFiltersJson','evidenceGapsJson','auditChecksJson','retrievalJson','coverageNotesJson','auditDataJson','rawRecordJson'];
  const cell = (value: unknown) => { let text = String(value ?? ''); if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; };
  const rows = records.map(r => [r.id,r.time,r.operation,r.user,r.workload,r.recordType,r.clientIP,r.normalizedIPs.join('; '),r.result,r.object,r.parseError,collection.query.user,collection.query.start,collection.query.end,collection.query.operations.join('; '),collection.tenant,collection.collectedAt,scope,JSON.stringify(filters),JSON.stringify(collection.evidenceGaps),JSON.stringify(collection.auditChecks),JSON.stringify(collection.retrieval),JSON.stringify(collection.notes),JSON.stringify(r.auditData),JSON.stringify(r.raw)]);
  return '\uFEFF' + [headers,...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

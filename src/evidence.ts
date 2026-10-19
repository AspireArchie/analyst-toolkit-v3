import type { Collection, SignInQuery } from './contracts';

export function validateQuery(value: unknown): SignInQuery {
  const q = value as SignInQuery;
  if (!q || typeof q.user !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.user) || q.user.length > 320) {
    throw new Error('Enter the full user principal name (for example user@contoso.com).');
  }
  const start = Date.parse(q.start), end = Date.parse(q.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > Date.now() + 60_000) {
    throw new Error('Choose a valid date range ending no later than now.');
  }
  return { user: q.user, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function csv(collection: Collection): string {
  const headers = ['id', 'timeUtc', 'user', 'type', 'application', 'ipAddress', 'city', 'country', 'errorCode', 'failureReason', 'tenant', 'rangeStartUtc', 'rangeEndUtc', 'collectedAtUtc', 'rawJson'];
  const cell = (value: unknown): string => {
    let text = String(value ?? '');
    // Prevent spreadsheet formula execution when opening attacker-controlled fields.
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const rows = collection.rows.map(r => [r.id, r.createdDateTime, r.userPrincipalName,
    r.signInEventTypes?.join(';') ?? (r.isInteractive ? 'interactiveUser' : 'nonInteractiveUser'),
    r.appDisplayName, r.ipAddress, r.location?.city, r.location?.countryOrRegion,
    r.status?.errorCode, r.status?.failureReason, collection.tenant, collection.query.start,
    collection.query.end, collection.collectedAt, JSON.stringify(r)]);
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

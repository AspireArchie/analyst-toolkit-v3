import type { AuditCategory, AuditCollection, AuditRecord, DirectoryAudit, SignInQuery } from './contracts';

export function auditRecords(rows: DirectoryAudit[], query: SignInQuery, userId: string): AuditRecord[] {
  const user = query.user.toLowerCase(), id = userId.toLowerCase();
  const matches = (value?: { id?: string; userPrincipalName?: string }) => Boolean(value &&
    (value.id?.toLowerCase() === id || value.userPrincipalName?.toLowerCase() === user));
  const seen = new Set<string>();
  return rows.flatMap(event => {
    const time = Date.parse(event.activityDateTime);
    if (!event.id || seen.has(event.id) || !Number.isFinite(time) || time < Date.parse(query.start) || time >= Date.parse(query.end)) return [];
    const actor = matches(event.initiatedBy?.user), target = event.targetResources?.some(matches) ?? false;
    if (!actor && !target) return [];
    seen.add(event.id);
    const text = [event.activityDisplayName, event.category, ...(event.targetResources ?? []).flatMap(t => (t.modifiedProperties ?? []).map(p => p.displayName))].join(' ').toLowerCase();
    const tags: AuditCategory[] = [];
    if (/password/.test(text)) tags.push('password');
    if (/mfa|multi.?factor|authentication.?method|security.?info|strong.?auth|fido|passkey|authenticator/.test(text)) tags.push('mfa');
    if (/role|privileged.?identity|eligible.?assignment/.test(text)) tags.push('roles');
    if (/consent|oauth|permission.?grant|delegated.?permission/.test(text)) tags.push('consent');
    if (/device/.test(text)) tags.push('devices');
    if (/group/.test(text)) tags.push('groups');
    if (!tags.length) tags.push('other');
    return [{ event, relation: actor && target ? 'both' as const : actor ? 'actor' as const : 'target' as const, tags }];
  }).sort((a, b) => Date.parse(b.event.activityDateTime) - Date.parse(a.event.activityDateTime));
}

export function auditCsv(collection: AuditCollection): string {
  const headers = ['id', 'timeUtc', 'activity', 'category', 'tags', 'accountRelation', 'result', 'resultReason', 'actorUser', 'actorApp', 'actorIp', 'targetsJson', 'modifiedPropertiesJson', 'correlationId', 'loggedByService', 'affectedUser', 'affectedUserId', 'tenant', 'rangeStartUtc', 'rangeEndUtc', 'collectedAtUtc', 'rawJson'];
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const rows = collection.records.map(({ event: e, relation, tags }) => [e.id, e.activityDateTime, e.activityDisplayName, e.category, tags.join(';'), relation, e.result, e.resultReason,
    e.initiatedBy?.user?.userPrincipalName ?? e.initiatedBy?.user?.id, e.initiatedBy?.app?.displayName ?? e.initiatedBy?.app?.servicePrincipalId,
    e.initiatedBy?.user?.ipAddress, JSON.stringify(e.targetResources ?? []),
    JSON.stringify((e.targetResources ?? []).map(t => ({ id: t.id, modifiedProperties: t.modifiedProperties ?? [] }))),
    e.correlationId, e.loggedByService, collection.query.user, collection.userId, collection.tenant, collection.query.start, collection.query.end, collection.collectedAt, JSON.stringify(e)]);
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

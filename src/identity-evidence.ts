import type { IdentityCollection, IdentityKind, IdentityQuery, IdentityRow, IdentityResult, SignIn } from './contracts';

export const identityKinds: IdentityKind[] = ['risk-detections', 'devices', 'app-consents'];
export const identityColumns: Record<IdentityKind, string[]> = {
  'risk-detections': ['UPN', 'Activity UTC', 'Detected UTC', 'Detection type', 'Risk level', 'IP address', 'Detection source', 'Risk state', 'Risk detail', 'Sign-in request ID', 'Correlation ID', 'Captured sign-in IDs'],
  devices: ['Registered UTC', 'Device ID', 'Name', 'OS', 'Join type', 'Compliance (current)', 'Audit time UTC', 'Activity', 'Result'],
  'app-consents': ['UPN', 'Application', 'App ID', 'Consent type', 'Scopes', 'Resource API', 'Review', 'Audit time UTC', 'Activity', 'Result'],
};
const text = (value: unknown) => value === undefined || value === null ? '' : String(value);
const inWindow = (value: unknown, query: IdentityQuery) => {
  const time = Date.parse(text(value)); return Number.isFinite(time) && time >= Date.parse(query.start) && time < Date.parse(query.end);
};
export function buildIdentityCollection(kind: IdentityKind, query: IdentityQuery, tenant: string, result: IdentityResult, signIns: SignIn[] = []): IdentityCollection {
  const rows: IdentityRow[] = [], seen = new Set<string>();
  const add = (row: IdentityRow) => { if (!seen.has(row.key)) { seen.add(row.key); rows.push(row); } };
  for (const item of result.rows) {
    if (kind === 'risk-detections') {
      if (text(item.userId).toLowerCase() !== result.userId.toLowerCase()) continue;
      if (!query.allRetained && !inWindow(item.activityDateTime, query) && !inWindow(item.detectedDateTime, query)) continue;
      const linked = signIns.filter(s => text(s.userPrincipalName).toLowerCase() === query.user.toLowerCase() &&
        (item.requestId && s.id === item.requestId || item.correlationId && s.correlationId === item.correlationId)).map(s => s.id);
      add({ key: `risk:${item.id}`, source: 'risk', tone: item.riskLevel === 'high' ? 'failure' : ['medium', 'low'].includes(item.riskLevel) ? 'warning' : 'neutral', flags: [],
        values: { UPN: text(item.userPrincipalName ?? result.userPrincipalName), 'Activity UTC': text(item.activityDateTime), 'Detected UTC': text(item.detectedDateTime), 'Detection type': text(item.riskEventType), 'Risk level': text(item.riskLevel), 'IP address': text(item.ipAddress), 'Detection source': text(item.source), 'Risk state': text(item.riskState), 'Risk detail': text(item.riskDetail), 'Sign-in request ID': text(item.requestId), 'Correlation ID': text(item.correlationId), 'Captured sign-in IDs': linked.join('; ') }, raw: item });
    } else if (kind === 'devices') {
      const flags: string[] = [];
      if (inWindow(item.registrationDateTime, query)) flags.push('Registered during incident window');
      if (!item.registrationDateTime) flags.push('Registration time unavailable');
      if (item.isCompliant === false) flags.push('Currently non-compliant');
      add({ key: `device:${item.id}`, source: 'device', tone: flags.length ? 'warning' : 'neutral', flags,
        values: { 'Registered UTC': text(item.registrationDateTime), 'Device ID': text(item.deviceId), Name: text(item.displayName), OS: [item.operatingSystem, item.operatingSystemVersion].filter(Boolean).join(' '), 'Join type': ({ Workplace: 'Entra registered', AzureAd: 'Entra joined', ServerAd: 'Hybrid joined' } as Record<string,string>)[item.trustType] ?? text(item.trustType), 'Compliance (current)': item.isCompliant === true ? 'Compliant' : item.isCompliant === false ? 'Non-compliant' : 'Unknown', 'Audit time UTC': '', Activity: '', Result: '' }, raw: item });
    } else {
      const grant = item.grant, client = item.client, resource = item.resource;
      const scopes: string[] = text(grant.scope).split(/\s+/).filter(Boolean);
      const watch = new Set(['mail.read', 'mail.readwrite', 'mail.send', 'contacts.read', 'contacts.readwrite', 'files.read.all', 'files.readwrite.all', 'directory.readwrite.all', 'rolemanagement.readwrite.directory']);
      const flagged = scopes.filter(scope => watch.has(scope.toLowerCase()));
      const flags = flagged.length ? [`Sensitive scopes: ${flagged.join(', ')}`] : [];
      if (grant.consentType === 'AllPrincipals') flags.push('Tenant-wide grant applies to all users');
      if (!client) flags.push('Client application no longer available');
      if (!resource) flags.push('Resource application no longer available');
      if (grant.consentType !== 'AllPrincipals' && text(grant.principalId).toLowerCase() !== result.userId.toLowerCase()) continue;
      add({ key: `grant:${grant.id}`, source: 'grant', tone: flags.length ? 'warning' : 'neutral', flags,
        values: { UPN: grant.consentType === 'AllPrincipals' ? 'All users (tenant-wide)' : text(result.userPrincipalName), Application: text(client?.displayName) || text(grant.clientId), 'App ID': text(client?.appId), 'Consent type': text(grant.consentType), Scopes: text(grant.scope), 'Resource API': text(resource?.displayName) || text(grant.resourceId), Review: 'Unreviewed', 'Audit time UTC': '', Activity: '', Result: '' }, raw: { ...item, principal: { id: result.userId, userPrincipalName: result.userPrincipalName ?? null, context: 'Affected account resolved by Graph; AllPrincipals grants apply tenant-wide' } } });
    }
  }
  if (kind === 'risk-detections') {
    const riskTone = (level: unknown, state: unknown): IdentityRow['tone'] => state === 'confirmedCompromised' || level === 'high' ? 'failure' : state === 'atRisk' || ['medium', 'low'].includes(text(level)) ? 'warning' : ['confirmedSafe', 'remediated', 'dismissed'].includes(text(state)) ? 'success' : 'neutral';
    const user = result.riskyUser;
    if (user && text(user.id).toLowerCase() === result.userId.toLowerCase()) {
      add({ key: `risk-user:${user.id}`, source: 'risk-user', tone: riskTone(user.riskLevel, user.riskState), flags: ['Current state; always included regardless of selected dates', ...(user.isProcessing ? ['Risk evaluation is processing'] : []), ...(user.isDeleted ? ['User is deleted'] : [])], values: { UPN: text(user.userPrincipalName ?? result.userPrincipalName), 'Activity UTC': text(user.riskLastUpdatedDateTime), 'Detection type': 'Current user risk', 'Risk level': text(user.riskLevel), 'Risk state': text(user.riskState), 'Risk detail': text(user.riskDetail), 'Detection source': 'Identity Protection riskyUsers' }, raw: user });
    }
    for (const item of result.riskHistory ?? []) {
      if (item.userId && text(item.userId).toLowerCase() !== result.userId.toLowerCase()) continue;
      if (!query.allRetained && !inWindow(item.riskLastUpdatedDateTime, query)) continue;
      add({ key: `risk-history:${item.id}`, source: 'risk-history', tone: riskTone(item.riskLevel, item.riskState), flags: item.initiatedBy ? [`Initiated by: ${text(item.initiatedBy)}`] : [], values: { UPN: text(item.userPrincipalName ?? result.userPrincipalName), 'Activity UTC': text(item.riskLastUpdatedDateTime), 'Detection type': text(item.activity?.detail) || 'User risk change', 'Risk level': text(item.riskLevel), 'Risk state': text(item.riskState), 'Risk detail': text(item.riskDetail), 'Detection source': 'Identity Protection user history' }, raw: item });
    }
    const levels = new Set(['low', 'medium', 'high', 'hidden', 'unknownFutureValue']);
    for (const item of result.riskySignIns ?? []) {
      if (text(item.userId).toLowerCase() !== result.userId.toLowerCase()) continue;
      if (!query.allRetained && !inWindow(item.createdDateTime, query)) continue;
      const events = Array.isArray(item.riskEventTypes_v2) ? item.riskEventTypes_v2.filter(v => v && v !== 'none') : [];
      if (!levels.has(text(item.riskLevelAggregated)) && !levels.has(text(item.riskLevelDuringSignIn)) && !(item.riskState && item.riskState !== 'none') && !events.length) continue;
      const rank = (value: unknown) => { const index = ['high','medium','low','hidden','unknownFutureValue','none'].indexOf(text(value)); return index < 0 ? 99 : index; };
      const level = [item.riskLevelAggregated, item.riskLevelDuringSignIn].sort((a,b) => rank(a) - rank(b))[0];
      add({ key: `risky-signin:${item.id}`, source: 'risky-signin', tone: riskTone(level, item.riskState), flags: [`During sign-in: ${text(item.riskLevelDuringSignIn) || 'Not returned'}; aggregated: ${text(item.riskLevelAggregated) || 'Not returned'}`, ...([item.riskLevelAggregated,item.riskLevelDuringSignIn].includes('hidden') ? ['Risk details hidden; risk cannot be inferred from hidden values alone'] : [])], values: { UPN: text(item.userPrincipalName ?? result.userPrincipalName), 'Activity UTC': item.createdDateTime, 'Detection type': events.map(text).join('; ') || 'Sign-in risk indicators', 'Risk level': text(level), 'IP address': item.ipAddress, 'Detection source': item.signInEventTypes?.join('; ') ?? (item.isInteractive === false ? 'Non-interactive sign-in' : 'Interactive sign-in'), 'Risk state': text(item.riskState), 'Risk detail': text(item.riskDetail), 'Sign-in request ID': item.id, 'Correlation ID': text(item.correlationId), 'Captured sign-in IDs': signIns.some(s => s.id === item.id && s.userPrincipalName?.toLowerCase() === query.user.toLowerCase()) ? item.id : '' }, raw: item });
    }
  }
  for (const event of result.relatedAudits ?? []) {
    if (!inWindow(event.activityDateTime, query)) continue;
    const names = (event.targetResources ?? []).map(t => t.displayName ?? t.userPrincipalName ?? t.id).filter(Boolean).join('; ');
    const values: Record<string, string> = kind === 'devices'
      ? { 'Registered UTC': '', 'Device ID': '', Name: names, OS: '', 'Join type': '', 'Compliance (current)': '', 'Audit time UTC': event.activityDateTime, Activity: text(event.activityDisplayName), Result: text(event.result) }
      : { UPN: (event.targetResources ?? []).filter(t => text(t.id).toLowerCase() === result.userId.toLowerCase()).map(t => t.userPrincipalName).filter(Boolean).join('; ') || (event.initiatedBy?.user?.id?.toLowerCase() === result.userId.toLowerCase() ? text(event.initiatedBy.user.userPrincipalName) : ''), Application: names, 'App ID': '', 'Consent type': '', Scopes: '', 'Resource API': '', Review: '', 'Audit time UTC': event.activityDateTime, Activity: text(event.activityDisplayName), Result: text(event.result) };
    add({ key: `audit:${event.id}`, source: 'audit', tone: event.result === 'failure' ? 'failure' : event.result === 'success' ? 'success' : 'neutral', values,
      flags: ['Historical activity; inspect actor, targets and modified properties'], raw: event });
  }
  if (kind === 'risk-detections') rows.sort((a,b) => Number(b.source === 'risk-user') - Number(a.source === 'risk-user'));
  const coverage = kind === 'risk-detections'
    ? `${query.allRetained ? 'All retained detections, risk history and sign-in risk records' : 'Window-scoped detections (activity OR detection time), risk history and sign-in risk records'}. Current risky-user state is always included, regardless of its last-update date. Sources have independent retention. Hidden risk details are not a safe/risky verdict. Raw records preserve all returned fields. ${result.riskSources?.map(s => `${s.source}: ${s.ok ? `${s.count ?? 0} returned` : `UNAVAILABLE — ${s.error}`}`).join(' | ') ?? 'Source coverage not reported.'}`
    : kind === 'devices'
    ? 'Current registered-owner device inventory plus related device audit events in the incident window. Compliance and ownership are current state. Empty inventory cannot rule out a device that was deleted.'
    : 'Current user-specific and tenant-wide delegated grants plus related consent audit events in the incident window. Current grants have no creation timestamp. Related app audit events require review of the principal; unfamiliarity is an analyst decision.';
  return { kind, query, tenant, userId: result.userId, collectedAt: new Date().toISOString(), columns: identityColumns[kind], rows, coverage, ...(kind === 'risk-detections' ? { riskSources: result.riskSources } : {}) };
}
export function identityCsv(collection: IdentityCollection): string {
  const cell = (value: unknown) => {
    let valueText = text(value); if (/^\s*[=+@-]/.test(valueText) || /^[\t\r\n]/.test(valueText)) valueText = "'" + valueText;
    return '"' + valueText.replace(/"/g, '""') + '"';
  };
  const headers = ['key', 'source', ...collection.columns, 'flags', 'user', 'userId', 'tenant', 'windowStartUtc', 'windowEndUtc', 'allRetained', 'collectedAtUtc', 'rawJson', 'coverage', 'riskSourcesJson'];
  const rows = collection.rows.map(row => [row.key, row.source, ...collection.columns.map(c => row.values[c]), row.flags.join('; '), collection.query.user, collection.userId, collection.tenant, collection.query.start, collection.query.end, Boolean(collection.query.allRetained), collection.collectedAt, JSON.stringify(row.raw), collection.coverage, JSON.stringify(collection.riskSources)]);
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

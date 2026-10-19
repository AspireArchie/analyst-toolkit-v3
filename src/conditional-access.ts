import type { Collection, ConditionalAccessReport, SignIn } from './contracts';

export function selectedSignIns(collection: Collection | null, value: unknown): SignIn[] {
  if (!collection) throw new Error('Collect sign-ins first.');
  if (!Array.isArray(value) || value.length === 0 || value.length > collection.rows.length || !value.every(id => typeof id === 'string')) throw new Error('Select one or more sign-ins from the current collection.');
  const index = new Map(collection.rows.map(row => [row.id, row]));
  return [...new Set(value)].map(id => {
    const row = index.get(id);
    if (!row) throw new Error('Selected sign-in is not part of the current collection.');
    return row;
  });
}

export function conditionalAccessReport(collection: Collection, ids: unknown): ConditionalAccessReport {
  return {
    tenant: collection.tenant, collectedAt: collection.collectedAt,
    events: selectedSignIns(collection, ids).map(row => {
      const policies = row.appliedConditionalAccessPolicies;
      return {
        signInId: row.id, time: row.createdDateTime, user: row.userPrincipalName,
        application: row.appDisplayName, ip: row.ipAddress,
        overallStatus: row.conditionalAccessStatus ?? 'unknown',
        availability: Array.isArray(policies) ? policies.length ? 'returned' : 'empty' : 'unavailable',
        policies: Array.isArray(policies) ? policies : [],
      };
    }),
  };
}

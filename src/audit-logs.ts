import type { AuditCollection, BecApi, SessionState, UiAuditEvent } from './contracts';
import { tableValue } from './table-value.js';

interface AuditContext {
  api: BecApi;
  run: (work: (epoch: number) => Promise<void>) => Promise<void>;
  audit: (event: UiAuditEvent) => Promise<void>;
  message: (text: string, tone?: 'neutral' | 'success' | 'failure' | 'warning') => void;
  generation: () => number;
  state: () => SessionState;
}
export function initializeAuditLogs(context: AuditContext) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const input = (id: string) => el<HTMLInputElement>(id);
  let evidence: AuditCollection | null = null;
  let page = 0, version = 0;
  const pageSize = 100;
  const unwrap = <T>(reply: { ok: true; data: T } | { ok: false; error: string }): T => {
    if (!reply.ok) throw new Error(reply.error); return reply.data;
  };
  const activity = (work: () => Promise<void>) => { void work().catch(error => context.message(String(error), 'failure')); };
  function controls(busy: boolean, connected: boolean): void {
    el<HTMLButtonElement>('audit-collect').disabled = busy || !connected;
    for (const format of ['csv', 'json']) el<HTMLButtonElement>(`audit-export-${format}`).disabled = busy || !evidence;
  }
  async function render(): Promise<void> {
    const current = ++version, epoch = context.generation(), source = evidence;
    const search = input('audit-search').value.toLowerCase(), category = el<HTMLSelectElement>('audit-category').value;
    const relation = el<HTMLSelectElement>('audit-relation').value, result = el<HTMLSelectElement>('audit-result').value;
    const rows = (evidence?.records ?? []).filter(row =>
      (category === 'all' || row.tags.includes(category as typeof row.tags[number])) &&
      (relation === 'all' || row.relation === relation || row.relation === 'both' && relation !== 'both') &&
      (result === 'all' || result === 'other' && !['success', 'failure'].includes(row.event.result ?? '') || row.event.result === result) &&
      JSON.stringify(row).toLowerCase().includes(search));
    page = Math.max(0, Math.min(page, Math.ceil(rows.length / pageSize) - 1));
    const visible = rows.slice(page * pageSize, (page + 1) * pageSize);
    await context.audit({ action: 'audit_results_view', search, category, relation, result, page, ids: visible.map(row => row.event.id) });
    if (current !== version || epoch !== context.generation() || source !== evidence) return;
    const body = el('audit-body'); body.replaceChildren();
    for (const record of visible) {
      const event = record.event, tr = document.createElement('tr');
      const tone = event.result === 'success' ? 'success' : event.result === 'failure' ? 'failure' : event.result === 'timeout' ? 'warning' : 'neutral';
      tr.dataset.tone = tone;
      const actor = event.initiatedBy?.user?.userPrincipalName ?? event.initiatedBy?.user?.displayName ?? event.initiatedBy?.user?.id ?? event.initiatedBy?.app?.displayName ?? event.initiatedBy?.app?.servicePrincipalId ?? '(not returned)';
      const targets = (event.targetResources ?? []).map(t => t.userPrincipalName ?? t.displayName ?? t.id ?? '(not returned)').join('; ');
      for (const [index, value] of [event.activityDateTime, event.activityDisplayName ?? '', event.category ?? '', actor, targets, record.relation === 'both' ? 'Actor and target' : record.relation === 'actor' ? 'Performed by account' : 'Targets account'].entries()) {
        const cell = document.createElement('td');
        tableValue(cell, value, open => context.audit({ action: 'table_cell_toggle', page: 'audit-logs', id: event.id, field: ['Time', 'Activity', 'Category', 'Actor', 'Targets', 'Relation'][index], open }), error => context.message(String(error), 'failure')); tr.append(cell);
      }
      const resultCell = document.createElement('td'), badge = document.createElement('span');
      badge.className = 'status-badge'; badge.dataset.tone = tone; badge.textContent = event.result ?? 'unknown'; resultCell.append(badge);
      if (event.resultReason) { const detail = document.createElement('small'); detail.className = 'result-detail'; tableValue(detail, event.resultReason, open => context.audit({ action: 'table_cell_toggle', page: 'audit-logs', id: event.id, field: 'Result reason', open }), error => context.message(String(error), 'failure')); resultCell.append(detail); }
      tr.append(resultCell);
      const cell = document.createElement('td'), button = document.createElement('button'); button.textContent = 'View';
      button.addEventListener('click', () => activity(async () => {
        await context.audit({ action: 'audit_record_view', id: event.id });
        if (source !== evidence || epoch !== context.generation()) return;
        el('audit-record-json').textContent = JSON.stringify(event, null, 2);
        el<HTMLDetailsElement>('audit-record-details').open = true;
      }));
      cell.append(button); tr.append(cell); body.append(tr);
    }
    if (!visible.length) {
      const tr = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 8;
      cell.textContent = evidence ? 'No audit events match this view.' : 'Connect Graph and collect audit logs to begin.'; tr.append(cell); body.append(tr);
    }
    el('audit-heading').textContent = `Audit logs · ${evidence?.records.length ?? 0} events`;
    el('audit-page-info').textContent = rows.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, rows.length)} of ${rows.length}` : '0 events';
    el<HTMLButtonElement>('audit-previous').disabled = page === 0;
    el<HTMLButtonElement>('audit-next').disabled = (page + 1) * pageSize >= rows.length;
  }
  async function reset(): Promise<void> {
    evidence = null; page = 0;
    input('audit-user').value = ''; input('audit-search').value = '';
    el('audit-info').textContent = 'No collection run yet.';
    el('audit-record-json').textContent = 'Select an event to inspect its full record.';
    el<HTMLDetailsElement>('audit-record-details').open = false;
    await render();
  }
  async function rangeChange(): Promise<void> {
    const range = el<HTMLSelectElement>('audit-range').value;
    await context.audit({ action: 'range_change', range: `audit:${range}`, start: input('audit-start').value, end: input('audit-end').value });
    const custom = range === 'custom'; el('audit-custom-range').hidden = !custom;
    input('audit-start').required = custom; input('audit-end').required = custom;
  }
  for (const id of ['audit-range', 'audit-start', 'audit-end']) el(id).addEventListener('change', () => activity(rangeChange));
  el('audit-form').addEventListener('submit', event => {
    event.preventDefault();
    void context.run(async epoch => {
      evidence = null; page = 0; await render(); controls(true, context.state().graph);
      el('audit-record-json').textContent = 'Select an event to inspect its full record.';
      el('audit-info').textContent = 'Collection in progress. No completed audit evidence available.';
      const range = el<HTMLSelectElement>('audit-range').value;
      const end = range === 'custom' ? new Date(input('audit-end').value) : new Date();
      const start = range === 'custom' ? new Date(input('audit-start').value) : new Date(end.getTime() - Number(range) * 3600000);
      context.message('Collecting Entra audit events performed by or targeting the account…');
      const result = unwrap(await context.api.collectAudits({ user: input('audit-user').value.trim(), start: start.toISOString(), end: end.toISOString() }));
      if (epoch !== context.generation()) return;
      evidence = result;
      input('audit-search').value = '';
      for (const id of ['audit-category', 'audit-relation', 'audit-result']) el<HTMLSelectElement>(id).value = 'all';
      el('audit-info').textContent = `${result.query.user} | ${result.query.start} → ${result.query.end} (exclusive) | tenant ${result.tenant} | account ID ${result.userId} | collected ${result.collectedAt}`;
      await render(); context.message(`Audit collection complete: ${result.records.length} events.`, 'success');
    });
  });
  for (const id of ['audit-search', 'audit-category', 'audit-relation', 'audit-result']) el(id).addEventListener('input', () => { page = 0; activity(render); });
  el('audit-previous').addEventListener('click', () => { page--; activity(render); });
  el('audit-next').addEventListener('click', () => { page++; activity(render); });
  for (const format of ['csv', 'json'] as const) el(`audit-export-${format}`).addEventListener('click', () => void context.run(async epoch => {
    const file = unwrap(await context.api.exportAudits(format));
    if (epoch === context.generation()) context.message(file ? `Exported complete audit collection to ${file}` : 'Audit export cancelled.', file ? 'success' : 'neutral');
  }));
  el('audit-record-details').querySelector('summary')!.addEventListener('click', event => {
    event.preventDefault();
    activity(async () => {
      const details = el<HTMLDetailsElement>('audit-record-details'), open = !details.open;
      await context.audit({ action: 'details_toggle', section: 'audit-record-details', open }); details.open = open;
    });
  });
  return { controls, reset, render };
}

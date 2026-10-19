import { tableValue } from './table-value.js';
import type { BecApi, IdentityCollection, IdentityKind, IdentityRow, SessionState, UiAuditEvent } from './contracts';

interface Context {
  api: BecApi; run: (work: (epoch: number) => Promise<void>) => Promise<void>;
  audit: (event: UiAuditEvent) => Promise<void>;
  message: (text: string, tone?: 'neutral' | 'success' | 'failure' | 'warning') => void;
  generation: () => number; state: () => SessionState;
}
const modules = {
  'risk-detections': { title: 'Risk Detections', hint: 'Current user risk, risk history, detections and interactive/non-interactive sign-ins with risk indicators. Current user risk is always included; dates filter historical records.' },
  devices: { title: 'Devices', hint: 'Current devices owned by the user, with related device audit events from the incident window. Registration-in-window flags identify records for review; they do not establish a rogue device.' },
  'app-consents': { title: 'App Consents', hint: 'Current user and tenant-wide delegated grants, with related consent audit history from the incident window. UPN identifies user-specific grants; tenant-wide grants apply to all users.' },
};
export function initializeIdentityTabs(context: Context) {
  const controllers = (Object.keys(modules) as IdentityKind[]).map(kind => {
    const config = modules[kind], root = document.getElementById(`${kind}-module`)!;
    root.innerHTML = `
      <form class="query-panel" data-field="form">
        <div class="control-row"><label>Affected user principal name<input data-field="user" type="email" required autocomplete="off" placeholder="user@contoso.com" /></label><label>${kind === 'risk-detections' ? 'Risk event range' : 'Incident window'}<select data-field="range">${kind === 'risk-detections' ? '<option value="all">All retained risk evidence</option>' : ''}<option value="24">Last 24 hours</option><option value="48">Last 48 hours</option><option value="72">Last 72 hours</option><option value="168">Last week</option><option value="custom">Custom range</option></select></label></div>
        <div class="control-row" data-field="custom" hidden><label>Start (local time)<input data-field="start" type="datetime-local" /></label><label>End (local time, exclusive)<input data-field="end" type="datetime-local" /></label></div>
        <button data-field="collect" class="primary" type="submit" disabled>Collect ${config.title.toLowerCase()}</button><p class="help">${config.hint}</p>
      </form>
      <section class="results-panel" aria-label="${config.title} evidence">
        <div class="panel-header"><h2 data-field="heading">${config.title} · 0 records</h2><div class="export-buttons"><button data-field="csv" disabled>Export CSV</button><button data-field="json" disabled>Export raw JSON</button></div></div>
        <p data-field="info" class="help">No collection run yet.</p><p data-field="coverage" class="help"></p>
        <div class="control-row result-tools"><label>Search records<input data-field="search" type="search" placeholder="Search captured fields and raw data" /></label><label>View<select data-field="filter"><option value="all">All records</option>${kind === 'risk-detections' ? '<option value="risk-user">Current user risk</option><option value="risk-history">User risk history</option><option value="detections">Risk detections</option><option value="risky-signin">Sign-in risk indicators</option><option value="high">High risk</option><option value="medium">Medium risk</option><option value="low">Low risk</option>' : '<option value="current">Current state</option><option value="history">Incident-window audit history</option>' + (kind === 'devices' ? '<option value="flagged">Flagged for review</option>' : '')}${kind === 'devices' ? '<option value="window">Registered during incident window</option>' : ''}</select></label></div>
        <div class="table-scroll"><table><thead data-field="head"></thead><tbody data-field="body"></tbody></table></div>
        <div class="pagination"><button data-field="previous">Previous</button><span data-field="page">0 records</span><button data-field="next">Next</button></div>
        <details data-field="details"><summary>Selected record · raw data</summary><pre data-field="raw">Select a record to inspect all returned fields.</pre></details>
      </section>`;
    const el = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-field="${name}"]`)!;
    const input = (name: string) => el<HTMLInputElement>(name);
    let evidence: IdentityCollection | null = null, page = 0, version = 0;
    const unwrap = <T>(reply: { ok: true; data: T } | { ok: false; error: string }): T => { if (!reply.ok) throw new Error(reply.error); return reply.data; };
    const activity = (work: () => Promise<void>) => { void work().catch(error => context.message(String(error), 'failure')); };
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
    function controls(isBusy: boolean, connected: boolean): void {
      el<HTMLButtonElement>('collect').disabled = isBusy || !connected;
      for (const format of ['csv', 'json']) el<HTMLButtonElement>(format).disabled = isBusy || !evidence;
    }
    async function render(): Promise<void> {
      const current = ++version, epoch = context.generation(), source = evidence;
      const search = input('search').value.toLowerCase(), filter = el<HTMLSelectElement>('filter').value;
      const rows = (evidence?.rows ?? []).filter(row => {
        const visible = filter === row.source || filter === 'detections' && row.source === 'risk' || filter === 'all' || filter === 'current' && row.source !== 'audit' || filter === 'history' && row.source === 'audit' || filter === 'flagged' && row.flags.length > 0 || filter === 'window' && row.flags.includes('Registered during incident window') || filter === 'unfamiliar' && row.values.Review === 'Unfamiliar' || ['high', 'medium', 'low'].includes(filter) && row.values['Risk level'] === filter;
        return visible && JSON.stringify(row).toLowerCase().includes(search);
      });
      page = Math.max(0, Math.min(page, Math.ceil(rows.length / 100) - 1));
      const visible = rows.slice(page * 100, (page + 1) * 100);
      await context.audit({ action: 'identity_results_view', kind, search, filter, page, keys: visible.map(row => row.key) });
      if (current !== version || epoch !== context.generation() || source !== evidence) return;
      const columns = (evidence?.columns ?? []).filter(c => kind !== 'app-consents' || c !== 'Review'), header = make('tr');
      const showFlags = kind !== 'app-consents';
      for (const name of ['Source', ...columns, ...(showFlags ? ['Flags / review'] : []), 'Details']) header.append(make('th', name));
      el('head').replaceChildren(header); el('body').replaceChildren();
      for (const row of visible) {
        const tr = make('tr'); tr.dataset.tone = row.tone;
        const sourceNames = { risk: 'Risk detection', 'risk-user': 'Current user risk', 'risk-history': 'User risk history', 'risky-signin': 'Sign-in risk indicators', device: 'Current device', grant: 'Current grant', audit: 'Audit event' };
        tr.append(make('td', sourceNames[row.source]));
        for (const column of columns) {
          const cell = make('td');
          tableValue(cell, row.values[column] || '—', open => context.audit({ action: 'table_cell_toggle', page: kind, id: row.key, field: column, open }), error => context.message(String(error), 'failure'));
          if (column === 'Risk level' || column === 'Result') {
            const badge = make('span', row.values[column] || 'unknown'); badge.className = 'status-badge'; badge.dataset.tone = row.tone; cell.replaceChildren(badge);
          }
          tr.append(cell);
        }
        if (showFlags) {
          const flags = make('td');
          tableValue(flags, row.flags.join('; '), open => context.audit({ action: 'table_cell_toggle', page: kind, id: row.key, field: 'Flags', open }), error => context.message(String(error), 'failure'));
          tr.append(flags);
        }
        const cell = make('td'), button = make('button', 'View'); button.dataset.recordKey = row.key;
        button.addEventListener('click', () => activity(async () => {
          await context.audit({ action: 'identity_record_view', kind, key: row.key });
          if (epoch !== context.generation() || source !== evidence) return;
          el('raw').textContent = JSON.stringify(row.raw, null, 2); el<HTMLDetailsElement>('details').open = true;
        })); cell.append(button); tr.append(cell); el('body').append(tr);
      }
      if (!visible.length) { const tr = make('tr'), cell = make('td', evidence ? 'No records match this view.' : 'Connect Graph and collect evidence to begin.'); cell.colSpan = columns.length + (showFlags ? 3 : 2); tr.append(cell); el('body').append(tr); }
      el('heading').textContent = `${config.title} · ${evidence?.rows.length ?? 0} records`;
      el('page').textContent = rows.length ? `${page * 100 + 1}–${Math.min((page + 1) * 100, rows.length)} of ${rows.length}` : '0 records';
      el<HTMLButtonElement>('previous').disabled = page === 0; el<HTMLButtonElement>('next').disabled = (page + 1) * 100 >= rows.length;
    }
    async function rangeChange(): Promise<void> {
      const range = el<HTMLSelectElement>('range').value;
      await context.audit({ action: 'range_change', range: `${kind}:${range}`, start: input('start').value, end: input('end').value });
      el('custom').hidden = range !== 'custom'; input('start').required = range === 'custom'; input('end').required = range === 'custom';
    }
    for (const name of ['range', 'start', 'end']) el(name).addEventListener('change', () => activity(rangeChange));
    el('form').addEventListener('submit', event => {
      event.preventDefault();
      void context.run(async epoch => {
        evidence = null; page = 0; await render(); controls(true, context.state().graph);
        el('raw').textContent = 'Select a record to inspect all returned fields.';
        el('info').textContent = 'Collection in progress. No completed evidence set available.'; el('coverage').textContent = '';
        const range = el<HTMLSelectElement>('range').value;
        const end = range === 'custom' ? new Date(input('end').value) : new Date();
        const start = range === 'custom' ? new Date(input('start').value) : range === 'all' ? new Date(0) : new Date(end.getTime() - Number(range) * 3600000);
        context.message(`Collecting ${config.title.toLowerCase()}…`);
        const snapshot = unwrap(await context.api.collectIdentity(kind, { user: input('user').value.trim(), start: start.toISOString(), end: end.toISOString(), allRetained: range === 'all' }));
        if (epoch !== context.generation()) return;
        evidence = snapshot; input('search').value = ''; el<HTMLSelectElement>('filter').value = 'all';
        el('info').textContent = `${snapshot.query.user} | ${snapshot.query.allRetained ? 'All retained risk evidence' : `${snapshot.query.start} → ${snapshot.query.end} (exclusive)`} | tenant ${snapshot.tenant} | user ID ${snapshot.userId} | collected ${snapshot.collectedAt}`;
        el('coverage').textContent = snapshot.coverage;
        const incomplete = snapshot.riskSources?.some(source => !source.ok) ?? false;
        el('coverage').dataset.tone = incomplete ? 'warning' : 'neutral';
        await render(); context.message(`${config.title}: ${snapshot.rows.length} records.${incomplete ? ' Incomplete coverage — review source errors below.' : ''}`, incomplete ? 'warning' : 'success');
      });
    });
    for (const name of ['search', 'filter']) el(name).addEventListener('input', () => { page = 0; activity(render); });
    el('previous').addEventListener('click', () => { page--; activity(render); }); el('next').addEventListener('click', () => { page++; activity(render); });
    for (const format of ['csv', 'json'] as const) el(format).addEventListener('click', () => void context.run(async epoch => {
      const file = unwrap(await context.api.exportIdentity(kind, format));
      if (epoch === context.generation()) context.message(file ? `Exported ${config.title.toLowerCase()} evidence to ${file}${kind === 'risk-detections' && format === 'csv' ? ' and .metadata.json companion' : ''}` : 'Export cancelled.', file ? 'success' : 'neutral');
    }));
    el('details').querySelector('summary')!.addEventListener('click', event => {
      event.preventDefault(); activity(async () => {
        const details = el<HTMLDetailsElement>('details'), open = !details.open;
        await context.audit({ action: 'details_toggle', section: `${kind}-details`, open }); details.open = open;
      });
    });
    async function reset(): Promise<void> {
      evidence = null; page = 0; input('user').value = ''; input('search').value = ''; el<HTMLSelectElement>('filter').value = 'all';
      el('info').textContent = 'No collection run yet.'; el('coverage').textContent = ''; el('raw').textContent = 'Select a record to inspect all returned fields.'; el<HTMLDetailsElement>('details').open = false;
      await render();
    }
    return { controls, reset, render };
  });
  return {
    controls: (busy: boolean, connected: boolean) => controllers.forEach(c => c.controls(busy, connected)),
    reset: async () => { for (const controller of controllers) await controller.reset(); },
    render: async () => { for (const controller of controllers) await controller.render(); },
  };
}

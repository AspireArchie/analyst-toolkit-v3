import type { BecApi, Reply, SessionState, UalCollection, UalFilters, UiAuditEvent } from './contracts';
import { tableValue } from './table-value.js';

interface Context {
  api: BecApi;
  run: (work: (epoch: number) => Promise<void>) => Promise<void>;
  audit: (event: UiAuditEvent) => Promise<void>;
  message: (text: string, tone?: 'neutral' | 'success' | 'failure' | 'warning') => void;
  generation: () => number;
  state: () => SessionState;
}
const becOperations = 'MailItemsAccessed, Send, SendAs, SendOnBehalf, HardDelete, SoftDelete, MoveToDeletedItems, New-InboxRule, Set-InboxRule, Remove-InboxRule, UpdateInboxRules, Set-Mailbox, Add-MailboxPermission';
export function initializeUalLogs(context: Context) {
  const root = document.getElementById('uals-module')!;
  root.className = 'ual-module';
  root.innerHTML = `
    <section class="query-panel">
      <form id="ual-form">
        <div class="ual-query-row">
          <label>Account UPN<input id="ual-user" type="email" placeholder="user@contoso.com" required></label>
          <label>Timeframe<select id="ual-range"><option value="24">Last 24 hours</option><option value="48">Last 48 hours</option><option value="72">Last 72 hours</option><option value="168">Last week</option><option value="custom">Custom range</option></select></label>
          <button id="ual-collect" type="submit">Collect UALs</button>
        </div>
        <div id="ual-custom-range" class="ual-query-row" hidden><label>Start (local time)<input id="ual-start" type="datetime-local"></label><label>End (local time, exclusive)<input id="ual-end" type="datetime-local"></label></div>
        <label>Operations · blank collects all<input id="ual-operations" placeholder="MailItemsAccessed, Send, New-InboxRule"></label>
        <div class="actions"><button id="ual-bec" type="button">BEC operations</button><button id="ual-all-operations" type="button">All operations</button></div>
      </form>
      <p class="help">Uses the shared Exchange connection in Session. User scope matches the audited actor; other users acting against this mailbox may require separate searches.</p>
      <p id="ual-info" class="help">No collection run yet.</p>
    </section>
    <section class="query-panel">
      <h2 id="ual-heading">Unified Audit Logs</h2>
      <div class="ual-filter-grid">
        <label>Search captured fields<input id="ual-search" type="search" placeholder="Object, recipient, rule name…"></label>
        <label>Include IPs / CIDRs<input id="ual-include" placeholder="203.0.113.8, 2001:db8::/32"></label>
        <label>Exclude IPs / CIDRs<input id="ual-exclude" placeholder="Trusted IPs or networks"></label>
        <label>IP availability<select id="ual-ip-mode"><option value="all">All records</option><option value="known">With a parsed IP</option><option value="unknown">Missing / unparseable IP</option></select></label>
        <label>Operation<select id="ual-operation"><option value="all">All operations</option></select></label>
        <label>Workload<select id="ual-workload"><option value="all">All workloads</option></select></label>
        <label>Result<select id="ual-result"><option value="all">All results</option><option value="success">Success</option><option value="failure">Failure</option><option value="other">Other / not returned</option></select></label>
      </div>
      <div class="actions"><button id="ual-apply" type="button">Apply filters</button><button id="ual-clear" type="button">Clear filters</button></div>
      <p class="help">IP filters change the view, preserving the collection. Separate addresses with commas or spaces. Exclusions take priority; records without an IP remain visible unless an include or availability filter removes them.</p>
      <p id="ual-view-status" class="help" role="status"></p>
      <div class="table-scroll"><table><thead><tr><th>Time (UTC)</th><th>Operation</th><th>User</th><th>Workload</th><th>Client IP</th><th>Object</th><th>Result</th><th>Details</th></tr></thead><tbody id="ual-body"></tbody></table></div>
      <div class="actions"><button id="ual-previous">Previous</button><span id="ual-page-info" class="help"></span><button id="ual-next">Next</button></div>
      <div class="actions"><label>Export scope<select id="ual-export-scope"><option value="filtered">All matching filtered records</option><option value="all">Complete collection</option></select></label><button id="ual-export-csv">Export CSV</button><button id="ual-export-json">Export JSON</button></div>
      <p class="help">Exports apply the current filter inputs. CSV exports include a .metadata.json companion with query details, auditing checks and coverage notes, including empty searches.</p>
      <details id="ual-record-details"><summary>Raw event</summary><pre id="ual-record-json">Select an event to inspect its captured fields.</pre></details>
      <div id="ual-coverage"></div>
    </section>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const input = (id: string) => el<HTMLInputElement>(id);
  const select = (id: string) => el<HTMLSelectElement>(id);
  const unwrap = <T>(reply: Reply<T>): T => { if (!reply.ok) throw new Error(reply.error); return reply.data; };
  const activity = (work: () => Promise<void>) => { void work().catch(error => context.message(String(error), 'failure')); };
  let evidence: UalCollection | null = null, page = 0, version = 0, busy = false;
  const filters = (): UalFilters => ({ search: input('ual-search').value.trim(), includeIPs: input('ual-include').value.trim(), excludeIPs: input('ual-exclude').value.trim(), ipMode: select('ual-ip-mode').value as UalFilters['ipMode'], operation: select('ual-operation').value, workload: select('ual-workload').value, result: select('ual-result').value as UalFilters['result'] });
  function controls(working: boolean, connected: boolean) {
    busy = working;
    el<HTMLButtonElement>('ual-collect').disabled = working || !connected;
    for (const format of ['csv', 'json']) el<HTMLButtonElement>(`ual-export-${format}`).disabled = working || !evidence;
    for (const id of ['ual-apply', 'ual-clear']) el<HTMLButtonElement>(id).disabled = working || !evidence;
  }
  function clearFilters() {
    for (const id of ['ual-search', 'ual-include', 'ual-exclude']) input(id).value = '';
    for (const id of ['ual-ip-mode', 'ual-operation', 'ual-workload', 'ual-result']) select(id).value = 'all';
    page = 0;
  }
  async function render(requestedFilters: UalFilters = filters()) {
    const current = ++version, source = evidence, epoch = context.generation();
    let view;
    try { view = evidence ? unwrap(await context.api.viewUal(requestedFilters, page)) : { records: [], page: 0, total: 0, matched: 0, unknownIPs: 0 }; }
    catch (error) { el('ual-view-status').textContent = String(error); throw error; }
    if (current !== version || source !== evidence || epoch !== context.generation()) return;
    page = view.page;
    el('ual-view-status').textContent = `${view.matched} matching / ${view.total} captured · ${view.unknownIPs} captured records without a parsed IP`;
    el('ual-heading').textContent = `Unified Audit Logs · ${view.total} events`;
    const body = el('ual-body'); body.replaceChildren();
    for (const record of view.records) {
      const tr = document.createElement('tr'); tr.dataset.tone = record.tone;
      for (const [index, value] of [record.time || 'Not returned', record.operation, record.user, record.workload, record.clientIP || 'Not returned', record.object].entries()) {
        const td = document.createElement('td');
        tableValue(td, value, open => context.audit({ action: 'table_cell_toggle', page: 'uals', id: record.id, field: ['Time', 'Operation', 'User', 'Workload', 'Client IP', 'Object'][index], open }), error => context.message(String(error), 'failure')); tr.append(td);
      }
      const status = document.createElement('td'), badge = document.createElement('span'); badge.className = 'status-badge'; badge.dataset.tone = record.tone; badge.textContent = record.result || 'Not returned'; status.append(badge); tr.append(status);
      const td = document.createElement('td'), button = document.createElement('button'); button.textContent = 'View';
      button.addEventListener('click', () => activity(async () => {
        await context.audit({ action: 'ual_record_view', id: record.id });
        if (source !== evidence || epoch !== context.generation()) return;
        el('ual-record-json').textContent = JSON.stringify(record, null, 2);
        await context.audit({ action: 'details_toggle', section: 'ual-record-details', open: true });
        el<HTMLDetailsElement>('ual-record-details').open = true;
      })); td.append(button); tr.append(td); body.append(tr);
    }
    if (!view.records.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 8; td.textContent = evidence ? 'No events match this view.' : 'Connect Exchange and collect UALs to begin.'; tr.append(td); body.append(tr); }
    el('ual-page-info').textContent = view.matched ? `${page * 100 + 1}–${Math.min((page + 1) * 100, view.matched)} of ${view.matched}` : '0 events';
    el<HTMLButtonElement>('ual-previous').disabled = page === 0;
    el<HTMLButtonElement>('ual-next').disabled = (page + 1) * 100 >= view.matched;
  }
  function coverage() {
    const panel = el('ual-coverage'); panel.replaceChildren();
    if (!evidence) return;
    for (const note of [...evidence.evidenceGaps, ...evidence.notes]) {
      const p = document.createElement('p'); p.className = 'help'; p.textContent = note;
      if (evidence.evidenceGaps.includes(note)) { p.dataset.tone = 'warning'; p.classList.add('ual-gap'); }
      panel.append(p);
    }
    if (evidence.auditChecks.length) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(evidence.auditChecks, null, 2); panel.append(pre); }
  }
  async function reset() {
    evidence = null; version++; page = 0; clearFilters(); input('ual-user').value = '';
    for (const id of ['ual-operation', 'ual-workload']) select(id).replaceChildren(new Option(id === 'ual-operation' ? 'All operations' : 'All workloads', 'all'));
    el('ual-info').textContent = 'No collection run yet.'; el('ual-record-json').textContent = 'Select an event to inspect its captured fields.'; el<HTMLDetailsElement>('ual-record-details').open = false;
    coverage(); await render();
  }
  select('ual-range').addEventListener('change', () => activity(async () => {
    const custom = select('ual-range').value === 'custom';
    await context.audit({ action: 'range_change', range: `ual:${select('ual-range').value}`, start: input('ual-start').value, end: input('ual-end').value });
    el('ual-custom-range').hidden = !custom; input('ual-start').required = custom; input('ual-end').required = custom;
  }));
  el('ual-bec').addEventListener('click', () => { input('ual-operations').value = becOperations; });
  el('ual-all-operations').addEventListener('click', () => { input('ual-operations').value = ''; });
  el('ual-form').addEventListener('submit', event => {
    event.preventDefault(); void context.run(async epoch => {
      evidence = null; version++; page = 0; clearFilters(); coverage(); await render();
      el('ual-record-json').textContent = 'Select an event to inspect its captured fields.'; el<HTMLDetailsElement>('ual-record-details').open = false;
      el('ual-info').textContent = 'Collection in progress. No completed UAL evidence available.';
      const range = select('ual-range').value, end = range === 'custom' ? new Date(input('ual-end').value) : new Date();
      const start = range === 'custom' ? new Date(input('ual-start').value) : new Date(end.getTime() - Number(range) * 3600000);
      context.message('Collecting unified audit metadata via Exchange…');
      let result: UalCollection;
      try { result = unwrap(await context.api.collectUal({ user: input('ual-user').value.trim(), start: start.toISOString(), end: end.toISOString(), operations: input('ual-operations').value.split(/[,;\s]+/).filter(Boolean) })); }
      catch (error) { if (epoch === context.generation()) el('ual-info').textContent = 'Collection failed. No completed UAL evidence available.'; throw error; }
      if (epoch !== context.generation()) return;
      evidence = result;
      for (const [id, values, label] of [['ual-operation', result.records.map(r => r.operation), 'All operations'], ['ual-workload', result.records.map(r => r.workload), 'All workloads']] as const) {
        select(id).replaceChildren(new Option(label, 'all'));
        for (const value of [...new Set(values)].filter(Boolean).sort()) select(id).add(new Option(value, value));
      }
      el('ual-info').textContent = `${result.query.user} · ${result.query.start} to ${result.query.end} · tenant ${result.tenant} · ${result.retrieval.pages ?? 0} search pages · collected ${result.collectedAt}`;
      coverage(); await render(); context.message(`Collected ${result.records.length} UAL events.`, result.evidenceGaps.length || !result.records.length ? 'warning' : 'success');
    });
  });
  el('ual-apply').addEventListener('click', () => { page = 0; activity(render); });
  el('ual-clear').addEventListener('click', () => { clearFilters(); activity(render); });
  for (const id of ['ual-search', 'ual-include', 'ual-exclude']) input(id).addEventListener('keydown', event => { if (event.key === 'Enter' && !busy) { event.preventDefault(); page = 0; activity(render); } });
  for (const id of ['ual-ip-mode', 'ual-operation', 'ual-workload', 'ual-result']) select(id).addEventListener('change', () => { if (!busy && evidence) { page = 0; activity(render); } });
  el('ual-previous').addEventListener('click', () => { page = Math.max(0, page - 1); activity(render); });
  el('ual-next').addEventListener('click', () => { page++; activity(render); });
  for (const format of ['csv', 'json'] as const) el(`ual-export-${format}`).addEventListener('click', () => void context.run(async epoch => {
    const currentFilters = filters(), scope = select('ual-export-scope').value as 'all' | 'filtered';
    await render(currentFilters);
    if (epoch !== context.generation()) return;
    const path = unwrap(await context.api.exportUal(format, scope, currentFilters));
    if (epoch === context.generation()) context.message(path ? `Exported ${path}${format === 'csv' ? ' and .metadata.json companion' : ''}` : 'Export cancelled.', path ? 'success' : 'neutral');
  }));
  el<HTMLDetailsElement>('ual-record-details').addEventListener('click', event => {
    if ((event.target as HTMLElement).tagName !== 'SUMMARY') return;
    event.preventDefault(); activity(async () => {
      const details = el<HTMLDetailsElement>('ual-record-details'), open = !details.open;
      await context.audit({ action: 'details_toggle', section: 'ual-record-details', open }); details.open = open;
    });
  });
  return { controls, render, reset };
}

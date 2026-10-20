import { initializeM365Tabs } from './m365-tabs.js';
import { initializeNotepad } from './notepad-ui.js';
import { initializeDataTools } from './data-tools.js';
import { initializeBrowserHistory } from './browser-history-ui.js';
import { initializeKqlLibrary } from './kql-library.js';
import { initializeAuditLogs } from './audit-logs.js';
import { initializeUalLogs } from './ual-logs.js';
import { tableValue } from './table-value.js';
import { initializeIdentityTabs } from './identity-tabs.js';
import type { AuthMode, BecApi, Collection, ConditionalAccessReport, Reply, SessionState, SignIn, UiAuditEvent, WorkspacePage, Provider, OsintReport } from './contracts';
declare global { interface Window { bec: BecApi } }

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing interface element: ${id}`);
  return value as T;
};
const input = (id: string) => el<HTMLInputElement>(id);
const authMode = () => el<HTMLSelectElement>('auth-mode').value as AuthMode;
async function audit(event: UiAuditEvent): Promise<void> { unwrap(await window.bec.audit(event)); }
function activity(work: () => Promise<void>): void {
  void work().catch(error => message(String(error)));
}
async function showLogInfo(): Promise<void> {
  const info = unwrap(await window.bec.logInfo());
  el('investigation-log').textContent = `Investigation ${info.id} · Log: ${info.file}`;
}
async function prepareAuth(service: string): Promise<void> {
  await audit({ action: 'details_toggle', section: 'session-output', open: true });
  el('session-output').parentElement!.setAttribute('open', '');
  const text = authMode() === 'browser'
    ? `Requesting ${service} sign-in. Your browser will open when the device code arrives. Enter the code from Session output on the Microsoft page.`
    : `Requesting ${service} device sign-in. No popup is expected. Use the URL and code that appear in Session output below.`;
  el('session-output').textContent = text;
  message(text, 'warning');
}
let state: SessionState = { graph: false, exchange: false, tenant: '', account: '' };
let busy = false;
let generation = 0;
let collection: Collection | null = null;
let page = 0;
type Tone = 'neutral' | 'success' | 'failure' | 'warning';
const connectionPhase: Record<'graph' | 'exchange', 'idle' | 'connecting' | 'failed'> = { graph: 'idle', exchange: 'idle' };
const pageSize = 100;
const selected = new Set<string>();
let visibleIds: string[] = [];
let selectionQueue = Promise.resolve();
function clearConditionalAccess(): void {
  el('ca-panel').hidden = true; el('ca-events').replaceChildren();
  el('ca-policy-json').textContent = 'Choose a policy evaluation to inspect its raw fields.';
}
function selectionControls(): void {
  el('selection-count').textContent = `${selected.size} sign-ins selected (across pages and filters)`;
  el<HTMLButtonElement>('inspect-ca').disabled = busy || selected.size === 0;
  el<HTMLButtonElement>('clear-selection').disabled = busy || selected.size === 0;
  el<HTMLButtonElement>('select-page').disabled = busy || visibleIds.length === 0;
  document.querySelectorAll<HTMLInputElement>('[data-select-signin]').forEach(box => {
    box.checked = selected.has(box.dataset.selectSignin!); box.disabled = busy;
  });
}
function changeSelection(change: (ids: Set<string>) => void): void {
  if (busy) return;
  const source = collection, epoch = generation;
  selectionQueue = selectionQueue.then(async () => {
    if (source !== collection || epoch !== generation) return;
    const next = new Set(selected); change(next);
    await audit({ action: 'sign_in_selection', ids: [...next] });
    if (source !== collection || epoch !== generation) return;
    selected.clear(); next.forEach(id => selected.add(id)); clearConditionalAccess(); selectionControls();
  }).catch(error => { selectionControls(); message(String(error)); });
}

function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
function message(value: string, tone: Tone = 'neutral'): void {
  el('operation-status').textContent = value; el('operation-status').dataset.tone = tone;
}
function connectionIndicators(): void {
  for (const service of ['graph', 'exchange'] as const) {
    const connected = state[service], phase = connectionPhase[service];
    const tone: Tone = connected ? 'success' : phase === 'failed' ? 'failure' : phase === 'connecting' ? 'warning' : 'neutral';
    const label = connected ? 'Connected successfully' : phase === 'failed' ? 'Connection failed — retry sign-in' : phase === 'connecting' ? 'Connecting — complete authentication' : 'Disconnected';
    el(`${service}-connection`).textContent = `${service === 'graph' ? 'Graph' : 'Exchange'}: ${connected ? 'connected' : phase === 'failed' ? 'failed' : phase === 'connecting' ? 'connecting' : 'disconnected'}`;
    el(`${service}-connection`).dataset.tone = tone;
    el(`${service}-card`).dataset.tone = tone;
    el(`${service}-card-status`).textContent = label;
  }
  el('session-status').dataset.tone = state.graph ? 'success' : connectionPhase.graph === 'failed' ? 'failure' : 'neutral';
}
function controls(): void {
  identityTabs.controls(busy, state.graph);
  auditLogs.controls(busy, state.graph);
  ualLogs.controls(busy, state.exchange);
  m365Tabs.controls(busy, state);
  selectionControls();
  el<HTMLSelectElement>('auth-mode').disabled = busy;
  for (const id of ['install', 'connect', 'exchange', 'collect']) el<HTMLButtonElement>(id).disabled = busy;
  el<HTMLButtonElement>('connect').disabled = busy || state.graph;
  input('tenant').disabled = busy || state.graph;
  el<HTMLButtonElement>('exchange').disabled = busy || !state.graph || state.exchange;
  el<HTMLButtonElement>('collect').disabled = busy || !state.graph;
  for (const id of ['export-csv', 'export-json']) el<HTMLButtonElement>(id).disabled = busy || !collection;
  el('session-status').textContent = state.graph
    ? `Graph: ${state.account} · tenant ${state.tenant} | Exchange: ${state.exchange ? 'connected' : 'disconnected'}`
    : 'Disconnected. Connect Graph to begin investigation.';
  connectionIndicators();
  el('connection-summary').title = state.graph ? `${state.account} · tenant ${state.tenant}` : 'Manage connections in the Session tab';
}
async function operation(work: (epoch: number) => Promise<void>): Promise<void> {
  if (busy) return;
  const epoch = generation;
  busy = true; controls();
  try { await work(epoch); }
  catch (error) { if (epoch === generation) message(error instanceof Error ? error.message : String(error), 'failure'); }
  finally {
    if (epoch === generation) {
      try { state = unwrap(await window.bec.state()); } catch { /* App may be closing. */ }
      busy = false; controls();
    }
  }
}
const auditLogs = initializeAuditLogs({ api: window.bec, run: operation, audit, message, generation: () => generation, state: () => state });
const identityTabs = initializeIdentityTabs({ api: window.bec, run: operation, audit, message, generation: () => generation, state: () => state });
const ualLogs = initializeUalLogs({ api: window.bec, run: operation, audit, message, generation: () => generation, state: () => state });
const m365Tabs = initializeM365Tabs({ api: window.bec, run: operation, audit, message, generation: () => generation, state: () => state });
let navigationSequence = 0;
async function navigate(page: WorkspacePage): Promise<void> {
  const currentNavigation = ++navigationSequence;
  await audit({ action: 'navigate', page });
  if (currentNavigation !== navigationSequence) return;
  const parent = document.querySelector(`[data-page="${page}"]`)?.closest<HTMLDetailsElement>('details.nav-group');
  if (parent && !parent.open) {
    await audit({ action: 'nav_group_toggle', group: parent.id === 'entra-nav' ? 'entra' : 'm365', open: true });
    parent.open = true;
  }
  if (currentNavigation !== navigationSequence) return;
  const pages = {
    session: { title: 'Session', description: 'Manage Graph and Exchange connections for BEC compromise investigations.' },
    'sign-ins': { title: 'Sign in Exports', description: 'Query and export Entra sign-in logs.' },
    toolkit: { title: 'OSINT Toolkit', description: 'IP reputation and file intelligence for standard BAU investigations.' },
    notepad: { title: 'Notepad', description: 'Tabbed notes. Save locally only when needed.' },
    'data-tools': { title: 'Data Tools', description: 'Defang, refang, Base64 and JSON.' },
    'browser-history': { title: 'Browser History', description: 'Chrome, Edge and Firefox history databases.' },
    'kql-library': { title: 'KQL Library', description: 'Saved query templates and parameters.' },
    settings: { title: 'Settings', description: 'Manage OSINT provider API keys.' },
    'audit-logs': { title: 'Audit Logs', description: 'Entra directory changes performed by or targeting the affected account.' },
    'risk-detections': { title: 'Risk Detections', description: 'Identity Protection risk events for the affected account.' },
    devices: { title: 'Devices', description: 'Current owned devices and incident-window registration activity.' },
    'app-consents': { title: 'App Consents', description: 'Delegated grants and consent activity affecting the account.' },
    'inbox-rules': { title: 'Inbox Rules', description: 'Current rules and historical rule changes.' },
    'trace-outbound': { title: 'Outbound Trace', description: 'Sender-scoped message trace metadata.' },
    'trace-inbound': { title: 'Inbound Trace', description: 'Recipient-scoped message trace and rule candidates.' },
    'defender-review': { title: 'Quarantine / Threat Explorer', description: 'Defender delivery, threat and URL metadata.' },
    forwarding: { title: 'Forwarding', description: 'Mailbox forwarding and tenant transport rules.' },
    uals: { title: 'UALs', description: 'Microsoft 365 unified audit logs.' },
  };
  const { title, description } = pages[page];
  el('breadcrumb').textContent = title; el('page-title').textContent = title;
  el('page-description').textContent = description;
  el('notepad-module').hidden = page !== 'notepad';
  el('data-module').hidden = page !== 'data-tools';
  el('history-module').hidden = page !== 'browser-history';
  el('kql-module').hidden = page !== 'kql-library';
  el('toolkit-module').hidden = page !== 'toolkit';
  el('settings-module').hidden = page !== 'settings';
  document.querySelector<HTMLElement>('.shared-session')!.hidden = page === 'toolkit' || page === 'kql-library' || page === 'browser-history' || page === 'data-tools' || page === 'notepad' || page === 'settings';
  el('operation-status').hidden = page === 'toolkit' || page === 'kql-library' || page === 'browser-history' || page === 'data-tools' || page === 'notepad' || page === 'settings';
  if (page === 'settings') void refreshKeys();
  el('session-module').hidden = page !== 'session';
  el('uals-module').hidden = page !== 'uals';
  for (const kind of ['inbox-rules','trace-outbound','trace-inbound','defender-review','forwarding']) el(`${kind}-module`).hidden = page !== kind;
  for (const kind of ['risk-detections', 'devices', 'app-consents']) el(`${kind}-module`).hidden = page !== kind;
  el('sign-in-module').hidden = page !== 'sign-ins'; el('audit-module').hidden = page !== 'audit-logs';
  document.title = `${title} · BEC Bot`;
  document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => {
    const active = button.dataset.page === page; button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  document.querySelectorAll<HTMLDetailsElement>('.nav-group').forEach(group => {
    group.classList.toggle('has-active-page', Boolean(group.querySelector('[aria-current="page"]')));
  });
}
for (const group of ['entra', 'm365'] as const) {
  const details = el<HTMLDetailsElement>(`${group}-nav`);
  details.querySelector('summary')!.addEventListener('click', event => {
    event.preventDefault();
    activity(async () => {
      const open = !details.open;
      await audit({ action: 'nav_group_toggle', group, open });
      details.open = open;
    });
  });
}
document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(button => {
  button.addEventListener('click', () => activity(() => navigate(button.dataset.page as WorkspacePage)));
});
el('open-session').addEventListener('click', () => activity(() => navigate('session')));
window.bec.onLog(text => {
  const output = el('session-output');
  output.textContent = (output.textContent + '\n' + text).slice(-40000);
  (output.parentElement as HTMLDetailsElement).open = true; output.scrollTop = output.scrollHeight;
});
el('install').addEventListener('click', () => void operation(async epoch => {
  message('Installing Graph Authentication and ExchangeOnlineManagement for this Windows user…');
  unwrap(await window.bec.install()); if (epoch !== generation) return;
  message('Modules installed. Enter the tenant ID, then connect Graph.');
}));
el('connect').addEventListener('click', () => void operation(async epoch => {
  connectionPhase.graph = 'connecting'; controls();
  try {
    await prepareAuth('Microsoft Graph');
    const result = unwrap(await window.bec.connect(input('tenant').value.trim(), authMode()));
    if (epoch !== generation) return;
    state = result; connectionPhase.graph = 'idle';
    message(`Microsoft Graph connected successfully as ${state.account}. Investigation session ready.`, 'success');
  } catch (error) { if (epoch === generation) connectionPhase.graph = 'failed'; throw error; }
}));
el('exchange').addEventListener('click', () => void operation(async epoch => {
  connectionPhase.exchange = 'connecting'; controls();
  try {
    await prepareAuth('Exchange');
    const result = unwrap(await window.bec.exchange(authMode())); if (epoch !== generation) return;
    state = result; connectionPhase.exchange = 'idle';
    message('Exchange Online connected successfully. The connection is available across this investigation.', 'success');
  } catch (error) { if (epoch === generation) connectionPhase.exchange = 'failed'; throw error; }
}));
el('reset').addEventListener('click', async () => {
  generation++; busy = true; controls();
  try {
    state = unwrap(await window.bec.reset()); collection = null; selected.clear(); clearConditionalAccess(); await auditLogs.reset(); await identityTabs.reset(); await ualLogs.reset(); await m365Tabs.reset();
    connectionPhase.graph = 'idle'; connectionPhase.exchange = 'idle';
    el('session-output').textContent = 'Session cleared.';
    el('record-json').textContent = 'Select a record to inspect all returned fields.';
    input('user').value = ''; input('search').value = ''; page = 0;
    el('collection-info').textContent = 'Results stay in memory until exported or the session is cleared.';
    await showLogInfo(); await render(); await navigate('session'); message('Fresh investigation. Connect to the required tenant.');
  } catch (error) { message(String(error)); }
  finally { busy = false; controls(); }
});
el('range').addEventListener('change', () => activity(async () => {
  await auditRange();
  const custom = el<HTMLSelectElement>('range').value === 'custom';
  el('custom-range').hidden = !custom; input('start').required = custom; input('end').required = custom;
}));
async function auditRange(): Promise<void> {
  await audit({ action: 'range_change', range: el<HTMLSelectElement>('range').value, start: input('start').value, end: input('end').value });
}
for (const id of ['start', 'end']) el(id).addEventListener('change', () => activity(auditRange));
el('query-form').addEventListener('submit', event => {
  event.preventDefault();
  void operation(async epoch => {
    const range = el<HTMLSelectElement>('range').value;
    const end = range === 'custom' ? new Date(input('end').value) : new Date();
    const start = range === 'custom' ? new Date(input('start').value) : new Date(end.getTime() - Number(range) * 3600000);
    collection = null; selected.clear(); clearConditionalAccess(); page = 0; await render(); controls();
    el('record-json').textContent = 'Select a record to inspect all returned fields.';
    el('collection-info').textContent = 'Collection in progress. No completed evidence set available.';
    message('Collecting both sign-in types and all result pages…');
    const result = unwrap(await window.bec.collect({ user: input('user').value.trim(), start: start.toISOString(), end: end.toISOString() }));
    if (epoch !== generation) return;
    collection = result;
    input('search').value = ''; el<HTMLSelectElement>('type-filter').value = 'all';
    el('collection-info').textContent = `${collection.query.user} | ${collection.query.start} → ${collection.query.end} (exclusive) | tenant ${collection.tenant} | collected ${collection.collectedAt}`;
    await render(); message(`Collection complete: ${collection.rows.length} records. Only logs still retained by Microsoft Entra are available.`);
  });
});
function interactive(row: SignIn): boolean { return row.signInEventTypes?.includes('interactiveUser') ?? row.isInteractive; }
function signInOutcome(row: SignIn): { tone: Tone; label: string } {
  const code = row.status?.errorCode;
  if (code === 0) return { tone: 'success', label: 'Success' };
  if (code === undefined || code === null) return { tone: 'neutral', label: 'Unknown' };
  // Documented MFA/enrolment and interactive challenge interruptions. Preserve raw
  // failure details; do not classify a failed MFA challenge as an MFA requirement.
  const interrupted = new Set([50072, 50074, 50076, 50079, 50125, 50140, 50158]);
  return interrupted.has(code)
    ? { tone: 'warning', label: 'Interrupted / MFA' }
    : { tone: 'failure', label: 'Failed' };
}
let renderVersion = 0;
async function render(): Promise<void> {
  const version = ++renderVersion;
  const currentGeneration = generation;
  const search = input('search').value.toLowerCase(), type = el<HTMLSelectElement>('type-filter').value;
  const rows = (collection?.rows ?? []).filter(row =>
    (type === 'all' || (type === 'interactive' ? interactive(row) : !interactive(row))) && JSON.stringify(row).toLowerCase().includes(search));
  page = Math.max(0, Math.min(page, Math.ceil(rows.length / pageSize) - 1));
  await audit({ action: 'results_view', search, type, page, ids: rows.slice(page * pageSize, (page + 1) * pageSize).map(row => row.id) });
  if (version !== renderVersion || currentGeneration !== generation) return;
  visibleIds = rows.slice(page * pageSize, (page + 1) * pageSize).map(row => row.id);
  const body = el('results-body'); body.replaceChildren();
  for (const row of rows.slice(page * pageSize, (page + 1) * pageSize)) {
    const tr = document.createElement('tr');
    const selectCell = document.createElement('td'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.dataset.selectSignin = row.id;
    checkbox.setAttribute('aria-label', `Select sign-in ${row.id} at ${row.createdDateTime}`);
    checkbox.checked = selected.has(row.id); checkbox.disabled = busy;
    checkbox.addEventListener('change', () => {
      const checked = checkbox.checked;
      checkbox.checked = selected.has(row.id);
      changeSelection(ids => { if (checked) ids.add(row.id); else ids.delete(row.id); });
    });
    selectCell.append(checkbox); tr.append(selectCell);
    const outcome = signInOutcome(row); tr.dataset.tone = outcome.tone;
    for (const [index, value] of [row.createdDateTime, interactive(row) ? 'Interactive' : 'Non-interactive', row.appDisplayName, row.ipAddress, [row.location?.city, row.location?.countryOrRegion].filter(Boolean).join(', ')].entries()) {
      const td = document.createElement('td'); tableValue(td, value, open => audit({ action: 'table_cell_toggle', page: 'sign-ins', id: row.id, field: ['Time', 'Type', 'Application', 'IP', 'Location'][index], open }), error => message(String(error), 'failure')); tr.append(td);
    }
    const resultCell = document.createElement('td'), badge = document.createElement('span');
    badge.className = 'status-badge'; badge.dataset.tone = outcome.tone; badge.textContent = outcome.label;
    resultCell.append(badge);
    if (row.status?.errorCode !== 0) {
      const detail = document.createElement('small'); detail.className = 'result-detail';
      tableValue(detail, `${row.status?.errorCode ?? 'No error code returned'}${row.status?.failureReason ? ': ' + row.status.failureReason : ''}`, open => audit({ action: 'table_cell_toggle', page: 'sign-ins', id: row.id, field: 'Result reason', open }), error => message(String(error), 'failure'));
      resultCell.append(detail);
    }
    tr.append(resultCell);
    const td = document.createElement('td'), button = document.createElement('button');
    button.textContent = 'View'; button.addEventListener('click', () => activity(async () => {
      await audit({ action: 'record_view', id: row.id });
      if (currentGeneration !== generation) return;
      el('record-json').textContent = JSON.stringify(row, null, 2); el<HTMLDetailsElement>('record-details').open = true;
    })); td.append(button); tr.append(td); body.append(tr);
  }
  if (!rows.length) {
    const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 8;
    td.textContent = collection ? 'No sign-ins match this view.' : 'Connect and collect sign-ins to begin.';
    tr.append(td); body.append(tr);
  }
  el('results-heading').textContent = `Sign-ins · ${collection?.rows.length ?? 0} records`;
  el('page-info').textContent = rows.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, rows.length)} of ${rows.length}` : '0 records';
  el<HTMLButtonElement>('previous').disabled = page === 0;
  el<HTMLButtonElement>('next').disabled = (page + 1) * pageSize >= rows.length;
  selectionControls();
}
el('select-page').addEventListener('click', () => {
  const ids = [...visibleIds]; changeSelection(selection => ids.forEach(id => selection.add(id)));
});
el('clear-selection').addEventListener('click', () => changeSelection(ids => ids.clear()));
el('inspect-ca').addEventListener('click', () => void operation(async epoch => {
  await selectionQueue;
  const report = unwrap(await window.bec.conditionalAccess([...selected]));
  if (epoch !== generation) return;
  renderConditionalAccess(report);
  message(`Conditional Access evaluations shown for ${report.events.length} selected sign-ins from captured JSON.`);
}));

function renderConditionalAccess(report: ConditionalAccessReport): void {
  const events = el('ca-events'); events.replaceChildren();
  const unavailable = report.events.filter(event => event.availability === 'unavailable').length;
  const evaluations = report.events.reduce((total, event) => total + event.policies.length, 0);
  el('ca-summary').textContent = `${report.events.length} selected sign-ins · ${evaluations} policy evaluations · ${unavailable} sign-ins with unavailable policy detail | Tenant ${report.tenant} | Evidence collected ${report.collectedAt}`;
  for (const event of report.events) {
    const section = document.createElement('section'); section.className = 'ca-event';
    const heading = document.createElement('div'); heading.className = 'ca-event-heading';
    const title = document.createElement('h3'); title.textContent = `${event.time} · ${event.user}`;
    const context = document.createElement('p'); context.textContent = `${event.application} | ${event.ip} | Sign-in ID ${event.signInId} | Overall Conditional Access: ${event.overallStatus}`;
    heading.append(title, context); section.append(heading);
    if (event.availability !== 'returned') {
      const notice = document.createElement('p'); notice.className = 'ca-notice';
      notice.textContent = event.availability === 'empty'
        ? 'Graph returned an empty policy list for this event. No per-policy evaluations are available; this is not a per-policy “not applied” result.'
        : 'Policy details were not returned in this record. This does not mean “not applied”.';
      section.append(notice);
    } else {
      const scroll = document.createElement('div'); scroll.className = 'table-scroll';
      const table = document.createElement('table'), head = document.createElement('thead'), header = document.createElement('tr');
      for (const name of ['Policy', 'Policy ID', 'Outcome (raw)', 'Grant controls', 'Session controls', 'Details']) {
        const th = document.createElement('th'); th.textContent = name; header.append(th);
      }
      head.append(header); table.append(head);
      const body = document.createElement('tbody');
      event.policies.forEach((policy, index) => {
        const row = document.createElement('tr');
        for (const [column, value] of [policy.displayName ?? '(unnamed policy)', policy.id ?? '(not returned)', policy.result ?? 'unknown', policy.enforcedGrantControls?.join(', ') ?? '—', policy.enforcedSessionControls?.join(', ') ?? '—'].entries()) {
          const cell = document.createElement('td'); tableValue(cell, value, open => audit({ action: 'table_cell_toggle', page: 'sign-ins', id: event.signInId, field: `CA policy ${index}, column ${column}`, open }), error => message(String(error), 'failure')); row.append(cell);
        }
        const cell = document.createElement('td'), button = document.createElement('button'); button.textContent = 'View evaluation';
        button.addEventListener('click', () => activity(async () => {
          const epoch = generation, source = collection;
          await audit({ action: 'ca_policy_view', signInId: event.signInId, index });
          if (epoch !== generation || source !== collection) return;
          el('ca-policy-json').textContent = JSON.stringify({ signInId: event.signInId, policy }, null, 2);
          el<HTMLDetailsElement>('ca-policy-details').open = true;
        }));
        cell.append(button); row.append(cell); body.append(row);
      });
      table.append(body); scroll.append(table); section.append(scroll);
    }
    events.append(section);
  }
  el('ca-panel').hidden = false;
}
for (const id of ['search', 'type-filter']) el(id).addEventListener('input', () => { page = 0; activity(render); });
el('previous').addEventListener('click', () => { page--; activity(render); });
el('next').addEventListener('click', () => { page++; activity(render); });
for (const section of ['session-output', 'record-details', 'ca-policy-details'] as const) {
  const details = section === 'session-output' ? el(section).parentElement as HTMLDetailsElement : el<HTMLDetailsElement>(section);
  details.querySelector('summary')!.addEventListener('click', event => {
    event.preventDefault();
    activity(async () => {
      const open = !details.open;
      await audit({ action: 'details_toggle', section, open });
      details.open = open;
    });
  });
}
for (const format of ['csv', 'json'] as const) el(`export-${format}`).addEventListener('click', () => void operation(async epoch => {
  const saved = unwrap(await window.bec.export(format)); if (epoch !== generation) return;
  message(saved ? `Exported complete collection to ${saved}` : 'Export cancelled.');
}));
controls();
void operation(async () => {
  await showLogInfo(); await navigate('session'); await render(); await auditLogs.render(); await identityTabs.render(); await ualLogs.render(); await m365Tabs.render();
  state = unwrap(await window.bec.state());
});

const providerNames: Record<Provider, string> = { virustotal: 'VirusTotal', abuseipdb: 'AbuseIPDB', ipdata: 'IPData' };
for (const provider of Object.keys(providerNames) as Provider[]) {
  const field = document.createElement('div'); field.className = 'key-field';
  const label = document.createElement('label'); label.textContent = providerNames[provider];
  const key = document.createElement('input'); key.id = `key-${provider}`; key.type = 'password'; key.autocomplete = 'new-password'; key.maxLength = 1024;
  const status = document.createElement('span'); status.id = `key-status-${provider}`; status.className = 'help';
  label.append(key, status);
  const removeLabel = document.createElement('label'); removeLabel.className = 'checkbox-label';
  const remove = document.createElement('input'); remove.type = 'checkbox'; remove.id = `remove-${provider}`;
  remove.addEventListener('change', () => { key.disabled = remove.checked; if (remove.checked) key.value = ''; });
  removeLabel.append(remove, 'Remove saved key'); field.append(label, removeLabel); el('key-fields').append(field);
}
function keyStatuses(status: Record<Provider, boolean>): void {
  for (const p of Object.keys(providerNames) as Provider[]) el(`key-status-${p}`).textContent = status[p] ? 'Key saved' : 'Not configured';
}
async function refreshKeys(): Promise<void> {
  try { keyStatuses(unwrap(await window.bec.keyStatus())); } catch (error) { el('keys-status').textContent = String(error); }
}
el('keys-form').addEventListener('submit', event => {
  event.preventDefault();
  void (async () => {
    const button = el<HTMLButtonElement>('save-keys'); button.disabled = true;
    try {
      const changes: Partial<Record<Provider, string>> = {};
      for (const p of Object.keys(providerNames) as Provider[]) {
        if (input(`remove-${p}`).checked) changes[p] = '';
        else if (input(`key-${p}`).value.trim()) changes[p] = input(`key-${p}`).value.trim();
      }
      keyStatuses(unwrap(await window.bec.saveKeys(changes)));
      for (const p of Object.keys(providerNames) as Provider[]) { input(`key-${p}`).value = ''; input(`key-${p}`).disabled = false; input(`remove-${p}`).checked = false; }
      el('keys-status').textContent = 'API keys saved securely.';
    } catch (error) { el('keys-status').textContent = String(error); }
    finally { button.disabled = false; }
  })();
});
function renderOsint(report: OsintReport): void {
  const root = el('osint-results'); root.replaceChildren();
  const make = (tag: string, text = '', cls = ''): HTMLElement => {
    const node = document.createElement(tag); node.textContent = text; node.className = cls; return node;
  };
  const display = (v: unknown): string => v == null || v === '' ? 'Not available' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
  const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const assessments = report.results.filter(r => report.kind === 'ip' || r.provider === 'virustotal').map(result => {
    const d = result.data ?? {}; let tone: Tone = 'neutral';
    if (result.status === 'ok') {
      if (result.provider === 'virustotal') {
        const stats = d.last_analysis_stats ?? {};
        if (number(stats.malicious) && stats.malicious > 0) tone = 'failure';
        else if (number(stats.suspicious) && stats.suspicious > 0) tone = 'failure';
        else if (stats.malicious === 0 && stats.suspicious === 0) tone = 'success';
        if (Object.values(d.last_analysis_results ?? {}).some(v => v && typeof v === 'object' && ['malicious', 'suspicious'].includes(String((v as Record<string, unknown>).category)))) tone = 'failure';
      } else if (result.provider === 'abuseipdb') {
        if (d.totalReports > 0 || d.abuseConfidenceScore > 0 || (Array.isArray(d.reports) && d.reports.length > 0)) tone = 'failure';
        else if (d.totalReports === 0 && d.abuseConfidenceScore === 0) tone = 'success';
      } else {
        const t = d.threat ?? {};
        if (['is_threat', 'is_known_attacker', 'is_known_abuser'].some(k => t[k] === true) || (Array.isArray(t.blocklists) && t.blocklists.length > 0)) tone = 'failure';
        else if (t.is_threat === false) tone = 'success';
      }
    }
    return { result, d, tone };
  });
  const heading = make('div', '', 'osint-heading');
  heading.append(make('strong', report.indicator, 'indicator-value'), make('span', `Queried ${report.queriedAt}`, 'help'));
  root.append(heading);
  const overall: Tone = assessments.some(a => a.tone === 'failure') ? 'failure' : assessments.length > 0 && assessments.every(a => a.tone === 'success') ? 'success' : 'neutral';
  const status = make('div', overall === 'failure' ? 'Detections / reports present' : overall === 'success' ? '0 detections / reports' : 'Assessment incomplete', 'osint-status-bar');
  status.dataset.tone = overall; status.setAttribute('role', 'status'); root.append(status);
  const facts = make('div', '', 'osint-facts');
  const fact = (label: string, value: string, source: string) => { const box = make('div'); box.append(make('span', label, 'eyebrow'), make('strong', value), make('small', source)); facts.append(box); };
  if (report.kind === 'ip') {
    const successful = assessments.filter(a => a.result.status === 'ok');
    const located = [...successful].sort((a,b) => (a.result.provider === 'ipdata' ? -1 : b.result.provider === 'ipdata' ? 1 : 0)).find(a => a.d.country_name || a.d.countryName || a.d.country || a.d.countryCode);
    const location = located ? [located.d.city, located.d.region, located.d.country_name ?? located.d.countryName ?? located.d.country ?? located.d.countryCode].filter(Boolean).join(', ') : 'Not available';
    fact('Location', location, located ? providerNames[located.result.provider] : 'No location returned');
    const owner = successful.find(a => a.d.isp || a.d.as_owner || a.d.asn?.name);
    fact('ISP / network', display(owner && (owner.d.isp ?? owner.d.as_owner ?? owner.d.asn?.name)), owner ? providerNames[owner.result.provider] : 'No ownership returned');
    const asn = successful.find(a => a.d.asn);
    fact('ASN', display(asn && (typeof asn.d.asn === 'object' ? asn.d.asn.asn : `AS${String(asn.d.asn).replace(/^AS/, '')}`)), asn ? providerNames[asn.result.provider] : 'No ASN returned');
  } else {
    const d = assessments[0]?.d ?? {};
    fact('File', display(d.meaningful_name ?? d.names?.[0]), display(d.type_description));
    fact('Signature', display(d.signature_info?.verified), 'VirusTotal');
    fact('Signer', display(d.signature_info?.signers ?? d.signature_info?.signer), 'VirusTotal');
  }
  root.append(facts);
  const grid = make('div', '', 'osint-grid'); root.append(grid);
  for (const a of assessments) {
    const { result, d } = a;
    const card = make('section', '', 'osint-card'); card.dataset.tone = a.tone;
    const title = make('div', '', 'provider-heading');
    title.append(make('h2', providerNames[result.provider])); card.append(title);
    const summary = make('div', '', 'provider-summary'); card.append(summary);
    const datum = (label: string, value: unknown, tone: Tone = 'neutral') => {
      const item = make('span', '', 'detection-datum'); item.dataset.tone = tone;
      item.append(make('strong', display(value)), make('span', label)); summary.append(item);
    };
    if (result.status !== 'ok') summary.append(make('span', result.message ?? result.status, 'help'));
    else if (result.provider === 'virustotal') {
      const stats = d.last_analysis_stats ?? {};
      for (const [category, count] of Object.entries(stats)) datum(category.replaceAll('_', ' '), count, ['malicious', 'suspicious'].includes(category) && Number(count) > 0 ? 'failure' : ['harmless', 'undetected'].includes(category) || (['malicious', 'suspicious'].includes(category) && count === 0) ? 'success' : 'neutral');
      if (!Object.keys(stats).length) summary.append(make('span', 'Analysis counts unavailable', 'help'));
      const detections = Object.entries(d.last_analysis_results ?? {}) as [string, Record<string, unknown>][];
      const positive = detections.filter(([, value]) => value.category === 'malicious' || value.category === 'suspicious');
      if (positive.length) {
        const list = make('div', '', 'positive-detections');
        for (const [engine, value] of positive) {
          const item = make('span', `${engine}: ${display(value.result ?? value.category)}`, 'status-badge'); item.dataset.tone = 'failure'; list.append(item);
        }
        card.append(list);
      }
    } else if (result.provider === 'abuseipdb') {
      datum('abuse confidence', number(d.abuseConfidenceScore) ? `${d.abuseConfidenceScore}%` : undefined, a.tone);
      datum('reports / 90 days', d.totalReports, d.totalReports > 0 ? 'failure' : a.tone);
      datum('reporters', d.numDistinctUsers);
      datum('last reported', d.lastReportedAt);
      const reports = (Array.isArray(d.reports) ? d.reports : []).filter((r: unknown): r is Record<string, unknown> => Boolean(r) && typeof r === 'object' && !Array.isArray(r))
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => (Date.parse(String(b.reportedAt)) || 0) - (Date.parse(String(a.reportedAt)) || 0));
      if (reports.length) {
        const reportList = (items: Record<string, unknown>[], snippet: boolean): HTMLElement => {
          const list = make('div', '', 'abuse-reports');
          for (const item of items) {
            const entry = make('article', '', 'abuse-report');
            entry.append(make('div', `${display(item.reportedAt)} · ${display(item.reporterCountryName ?? item.reporterCountryCode)} · Reporter ${display(item.reporterId)} · Categories: ${display(item.categories)}`, 'help'));
            const comment = display(item.comment);
            entry.append(make('p', snippet && comment.length > 350 ? `${comment.slice(0, 350)}…` : comment)); list.append(entry);
          }
          return list;
        };
        card.append(make('h3', 'Recent reports', 'recent-reports-heading'), reportList(reports.slice(0, 3), true));
        const allReports = document.createElement('details'); allReports.className = 'all-abuse-reports';
        allReports.append(make('summary', `View all returned reports (${reports.length})`));
        if (d.totalReports > reports.length) allReports.append(make('p', `${reports.length} of ${d.totalReports} reports returned by the API. Use Report for the provider history.`, 'help'));
        // Populate a potentially large report list only when requested.
        allReports.addEventListener('toggle', () => { if (allReports.open && !allReports.querySelector('.abuse-reports')) allReports.append(reportList(reports, false)); });
        card.append(allReports);
      } else if (d.totalReports > 0) card.append(make('p', 'Report comments not returned. Open Report for history.', 'help'));
    } else {
      const threat = d.threat ?? {};
      for (const [flag, value] of Object.entries(threat)) {
        if (typeof value === 'boolean') datum(flag.replace(/^is_/, '').replaceAll('_', ' '), value ? 'Yes' : 'No', value && ['is_threat', 'is_known_attacker', 'is_known_abuser'].includes(flag) ? 'failure' : value ? 'warning' : 'neutral');
      }
      if (Array.isArray(threat.blocklists) && threat.blocklists.length) {
        const lists = make('div', '', 'positive-detections');
        for (const list of threat.blocklists) { const badge = make('span', display(list.name ?? list.site ?? list), 'status-badge'); badge.dataset.tone = 'failure'; lists.append(badge); }
        card.append(lists);
      }
      if (!Object.keys(threat).length) summary.append(make('span', 'Threat data unavailable', 'help'));
    }
    if (result.provider !== 'ipdata') {
      const link = document.createElement('a'); link.className = 'report-link'; link.textContent = 'Report ↗';
      link.href = result.provider === 'virustotal' ? `https://www.virustotal.com/gui/${report.kind === 'ip' ? 'ip-address' : 'file'}/${encodeURIComponent(report.indicator)}/detection` : `https://www.abuseipdb.com/check/${encodeURIComponent(report.indicator)}`;
      link.addEventListener('click', event => { event.preventDefault(); void window.bec.openReport(result.provider, report.indicator).then(reply => { if (!reply.ok) el('osint-status').textContent = reply.error; }).catch(error => { el('osint-status').textContent = String(error); }); });
      title.append(link);
    }
    if (result.status === 'ok') {
      const details = document.createElement('details'); details.append(make('summary', 'Details'));
      if (d.last_analysis_date) details.append(make('p', `Last analysis: ${new Date(d.last_analysis_date * 1000).toISOString()}`, 'help'));
      if (d.last_analysis_results) {
        const table = document.createElement('table');
        const entries = Object.entries(d.last_analysis_results) as [string, Record<string, unknown>][];
        const rank = (v: Record<string, unknown>) => v.category === 'malicious' ? 0 : v.category === 'suspicious' ? 1 : 2;
        for (const [engine, detection] of entries.sort((a,b) => rank(a[1]) - rank(b[1]))) {
          const row = document.createElement('tr'); row.dataset.tone = rank(detection) < 2 ? 'failure' : 'neutral';
          for (const v of [engine, detection.category, detection.result]) row.append(make('td', display(v))); table.append(row);
        }
        details.append(table);
      }
      details.append(make('pre', JSON.stringify(d, null, 2))); card.append(details);
    }
    grid.append(card);
  }
  el('osint-status').textContent = '';
}
el('osint-form').addEventListener('submit', event => {
  event.preventDefault();
  const button = el<HTMLButtonElement>('lookup'); if (button.disabled) return;
  button.disabled = true; el('osint-results').replaceChildren(); el('osint-status').textContent = 'Checking configured providers…';
  void (async () => {
    try { renderOsint(unwrap(await window.bec.osint(input('indicator').value.trim()))); }
    catch (error) { el('osint-status').textContent = String(error); }
    finally { button.disabled = false; }
  })();
});

initializeKqlLibrary();

initializeBrowserHistory(window.bec);

initializeDataTools();

initializeNotepad(el('notepad-surface'),window.notes);

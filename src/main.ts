import { buildM365Collection, filterM365, m365Csv, m365Kinds, validateDetonation, validateM365Filters, validateM365Query } from './m365-evidence';
import type { M365Collection, M365Kind, M365Result } from './contracts';
import { registerNotepad } from './notepad-main';
import { BrowserHistory } from './browser-history';
import { validateHistoryQuery } from './browser-history-db';
import type { HistoryBrowser } from './contracts';
import { ApiKeyStore } from './api-keys';
import { lookup, validateIndicator } from './osint';
import { app, BrowserWindow, dialog, ipcMain, shell, clipboard } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PowerShellSession } from './powershell';
import { csv, validateQuery } from './evidence';
import type { AuditCollection, Collection, DirectoryAudit, Reply, SessionState, SignIn } from './contracts';
import { auditCsv, auditRecords } from './directory-audits';
import { buildIdentityCollection, identityCsv, identityKinds } from './identity-evidence';
import type { IdentityCollection, IdentityKind, IdentityResult } from './contracts';
import { InvestigationLog } from './investigation-log';
import { buildUalCollection, filterUal, ualCsv, validateUalFilters, validateUalQuery } from './ual-evidence';
import type { UalCollection } from './contracts';
import { conditionalAccessReport, selectedSignIns } from './conditional-access';

const emptyState = (): SessionState => ({ graph: false, exchange: false, tenant: '', account: '' });
let state = emptyState();
let evidence: Collection | null = null;
let auditEvidence: AuditCollection | null = null;
let ualEvidence: UalCollection | null = null;
const m365Evidence = new Map<M365Kind, M365Collection>();
const browserHistory = new BrowserHistory();
const identityEvidence = new Map<IdentityKind, IdentityCollection>();
let locked = false;
let epoch = 0;
let openAuthBrowser = false;
let investigation: InvestigationLog;
let shuttingDown = false;
let resetting = false;
const inFlight = new Set<Promise<unknown>>();
const logDirectory = path.join(app.isPackaged ? path.dirname(app.getPath('exe')) : path.join(__dirname, '..'), 'session_logs');
const session = new PowerShellSession(message => {
  investigation.write('POWERSHELL_OUTPUT', { message });
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('bec:log', message);
  if (openAuthBrowser && /https:\/\/(?:www\.)?microsoft\.com\/devicelogin\b|https:\/\/login\.microsoftonline\.com\/(?:common|organizations)\/oauth2\/deviceauth\b/i.test(message)) {
    openAuthBrowser = false;
    investigation.write('AUTH_BROWSER_OPEN', { url: 'https://microsoft.com/devicelogin' });
    // Never open arbitrary URLs supplied by child-process output.
    void shell.openExternal('https://microsoft.com/devicelogin').catch(() => {
      investigation.write('AUTH_BROWSER_FAILED');
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('bec:log', 'Could not open the browser automatically. Open https://microsoft.com/devicelogin manually and enter the code above.');
    });
  }
}, () => {
  investigation?.write('POWERSHELL_SESSION_CLOSED');
  openAuthBrowser = false;
  state = emptyState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('bec:log', 'PowerShell session closed. Reconnect before running another collection.');
  }
}, (event, details) => investigation.write(event, details));

function registerHandlers(): void {
  const keys = new ApiKeyStore(path.join(app.getPath('userData'), 'api-keys.enc'));
  const handle = (name: string, work: (value: unknown) => Promise<unknown>) => {
    ipcMain.handle(`bec:${name}`, async (event, value): Promise<Reply<unknown>> => {
      const trusted = pathToFileURL(path.join(__dirname, '../ui/index.html')).href;
      if (event.senderFrame?.url !== trusted || event.senderFrame !== event.sender.mainFrame) return { ok: false, error: 'Untrusted request.' };
      const transcript = investigation;
      const execute = async (): Promise<Reply<unknown>> => {
        try {
          if (shuttingDown) throw new Error('Application is closing.');
          if (resetting) throw new Error('Investigation is being reset. Please wait.');
          transcript.write('ACTION_BEGIN', { action: name, parameters: name === 'save-keys' ? '[REDACTED]' : value ?? null, tenant: state.tenant, account: state.account });
          const data = await work(value);
          transcript.write('ACTION_SUCCEEDED', { action: name });
          if (name === 'reset') {
            transcript.end('New investigation requested');
            investigation = new InvestigationLog(logDirectory);
          }
          return { ok: true, data };
        } catch (error) {
          let text = error instanceof Error ? error.message : String(error);
          try { transcript.write('ACTION_FAILED', { action: name, error: text }); }
          catch (loggingError) { text = String(loggingError); session.stop(); }
          return { ok: false, error: text };
        }
      };
      const pending = execute();
      if (name !== 'reset') inFlight.add(pending);
      try { return await pending; } finally { inFlight.delete(pending); }
    });
  };
  const exclusive = async (work: () => Promise<unknown>): Promise<unknown> => {
    if (locked) throw new Error('Another operation is running. Wait or start a fresh investigation.');
    locked = true;
    const current = epoch;
    try { return await work(); } finally { if (current === epoch) locked = false; }
  };
  handle('history-import', async browser => {
    if (!['auto','chrome','edge','firefox'].includes(String(browser))) throw Error('Invalid browser selection.');
    const { canceled, filePaths } = await dialog.showOpenDialog({ title: 'Import browser history database', properties: ['openFile'], filters: [{ name: 'History databases (History / places.sqlite)', extensions: ['*'] }] });
    if (canceled || !filePaths[0]) return null;
    investigation.write('HISTORY_IMPORT_BEGIN', { file: filePaths[0], browser });
    const source = await browserHistory.import(filePaths[0], browser as HistoryBrowser);
    investigation.write('HISTORY_IMPORT_COMPLETE', source); return source;
  });
  handle('history-query', async value => browserHistory.query(validateHistoryQuery(value)));
  handle('history-copy', async value => {
    const request = value as { query: unknown; mode: unknown; visitId?: string };
    if (!request || !['urls','visits'].includes(String(request.mode))) throw Error('Invalid history copy request.');
    const result = await browserHistory.copy(validateHistoryQuery(request.query), request.mode as 'urls' | 'visits', request.visitId);
    investigation.write('HISTORY_CLIPBOARD_WRITE', { mode: request.mode, count: result.count });
    await clipboard.writeText(result.text); return result.count;
  });
  handle('history-clear', async () => { await browserHistory.clear(); return null; });
  handle('open-report', async value => {
    const request = value as { provider?: unknown; indicator?: unknown } | null;
    const { indicator, kind } = validateIndicator(request?.indicator);
    const encoded = encodeURIComponent(indicator);
    let url: string;
    if (request?.provider === 'virustotal') url = `https://www.virustotal.com/gui/${kind === 'ip' ? 'ip-address' : 'file'}/${encoded}/detection`;
    else if (request?.provider === 'abuseipdb' && kind === 'ip') url = `https://www.abuseipdb.com/check/${encoded}`;
    else throw new Error('No public report link for this provider and indicator.');
    await shell.openExternal(url); return null;
  });
  handle('key-status', async () => keys.status());
  handle('save-keys', value => exclusive(() => keys.update(value)));
  handle('osint', async value => lookup(value, await keys.read()));
  handle('state', async () => state);
  handle('log-info', async () => ({ id: investigation.id, file: investigation.file }));
  handle('audit', async value => {
    const item = value as Record<string, unknown>;
    if (!item || typeof item !== 'object') throw new Error('Invalid activity event.');
    switch (item.action) {
      case 'table_cell_toggle': {
        if (!['sign-ins', 'audit-logs', ...identityKinds, 'uals', 'browser-history'].includes(String(item.page)) || typeof item.id !== 'string' || item.id.length > 1000 || typeof item.field !== 'string' || item.field.length > 200 || typeof item.open !== 'boolean') throw new Error('Invalid table expansion.');
        const record = item.page === 'sign-ins' ? evidence?.rows.find(r => r.id === item.id)
          : item.page === 'audit-logs' ? auditEvidence?.records.find(r => r.event.id === item.id)
          : item.page === 'uals' ? ualEvidence?.records.find(r => r.id === item.id)
          : identityEvidence.get(item.page as IdentityKind)?.rows.find(r => r.key === item.id);
        if (item.page !== 'browser-history' && !record) throw new Error('Record is not part of the current collection.');
        investigation.write('TABLE_CELL_TOGGLE', { ...item, record: item.open ? record : undefined });
        return null;
      }
      case 'navigate':
        if (!['session', 'sign-ins', 'audit-logs', ...identityKinds, ...m365Kinds, 'uals', 'toolkit', 'kql-library', 'browser-history', 'data-tools', 'notepad', 'settings'].includes(String(item.page))) throw new Error('Invalid page.');
        break;
      case 'nav_group_toggle':
        if (!['entra', 'm365'].includes(String(item.group)) || typeof item.open !== 'boolean') throw new Error('Invalid navigation group.');
        break;
      case 'record_view': {
        const row = evidence?.rows.find(row => row.id === item.id);
        if (!row) throw new Error('Record is not part of the current evidence collection.');
        investigation.write('RECORD_EXPANDED', { tenant: evidence!.tenant, query: evidence!.query, record: row });
        return null;
      }
      case 'ual_record_view': {
        const record = ualEvidence?.records.find(row => row.id === item.id);
        if (!record) throw new Error('UAL event is not part of the current collection.');
        investigation.write('UAL_RECORD_EXPANDED', { tenant: ualEvidence!.tenant, query: ualEvidence!.query, record });
        return null;
      }
      case 'audit_record_view': {
        const record = auditEvidence?.records.find(row => row.event.id === item.id);
        if (!record) throw new Error('Audit event is not part of the current collection.');
        investigation.write('AUDIT_RECORD_EXPANDED', { tenant: auditEvidence!.tenant, query: auditEvidence!.query, record });
        return null;
      }
      case 'identity_record_view': {
        const record = identityEvidence.get(item.kind as IdentityKind)?.rows.find(row => row.key === item.key);
        if (!record) throw new Error('Record is not part of the current module evidence.');
        investigation.write('IDENTITY_RECORD_EXPANDED', { kind: item.kind, record });
        return null;
      }
      case 'identity_results_view':
        if (!identityKinds.includes(item.kind as IdentityKind) || typeof item.search !== 'string' || item.search.length > 10000 || !['all', 'current', 'history', 'flagged', 'window', 'unfamiliar', 'high', 'medium', 'low', 'detections', 'risk-user', 'risk-history', 'risky-signin'].includes(String(item.filter)) || !Number.isInteger(item.page) || Number(item.page) < 0 || !Array.isArray(item.keys) || item.keys.length > 100 || !item.keys.every(key => typeof key === 'string' && key.length < 1000)) throw new Error('Invalid identity evidence view.');
        break;
      case 'audit_results_view':
        if (typeof item.search !== 'string' || item.search.length > 10000 || !['all', 'password', 'mfa', 'roles', 'consent', 'devices', 'groups', 'other'].includes(String(item.category)) || !['all', 'actor', 'target', 'both'].includes(String(item.relation)) || !['all', 'success', 'failure', 'other'].includes(String(item.result)) || !Number.isInteger(item.page) || Number(item.page) < 0 || !Array.isArray(item.ids) || item.ids.length > 100 || !item.ids.every(id => typeof id === 'string' && id.length < 1000)) throw new Error('Invalid audit view.');
        break;
      case 'sign_in_selection':
        if (Array.isArray(item.ids) && item.ids.length === 0) break;
        selectedSignIns(evidence, item.ids);
        break;
      case 'ca_policy_view': {
        const row = selectedSignIns(evidence, [item.signInId])[0];
        if (!Number.isInteger(item.index) || Number(item.index) < 0) throw new Error('Invalid policy index.');
        const policy = row.appliedConditionalAccessPolicies?.[Number(item.index)];
        if (!policy) throw new Error('Policy evaluation is not part of the selected sign-in.');
        investigation.write('CONDITIONAL_ACCESS_POLICY_EXPANDED', { signInId: row.id, policy });
        return null;
      }
      case 'results_view':
        if (typeof item.search !== 'string' || item.search.length > 10000 || !['all', 'interactive', 'noninteractive'].includes(String(item.type)) || !Number.isInteger(item.page) || Number(item.page) < 0 || !Array.isArray(item.ids) || item.ids.length > 100 || !item.ids.every(id => typeof id === 'string' && id.length < 500)) throw new Error('Invalid results view.');
        break;
      case 'details_toggle':
        if (!['session-output', 'record-details', 'ca-policy-details', 'audit-record-details', 'ual-record-details', ...identityKinds.map(kind => `${kind}-details`)].includes(String(item.section)) || typeof item.open !== 'boolean') throw new Error('Invalid details view.');
        break;
      case 'range_change':
        if (![item.range, item.start, item.end].every(v => typeof v === 'string' && v.length <= 100)) throw new Error('Invalid range change.');
        break;
      default: throw new Error('Unknown activity event.');
    }
    investigation.write('UI_ACTIVITY', item);
    return null;
  });
  handle('reset', async () => {
    resetting = true;
    epoch++; session.stop(); evidence = null; auditEvidence = null; ualEvidence = null; identityEvidence.clear(); m365Evidence.clear(); locked = false;
    await Promise.allSettled([...inFlight]);
    resetting = false;
    return state;
  });
  handle('install', () => exclusive(async () => { await session.run('install'); return null; }));
  handle('connect', value => exclusive(async () => {
    const { tenant, mode } = (value ?? {}) as { tenant: unknown; mode: unknown };
    if (typeof tenant !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(tenant)) throw new Error('Enter the tenant ID as a GUID from Microsoft Entra.');
    if (mode !== 'browser' && mode !== 'device') throw new Error('Choose browser or device-code sign-in.');
    if (state.graph) throw new Error('Start a fresh investigation before changing connections.');
    const current = epoch;
    openAuthBrowser = mode === 'browser';
    let result: SessionState;
    try { result = await session.run('connect', { tenant, mode }) as SessionState; }
    finally { if (current === epoch) openAuthBrowser = false; }
    if (epoch !== current) throw new Error('Investigation reset.');
    investigation.write('GRAPH_CONNECTED', result);
    state = result; return state;
  }));
  handle('exchange', mode => exclusive(async () => {
    if (mode !== 'browser' && mode !== 'device') throw new Error('Choose browser or device-code sign-in.');
    if (!state.graph) throw new Error('Connect Graph first.');
    const current = epoch;
    openAuthBrowser = mode === 'browser';
    let result: SessionState;
    try { result = await session.run('exchange', { mode }) as SessionState; }
    finally { if (current === epoch) openAuthBrowser = false; }
    if (epoch !== current) throw new Error('Investigation reset.');
    investigation.write('EXCHANGE_CONNECTED', result);
    state = result; return state;
  }));
  handle('collect', value => exclusive(async () => {
    evidence = null;
    if (!state.graph) throw new Error('Connect Graph first.');
    const query = validateQuery(value), tenant = state.tenant, current = epoch;
    investigation.write('SIGNIN_COLLECTION_BEGIN', { tenant, account: state.account, query });
    const result = await session.run('collect', query) as { rows: SignIn[] };
    if (epoch !== current) throw new Error('Investigation reset.');
    if (!Array.isArray(result.rows)) throw new Error('Invalid sign-in collection response.');
    evidence = { query, tenant, collectedAt: new Date().toISOString(), rows: result.rows };
    investigation.write('SIGNIN_COLLECTION_COMPLETE', { query, tenant, collectedAt: evidence.collectedAt, count: evidence.rows.length, recordIds: evidence.rows.map(row => row.id) });
    return evidence;
  }));
  handle('collect-m365', value => exclusive(async () => {
    const request = value as { kind: M365Kind; query: unknown };
    if (!request || !m365Kinds.includes(request.kind)) throw Error('Invalid Microsoft 365 module.');
    m365Evidence.delete(request.kind);
    const query = validateM365Query(request.kind, request.query), current = epoch, tenant = state.tenant;
    if (!state.graph && !state.exchange) throw Error('Connect in Session first.');
    if (request.kind !== 'defender-review' && !state.exchange) throw Error('Connect Exchange in Session first.');
    investigation.write('M365_COLLECTION_BEGIN', { kind: request.kind, query, tenant });
    const result = await session.run('collect-m365', { kind: request.kind, ...query }) as M365Result;
    if (current !== epoch) throw Error('Investigation reset.');
    if (!result || !Array.isArray(result.sources) || !Array.isArray(result.aliases) || !result.aliases.every(a=>typeof a==='string') || !result.sources.every(s=>s && typeof s.name==='string' && typeof s.ok==='boolean' && Array.isArray(s.rows))) throw Error('Invalid Microsoft 365 evidence response.');
    const snapshot = buildM365Collection(request.kind, query, tenant, result, m365Evidence.get('inbox-rules'));
    investigation.write('M365_COLLECTION_COMPLETE', { kind: request.kind, query, tenant, count: snapshot.records.length, recordIds: snapshot.records.map(r=>r.id), sources: snapshot.sources, notes: snapshot.notes });
    m365Evidence.set(request.kind, snapshot); return snapshot;
  }));
  handle('view-m365', async value => {
    const request = value as { kind: M365Kind; filters: unknown; page: number };
    if (!request || !m365Kinds.includes(request.kind) || !Number.isSafeInteger(request.page) || request.page < 0) throw Error('Invalid Microsoft 365 view.');
    const filters = validateM365Filters(request.filters), snapshot = m365Evidence.get(request.kind);
    if (!snapshot) throw Error('Collect evidence in this tab first.');
    const rows = filterM365(snapshot,filters), page = Math.max(0, Math.min(request.page,Math.ceil(rows.length/100)-1));
    const records = rows.slice(page*100,(page+1)*100);
    investigation.write('M365_RESULTS_VIEW', { kind:request.kind,filters,page,matched:rows.length,recordIds:records.map(r=>r.id) });
    return {records,page,matched:rows.length,total:snapshot.records.length};
  });
  handle('inspect-m365', async value => {
    const request = value as {kind:M365Kind;id:string;field?:string;open?:boolean};
    if (!request || !m365Kinds.includes(request.kind) || typeof request.id!=='string' || request.field!==undefined && (typeof request.field!=='string' || request.field.length>200) || request.open!==undefined && typeof request.open!=='boolean') throw Error('Invalid Microsoft 365 inspection.');
    const record=m365Evidence.get(request.kind)?.records.find(r=>r.id===request.id);
    if(!record)throw Error('Record is not part of the current module evidence.');
    investigation.write('M365_RECORD_INSPECTION',{...request,record:request.open===false?undefined:record}); return record;
  });
  handle('export-m365', value => exclusive(async () => {
    const request=value as {kind:M365Kind;format:string;scope:string;filters:unknown};
    if(!request || !m365Kinds.includes(request.kind) || !['csv','json'].includes(request.format) || !['all','filtered'].includes(request.scope))throw Error('Invalid Microsoft 365 export.');
    const filters=validateM365Filters(request.filters),snapshot=m365Evidence.get(request.kind),current=epoch;
    if(!snapshot)throw Error('Collect evidence in this tab first.');
    const records=request.scope==='all'?snapshot.records:filterM365(snapshot,filters);
    const {kind,format,scope}=request;
    const {canceled,filePath}=await dialog.showSaveDialog({title:`Export ${kind} (${scope})`,defaultPath:`${kind}-${snapshot.query.user.replace(/[^a-z\d.-]/gi,'_')}-${Date.now()}.${format}`,filters:[{name:format.toUpperCase(),extensions:[format]}]});
    if(canceled||!filePath){investigation.write('M365_EXPORT_CANCELLED',{kind,format,scope,filters});return null;}
    if(current!==epoch)throw Error('Investigation reset; export cancelled.');
    const metadata={...snapshot,records:undefined,exportScope:scope,filters,sourceCount:snapshot.records.length,exportedCount:records.length};
    const content=format==='csv'?m365Csv(snapshot,records,scope,filters):JSON.stringify({...metadata,records},null,2);
    investigation.write('M365_EXPORT_BEGIN',{kind,format,scope,filePath,filters,count:records.length,recordIds:records.map(r=>r.id)});
    await writeFile(filePath,content,'utf8');
    investigation.write('M365_EXPORT_FILE_WRITTEN',{filePath,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')});
    if(format==='csv'){
      const metadataPath=`${filePath}.metadata.json`,report=JSON.stringify(metadata,null,2);
      investigation.write('M365_METADATA_EXPORT_BEGIN',{filePath:metadataPath});await writeFile(metadataPath,report,'utf8');
      investigation.write('M365_EXPORT_FILE_WRITTEN',{filePath:metadataPath,sha256:createHash('sha256').update(report).digest('hex')});
    }
    investigation.write('M365_EXPORT_COMPLETE',{kind,format,scope,filePath,count:records.length});return filePath;
  }));
  handle('capture-detonation', value => exclusive(async () => {
    const report=validateDetonation(value),snapshot=m365Evidence.get('defender-review');
    if(!snapshot)throw Error('Collect Defender review evidence first, including source availability.');
    const id='detonation:'+createHash('sha256').update(JSON.stringify(report)).digest('hex');
    if(snapshot.records.some(r=>r.id===id))throw Error('This detonation capture is already recorded.');
    const record={id,source:'Manual detonation capture',values:{UPN:snapshot.query.user,'Time UTC':report.observedAt,'Subject / URL':report.url,'Status / verdict':report.verdict,'Detection methods':'Manual portal report capture'},findings:['Analyst-captured observation; review the referenced source report'],raw:{...report,capturedAt:new Date().toISOString(),capturedBy:state.account,query:snapshot.query,provenance:'Manually recorded report; no URL visited or detonated by BEC Bot'}};
    investigation.write('M365_DETONATION_CAPTURE',{kind:snapshot.kind,record});snapshot.records.push(record);
    const manual=snapshot.sources.find(s=>s.name==='Manual detonation capture');
    if(manual){manual.returned++;manual.checkedAt=record.raw.capturedAt;}else snapshot.sources.push({name:'Manual detonation capture',ok:true,returned:1,checkedAt:record.raw.capturedAt,metadata:{provenance:'Analyst observation; see referenced report'}});
    return snapshot;
  }));
  handle('m365-portal', async portal => {
    if(portal!=='explorer'&&portal!=='quarantine')throw Error('Unknown Microsoft 365 portal.');
    const url=portal==='explorer'?'https://security.microsoft.com/threatexplorerv3':'https://security.microsoft.com/quarantine';
    investigation.write('M365_PORTAL_OPEN',{portal,url});await shell.openExternal(url);return null;
  });
  handle('collect-ual', value => exclusive(async () => {
    ualEvidence = null;
    if (!state.exchange) throw new Error('Connect Exchange in Session first.');
    const query = validateUalQuery(value), tenant = state.tenant, current = epoch;
    investigation.write('UAL_COLLECTION_BEGIN', { query, tenant, account: state.account });
    const result = await session.run('collect-ual', query) as { rows: Record<string, any>[] };
    if (current !== epoch) throw new Error('Investigation reset.');
    if (!result || !Array.isArray(result.rows)) throw new Error('Invalid UAL collection response.');
    const snapshot = buildUalCollection(query, tenant, result);
    investigation.write('UAL_COLLECTION_COMPLETE', { query, tenant, count: snapshot.records.length, recordIds: snapshot.records.map(r => r.id), retrieval: snapshot.retrieval, auditChecks: snapshot.auditChecks, evidenceGaps: snapshot.evidenceGaps });
    ualEvidence = snapshot; return snapshot;
  }));
  handle('view-ual', async value => {
    const request = value as { filters: unknown; page: number };
    const filters = validateUalFilters(request?.filters);
    if (!Number.isSafeInteger(request.page) || request.page < 0) throw new Error('Invalid UAL page.');
    if (!ualEvidence) throw new Error('Collect UAL evidence first.');
    const rows = filterUal(ualEvidence.records, filters);
    const page = Math.max(0, Math.min(request.page, Math.ceil(rows.length / 100) - 1));
    const records = rows.slice(page * 100, (page + 1) * 100);
    investigation.write('UAL_RESULTS_VIEW', { filters, page, matched: rows.length, recordIds: records.map(r => r.id) });
    return { records, page, total: ualEvidence.records.length, matched: rows.length, unknownIPs: ualEvidence.records.filter(r => !r.normalizedIPs.length).length };
  });
  handle('export-ual', value => exclusive(async () => {
    const request = value as { format: string; scope: string; filters: unknown };
    if (!request || !['csv', 'json'].includes(request.format) || !['all', 'filtered'].includes(request.scope)) throw new Error('Invalid UAL export.');
    const filters = validateUalFilters(request.filters), snapshot = ualEvidence, current = epoch;
    if (!snapshot) throw new Error('Collect UAL evidence first.');
    const records = request.scope === 'all' ? snapshot.records : filterUal(snapshot.records, filters);
    const { format, scope } = request;
    const { canceled, filePath } = await dialog.showSaveDialog({ title: `Export ${scope} UAL evidence`, defaultPath: `ual-${snapshot.query.user.replace(/[^a-z\d.-]/gi, '_')}-${Date.now()}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (canceled || !filePath) { investigation.write('UAL_EXPORT_CANCELLED', { format, scope, filters }); return null; }
    if (current !== epoch) throw new Error('Investigation reset; export cancelled.');
    const metadata = { ...snapshot, records: undefined, exportScope: scope, viewFilters: filters, sourceCount: snapshot.records.length, exportedCount: records.length };
    const content = format === 'csv' ? ualCsv(snapshot, records, scope, filters) : JSON.stringify({ ...metadata, records }, null, 2);
    investigation.write('UAL_EXPORT_BEGIN', { filePath, format, scope, filters, count: records.length, recordIds: records.map(r => r.id) });
    await writeFile(filePath, content, 'utf8');
    investigation.write('UAL_EXPORT_FILE_WRITTEN', { filePath, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
    if (format === 'csv') {
      const metadataPath = `${filePath}.metadata.json`, report = JSON.stringify(metadata, null, 2);
      investigation.write('UAL_METADATA_EXPORT_BEGIN', { filePath: metadataPath });
      await writeFile(metadataPath, report, 'utf8');
      investigation.write('UAL_EXPORT_FILE_WRITTEN', { filePath: metadataPath, bytes: Buffer.byteLength(report), sha256: createHash('sha256').update(report).digest('hex') });
    }
    investigation.write('UAL_EXPORT_COMPLETE', { filePath, format, scope, count: records.length });
    return filePath;
  }));
  handle('collect-audits', value => exclusive(async () => {
    auditEvidence = null;
    if (!state.graph) throw new Error('Connect Graph first.');
    const query = validateQuery(value), tenant = state.tenant, current = epoch;
    investigation.write('AUDIT_COLLECTION_BEGIN', { query, tenant, account: state.account });
    const result = await session.run('collect-audits', query) as { userId: string; rows: DirectoryAudit[] };
    if (current !== epoch) throw new Error('Investigation reset.');
    if (!Array.isArray(result.rows) || typeof result.userId !== 'string' || !result.userId) throw new Error('Invalid audit collection response.');
    const snapshot: AuditCollection = { query, tenant, userId: result.userId, collectedAt: new Date().toISOString(), records: auditRecords(result.rows, query, result.userId) };
    investigation.write('AUDIT_COLLECTION_COMPLETE', { query, tenant, userId: snapshot.userId, count: snapshot.records.length, recordIds: snapshot.records.map(r => r.event.id), collectedAt: snapshot.collectedAt });
    auditEvidence = snapshot;
    return snapshot;
  }));
  handle('export-audits', format => exclusive(async () => {
    if (format !== 'csv' && format !== 'json') throw new Error('Unsupported export format.');
    if (!auditEvidence) throw new Error('Collect audit logs before exporting.');
    const snapshot = auditEvidence, current = epoch;
    const { canceled, filePath } = await dialog.showSaveDialog({ title: 'Export complete Entra audit collection', defaultPath: `entra-audits-${snapshot.query.user.replace(/[^a-z\d.-]/gi, '_')}-${Date.now()}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (canceled || !filePath) { investigation.write('AUDIT_EXPORT_CANCELLED', { format }); return null; }
    if (current !== epoch) throw new Error('Investigation reset; export cancelled.');
    investigation.write('AUDIT_EXPORT_BEGIN', { filePath, format, query: snapshot.query, tenant: snapshot.tenant, count: snapshot.records.length });
    const content = format === 'csv' ? auditCsv(snapshot) : JSON.stringify(snapshot, null, 2);
    await writeFile(filePath, content, 'utf8');
    investigation.write('AUDIT_EXPORT_COMPLETE', { filePath, format, count: snapshot.records.length, bytes: Buffer.byteLength(content, 'utf8'), sha256: createHash('sha256').update(content).digest('hex') });
    return filePath;
  }));
  handle('collect-identity', value => exclusive(async () => {
    const request = value as { kind: IdentityKind; query: unknown };
    if (!request || !identityKinds.includes(request.kind)) throw new Error('Unknown identity evidence module.');
    identityEvidence.delete(request.kind);
    if (!state.graph) throw new Error('Connect Graph first.');
    const base = validateQuery(request.query);
    const allRetained = (request.query as { allRetained?: unknown }).allRetained;
    if (allRetained !== undefined && typeof allRetained !== 'boolean') throw new Error('Invalid retained-events option.');
    if (allRetained && request.kind !== 'risk-detections') throw new Error('Only risk detections support all-retained collection.');
    const query = { ...base, allRetained: Boolean(allRetained) }, tenant = state.tenant, current = epoch;
    investigation.write('IDENTITY_COLLECTION_BEGIN', { kind: request.kind, query, tenant, account: state.account });
    const result = await session.run('collect-identity', { kind: request.kind, ...query }) as IdentityResult;
    if (current !== epoch) throw new Error('Investigation reset.');
    if (!result || typeof result.userId !== 'string' || !result.userId || !Array.isArray(result.rows) || (result.relatedAudits !== undefined && !Array.isArray(result.relatedAudits))) throw new Error('Invalid identity evidence response.');
    if (result.riskHistory !== undefined && !Array.isArray(result.riskHistory) || result.riskySignIns !== undefined && !Array.isArray(result.riskySignIns) || result.riskSources !== undefined && (!Array.isArray(result.riskSources) || !result.riskSources.every(s => s && typeof s.source === 'string' && typeof s.ok === 'boolean'))) throw new Error('Invalid risk evidence response.');
    const snapshot = buildIdentityCollection(request.kind, query, tenant, result, evidence?.rows ?? []);
    investigation.write('IDENTITY_COLLECTION_COMPLETE', { kind: request.kind, query, tenant, count: snapshot.rows.length, keys: snapshot.rows.map(row => row.key), coverage: snapshot.coverage, riskSources: snapshot.riskSources });
    identityEvidence.set(request.kind, snapshot);
    return snapshot;
  }));
  handle('review-app', value => {
    const request = value as { key: string; review: string };
    if (!request || !['Unreviewed', 'Recognised', 'Unfamiliar'].includes(request.review)) throw new Error('Invalid application review.');
    const row = identityEvidence.get('app-consents')?.rows.find(row => row.key === request.key && row.source === 'grant');
    if (!row) throw new Error('Grant is not part of the current App Consents evidence.');
    const related = identityEvidence.get('app-consents')!.rows.filter(candidate => candidate.source === 'grant' && candidate.raw.grant.clientId === row.raw.grant.clientId);
    investigation.write('APPLICATION_FAMILIARITY_REVIEW', { key: row.key, keysAffected: related.map(r => r.key), application: row.values.Application, before: related.map(r => ({ key: r.key, review: r.values.Review })), after: request.review });
    for (const grant of related) {
      grant.values.Review = request.review;
      grant.flags = grant.flags.filter(flag => flag !== 'Marked unfamiliar by analyst');
      if (request.review === 'Unfamiliar') grant.flags.push('Marked unfamiliar by analyst');
      grant.tone = grant.flags.length ? 'warning' : 'neutral';
    }
    return Promise.resolve(related);
  });
  handle('export-identity', value => exclusive(async () => {
    const request = value as { kind: IdentityKind; format: 'csv' | 'json' };
    if (!request || !identityKinds.includes(request.kind) || !['csv', 'json'].includes(request.format)) throw new Error('Invalid identity export.');
    const snapshot = identityEvidence.get(request.kind), current = epoch;
    if (!snapshot) throw new Error('Collect evidence in this tab before exporting.');
    const { kind, format } = request;
    const { canceled, filePath } = await dialog.showSaveDialog({ title: `Export complete ${kind} evidence`, defaultPath: `${kind}-${snapshot.query.user.replace(/[^a-z\d.-]/gi, '_')}-${Date.now()}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (canceled || !filePath) { investigation.write('IDENTITY_EXPORT_CANCELLED', { kind, format }); return null; }
    if (current !== epoch) throw new Error('Investigation reset; export cancelled.');
    investigation.write('IDENTITY_EXPORT_BEGIN', { kind, format, filePath, count: snapshot.rows.length, tenant: snapshot.tenant, query: snapshot.query });
    const content = format === 'csv' ? identityCsv(snapshot) : JSON.stringify(snapshot, null, 2);
    await writeFile(filePath, content, 'utf8');
    if (kind === 'risk-detections' && format === 'csv') {
      const metadataPath = `${filePath}.metadata.json`, metadata = JSON.stringify({ ...snapshot, rows: undefined, recordCount: snapshot.rows.length }, null, 2);
      investigation.write('IDENTITY_METADATA_EXPORT_BEGIN', { filePath: metadataPath });
      await writeFile(metadataPath, metadata, 'utf8');
      investigation.write('IDENTITY_METADATA_EXPORT_COMPLETE', { filePath: metadataPath, sha256: createHash('sha256').update(metadata).digest('hex') });
    }
    investigation.write('IDENTITY_EXPORT_COMPLETE', { kind, format, filePath, count: snapshot.rows.length, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
    return filePath;
  }));
  handle('conditional-access', async ids => {
    if (!evidence) throw new Error('Collect sign-ins first.');
    const report = conditionalAccessReport(evidence, ids);
    investigation.write('CONDITIONAL_ACCESS_VIEW', { source: 'captured sign-in JSON; no additional Graph request', ...report });
    return report;
  });
  handle('export', format => exclusive(async () => {
    if (format !== 'csv' && format !== 'json') throw new Error('Unsupported export format.');
    if (!evidence) throw new Error('Collect sign-ins before exporting.');
    const snapshot = evidence, current = epoch;
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export complete sign-in collection',
      defaultPath: `sign-ins-${snapshot.query.user.replace(/[^a-z\d.-]/gi, '_')}-${Date.now()}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (canceled || !filePath) { investigation.write('EXPORT_CANCELLED', { format }); return null; }
    if (epoch !== current) throw new Error('Investigation reset; export cancelled.');
    investigation.write('EXPORT_WRITE_BEGIN', { filePath, format, count: snapshot.rows.length, tenant: snapshot.tenant, query: snapshot.query });
    const content = format === 'csv' ? csv(snapshot) : JSON.stringify(snapshot, null, 2);
    await writeFile(filePath, content, 'utf8');
    investigation.write('EXPORT_WRITE_COMPLETE', { filePath, format, count: snapshot.rows.length, bytes: Buffer.byteLength(content, 'utf8'), sha256: createHash('sha256').update(content, 'utf8').digest('hex') });
    return filePath;
  }));
}

// The main process owns windows and future privileged local operations.
function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 650,
    title: 'BEC Bot', backgroundColor: '#101010', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  void window.loadFile(path.join(__dirname, '../ui/index.html'));
}

void app.whenReady().then(() => {
  try { investigation = new InvestigationLog(logDirectory); }
  catch (error) { dialog.showErrorBox('Cannot start investigation logging', String(error)); app.exit(1); return; }
  registerHandlers();
  registerNotepad();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
let quitReady = false;
app.on('before-quit', event => {
  if (quitReady) return;
  event.preventDefault(); shuttingDown = true;
  void (async () => {
    try {
      investigation.write('APPLICATION_CLOSING');
      session.stop('Application closing.');
      await browserHistory.close();
      await Promise.allSettled([...inFlight]);
      investigation.end('Application closed');
    } catch (error) { dialog.showErrorBox('Investigation log error', String(error)); }
    quitReady = true; app.quit();
  })();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

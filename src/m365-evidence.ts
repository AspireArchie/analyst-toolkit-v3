import { createHash } from 'node:crypto';
import { validateQuery } from './evidence';
import { buildUalCollection } from './ual-evidence';
import type { DetonationCapture, M365Collection, M365Filters, M365Kind, M365Query, M365Record, M365Result } from './contracts';
export const m365Kinds: M365Kind[] = ['inbox-rules','trace-outbound','trace-inbound','defender-review','forwarding'];
const str = (v: unknown): string => v == null ? '' : Array.isArray(v) ? v.map(str).join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const active = (v: unknown) => v === true || Array.isArray(v) && v.length > 0 || v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 || typeof v === 'string' && v !== '' && v.toLowerCase() !== 'false';
export function validateM365Query(kind: M365Kind, value: unknown): M365Query {
  if (!m365Kinds.includes(kind)) throw Error('Invalid Microsoft 365 module.');
  const query = validateQuery(value), party = (value as M365Query).party ?? '';
  if (typeof party !== 'string' || party.length > 320 || party && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(party)) throw Error('Counterparty must be one full email address.');
  if (party && !['trace-inbound','trace-outbound'].includes(kind)) throw Error('Counterparty filters are only supported for message traces.');
  if (kind.startsWith('trace-') && Date.parse(query.start) < Date.now() - 90 * 86400000) throw Error('Message Trace V2 supports the last 90 days. Choose a newer start date.');
  return { ...query, party };
}
export function validateM365Filters(value: unknown): M365Filters {
  const f = value as M365Filters;
  if (!f || typeof f.search !== 'string' || f.search.length > 10000 || typeof f.source !== 'string' || f.source.length > 100 || typeof f.flagged !== 'boolean') throw Error('Invalid Microsoft 365 filters.');
  return { search: f.search, source: f.source, flagged: f.flagged };
}
export function filterM365(c: M365Collection, f: M365Filters): M365Record[] {
  return c.records.filter(r => (!f.source || f.source === 'all' || r.source === f.source) && (!f.flagged || r.findings.length > 0) && (!f.search || JSON.stringify(r).toLowerCase().includes(f.search.toLowerCase())));
}
function ruleFindings(row: Record<string, any>) {
  return [['ForwardTo','Forwards mail'],['ForwardAsAttachmentTo','Forwards mail as attachment'],['RedirectTo','Redirects mail'],['DeleteMessage','Deletes mail'],['MoveToFolder','Moves mail'],['CopyToFolder','Copies mail'],['MarkAsRead','Marks mail as read'],['StopProcessingRules','Stops rule processing']].filter(([field]) => active(row[field])).map(([,label]) => label);
}
const conditions = (row: Record<string, any>) => Object.entries(row).filter(([key,v]) => /^(From$|SentTo|Subject|Body|Header|RecipientAddress|SenderAddress|FromAddress|ExceptIf)/.test(key) && active(v)).map(([key,v])=>`${key}: ${str(v)}`).join('; ');
const actions = (row: Record<string, any>) => Object.entries(row).filter(([key,v]) => /^(ForwardTo|ForwardAsAttachmentTo|RedirectTo|DeleteMessage|MoveToFolder|CopyToFolder|MarkAsRead|StopProcessingRules)$/.test(key) && active(v)).map(([key,v])=>`${key}: ${str(v)}`).join('; ');
function timeInWindow(value: unknown, query: M365Query): boolean {
  const t = Date.parse(utc(value)); return !Number.isFinite(t) || t >= Date.parse(query.start) && t < Date.parse(query.end);
}
function utc(value:unknown):string { let t=str(value);if(/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(t)&&!/(?:Z|[+-]\d\d:\d\d)$/i.test(t))t+='Z';const n=Date.parse(t);return Number.isFinite(n)?new Date(n).toISOString():t; }
export function buildM365Collection(kind: M365Kind, query: M365Query, tenant: string, result: M365Result, priorRules?: M365Collection): M365Collection {
  const records: M365Record[] = [], seen = new Set<string>();
  const aliases = [...new Set([query.user, ...result.aliases].map(v=>v.toLowerCase()))];
  const source = (name: string) => result.sources.find(s=>s.name===name && s.ok);
  const notes = ['Read-only metadata collection. No Content Search, eDiscovery, message preview/download, release, deletion or configuration changes are performed.', 'Current configuration describes collection time. It cannot establish historical state or prove that a rule acted on an individual message.'];
  const add = (source: string, raw: Record<string, any>, values: Record<string, string>, findings: string[] = [], key?: string) => {
    const id = source + ':' + (key || hash(raw)); if (seen.has(id)) return; seen.add(id);
    records.push({ id, source, raw, values: { UPN: query.user, ...values }, findings });
  };
  let columns: string[];
  if (kind === 'inbox-rules') {
    columns = ['UPN','Name','Enabled','Priority','Conditions','Actions','Created UTC','Time UTC','Source IP','Operation','Description'];
    for (const r of source('inbox-rules')?.rows ?? []) add('Current rule',r,{Name:str(r.Name),Enabled:str(r.Enabled),Priority:str(r.Priority),Conditions:conditions(r),Actions:actions(r),'Created UTC':str(r.WhenCreated) || 'Not returned','Time UTC':str(r.WhenChanged),Description:str(r.Description)},ruleFindings(r));
    const history = source('rule-history'); let unmatched = 0;
    if (history) {
      const report = buildUalCollection({...query,operations:[]},tenant,{rows:history.rows,retrieval:history.metadata?.retrieval,auditChecks:history.metadata?.auditChecks});
      notes.push(...report.evidenceGaps.map(g=>`Evidence gap: ${g}`));
      if(history.metadata?.retrieval?.highCompleteness!==true)notes.push('Historical UAL search completeness was not confirmed as HighCompleteness; source limitations may apply.');
      for (const event of report.records) {
        const data = event.auditData;
        if (!data) { unmatched++; continue; }
        const params = [...(Array.isArray(data.Parameters) ? data.Parameters : []), ...(Array.isArray(data.OperationProperties) ? data.OperationProperties : [])];
        const values = [data.UserId,data.MailboxOwnerUPN,data.MailboxOwnerSid,data.ObjectId,data.OfficeObjectId, ...params.filter((p:any)=>['mailbox','identity','user','userprincipalname'].includes(str(p.Name).toLowerCase())).map((p:any)=>p.Value)].map(v=>str(v).toLowerCase());
        const matches = aliases.some(alias=>values.some(v=>v===alias || v.startsWith(alias+'\\') || v.startsWith(alias+'/')));
        if (!matches) { unmatched++; continue; }
        const parameters = Object.fromEntries(params.map((p:any)=>[str(p.Name),p.Value]));
        const changes = params.map((p:any)=>`${str(p.Name)}: ${str(p.Value)}`).join('; ');
        add('Historical rule change',event.raw,{Name:str(parameters.Name || parameters.RuleName || data.ObjectId),Conditions:conditions(parameters) || str(parameters.RuleCondition),Actions:actions(parameters) || str(parameters.RuleActions) || changes,'Created UTC':event.operation==='New-InboxRule'?event.time:'','Time UTC':event.time,'Source IP':event.clientIP,Operation:event.operation,Description:'Matched audited actor or mailbox reference; inspect raw fields to establish target and change.'},ruleFindings(parameters),event.id);
      }
    }
    notes.push(`Historical searches use New-InboxRule, Set-InboxRule, Remove-InboxRule and UpdateInboxRules, including tenant-wide operation searches to capture administrator/delegate actions. ${unmatched} returned records could not be attributed by actor/mailbox references and are not included. Missing identity references can limit coverage.`, 'Creation time and source IP are not fabricated for current rules. Historical rows show the event timestamp/IP when returned; current rules are not date-filtered.');
  } else if (kind.startsWith('trace-')) {
    columns = ['Time UTC','UPN','Sender','Recipient','Subject','Status','Sender IP','Recipient IP','Message trace ID','Message ID',...(kind==='trace-inbound'?['Rule candidates']:[])];
    const rows = (source('trace')?.rows ?? []).filter(r=>timeInWindow(r.Received,query));
    const counts = new Map<string,Set<string>>();
    for (const r of rows) { const key = str(r.MessageTraceId || r.MessageId); if (!key) continue; const set = counts.get(key) ?? new Set(); set.add(str(r.RecipientAddress)); counts.set(key,set); }
    const domains = (source('accepted-domains')?.rows ?? []).map(r=>str(r.DomainName).toLowerCase());
    const localRuleSource = source('inbox-rules');
    const reusableRules = priorRules && priorRules.query.user.toLowerCase()===query.user.toLowerCase() && priorRules.tenant===tenant ? priorRules.records.filter(r=>r.source==='Current rule').map(r=>r.raw) : [];
    const candidateRules = localRuleSource ? localRuleSource.rows : reusableRules;
    if(kind==='trace-inbound' && !localRuleSource && reusableRules.length)notes.push(`Rule candidates reuse the Inbox Rules snapshot collected ${priorRules!.collectedAt}; fresh rule collection was unavailable. Export that snapshot as supporting evidence.`);
    for (const r of rows) {
      const findings: string[] = [], recipients = counts.get(str(r.MessageTraceId || r.MessageId))?.size ?? 1;
      if (recipients>=20) findings.push(`Bulk-recipient candidate: ${recipients} unique recipients in this collection`);
      if (/\b(invoice|payment|bank|transfer|remittance|beneficiary|iban|swift)\b/i.test(str(r.Subject))) findings.push('Payment-related subject terms; analyst review required');
      if (kind==='trace-outbound' && domains.includes(str(r.RecipientAddress).split('@')[1]?.toLowerCase())) findings.push('Internal recipient (accepted-domain match); review for spearphishing');
      const candidates = candidateRules.filter(rule=>rule.Enabled!==false && str(rule.Enabled).toLowerCase()!=='false' && ruleFindings(rule).some(f=>/Deletes|Moves|Redirects|Forwards|Marks/.test(f)));
      if (kind==='trace-inbound' && candidates.length) findings.push('Potential hiding/forwarding rules present; conditions, exceptions and execution require verification');
      add('Message trace',r,{'Time UTC':utc(r.Received),Sender:str(r.SenderAddress),Recipient:str(r.RecipientAddress),Subject:str(r.Subject),Status:str(r.Status),'Sender IP':str(r.FromIP),'Recipient IP':str(r.ToIP),'Message trace ID':str(r.MessageTraceId),'Message ID':str(r.MessageId),'Rule candidates':kind==='trace-inbound'?candidates.map(c=>`${str(c.Name)}: ${actions(c)} | ${conditions(c)}`).join('; '):''},findings,[str(r.MessageTraceId || r.MessageId) || hash(r),str(r.RecipientAddress),utc(r.Received)].join('|'));
    }
    if(kind==='trace-inbound') for(const rule of candidateRules.filter(r=>r.Enabled!==false && str(r.Enabled).toLowerCase()!=='false' && ruleFindings(r).some(f=>/Deletes|Moves|Redirects|Forwards|Marks/.test(f)))) {
      add('Current rule candidate',rule,{Subject:str(rule.Name),Status:str(rule.Enabled),'Rule candidates':`${actions(rule)} | ${conditions(rule)} | ${str(rule.Description)}`},['Current rule for manual correlation; no proof of execution on traced messages']);
    }
    notes.push('Message Trace V2 is split into at most ten-day windows and saturated windows are recollected in smaller ranges. End time is exclusive. Retention is 90 days.', 'Trace includes message metadata and subjects, not message bodies. Subject keywords are review hints; unfamiliar recipients and fraud intent require analyst judgement. Bulk counts are limited to the queried account/time/counterparty.', 'Inbound rule candidates are a current-state checklist, not proof that a response was hidden. Raw rules retain conditions, exceptions, priority and actions.');
  } else if (kind==='forwarding') {
    columns = ['UPN','Name','State','Mode','Priority','Forwarding SMTP','Forwarding address','Deliver to mailbox and forward','Actions','Conditions','Time UTC','Description'];
    for (const r of source('mailbox')?.rows ?? []) add('Mailbox forwarding',r,{Name:str(r.PrimarySmtpAddress || r.UserPrincipalName),'Forwarding SMTP':str(r.ForwardingSmtpAddress),'Forwarding address':str(r.ForwardingAddress),'Deliver to mailbox and forward':str(r.DeliverToMailboxAndForward),'Time UTC':str(r.WhenChanged)},active(r.ForwardingSmtpAddress)||active(r.ForwardingAddress)?['Mailbox forwarding configured; review destination and business purpose']:[]);
    for (const r of source('transport-rules')?.rows ?? []) add('Tenant transport rule',r,{Name:str(r.Name),State:str(r.State),Mode:str(r.Mode),Priority:str(r.Priority),Actions:['RedirectMessageTo','BlindCopyTo','CopyTo','AddToRecipients'].filter(k=>active(r[k])).map(k=>`${k}: ${str(r[k])}`).join('; '),Conditions:conditions(r),'Time UTC':str(r.WhenChanged),Description:str(r.Description)},['Tenant-wide inventory candidate; verify conditions/exceptions before attributing to the account']);
    notes.push('Transport rules are tenant-wide candidates, including disabled/test-mode rules. Their presence does not establish creation by an attacker or application to the selected account. Current mailbox/transport configuration is not constrained by the incident dates.');
  } else {
    columns = ['Time UTC','UPN','Subject / URL','Sender','Recipient','Status / verdict','Threats','Detection methods','Sender IP','Network message ID'];
    for (const s of result.sources.filter(s=>s.ok && !['mailbox'].includes(s.name))) for (const r of s.rows) {
      if (!timeInWindow(r.Timestamp ?? r.ReceivedTime ?? r.Received,query)) continue;
      const threats = str(r.ThreatTypes || r.QuarantineTypes || r.Type), methods = str(r.DetectionMethods || r.DetectionTechnology);
      add(s.name,r,{'Time UTC':str(r.Timestamp ?? r.ReceivedTime ?? r.Received),'Subject / URL':str(r.Url || r.Subject),Sender:str(r.SenderFromAddress || r.SenderAddress || r.SenderMailFromAddress),Recipient:str(r.RecipientEmailAddress || r.RecipientAddress || r.AccountUpn),'Status / verdict':str(r.DeliveryAction || r.ActionType || r.ReleaseStatus),Threats:threats,'Detection methods':methods,'Sender IP':str(r.SenderIPv4 || r.SenderIPv6 || r.IPAddress),'Network message ID':str(r.NetworkMessageId)},threats && threats!=='None'?['Threat/quarantine metadata present; review source verdict and sender authentication']:[]);
    }
    notes.push('Quarantine and Defender tables have separate licensing, permissions and retention. An unavailable source is an evidence gap, not an empty search. Select an earlier window (for example 14 or 28 days) to investigate delivery before the incident.', 'Review sender identity, authentication details, delivery actions, threat detection methods and URL-click chains in raw data. Trusted/compromised third-party senders can deliver AiTM lures; delivery/block status alone is insufficient.', 'Full URL detonation reports/chains are reviewed in the Defender portal. Use Capture detonation result to record observed verdict, URL, observation time, report reference and analyst notes. Captures are manual evidence, not an automated detonation result.');
  }
  if (result.sources.some(s=>!s.ok)) notes.unshift('INCOMPLETE COVERAGE: one or more sources could not be collected. Review source errors; successful sources are retained.');
  if (!source('mailbox')) notes.push('Mailbox/alias resolution unavailable. Queries used the entered UPN only; alias coverage may be incomplete.');
  return { kind, query, tenant, collectedAt:new Date().toISOString(),aliases,columns,records,sources:result.sources.map(({rows,...s})=>({...s,returned:rows.length})),notes };
}
export function validateDetonation(value: unknown): DetonationCapture {
  const r=value as DetonationCapture;
  if (!r || !['malicious','suspicious','clean','unknown'].includes(r.verdict) || !['url','reference','notes','observedAt'].every(k=>typeof (r as any)[k]==='string' && (r as any)[k].length<=20000) || !Number.isFinite(Date.parse(r.observedAt)) || Date.parse(r.observedAt)>Date.now()+60000) throw Error('Enter a valid URL, observation time, verdict and report reference.');
  const url=new URL(r.url); if (!['http:','https:'].includes(url.protocol)) throw Error('Only HTTP(S) URL indicators are supported. URLs are recorded, never visited.');
  if (!r.reference.trim()) throw Error('Include the report reference or evidence filename for the observed verdict.');
  return {...r,observedAt:new Date(r.observedAt).toISOString()};
}
export function m365Csv(c:M365Collection,rows:M365Record[],scope:string,filters:M365Filters):string {
  const cell=(v:unknown)=>{let t=str(v);if(/^\s*[=+@-]/.test(t)||/^[\t\r\n]/.test(t))t="'"+t;return '"'+t.replace(/"/g,'""')+'"'};
  return '\uFEFF'+[['id','source',...c.columns,'findings','tenant','queryUser','startUtc','endUtc','counterparty','exportScope','filtersJson','rawJson'],...rows.map(r=>[r.id,r.source,...c.columns.map(k=>r.values[k]),r.findings.join('; '),c.tenant,c.query.user,c.query.start,c.query.end,c.query.party,scope,JSON.stringify(filters),JSON.stringify(r.raw)])].map(row=>row.map(cell).join(',')).join('\r\n');
}

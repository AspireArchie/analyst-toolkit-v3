import { tableValue } from './table-value.js';
import type { BecApi, DetonationCapture, M365Collection, M365Filters, M365Kind, SessionState, UiAuditEvent } from './contracts';
interface Context { api:BecApi;run:(work:(epoch:number)=>Promise<void>)=>Promise<void>;audit:(event:UiAuditEvent)=>Promise<void>;message:(text:string,tone?:'neutral'|'success'|'failure'|'warning')=>void;generation:()=>number;state:()=>SessionState }
const modules = {
  'inbox-rules': { title:'Inbox Rules',hint:'Current rules (including hidden) and incident-window UAL changes. Creation time/IP are shown only when returned.' },
  'trace-outbound': { title:'Outbound Trace',hint:'Sender-scoped Message Trace V2 metadata. Review recipients, subject keywords and bulk-recipient candidates.' },
  'trace-inbound': { title:'Inbound Trace',hint:'Recipient-scoped trace with current hiding/forwarding rule candidates. A candidate is not proof of execution.' },
  'defender-review': { title:'Quarantine / Threat Explorer',hint:'Quarantine, email delivery/threat metadata, email URLs, Safe Links clicks and post-delivery events, where available. Use a window before the incident to look for lures.' },
  forwarding: { title:'Forwarding',hint:'Current mailbox forwarding and tenant-wide transport-rule candidates. Verify conditions, exceptions, mode and business purpose.' },
};
export function initializeM365Tabs(context:Context) {
  const controllers=(Object.keys(modules) as M365Kind[]).map(kind=>{
    const config=modules[kind],root=document.getElementById(`${kind}-module`)!;
    root.className='m365-module';
    root.innerHTML=`<form class="query-panel" data-field="form">
      <div class="control-row"><label>Affected UPN<input data-field="user" type="email" required placeholder="user@contoso.com"></label><label>Incident / review window<select data-field="range"><option value="24">Last 24 hours</option><option value="48">Last 48 hours</option><option value="72">Last 72 hours</option><option value="168">Last week</option><option value="336">Last 14 days</option><option value="672">Last 28 days</option><option value="custom">Custom range</option></select></label></div>
      <div data-field="custom" class="control-row" hidden><label>Start (local time)<input data-field="start" type="datetime-local"></label><label>End (local time, exclusive)<input data-field="end" type="datetime-local"></label></div>
      ${kind.startsWith('trace-')?`<div class="control-row"><label>${kind==='trace-inbound'?'External / counterparty sender':'Counterparty recipient'} (optional)<input data-field="party" type="email" placeholder="Specific email address"></label></div>`:''}
      <button data-field="collect" class="primary" type="submit">Collect evidence</button><p class="help">${config.hint}</p><p class="help">Uses the shared Session connections. Metadata only; message content searches and eDiscovery are outside this module.</p>
    </form>
    <section class="results-panel"><div class="panel-header"><h2 data-field="heading">${config.title} · 0 records</h2></div>
      <p data-field="info" class="help">No collection run yet.</p><div data-field="sources" class="m365-sources"></div>
      <div class="control-row result-tools"><label>Search all captured fields<input data-field="search" type="search"></label><label>Source<select data-field="source"><option value="all">All sources</option></select></label><label class="checkbox-label"><input data-field="flagged" type="checkbox">Review candidates only</label><button data-field="apply" type="button">Apply filters</button><button data-field="clear" type="button">Clear filters</button></div>
      <div class="table-scroll"><table><thead data-field="head"></thead><tbody data-field="body"></tbody></table></div>
      <div class="pagination"><button data-field="previous">Previous</button><span data-field="page"></span><button data-field="next">Next</button></div>
      <div class="control-row result-tools"><label>Export scope<select data-field="scope"><option value="all">Complete captured collection</option><option value="filtered">All matching filtered records</option></select></label><button data-field="csv">Export CSV</button><button data-field="json">Export JSON</button></div>
      <p class="help">CSV includes a .metadata.json companion with source availability and coverage, even for empty searches.</p>
      <details data-field="details"><summary>Selected record · raw fields</summary><pre data-field="raw">Select a record to inspect.</pre></details><div data-field="notes" class="m365-notes"></div>
    </section>
    ${kind==='defender-review'?`<section class="query-panel"><h2>URL detonation evidence</h2><div class="control-row"><button data-field="explorer">Open Threat Explorer</button><button data-field="quarantine">Open Quarantine</button></div><p class="help">Review the existing report in Defender, then record its verdict and reference below. BEC Bot does not visit/detonate the URL or retrieve message bodies. This capture is labelled as a manual observation.</p><form data-field="detonation"><div class="control-row"><label>Suspected URL<input data-field="url" type="url" required placeholder="https://…"></label><label>Observed verdict<select data-field="verdict"><option value="unknown">Unknown</option><option value="malicious">Malicious</option><option value="suspicious">Suspicious</option><option value="clean">Clean</option></select></label><label>Observed at (local time)<input data-field="observed" type="datetime-local" required></label></div><label>Report reference / evidence filename<input data-field="reference" required></label><label>Report observations / sender reputation<textarea data-field="capture-notes" rows="4"></textarea></label><button data-field="capture" type="submit">Capture detonation result</button></form></section>`:''}`;
    const el=<T extends HTMLElement=HTMLElement>(name:string)=>root.querySelector<T>(`[data-field="${name}"]`)!;
    if(kind==='defender-review')el<HTMLSelectElement>('range').value='672';
    const value=(name:string)=>(el<HTMLInputElement>(name)).value;
    const unwrap=<T>(reply:{ok:true;data:T}|{ok:false;error:string}):T=>{if(!reply.ok)throw Error(reply.error);return reply.data;};
    const activity=(work:()=>Promise<void>)=>{void work().catch(error=>context.message(String(error),'failure'));};
    const make=(tag:string,text='')=>{const node=document.createElement(tag);node.textContent=text;return node;};
    let snapshot:M365Collection|null=null,page=0,version=0,rawId:string|null=null;
    const filters=():M365Filters=>({search:value('search').trim(),source:value('source'),flagged:el<HTMLInputElement>('flagged').checked});
    function controls(busy:boolean,state:SessionState) {
      el<HTMLButtonElement>('collect').disabled=busy||!(kind==='defender-review'?state.graph||state.exchange:state.exchange);
      for(const key of ['csv','json','apply','clear'])el<HTMLButtonElement>(key).disabled=busy||!snapshot;
      if(kind==='defender-review')el<HTMLButtonElement>('capture').disabled=busy||!snapshot;
    }
    function summaries() {
      el('sources').replaceChildren();el('notes').replaceChildren();
      if(!snapshot)return;
      for(const source of snapshot.sources){const p=make('p',`${source.name}: ${source.ok?`${source.returned} returned`:`Unavailable — ${source.error}`} · checked ${source.checkedAt}`);p.className='help';p.dataset.tone=source.ok?'success':'failure';el('sources').append(p);}
      for(const note of snapshot.notes){const p=make('p',note);p.className='help';if(note.startsWith('INCOMPLETE'))p.classList.add('ual-gap');el('notes').append(p);}
      const selector=el<HTMLSelectElement>('source'),prior=selector.value;
      selector.replaceChildren(new Option('All sources','all'));for(const source of [...new Set(snapshot.records.map(r=>r.source))])selector.add(new Option(source,source));
      if([...selector.options].some(o=>o.value===prior))selector.value=prior;
    }
    async function render(requested=filters()) {
      const current=++version,epoch=context.generation(),source=snapshot;
      const view=snapshot?unwrap(await context.api.viewM365(kind,requested,page)):{records:[],page:0,total:0,matched:0};
      if(current!==version||epoch!==context.generation()||source!==snapshot)return;
      page=view.page;el('heading').textContent=`${config.title} · ${view.total} records`;
      const columns=snapshot?.columns??[],head=make('tr');for(const name of ['Source',...columns,'Review notes','Details'])head.append(make('th',name));el('head').replaceChildren(head);el('body').replaceChildren();
      for(const record of view.records){
        const tr=make('tr');tr.dataset.tone=record.findings.length?'warning':'neutral';tr.append(make('td',record.source));
        for(const [field,text] of [...columns.map(c=>[c,record.values[c]||'—']),['Review notes',record.findings.join('; ')]]){
          const cell=make('td');tableValue(cell,text,async open=>{unwrap(await context.api.inspectM365(kind,record.id,field,open));},error=>context.message(String(error),'failure'));tr.append(cell);
        }
        const cell=make('td'),button=make('button','View');button.setAttribute('type','button');
        button.addEventListener('click',()=>activity(async()=>{const recordData=unwrap(await context.api.inspectM365(kind,record.id));if(source!==snapshot||epoch!==context.generation())return;rawId=record.id;el('raw').textContent=JSON.stringify(recordData,null,2);el<HTMLDetailsElement>('details').open=true;}));cell.append(button);tr.append(cell);el('body').append(tr);
      }
      if(!view.records.length){const tr=make('tr'),td=make('td',snapshot?'No records match this view. Review source availability and coverage.':'Connect in Session and collect evidence to begin.');(td as HTMLTableCellElement).colSpan=columns.length+3;tr.append(td);el('body').append(tr);}
      el('page').textContent=view.matched?`${page*100+1}–${Math.min((page+1)*100,view.matched)} of ${view.matched} matching / ${view.total} captured`:'0 matching records';
      el<HTMLButtonElement>('previous').disabled=page===0;el<HTMLButtonElement>('next').disabled=(page+1)*100>=view.matched;
    }
    function clearFilters(){el<HTMLInputElement>('search').value='';el<HTMLSelectElement>('source').value='all';el<HTMLInputElement>('flagged').checked=false;page=0;}
    el('form').addEventListener('submit',event=>{event.preventDefault();void context.run(async epoch=>{
      snapshot=null;version++;page=0;rawId=null;clearFilters();el('raw').textContent='Select a record to inspect.';el<HTMLDetailsElement>('details').open=false;summaries();await render();
      el('info').textContent='Collection in progress; no completed evidence available.';
      const range=value('range'),end=range==='custom'?new Date(value('end')):new Date(),start=range==='custom'?new Date(value('start')):new Date(end.getTime()-Number(range)*3600000);
      context.message(`Collecting ${config.title.toLowerCase()}…`);
      let result:M365Collection;
      try{result=unwrap(await context.api.collectM365(kind,{user:value('user').trim(),start:start.toISOString(),end:end.toISOString(),party:kind.startsWith('trace-')?value('party').trim():''}));}
      catch(error){if(epoch===context.generation())el('info').textContent='Collection failed. No completed evidence available.';throw error;}
      if(epoch!==context.generation())return;snapshot=result;summaries();
      el('info').textContent=`${result.query.user} · ${result.query.start} → ${result.query.end} (exclusive) · tenant ${result.tenant} · collected ${result.collectedAt}`;
      await render();context.message(`${config.title}: ${result.records.length} records.${result.sources.some(s=>!s.ok)?' Incomplete coverage — review source errors.':''}`,result.sources.some(s=>!s.ok)?'warning':'success');
    });});
    el('range').addEventListener('change',()=>activity(async()=>{await context.audit({action:'range_change',range:`${kind}:${value('range')}`,start:value('start'),end:value('end')});const custom=value('range')==='custom';el('custom').hidden=!custom;el<HTMLInputElement>('start').required=custom;el<HTMLInputElement>('end').required=custom;}));
    for(const name of ['source','flagged'])el(name).addEventListener('change',()=>{page=0;activity(()=>render());});
    el('apply').addEventListener('click',()=>{page=0;activity(()=>render());});el('clear').addEventListener('click',()=>{clearFilters();activity(()=>render());});
    el('previous').addEventListener('click',()=>{page=Math.max(0,page-1);activity(()=>render());});el('next').addEventListener('click',()=>{page++;activity(()=>render());});
    for(const format of ['csv','json'] as const)el(format).addEventListener('click',()=>void context.run(async epoch=>{const selected=filters(),scope=value('scope') as 'all'|'filtered';await render(selected);if(epoch!==context.generation())return;const path=unwrap(await context.api.exportM365(kind,format,scope,selected));if(epoch===context.generation())context.message(path?`Exported ${path}${format==='csv'?' and .metadata.json companion':''}`:'Export cancelled.',path?'success':'neutral');}));
    if(kind==='defender-review'){
      for(const portal of ['explorer','quarantine'] as const)el(portal).addEventListener('click',()=>activity(async()=>{unwrap(await context.api.openM365Portal(portal));}));
      el('detonation').addEventListener('submit',event=>{event.preventDefault();void context.run(async epoch=>{const report:DetonationCapture={url:value('url').trim(),verdict:value('verdict') as DetonationCapture['verdict'],observedAt:new Date(value('observed')).toISOString(),reference:value('reference'),notes:value('capture-notes')};const result=unwrap(await context.api.captureDetonation(report));if(epoch!==context.generation())return;snapshot=result;clearFilters();summaries();await render();context.message('Manual detonation observation captured. Export to retain it with the investigation evidence.','success');});});
    }
    el('details').querySelector('summary')!.addEventListener('click',event=>{event.preventDefault();activity(async()=>{const details=el<HTMLDetailsElement>('details'),open=!details.open;if(rawId)unwrap(await context.api.inspectM365(kind,rawId,'Raw details',open));details.open=open;});});
    async function reset(){snapshot=null;version++;page=0;rawId=null;clearFilters();el<HTMLInputElement>('user').value='';el('info').textContent='No collection run yet.';el('raw').textContent='Select a record to inspect.';el<HTMLDetailsElement>('details').open=false;summaries();if(kind==='defender-review')for(const name of ['url','observed','reference','capture-notes'])el<HTMLInputElement>(name).value='';await render();}
    return {controls,render,reset};
  });
  return {controls:(busy:boolean,state:SessionState)=>controllers.forEach(c=>c.controls(busy,state)),render:async()=>{for(const c of controllers)await c.render();},reset:async()=>{for(const c of controllers)await c.reset();}};
}

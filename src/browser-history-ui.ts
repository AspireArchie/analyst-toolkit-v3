import type { BecApi, HistoryBrowser, HistoryQuery, HistorySource, HistoryVisit, Reply } from './contracts';
import { tableValue } from './table-value.js';
export function initializeBrowserHistory(api: BecApi): void {
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
  const value=(id:string)=>(el<HTMLInputElement>(id)).value;
  const status=el('history-status');
  const unwrap=<T>(reply:Reply<T>):T=>{if(!reply.ok)throw Error(reply.error);return reply.data;};
  let source:HistorySource|null=null,page=0,total=0,sequence=0,importing=false,timer:ReturnType<typeof setTimeout>|undefined;
  const query=():HistoryQuery=>({sourceId:source?.id??'',search:value('history-search'),protocol:value('history-protocol') as HistoryQuery['protocol'],type:value('history-type') as HistoryQuery['type'],start:value('history-start')?new Date(value('history-start')).toISOString():'',end:value('history-end')?new Date(value('history-end')).toISOString():'',page});
  const make=(tag:string,text='',cls='')=>{const node=document.createElement(tag);node.textContent=text;node.className=cls;return node;};
  const controls=()=>{
    el<HTMLButtonElement>('history-import').disabled=importing;
    el<HTMLSelectElement>('history-browser').disabled=importing;
    for(const id of ['history-clear','history-copy-urls','history-copy-visits'])el<HTMLButtonElement>(id).disabled=importing||!source||(id!=='history-clear'&&!total);
    for(const id of ['history-search','history-protocol','history-type','history-start','history-end'])el<HTMLInputElement>(id).disabled=importing||!source;
    el<HTMLButtonElement>('history-previous').disabled=importing||!source||page===0;
    el<HTMLButtonElement>('history-next').disabled=importing||!source||(page+1)*100>=total;
  };
  async function copy(mode:'urls'|'visits',id?:string):Promise<void>{
    try {const count=unwrap(await api.copyHistory(query(),mode,id));status.textContent=`Copied ${count} ${mode==='urls'?'URL(s)':'visit(s)'}.`;}
    catch(error){status.textContent=String(error);}
  }
  function details(row:HistoryVisit):void{
    el('history-record-json').textContent=JSON.stringify({source,visit:row},null,2);
    el<HTMLDetailsElement>('history-record').open=true;
  }
  async function render(paging=false):Promise<void>{
    if(!source)return;
    const viewport=el('history-body').closest<HTMLElement>('.table-scroll')!;
    // Keep the results footprint while loading and on a shorter final page.
    // Removing rows before the async query collapses the page and clamps its scroll.
    if(paging)viewport.style.minHeight=`${viewport.getBoundingClientRect().height}px`;
    const current=++sequence;total=0;controls();if(!paging)el('history-summary').textContent='Loading visits…';
    try{
      const result=unwrap(await api.queryHistory(query()));if(current!==sequence||result.sourceId!==source?.id)return;
      total=result.total;page=result.page;
      el('history-summary').textContent=`${total.toLocaleString()} visits · ${result.pages.toLocaleString()} URLs${result.first?` · ${result.first} → ${result.last}`:''}`;
      el('history-page').textContent=total?`${page*100+1}–${Math.min((page+1)*100,total)} of ${total.toLocaleString()}`:'No visits';
      const body=document.createDocumentFragment();
      for(const row of result.rows){
        const tr=document.createElement('tr');tr.append(make('td',row.time??'Unknown'));
        const valueCell=(container:HTMLElement,text:string,field:string)=>tableValue(container,text,async open=>{unwrap(await api.audit({action:'table_cell_toggle',page:'browser-history',id:row.id,field,open}));},error=>{status.textContent=String(error);});
        const urlCell=make('td'),title=make('strong','','history-title'),url=make('span','','history-url');
        valueCell(title,row.title||'(no title)','Title');valueCell(url,row.url,'URL');urlCell.append(title,url);tr.append(urlCell);
        for(const [index,text] of [row.domain,row.type,row.urlVisits==null?'—':String(row.urlVisits),row.durationSeconds==null?'—':String(row.durationSeconds)].entries()){const cell=make('td');valueCell(cell,text,['Domain','Type','Visit count','Duration'][index]);tr.append(cell);}
        const actions=make('td','', 'history-actions');
        for(const [label,work] of [['Copy URL',()=>void copy('urls',row.id)],['Copy visit',()=>void copy('visits',row.id)],['Details',()=>details(row)]] as const){const button=document.createElement('button');button.textContent=label;button.addEventListener('click',work);actions.append(button);}
        tr.append(actions);body.append(tr);
      }
      if(!result.rows.length){const row=make('tr'),cell=document.createElement('td');cell.colSpan=7;cell.textContent='No visits match the current filters.';row.append(cell);body.append(row);}
      el('history-body').replaceChildren(body);
      if(!paging)viewport.style.minHeight='';
      viewport.scrollTop=0;
      status.textContent='';
    }catch(error){if(current===sequence){el('history-summary').textContent='Could not load visits.';el('history-page').textContent='';status.textContent=String(error);}}
    finally{if(current===sequence)controls();}
  }
  el('history-import').addEventListener('click',()=>{void(async()=>{
    if(importing)return;importing=true;sequence++;controls();status.textContent='Importing history…';
    try{
      const imported=unwrap(await api.importHistory(value('history-browser') as HistoryBrowser));
      if(imported){
        source=imported;page=0;
        for(const id of ['history-search','history-start','history-end'])el<HTMLInputElement>(id).value='';
        el<HTMLSelectElement>('history-protocol').value='all';el<HTMLSelectElement>('history-type').value='all';
        el('history-source').textContent=`${source.browser} · ${source.file} · ${source.visits.toLocaleString()} visits · ${source.pages.toLocaleString()} URLs`;
        el('history-record-json').textContent='Select a visit to inspect its source and raw timestamps.';el<HTMLDetailsElement>('history-record').open=false;
        await render();
      }else{status.textContent='Import cancelled.';if(source)await render();}
    }catch(error){if(source)await render();status.textContent=String(error);}
    finally{importing=false;controls();}
  })();});
  for(const id of ['history-search','history-protocol','history-type','history-start','history-end'])el(id).addEventListener(id==='history-search'?'input':'change',()=>{
    page=0;sequence++;clearTimeout(timer);timer=setTimeout(()=>void render(),id==='history-search'?180:0);
  });
  el('history-previous').addEventListener('click',()=>{page--;void render(true);});
  el('history-next').addEventListener('click',()=>{page++;void render(true);});
  el('history-copy-urls').addEventListener('click',()=>void copy('urls'));
  el('history-copy-visits').addEventListener('click',()=>void copy('visits'));
  el('history-clear').addEventListener('click',()=>{void(async()=>{
    try{unwrap(await api.clearHistory());clearTimeout(timer);sequence++;source=null;total=0;page=0;el('history-body').closest<HTMLElement>('.table-scroll')!.style.minHeight='';el('history-body').replaceChildren();el('history-source').textContent='No history imported.';el('history-summary').textContent='';el('history-page').textContent='';el('history-record-json').textContent='';el<HTMLDetailsElement>('history-record').open=false;status.textContent='History cleared.';controls();}
    catch(error){status.textContent=String(error);}
  })();});
  controls();
}

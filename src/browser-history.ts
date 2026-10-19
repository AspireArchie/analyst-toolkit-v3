import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HistoryBrowser, HistoryQuery, HistoryResults, HistorySource } from './contracts';

class HistoryWorker {
  private worker: Worker;
  private sequence=0;
  private stopped=false;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  readonly ready: Promise<HistorySource>;
  constructor(private directory: string,file: string,browser: HistoryBrowser){
    this.worker=new Worker(path.join(__dirname,'browser-history-worker.js'),{workerData:{file,browser,directory}});
    this.ready=this.wait<HistorySource>(0);
    this.worker.on('message',reply=>{const item=this.pending.get(reply.id);if(!item)return;clearTimeout(item.timer);this.pending.delete(reply.id);if(reply.ok)item.resolve(reply.data);else item.reject(Error(reply.error));});
    const fail=()=>{this.stopped=true;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(Error('History worker stopped. Reimport the history file.'));}this.pending.clear();};
    this.worker.on('error',fail);this.worker.on('exit',fail);
  }
  private wait<T>(id:number):Promise<T>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);this.stopped=true;reject(Error('History operation timed out. Reimport a smaller history file.'));void this.worker.terminate();},60000);this.pending.set(id,{resolve,reject,timer});});}
  run<T>(action:string,query:HistoryQuery,extra:Record<string,unknown>={}):Promise<T>{if(this.stopped)return Promise.reject(Error('History worker stopped. Reimport the history file.'));const id=++this.sequence,promise=this.wait<T>(id);this.worker.postMessage({id,action,query,...extra});return promise;}
  async close():Promise<void>{
    await this.worker.terminate();
    const absolute=path.resolve(this.directory);
    if(path.dirname(absolute)!==path.resolve(tmpdir())||!path.basename(absolute).startsWith('bec-history-'))throw Error('Invalid history temporary directory.');
    await rm(absolute,{recursive:true,force:true});
  }
}
export class BrowserHistory {
  private current: {worker:HistoryWorker;source:HistorySource}|null=null;
  private importing=false;
  private closed=false;
  private loading:Promise<HistorySource>|null=null;
  async import(file:string,browser:HistoryBrowser):Promise<HistorySource>{
    if(this.importing)throw Error('A history import is already running.');
    if(this.closed)throw Error('History viewer is closed.');
    if(!['auto','chrome','edge','firefox'].includes(browser))throw Error('Invalid browser selection.');
    this.importing=true;
    const load=async()=>{
      let worker:HistoryWorker|null=null;
      try{
        const directory=await mkdtemp(path.join(tmpdir(),'bec-history-'));
        worker=new HistoryWorker(directory,file,browser);
        const source=await worker.ready;
        if(this.closed)throw Error('History viewer is closing.');
        const old=this.current;this.current={worker,source};worker=null;
        if(old)await old.worker.close();
        return source;
      }finally{if(worker)await worker.close();this.importing=false;}
    };
    this.loading=load();try{return await this.loading;}finally{this.loading=null;}
  }
  private selected(q:HistoryQuery):HistoryWorker{if(!this.current||this.current.source.id!==q.sourceId)throw Error('Import a history database first, or refresh the current source.');return this.current.worker;}
  query(q:HistoryQuery):Promise<HistoryResults>{return this.selected(q).run('query',q);}
  copy(q:HistoryQuery,mode:'urls'|'visits',visitId?:string):Promise<{text:string;count:number}>{return this.selected(q).run('copy',q,{mode,visitId});}
  async clear():Promise<void>{if(this.importing)throw Error('Wait for the history import to finish.');const old=this.current;this.current=null;if(old)await old.worker.close();}
  async close():Promise<void>{this.closed=true;await this.loading?.catch(()=>{});await this.clear();}
}

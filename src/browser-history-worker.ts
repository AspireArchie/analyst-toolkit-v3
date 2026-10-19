import { parentPort, workerData } from 'node:worker_threads';
import { copyFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { HistoryDatabase, validateHistoryQuery } from './browser-history-db';
import type { HistoryBrowser, HistorySource } from './contracts';

const data = workerData as { file: string; browser: HistoryBrowser; directory: string };
let database: HistoryDatabase;
async function load(): Promise<HistorySource> {
  const candidates = [data.file, data.file+'-wal', data.file+'-journal'];
  const originals: { file: string; size: number; mtimeMs: number }[] = [];
  for(const file of candidates){
    try { const info=await stat(file); if(!info.isFile() || info.size>2*1024*1024*1024) throw Error('History file is not a regular file or exceeds 2 GB.'); originals.push({file,size:info.size,mtimeMs:info.mtimeMs}); }
    catch(error){ if((error as NodeJS.ErrnoException).code==='ENOENT' && file!==data.file)continue; throw error; }
  }
  if(originals.some(f=>f.file.endsWith('-journal')&&f.size>0)) throw Error('History database has an active recovery journal. Close the browser and acquire a clean copy first.');
  const files: HistorySource['files'] = [];
  for(const original of originals.filter(f=>!f.file.endsWith('-journal'))){
    const name=original.file===data.file?'History': 'History-wal', target=path.join(data.directory,name);
    await copyFile(original.file,target);
    const hash=createHash('sha256'); for await(const chunk of createReadStream(target))hash.update(chunk);
    files.push({name:path.basename(original.file),bytes:original.size,sha256:hash.digest('hex')});
  }
  // Detect concurrent browser writes instead of presenting a known unstable snapshot.
  for(const file of candidates){
    const before=originals.find(f=>f.file===file);
    const after=await stat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(Boolean(before)!==Boolean(after)||(before&&after&&(before.size!==after.size||before.mtimeMs!==after.mtimeMs))) throw Error('History changed during import. Close the browser and import a stable copy.');
  }
  database=new HistoryDatabase(path.join(data.directory,'History'),data.browser);
  const id=randomUUID();
  const stats=database.query({sourceId:id,search:'',protocol:'all',type:'all',start:'',end:'',page:0});
  return {id,file:data.file,browser:database.browser,importedAt:new Date().toISOString(),visits:stats.total,pages:stats.pages,files};
}
void load().then(source=>{
  parentPort!.on('message',request=>{
    try {
      const query=validateHistoryQuery(request.query);
      if(query.sourceId!==source.id)throw Error('History source changed. Refresh the view.');
      let result;
      if(request.action==='query')result=database.query(query);
      else if(request.action==='copy' && ['urls','visits'].includes(request.mode))result=database.copy(query,request.mode,request.visitId);
      else throw Error('Unsupported history operation.');
      parentPort!.postMessage({id:request.id,ok:true,data:result});
    } catch(error){parentPort!.postMessage({id:request.id,ok:false,error:error instanceof Error?error.message:String(error)});}
  });
  parentPort!.postMessage({id:0,ok:true,data:source});
}).catch(error=>{parentPort!.postMessage({id:0,ok:false,error:`Could not import browser history: ${error instanceof Error?error.message:String(error)}. Use a closed-browser copy of History or places.sqlite, with its matching -wal file if present.`});parentPort!.close();});

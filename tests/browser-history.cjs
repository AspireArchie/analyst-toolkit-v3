const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {HistoryDatabase,validateHistoryQuery}=require('../dist/browser-history-db');
const {BrowserHistory}=require('../dist/browser-history');
const {temp,cleanup,fixture,time,chromeTime}=require('./helpers/history.cjs');
const q=(extra={})=>({sourceId:'fixture',search:'',protocol:'all',type:'all',start:'',end:'',page:0,...extra});
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('Chromium preserves individual visits, exact raw timestamps and source counts',()=>{
  const dir=temp(),file=path.join(dir,'History');fixture(file).close();const before=hash(file),db=new HistoryDatabase(file,'auto');
  try{
    assert.equal(db.browser,'Chromium (Chrome / Edge)');
    const result=db.query(q());assert.equal(result.total,105);assert.equal(result.pages,2);assert.equal(result.rows.length,100);
    const older=db.query(q({page:1}));assert.equal(older.rows.length,5);assert.equal(older.rows.at(-1).time,time);assert.equal(older.rows.at(-1).rawTime,chromeTime.toString());
    assert.equal(older.rows.at(-1).urlVisits,105);assert.equal(older.rows.at(-1).durationSeconds,1.5);
    assert.equal(result.rows[0].referrer,'https://example.com/login');
    assert.equal(db.query(q({type:'typed'})).total,1);assert.equal(db.query(q({type:'reload'})).total,1);assert.equal(db.query(q({type:'redirect'})).total,1);
    assert.equal(db.query(q({protocol:'http'})).total,1);
    assert.equal(db.query(q({search:'EXAMPLE.ORG'})).total,1);
    assert.equal(db.query(q({search:"%' OR 1=1 --"})).total,0);
    assert.equal(db.query(q({start:time,end:'2026-10-19T10:30:01.123Z'})).total,1);
    assert.equal(db.query(q({page:100})).page,1);
    assert.equal(db.copy(q(),'urls').count,2);
    const copy=db.copy(q(),'visits','105');assert.equal(copy.count,1);assert.match(copy.text,/'=@test Title/);assert.match(copy.text,/2026-10-19T/);
    assert.throws(()=>db.copy(q({search:'not present'}),'urls'),/No matching/);
  }finally{db.close();assert.equal(hash(file),before);cleanup(dir);}
});
test('Firefox PRTime conversion, referrers, optional columns and schema validation',()=>{
  const dir=temp(),file=path.join(dir,'places.sqlite');fixture(file,'firefox',2).close();
  const db=new HistoryDatabase(file,'firefox');
  try{const result=db.query(q());assert.equal(result.rows.at(-1).time,time);assert.equal(result.rows[0].durationSeconds,null);assert.equal(result.rows[0].referrer,'https://example.com/login');assert.throws(()=>new HistoryDatabase(file,'edge'),/does not match/);}finally{db.close();}
  const empty=path.join(dir,'empty.sqlite');const raw=new DatabaseSync(empty);raw.exec('CREATE TABLE urls(id INTEGER,url TEXT);CREATE TABLE visits(id INTEGER,url INTEGER,visit_time INTEGER);');raw.close();
  const sparse=new HistoryDatabase(empty,'chrome');assert.equal(sparse.query(q()).total,0);sparse.close();
  const bad=path.join(dir,'bad');fs.writeFileSync(bad,'this is not SQLite');assert.throws(()=>new HistoryDatabase(bad,'auto'));
  const schema=path.join(dir,'schema');const unrelated=new DatabaseSync(schema);unrelated.exec('CREATE TABLE things(id INTEGER)');unrelated.close();assert.throws(()=>new HistoryDatabase(schema,'auto'),/Unsupported/);
  cleanup(dir);
});
test('worker imports matching WAL without changing source, failed imports retain current history',async()=>{
  const dir=temp(),file=path.join(dir,'History'),writer=fixture(file,'chrome',2,true);
  const before=[hash(file),hash(file+'-wal')],service=new BrowserHistory();
  try{
    const source=await service.import(file,'edge');assert.equal(source.browser,'Edge');assert.equal(source.visits,2);assert.equal(source.files.length,2);assert.equal(source.files[0].sha256,before[0]);assert.equal(source.files[1].sha256,before[1]);
    assert.equal((await service.query(q({sourceId:source.id}))).total,2);
    const invalid=path.join(dir,'invalid');fs.writeFileSync(invalid,'bad');await assert.rejects(service.import(invalid,'auto'),/Could not import/);
    assert.equal((await service.query(q({sourceId:source.id}))).total,2);
    await assert.rejects(async()=>service.query(q()),/Import a history/);
    assert.deepEqual([hash(file),hash(file+'-wal')],before);
    await service.clear();await assert.rejects(async()=>service.query(q({sourceId:source.id})),/Import a history/);
  }finally{await service.close();writer.close();cleanup(dir);}
});
test('copy is bounded explicitly and malformed IPC filters are rejected',()=>{
  for(const bad of [null,q({page:-1}),q({protocol:'javascript'}),q({search:1}),q({start:'invalid'}),q({start:'2026-10-20',end:'2026-10-19'})])assert.throws(()=>validateHistoryQuery(bad));
  const dir=temp(),file=path.join(dir,'History');fixture(file,'chrome',10001).close();const db=new HistoryDatabase(file,'auto');
  try{assert.throws(()=>db.copy(q(),'visits'),/10,000/);assert.equal(db.copy(q(),'urls').count,2);}finally{db.close();cleanup(dir);}
});

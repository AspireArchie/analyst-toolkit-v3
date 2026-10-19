const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
function temp() { return mkdtempSync(path.join(tmpdir(),'bec-history-test-')); }
function cleanup(directory) { const absolute=path.resolve(directory); if(path.dirname(absolute)!==path.resolve(tmpdir())||!path.basename(absolute).startsWith('bec-history-test-'))throw Error('Invalid test directory');rmSync(absolute,{recursive:true,force:true}); }
const time = '2026-10-19T10:30:00.123Z';
const chromeTime = BigInt(Date.parse(time))*1000n+11644473600000000n+456n;
function fixture(file, browser='chrome', count=105, wal=false) {
  const db = new DatabaseSync(file);
  if(wal)db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  db.exec('BEGIN');
  if(browser==='firefox'){
    db.exec('CREATE TABLE moz_places(id INTEGER PRIMARY KEY,url TEXT,title TEXT,visit_count INTEGER); CREATE TABLE moz_historyvisits(id INTEGER PRIMARY KEY,place_id INTEGER,visit_date INTEGER,visit_type INTEGER,from_visit INTEGER);');
    db.prepare('INSERT INTO moz_places VALUES(?,?,?,?)').run(1,'https://example.com/login','<img src=x onerror=alert(1)>',count);
    const statement=db.prepare('INSERT INTO moz_historyvisits VALUES(?,?,?,?,?)');
    for(let i=1;i<=count;i++)statement.run(i,1,BigInt(Date.parse(time))*1000n+BigInt(i-1)*1000000n, i===1?2:1,i-1);
  }else{
    db.exec('CREATE TABLE urls(id INTEGER PRIMARY KEY,url TEXT,title TEXT,visit_count INTEGER); CREATE TABLE visits(id INTEGER PRIMARY KEY,url INTEGER,visit_time INTEGER,transition INTEGER,from_visit INTEGER,visit_duration INTEGER);');
    db.prepare('INSERT INTO urls VALUES(?,?,?,?)').run(1,'https://example.com/login','<img src=x onerror=alert(1)>',count);
    db.prepare('INSERT INTO urls VALUES(?,?,?,?)').run(2,'http://example.org/file','=@test\nTitle',1);
    const statement=db.prepare('INSERT INTO visits VALUES(?,?,?,?,?,?)');
    for(let i=1;i<=count;i++)statement.run(i,i===count?2:1,chromeTime+BigInt(i-1)*1000000n,i===1?1:i===2?8:i===3?2147483648:0,i-1,1500000);
  }
  db.exec('COMMIT');
  return db;
}
module.exports={temp,cleanup,fixture,time,chromeTime};

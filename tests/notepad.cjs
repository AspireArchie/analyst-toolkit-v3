const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {tmpdir}=require('node:os');
const {NotepadStore}=require('../dist/notepad-store');
function setup(){const dir=fs.mkdtempSync(path.join(tmpdir(),'bec-notes-test-')),file=path.join(dir,'notepad.json');return{dir,file,clean(){const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(tmpdir()));assert.ok(path.basename(resolved).startsWith('bec-notes-test-'));fs.rmSync(resolved,{recursive:true,force:true});}};}
test('notes are memory-only until explicit save; later edits never update the saved snapshot',()=>{
  const fixture=setup();try{
    const store=new NotepadStore(fixture.file),first=store.state().notes[0];
    store.update({...first,title:'Incident',text:'saved version'});
    assert.ok(!fs.existsSync(fixture.file));assert.equal(store.state().notes[0].status,'unsaved');
    assert.equal(new NotepadStore(fixture.file).state().notes[0].text,'');
    store.save(first.id,1);const saved=fs.readFileSync(fixture.file,'utf8');assert.equal(store.state().notes[0].status,'saved');
    store.update({id:first.id,revision:1,title:'Incident edited',text:'UNSAVED VERSION'});store.add();
    assert.equal(fs.readFileSync(fixture.file,'utf8'),saved);assert.equal(store.state().notes[0].status,'modified');
    const restored=new NotepadStore(fixture.file).state();assert.equal(restored.notes.length,1);assert.equal(restored.notes[0].text,'saved version');
    assert.throws(()=>store.close(first.id,2,false),/Confirm closing/);
    store.close(first.id,2,true);store.openSaved(first.id);assert.equal(store.state().notes.at(-1).text,'saved version');
    store.forgetSaved(first.id);assert.equal(store.state().notes.at(-1).status,'unsaved');
    assert.equal(new NotepadStore(fixture.file).state().notes[0].text,'');
  }finally{fixture.clean();}
});
test('saving one tab excludes all other unsaved notes and rejects stale updates',()=>{
  const fixture=setup();try{
    const store=new NotepadStore(fixture.file),first=store.state().notes[0];store.add();const second=store.state().notes[1];
    store.update({...first,text:'one'});store.update({...second,text:'two'});store.save(first.id,1);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.file,'utf8')).notes.map(n=>n.text),['one']);
    assert.throws(()=>store.update({...first,text:'stale edit'}),/changed in another window/);
    assert.throws(()=>store.save(first.id,0),/changed in another window/);
    assert.throws(()=>store.save(first.id,undefined),/revision/);
    assert.equal(store.state().notes[0].text,'one');assert.equal(store.state().notes[1].status,'unsaved');
    store.close(first.id,1,false);assert.equal(store.state().saved.length,1);store.openSaved(first.id);assert.equal(store.state().notes.at(-1).text,'one');
  }finally{fixture.clean();}
});
test('invalid storage is preserved and failed writes leave notes unsaved',()=>{
  const fixture=setup();try{
    fs.writeFileSync(fixture.file,'broken');const store=new NotepadStore(fixture.file),note=store.state().notes[0];
    assert.equal(store.state().storageAvailable,false);store.update({...note,text:'draft'});assert.throws(()=>store.save(note.id,1),/Could not read/);assert.equal(fs.readFileSync(fixture.file,'utf8'),'broken');
    const file=path.join(fixture.dir,'cannot-write');fs.mkdirSync(file);const other=new NotepadStore(path.join(fixture.dir,'new.json'));const current=other.state().notes[0];
    fs.mkdirSync(path.join(fixture.dir,'new.json.tmp'));assert.throws(()=>other.save(current.id,0));assert.equal(other.state().notes[0].status,'unsaved');
  }finally{fixture.clean();}
});

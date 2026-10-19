const {test}=require('node:test');
const assert=require('node:assert/strict');
const transforms=import('../dist/data-transforms.mjs');
test('defang/refang handles mixed IP/URL delimiters, IPv6 and multiline input',async()=>{
  const {transformData,defang,refang}=await transforms;
  const original='5.101.157.184\nhttps://example.com:8443/file.html?q=1.2#fragment\n[2001:db8::1]';
  const fanged=defang(original);
  assert.match(fanged,/5\[\.\]101\[\.\]157\[\.\]184/);
  assert.match(fanged,/hxxps\[:\]\/\/example\[\.\]com/);
  assert.equal(refang(fanged),original);assert.equal(defang(fanged),fanged);
  assert.equal(transformData('refang','5(.)101{dot}157[.]184\nhxxps[:]//example[dot]com\n2001[colon]db8[:][:]1'),'5.101.157.184\nhttps://example.com\n2001:db8::1');
  assert.equal(refang('5 . 101 . 157 . 184\n5 dot 101 dot 157 dot 184'),'5.101.157.184\n5.101.157.184');
});
test('Base64 supports UTF-8/UTF-16LE, URL-safe/unpadded data and rejects corruption',async()=>{
  const {transformData}=await transforms;
  for(const encoding of ['utf8','utf16le']){
    const text='Get-Content "héllo 🌍"\n第二行';
    const encoded=transformData('base64-encode',text,encoding);
    assert.equal(encoded,Buffer.from(text,encoding==='utf8'?'utf8':'utf16le').toString('base64'));
    assert.equal(transformData('base64-decode',encoded,encoding),text);
  }
  assert.equal(transformData('base64-decode','aG Vs\nbG8'),'hello');
  const urlSafe=Buffer.from('hello? 🌍').toString('base64url');
  assert.equal(transformData('base64-decode',urlSafe),'hello? 🌍');
  assert.equal(transformData('base64-decode','77u/YQ=='),'\ufeffa');
  for(const invalid of ['abc$','a','a===','AA=','A==='])assert.throws(()=>transformData('base64-decode',invalid),/Invalid Base64/);
  assert.throws(()=>transformData('base64-decode','/w=='),/not valid UTF-8/);
  assert.throws(()=>transformData('base64-decode','YQ==','utf16le'),/not valid UTF-16LE/);
});
test('JSON formatting preserves evidence lexemes, duplicate keys, large numbers and escapes',async()=>{
  const {transformData}=await transforms;
  const json='{"id":900719925474099312345,"id":1e999,"items":[{},[],"x \\\" y",1.2300],"path":"C:\\\\folder"}';
  const formatted=transformData('json',json);
  assert.match(formatted,/900719925474099312345/);assert.match(formatted,/1e999/);assert.match(formatted,/1\.2300/);
  assert.equal((formatted.match(/"id"/g)||[]).length,2);assert.match(formatted,/\n  "items": \[/);
  assert.equal(formatted.replace(/\s+/g,''),json.replace(/\s+/g,''));
  assert.match(transformData('json','{"x":1}','utf8','4'),/\n    "x"/);
  assert.match(transformData('json','{"x":1}','utf8','tab'),/\n\t"x"/);
  for(const text of ['{"x":}', '{"x":1,}', 'NaN'])assert.throws(()=>transformData('json',text),/Invalid JSON/);
  assert.throws(()=>transformData('json','['.repeat(101)+'0'+']'.repeat(101)),/nesting/);
  assert.throws(()=>transformData('defang','a'.repeat(2097153)),/Input exceeds/);
});

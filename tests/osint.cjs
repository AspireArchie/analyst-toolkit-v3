const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lookup, validateIndicator } = require('../dist/osint');
test('strict IP and hash validation', () => {
  for (const ip of ['8.8.8.8', '2001:4860:4860::8888', '::ffff:192.0.2.1']) assert.equal(validateIndicator(ip).kind, 'ip');
  assert.equal(validateIndicator('A'.repeat(64)).indicator, 'a'.repeat(64));
  for (const bad of ['999.2.3.4', 'example.com', '8.8.8.8/path', 'fe80::1%eth0', 'a'.repeat(63), null]) assert.throws(() => validateIndicator(bad));
});
test('IPv6 queries use expected endpoints and isolate provider failures', async () => {
  const seen = [];
  const report = await lookup('2001:4860::8888', { virustotal: 'vt', abuseipdb: 'ab', ipdata: 'ip' }, async (url, options) => {
    seen.push({ url, options });
    if (url.includes('abuseipdb')) return new Response('', { status: 429 });
    if (url.includes('virustotal')) return Response.json({ data: { attributes: { asn: 15169 } } });
    return Response.json({ asn: { asn: 'AS15169' }, threat: { is_threat: false } });
  });
  assert.deepEqual(report.results.map(r => r.status), ['ok', 'error', 'ok']);
  assert.match(report.results[1].message, /quota/);
  assert.ok(seen.every(s => s.url.includes('2001%3A4860%3A%3A8888')));
  assert.equal(seen[0].options.headers['x-apikey'], 'vt');
  assert.equal(seen[1].options.headers.Key, 'ab');
  assert.ok(seen.every(s => s.options.redirect === 'error'));
});
test('hash lookups only call VirusTotal and preserve signature/detection fields', async () => {
  let calls = 0;
  const data = { signature_info: { verified: 'Signed', signers: 'Example' }, last_analysis_results: { Engine: { category: 'malicious' } } };
  const report = await lookup('a'.repeat(64), { virustotal: 'secret', abuseipdb: 'secret', ipdata: 'secret' }, async url => {
    calls++; assert.match(url, /\/files\//); return Response.json({ data: { attributes: data } });
  });
  assert.equal(calls, 1); assert.deepEqual(report.results[0].data, data);
  assert.deepEqual(report.results.slice(1).map(r => r.status), ['skipped', 'skipped']);
});
test('missing keys, malformed responses and network errors do not leak credentials', async () => {
  const missing = await lookup('8.8.8.8', {}, async () => { throw Error('should not call'); });
  assert.ok(missing.results.every(r => r.status === 'skipped'));
  const report = await lookup('8.8.8.8', { ipdata: 'TOPSECRET', virustotal: 'TOPSECRET' }, async url => {
    if (url.includes('ipdata')) throw Error(url);
    return Response.json({ bad: true });
  });
  assert.equal(report.results[0].status, 'error'); assert.equal(report.results[2].status, 'error');
  assert.ok(!JSON.stringify(report).includes('TOPSECRET'));
});

test('normalizes mixed defanged IPv4 and IPv6 without extracting surrounding text', () => {
  for (const value of [
    '5.101.157[.]184', '5[.]101[.]157[.]184', '5(.)101{.}157[dot]184',
    '5[DOT]101(dot)157{dot}184', '5 dot 101 dot 157 dot 184', '5 . 101 . 157 . 184',
    '5\\.101\\.157\\.184', '5\uff0e101\u3002157\uff61184', '5\u200b[.]101[.]157[.]184',
    '"5[.]101[.]157[.]184"', '[5.101.157.184]',
  ]) assert.deepEqual(validateIndicator(value), { indicator: '5.101.157.184', kind: 'ip' });
  for (const value of ['[2001:db8::1]', '2001[:]db8[:][:]1', '2001(colon)db8{colon}{colon}1']) {
    assert.deepEqual(validateIndicator(value), { indicator: '2001:db8::1', kind: 'ip' });
  }
  for (const value of ['5[.]101[.]157[.]999', 'IP: 5[.]101[.]157[.]184', '5[.]101[.]157[.]184.evil.com', '5 1.101.157.184', '8.8.8.8\n1.1.1.1']) assert.throws(() => validateIndicator(value));
});
test('defanged input is normalized for provider queries', async () => {
  let called = false;
  const report = await lookup('5[.]101.157[.]184', { abuseipdb: 'key' }, async url => {
    called = true; assert.match(url, /ipAddress=5\.101\.157\.184&/);
    return Response.json({ data: { totalReports: 0, abuseConfidenceScore: 0 } });
  });
  assert.ok(called); assert.equal(report.indicator, '5.101.157.184');
});

test('MD5, SHA-1 and SHA-256 route exclusively to VirusTotal and retain file details', async () => {
  for (const [length, kind] of [[32, 'md5'], [40, 'sha1'], [64, 'sha256']]) {
    const hash = 'AB'.repeat(length / 2);
    assert.deepEqual(validateIndicator(hash), { indicator: hash.toLowerCase(), kind });
    let calls = 0;
    const details = { signature_info: { verified: 'Signed', signers: 'Publisher' }, last_analysis_stats: { malicious: 0 }, md5: 'a'.repeat(32), sha1: 'a'.repeat(40), sha256: 'a'.repeat(64) };
    const report = await lookup(hash, { virustotal: 'vt', abuseipdb: 'ab', ipdata: 'ip' }, async url => {
      calls++; assert.equal(url, `https://www.virustotal.com/api/v3/files/${hash.toLowerCase()}`);
      return Response.json({ data: { attributes: details } });
    });
    assert.equal(calls, 1); assert.equal(report.kind, kind); assert.deepEqual(report.results[0].data, details);
    assert.ok(report.results.slice(1).every(r => r.status === 'skipped'));
  }
  for (const value of ['g'.repeat(32), 'a'.repeat(31), 'a'.repeat(41), 'a'.repeat(128)]) assert.throws(() => validateIndicator(value));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { installNetguard, netguardSelfTest } from '../src/netguard.js';

test('self-test: every route out is refused and recorded, none reaches the network', async () => {
  const r = await netguardSelfTest();
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.blocked, 6);
  assert.match(r.detail, /fetch: blocked.*socket: blocked.*socket-ip: blocked.*dns: blocked.*dns-resolve: blocked.*udp: blocked/);
  installNetguard().restore();
});

test('a real outbound attempt is blocked and appears in attempts', async () => {
  const g = installNetguard();
  // The timeout makes a loosened fetch guard fail fast (TimeoutError) instead of hanging on a real lookup.
  await assert.rejects(fetch('https://example.invalid/', { signal: AbortSignal.timeout(1500) }), /network blocked/);
  await assert.rejects(new Promise((res, rej) => { const q = http.get('http://other.invalid/', res); q.on('error', rej); }), /network blocked|ENOTFOUND|blocked/);
  assert.ok(g.attempts.some((a) => a === 'fetch:example.invalid'));
  assert.ok(g.attempts.some((a) => a.includes('other.invalid')));
  g.restore();
});

test('loopback still works under the guard', async () => {
  const g = installNetguard();
  const server = http.createServer((_q, s) => s.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(3000) });
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(g.attempts, []);
  } finally { await new Promise((r) => server.close(r)); g.restore(); } // always close: a failed assertion must not leave a listener that hangs the run
});

test('restore puts the real functions back', async () => {
  const before = net.Socket.prototype.connect;
  const g = installNetguard();
  assert.notEqual(net.Socket.prototype.connect, before);
  g.restore();
  assert.equal(net.Socket.prototype.connect, before);
});

test('raw IP-literal sockets are refused and recorded as socket:<ip>', async () => {
  const g = installNetguard();
  assert.throws(() => net.connect({ host: '192.0.2.1', port: 80 }), /network blocked: 192\.0\.2\.1/);
  assert.throws(() => net.connect(80, '192.0.2.2'), /network blocked: 192\.0\.2\.2/);
  assert.throws(() => http.get({ host: '192.0.2.3', port: 80 }), /network blocked: 192\.0\.2\.3/);
  assert.deepEqual(g.attempts.filter((a) => a.startsWith('socket:')), ['socket:192.0.2.1', 'socket:192.0.2.2', 'socket:192.0.2.3']);
  g.restore();
});

test('a wildcard bind (container HMLAB_BIND=0.0.0.0) can listen, but connecting to it is still refused', async () => {
  const g = installNetguard();
  const srv = net.createServer((c) => c.end());
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '0.0.0.0', res); });
  try {
    const { port } = srv.address();
    assert.deepEqual(g.attempts, [], 'listening is not an outbound attempt');
    await assert.rejects(new Promise((res, rej) => { try { const s = net.connect({ host: '0.0.0.0', port }); s.on('error', rej); s.on('connect', () => { s.destroy(); res(); }); } catch (e) { rej(e); } }), /network blocked/);
    assert.ok(g.attempts.includes('socket:0.0.0.0'));
  } finally { await new Promise((r) => srv.close(r)); g.restore(); }
});

test('dns.resolve*, dns.promises.* and Resolver are refused and recorded; loopback names pass the check', async () => {
  const g = installNetguard();
  await assert.rejects(dns.promises.resolve4('probe.invalid'), /network blocked/);
  await assert.rejects(dns.promises.lookup('probe2.invalid'), /network blocked/);
  await assert.rejects(new dns.promises.Resolver().resolve4('probe3.invalid'), /network blocked/);
  await new Promise((res) => dns.resolve4('probe4.invalid', (e) => { assert.match(e.message, /network blocked/); res(); }));
  for (const h of ['probe', 'probe2', 'probe3', 'probe4']) assert.ok(g.attempts.includes(`dns:${h === 'probe' ? 'probe' : h}.invalid`), h);
  g.restore();
});

test('udp: the address is found by position, so a message body cannot masquerade as it', () => {
  const g = installNetguard();
  const s = dgram.createSocket('udp4');
  try {
    assert.throws(() => s.send('127.0.0.1', 9, 'evil.invalid'), /network blocked: evil\.invalid/);
    assert.throws(() => s.send(Buffer.from('x'), 0, 1, 9, 'evil2.invalid'), /network blocked: evil2\.invalid/);
    assert.throws(() => s.send('x', 9, 'evil3.invalid', () => {}), /network blocked: evil3\.invalid/);
    assert.deepEqual(g.attempts.filter((a) => a.startsWith('udp:')), ['udp:evil.invalid', 'udp:evil2.invalid', 'udp:evil3.invalid']);
    s.send('plain message', 9, '127.0.0.1', () => {}); // a string body is fine for loopback
  } finally { s.close(); g.restore(); }
});

import { allowHost, clearAllowedHosts, allowedHostList, isPrivateAddress } from '../src/netguard.js';

test('Real allowlist: empty by default, allows exactly one name (lookup, not other names), clears, and a redirect is never followed', async () => {
  const g = installNetguard();
  assert.deepEqual(allowedHostList(), []);
  // not allowed yet: refused and recorded
  await assert.rejects(fetch('https://gw.invalid/mcp', { signal: AbortSignal.timeout(1500) }), /network blocked/);
  assert.ok(g.attempts.includes('fetch:gw.invalid'));
  allowHost('GW.invalid');
  assert.deepEqual(allowedHostList(), ['gw.invalid']);
  const before = g.attempts.length;
  // the allowed name passes the guard (it then fails in the real resolver: .invalid never resolves), and is NOT recorded as an attempt
  await assert.rejects(fetch('https://gw.invalid/mcp', { signal: AbortSignal.timeout(3000) }), (e) => !/network blocked/.test(e.message));
  assert.equal(g.attempts.length, before, 'the allowed name is not an attempt');
  // plain http to the allowed name, another name, a sibling subdomain and an IP are all still refused
  for (const u of ['http://gw.invalid/mcp', 'https://other.invalid/mcp', 'https://evil.gw.invalid/mcp', 'https://192.0.2.1/mcp']) {
    await assert.rejects(fetch(u, { signal: AbortSignal.timeout(1500) }), /network blocked/, u);
  }
  assert.ok(g.attempts.some((a) => a === 'fetch:other.invalid') && g.attempts.some((a) => a === 'fetch:evil.gw.invalid'));
  await assert.rejects(new Promise((_, rej) => { const s = net.connect({ host: '192.0.2.1', port: 443 }); s.on('error', rej); }), /network blocked/);
  await assert.rejects(new Promise((res, rej) => dns.lookup('other.invalid', (e) => (e ? rej(e) : res()))), /network blocked/);
  clearAllowedHosts();
  assert.deepEqual(allowedHostList(), []);
  await assert.rejects(fetch('https://gw.invalid/mcp', { signal: AbortSignal.timeout(1500) }), /network blocked/, 'cleared again');
  g.restore();
});

test('Real allowlist: restore() clears it, and allowHost does nothing when the guard is not installed', () => {
  assert.equal(allowHost('x.invalid'), false);
  const g = installNetguard();
  assert.equal(allowHost('x.invalid'), true);
  g.restore();
  assert.deepEqual(allowedHostList(), []);
});

test('isPrivateAddress: private, loopback, link-local (metadata), CGNAT, ULA, mapped and junk are refused; public ones are not', () => {
  for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '[::1]', 'not-an-address']) assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['93.184.216.34', '192.0.2.10', '172.32.0.1', '100.63.0.1', '2001:db8::1', '::ffff:93.184.216.34']) assert.equal(isPrivateAddress(a), false, a);
});

test('Real allowlist (resolver, socket and fetch stubbed UNDER the guard, so no packet leaves): public addresses are learned for that name only, private ones are refused, clear forgets, redirects are overridden', async () => {
  const saved = { lookup: dns.lookup, connect: net.Socket.prototype.connect, fetch: globalThis.fetch };
  const table = { 'gw.invalid': '192.0.2.10', 'rebind.invalid': '169.254.169.254', 'lan.invalid': '10.0.0.5' };
  dns.lookup = (host, ...rest) => { rest.find((r) => typeof r === 'function')(null, table[host], 4); };
  const connects = [];
  net.Socket.prototype.connect = function stubConnect(...a) { connects.push(a); return this; };
  const fetches = [];
  globalThis.fetch = async (u, init) => { fetches.push({ u: String(u), init }); return new Response('{}'); };
  const g = installNetguard();
  const look = (h) => new Promise((res, rej) => dns.lookup(h, (e, a) => (e ? rej(e) : res(a))));
  try {
    allowHost('gw.invalid'); allowHost('[2001:db8::1]'); allowHost('rebind.invalid');
    assert.deepEqual(allowedHostList().sort(), ['2001:db8::1', 'gw.invalid', 'rebind.invalid'], 'IPv6 brackets are stripped');
    assert.equal(await look('gw.invalid'), '192.0.2.10');
    net.connect({ host: '192.0.2.10', port: 443 });
    assert.equal(connects.length, 1, 'the address the allowed name resolved to is reachable');
    assert.throws(() => net.connect({ host: '192.0.2.99', port: 443 }), /network blocked/, 'any other address is not');
    // DNS rebinding: the allowed name answers with the metadata address
    await assert.rejects(look('rebind.invalid'), /private address/);
    assert.ok(g.attempts.includes('private:rebind.invalid'));
    assert.throws(() => net.connect({ host: '169.254.169.254', port: 80 }), /network blocked/, 'a refused private answer is never learned');
    // fetch to the allowed name is made with redirects forced to error, whatever the caller asked
    await fetch('https://gw.invalid/mcp', { redirect: 'follow' });
    assert.equal(fetches.at(-1).init.redirect, 'error');
    // clear forgets the learned address
    clearAllowedHosts();
    assert.throws(() => net.connect({ host: '192.0.2.10', port: 443 }), /network blocked/, 'cleared: the learned address is forgotten');
    // the owner's explicit opt-in for a private network
    allowHost('lan.invalid', { privateOk: true });
    assert.equal(await look('lan.invalid'), '10.0.0.5');
    clearAllowedHosts();
    await assert.rejects(look('lan.invalid'), /network blocked/);
  } finally { g.restore(); dns.lookup = saved.lookup; net.Socket.prototype.connect = saved.connect; globalThis.fetch = saved.fetch; }
});

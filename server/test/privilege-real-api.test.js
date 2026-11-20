import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { withServer } from './helpers.js';
import { installNetguard, allowedHostList } from '../src/netguard.js';

const KEY = 'agent-key-SECRET-api-0123456789';
const HELD = { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'action requires human approval', data: { instruction_id: 'ins_api1', policy_ids: ['p:1'], reason: 'r', retry_header: 'X-Procyon-Approval-Id', status: 'pending_approval' } } };

async function door() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}; calls.push({ method: body.method, approval: req.headers['x-procyon-approval-id'] || null });
      const j = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return j(401, { error: 'no' });
      if (body.method === 'initialize') return j(200, { jsonrpc: '2.0', id: 0, result: {} });
      if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      return req.headers['x-procyon-approval-id'] === 'ins_api1' ? j(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'done' }] } }) : j(403, HELD);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const realEnv = (port, extra = {}) => ({ STANDALONE_ENV: '/nonexistent/settings.env', HMLAB_REAL_URL: `http://127.0.0.1:${port}/door/mcp`, HMLAB_REAL_AGENT_KEY: KEY, HMLAB_REAL_TOOL: 'IndexMappingTool', ...extra });
const J = (url, body, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json', origin: new URL(url).origin }, body: JSON.stringify(body) });

test('unconfigured: Real cannot be chosen (409), the real call is refused, and nothing says Real is on', async () => {
  await withServer(async (url) => {
    assert.equal((await J(`${url}/api/mode`, { source: 'real' })).status, 409);
    const r = await J(`${url}/api/privilege/real/call`, {});
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'not_real_mode');
    assert.equal((await (await fetch(`${url}/api/info`)).json()).source, 'mock');
    const cfg = await (await fetch(`${url}/api/privilege/real`)).json();
    assert.equal(cfg.ok, false);
  });
});

test('configured: starts in Real, holds then executes through the API, the toggle switches both ways, and the key is in no answer', async () => {
  const d = await door();
  try {
    await withServer(async (url) => {
      const bodies = [];
      const grab = async (r) => { const t = await r.text(); bodies.push(t); return JSON.parse(t); };
      const info = await grab(await fetch(`${url}/api/info`));
      assert.equal(info.source, 'real'); assert.equal(info.realAvailable, true);
      const held = await grab(await J(`${url}/api/privilege/real/call`, {}));
      assert.equal(held.outcome, 'held'); assert.equal(held.held.instruction_id, 'ins_api1');
      const done = await grab(await J(`${url}/api/privilege/real/call`, { approvalId: 'ins_api1' }));
      assert.equal(done.outcome, 'executed');
      assert.equal(d.calls.at(-1).approval, 'ins_api1');
      // toggle to Mock: the real call is refused again; back to Real: it works
      assert.equal((await J(`${url}/api/mode`, { source: 'mock' })).status, 200);
      assert.equal((await (await fetch(`${url}/api/info`)).json()).source, 'mock');
      const before = d.calls.length;
      assert.equal((await J(`${url}/api/privilege/real/call`, {})).status, 409);
      assert.equal(d.calls.length, before, 'Mock sends nothing to the gateway');
      assert.equal((await J(`${url}/api/mode`, { source: 'real' })).status, 200);
      assert.equal((await grab(await J(`${url}/api/privilege/real/call`, {}))).outcome, 'held');
      bodies.push(await (await fetch(`${url}/api/privilege/real`)).text());
      for (const b of bodies) assert.ok(!b.includes(KEY), 'the agent key is in no response');
      // hostile input
      assert.equal((await J(`${url}/api/privilege/real/call`, { approvalId: 'a b' })).status, 400);
      assert.equal((await J(`${url}/api/privilege/real/call`, [1])).status, 400);
    }, { env: realEnv(d.port) });
  } finally { await d.close(); }
});

test('a wrong key is shown as refused (not hidden), and an unreachable gateway is a 502 JSON error with a failure trace', async () => {
  const d = await door();
  try {
    await withServer(async (url) => {
      const r = await (await J(`${url}/api/privilege/real/call`, {})).json();
      assert.equal(r.outcome, 'refused'); assert.equal(r.http, 401);
    }, { env: realEnv(d.port, { HMLAB_REAL_AGENT_KEY: 'a-different-key' }) });
  } finally { await d.close(); }
  await withServer(async (url) => {
    const r = await J(`${url}/api/privilege/real/call`, {});
    assert.equal(r.status, 502);
    assert.match(r.headers.get('content-type'), /json/);
    const j = await r.json();
    assert.equal(j.error, 'upstream_unreachable'); assert.equal(j.trace.response, null);
  }, { env: realEnv(1) });
});

test('the netguard allowlist follows the toggle: the one configured host while Real is on, empty in Mock, never at start in Mock', async () => {
  const g = installNetguard();
  try {
    const env = { STANDALONE_ENV: '/nonexistent/settings.env', HMLAB_REAL_URL: 'https://gw.invalid/door/mcp', HMLAB_REAL_AGENT_KEY: KEY, HMLAB_REAL_TOOL: 'T' };
    await withServer(async (url) => {
      assert.deepEqual(allowedHostList(), ['gw.invalid'], 'configured: Real is the default, so the one host is open');
      await J(`${url}/api/mode`, { source: 'mock' });
      assert.deepEqual(allowedHostList(), []);
      await J(`${url}/api/mode`, { source: 'real' });
      assert.deepEqual(allowedHostList(), ['gw.invalid']);
    }, { env });
    await withServer(async () => { assert.deepEqual(allowedHostList(), [], 'an unconfigured lab opens nothing'); }, { env: { STANDALONE_ENV: '/nonexistent/settings.env' } });
    await withServer(async () => { assert.deepEqual(allowedHostList(), [], 'MODE=mock keeps it closed even when Real is configured'); }, { env: { ...env, MODE: 'mock' } });
  } finally { g.restore(); }
});

test('the lab no longer fires its own PingID push: the old direct-push routes are gone, so the push only ever comes from Privilege', async () => {
  const d = await door();
  try {
    await withServer(async (url) => {
      assert.equal((await fetch(`${url}/api/privilege/real/pingid`)).status, 404);
      assert.equal((await J(`${url}/api/privilege/real/pingid/push`, {})).status, 404);
      assert.equal((await J(`${url}/api/privilege/real/pingid/poll`, { daId: 'x' })).status, 404);
    }, { env: realEnv(d.port) });
  } finally { await d.close(); }
});

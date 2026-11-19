import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createPrivilegeReal, classify, RealError, REAL_LIMITS, scrubDeep } from '../src/privilegeReal.js';
import { assertTrace } from '../src/gatewayTrace.js';

const KEY = 'agent-key-SECRET-0123456789';
const HELD = { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'action requires human approval', data: { expires_at: '2026-11-19T00:02:00Z', instruction_id: 'ins_abc123', policy_ids: ['p:1'], reason: 'Above Demo HITL', retry_header: 'X-Procyon-Approval-Id', status: 'pending_approval' } } };

// A stub MCP door on loopback. `mode` picks what tools/call answers; every request is recorded.
async function stub(mode, { approved = 'ins_abc123' } = {}) {
  const seen = []; let redirectHits = 0;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/elsewhere') { redirectHits += 1; res.end('you should not be here'); return; }
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ headers: req.headers, body });
      const json = (status, obj, h = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: 'bad key' });
      if (body.method === 'initialize') return json(200, { jsonrpc: '2.0', id: 0, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'sess-1' });
      if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      const presented = req.headers['x-procyon-approval-id'];
      switch (mode) {
        case 'held403': return presented === approved ? json(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'index mapping: {...}' }] } }) : json(403, HELD);
        case 'held200': return json(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'pending_approval: instruction ins_text9 waits for a human' }] } });
        case 'sse': res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'sse ok' }] } })}\n\n`);
        case 'echo': return json(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `your key was ${KEY}` }] } });
        case 'rpcerror': return json(200, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'tool exploded' } });
        case 'redirect': res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/elsewhere` }); return res.end();
        case 'big': res.writeHead(200, { 'content-type': 'application/json' }); return res.end(`{"result":{"content":[{"type":"text","text":"${'x'.repeat(REAL_LIMITS.body * 2)}"}]}}`);
        case 'slow': return undefined; // never answers
        default: return json(500, { error: 'boom' });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { seen, port, redirectHits: () => redirectHits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
const envFor = (port, extra = {}) => ({ HMLAB_REAL_URL: `http://127.0.0.1:${port}/door/mcp`, HMLAB_REAL_AGENT_KEY: KEY, HMLAB_REAL_TOOL: 'IndexMappingTool', HMLAB_REAL_ARGS: '{"index":"*"}', ...extra });
const withStub = async (mode, fn, opts) => { const s = await stub(mode, opts); try { await fn(s, createPrivilegeReal({ env: envFor(s.port) })); } finally { await s.close(); } };
const noKey = (v) => assert.ok(!JSON.stringify(v).includes(KEY), 'the agent key must not appear anywhere');

test('held (observed): handshake, then tools/call; the 403 pending_approval is read with its instruction id and retry header', async () => {
  await withStub('held403', async (s, real) => {
    const r = await real.call();
    assert.equal(r.outcome, 'held'); assert.equal(r.basis, 'observed'); assert.equal(r.http, 403);
    assert.equal(r.held.instruction_id, 'ins_abc123'); assert.equal(r.held.retry_header, 'X-Procyon-Approval-Id'); assert.deepEqual(r.held.policy_ids, ['p:1']);
    assert.deepEqual(s.seen.map((x) => x.body.method), ['initialize', 'notifications/initialized', 'tools/call']);
    const call = s.seen[2];
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.headers['mcp-session-id'], 'sess-1');
    assert.match(call.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.equal(call.headers['x-procyon-approval-id'], undefined, 'the first call carries no approval id');
    assert.deepEqual(call.body.params, { name: 'IndexMappingTool', arguments: { index: '*' } });
    assert.deepEqual(assertTrace(r.trace), []);
    assert.equal(r.trace.source, 'real');
    assert.deepEqual(r.trace.setup.map((x) => x.label), ['initialize', 'notifications/initialized']);
    noKey(r);
  });
});

test('the retry carries the approval id in X-Procyon-Approval-Id and executes', async () => {
  await withStub('held403', async (s, real) => {
    await real.call();
    const r = await real.call({ approvalId: 'ins_abc123' });
    assert.equal(r.outcome, 'executed'); assert.equal(r.http, 200); assert.equal(r.approvalPresented, 'ins_abc123');
    assert.match(r.summary, /index mapping/);
    assert.equal(s.seen.at(-1).headers['x-procyon-approval-id'], 'ins_abc123');
    assert.equal(r.trace.request.headers['X-Procyon-Approval-Id'], 'ins_abc123');
    assert.deepEqual(assertTrace(r.trace), []);
    // a wrong id is held again, never executes
    assert.equal((await real.call({ approvalId: 'ins_wrong' })).outcome, 'held');
    noKey(r);
  });
});

test('held (inferred): a 200 whose text says pending_approval is labelled inferred, with the id read from the text', async () => {
  await withStub('held200', async (_s, real) => {
    const r = await real.call();
    assert.equal(r.outcome, 'held'); assert.equal(r.basis, 'inferred'); assert.equal(r.held.instruction_id, 'ins_text9');
  });
});

test('text/event-stream answers are parsed; the agent key a gateway echoes back is scrubbed everywhere', async () => {
  await withStub('sse', async (_s, real) => { const r = await real.call(); assert.equal(r.outcome, 'executed'); assert.equal(r.summary, 'sse ok'); });
  await withStub('echo', async (_s, real) => { const r = await real.call(); assert.equal(r.outcome, 'executed'); assert.match(r.summary, /<agent key>/); noKey(r); });
});

test('a wrong key is refused (401, shown as observed) and the trace says so without the key', async () => {
  const s = await stub('held403');
  try {
    const r = await createPrivilegeReal({ env: envFor(s.port, { HMLAB_REAL_AGENT_KEY: 'wrong-key-value' }) }).call();
    assert.equal(r.outcome, 'refused'); assert.equal(r.http, 401);
    assert.ok(!JSON.stringify(r).includes('wrong-key-value'));
    assert.deepEqual(assertTrace(r.trace), []);
  } finally { await s.close(); }
});

test('a JSON-RPC error is refused; a redirect is NOT followed; an oversized body is bounded', async () => {
  await withStub('rpcerror', async (_s, real) => { const r = await real.call(); assert.equal(r.outcome, 'refused'); assert.match(r.message, /tool exploded/); });
  await withStub('redirect', async (s, real) => { const r = await real.call(); assert.equal(r.outcome, 'refused'); assert.match(r.message, /redirect/); assert.equal(s.redirectHits(), 0, 'the redirect target was never contacted'); });
  await withStub('big', async (_s, real) => { const r = await real.call(); assert.equal(r.truncated, true); assert.ok(JSON.stringify(r).length < REAL_LIMITS.body * 2); });
});

test('unreachable and slow gateways become a structured error with a failure trace, never the key', async () => {
  const s = await stub('held403'); const port = s.port; await s.close();
  const err = await createPrivilegeReal({ env: envFor(port) }).call().then(() => null, (e) => e);
  assert.ok(err instanceof RealError); assert.equal(err.code, 'upstream_unreachable'); assert.equal(err.status, 502);
  assert.equal(err.trace.response, null); noKey(err.trace); assert.ok(!err.message.includes(KEY));
});

test('input is validated: not configured is 409, a hostile approval id is 400, and only one call runs at a time', async () => {
  await assert.rejects(createPrivilegeReal({ env: {} }).call(), (e) => e.code === 'real_not_configured' && e.status === 409);
  await withStub('slow', async (_s, real) => {
    for (const bad of ['', 'a b', 'x'.repeat(65), '../../etc', 'ins\r\nX-Evil: 1', 7, {}]) await assert.rejects(real.call({ approvalId: bad }), (e) => e.code === 'bad_approval_id', JSON.stringify(bad));
  });
  const fastFail = { fetch: () => new Promise((r) => setTimeout(() => r(new Response('{}', { status: 200 })), 80)) };
  const real = createPrivilegeReal({ env: envFor(1), fetchImpl: fastFail.fetch });
  const first = real.call();
  await assert.rejects(real.call(), (e) => e.code === 'busy' && e.status === 429);
  await first;
});

test('classify and scrubDeep on their own', () => {
  assert.equal(classify(403, HELD).outcome, 'held');
  assert.equal(classify(403, { error: { message: 'no' } }).outcome, 'refused');
  assert.equal(classify(200, { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'bad' }] } }).outcome, 'refused');
  assert.equal(classify(500, null).outcome, 'unknown');
  assert.deepEqual(scrubDeep({ a: ['x KEY y', { b: 'KEY' }], c: 1 }, 'KEY'), { a: ['x <agent key> y', { b: '<agent key>' }], c: 1 });
  assert.deepEqual(scrubDeep({ KEY: 1 }, 'KEY'), { '<agent key>': 1 }, 'object keys too');
  assert.equal(scrubDeep('KEY', ''), 'KEY');
});

test('configView never carries the key, and shows only the origin and path', () => {
  const v = createPrivilegeReal({ env: envFor(9, { HMLAB_REAL_URL: 'http://127.0.0.1:9/door/mcp?token=q' }) }).configView();
  assert.deepEqual(v, { ok: true, host: '127.0.0.1', origin: 'http://127.0.0.1:9', tool: 'IndexMappingTool', url: 'http://127.0.0.1:9/door/mcp' });
  noKey(v);
});

test('a gateway that never answers times out with a structured error', async () => {
  const was = REAL_LIMITS.timeoutMs; REAL_LIMITS.timeoutMs = 300;
  try {
    await withStub('slow', async (_s, real) => {
      const err = await real.call().then(() => null, (e) => e);
      assert.equal(err.code, 'upstream_unreachable'); assert.match(err.message, /no answer in time/);
    });
  } finally { REAL_LIMITS.timeoutMs = was; }
});

// ---- review fixes: what counts as "ran", and every form of the key -----------------------------------------------------------------

test('a 200 that is not a complete JSON-RPC answer to our call is UNKNOWN, never "executed"', () => {
  for (const [label, status, body, opts] of [
    ['html login page', 200, '<html>please sign in</html>'], ['empty body', 200, ''], ['empty object', 200, {}],
    ['wrong id', 200, { jsonrpc: '2.0', id: 99, result: { content: [] } }], ['no result', 200, { jsonrpc: '2.0', id: 1 }],
    ['cut-off body', 200, { jsonrpc: '2.0', id: 1, result: { content: [] } }, { truncated: true }], ['array', 200, [1]], ['null', 200, null],
  ]) {
    const v = classify(status, body, opts);
    assert.equal(v.outcome, 'unknown', label);
    assert.match(v.message, /cannot say|not a JSON-RPC|too large/, label);
  }
  assert.equal(classify(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }).outcome, 'executed');
});

for (const [name, mode] of [['html', 'html'], ['empty', 'empty']]) {
  test(`end to end: a gateway answering ${name} with 200 is shown as unknown`, async () => {
    const server = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const m = raw ? JSON.parse(raw).method : '';
      if (m === 'initialize') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"jsonrpc":"2.0","id":0,"result":{}}'); }
      if (m === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      res.writeHead(200, { 'content-type': mode === 'html' ? 'text/html' : 'application/json' }); res.end(mode === 'html' ? '<html>login</html>' : '');
    }); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await createPrivilegeReal({ env: envFor(server.address().port) }).call();
      assert.equal(r.outcome, 'unknown'); assert.equal(r.http, 200);
    } finally { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); }
  });
}

test('the key is scrubbed in every form: as an object key, URL-encoded, base64, base64url; and a leftover is withheld, never sent', async () => {
  const forms = [KEY, encodeURIComponent(KEY), Buffer.from(KEY).toString('base64'), Buffer.from(KEY).toString('base64url')];
  const server = http.createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const m = raw ? JSON.parse(raw).method : '';
    if (m === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (m === 'initialize') return res.end('{"jsonrpc":"2.0","id":0,"result":{}}');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: forms.join(' | ') }], [KEY]: 'as a key' } }));
  }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await createPrivilegeReal({ env: envFor(server.address().port) }).call();
    assert.equal(r.outcome, 'executed');
    for (const f of forms) assert.ok(!JSON.stringify(r).includes(f), `form not scrubbed: ${f.slice(0, 10)}...`);
  } finally { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); }
});

test('the whole call has a deadline, and the busy flag cannot get stuck after any failure', async () => {
  const was = { ...REAL_LIMITS }; REAL_LIMITS.timeoutMs = 5000; REAL_LIMITS.totalMs = 400;
  try {
    await withStub('slow', async (_s, real) => {
      const t0 = Date.now();
      const err = await real.call().then(() => null, (e) => e);
      assert.equal(err.code, 'upstream_unreachable'); assert.ok(Date.now() - t0 < 2500, 'the overall deadline, not the 5 s per-request one, ended it');
      const again = await real.call().then(() => null, (e) => e); // not 429 busy: the flag reset
      assert.equal(again.code, 'upstream_unreachable');
    });
  } finally { Object.assign(REAL_LIMITS, was); }
});

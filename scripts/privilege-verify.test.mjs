import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/privilege-verify.mjs');
const KEY = 'fixture-value-not-a-real-credential';
const HELD = { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'action requires human approval', data: { instruction_id: 'ins_9f2c41ab', policy_ids: ['hitl:1'], reason: 'Above Demo HITL', retry_header: 'X-Procyon-Approval-Id', status: 'pending_approval', expires_at: '2026-11-19T00:02:00Z' } } };
const RAN = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } };

// A stub door. mode: 'held403' | 'held200' | 'open'. accepts: the approval id the retry must carry to run.
async function stub({ mode = 'held403', accepts = 'ins_9f2c41ab' } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      hits.push(body.method);
      const j = (st, o) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (body.method === 'initialize') return j(200, { jsonrpc: '2.0', id: 0, result: {} });
      if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      if (mode === 'open') return j(200, RAN);
      if (req.headers['x-procyon-approval-id'] === accepts) return j(200, RAN);
      return mode === 'held200' ? j(200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'pending_approval: instruction ins_9f2c41ab waits for a human' }] } }) : j(403, HELD);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, hits, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// Run the script as a child process with `answers` piped to it one line at a time.
function run(port, answers, flags = ['--yes'], envExtra = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HMLAB_REAL_URL: `http://127.0.0.1:${port}/door/mcp`, HMLAB_REAL_AGENT_KEY: KEY, HMLAB_REAL_TOOL: 'IndexMappingTool', ...envExtra };
    const child = spawn(process.execPath, [SCRIPT, ...flags], { cwd: ROOT, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    for (const a of answers) child.stdin.write(`${a}\n`);
    child.stdin.end();
  });
}

test('403 held, then the INSTRUCTION id runs: reports the 403 shape as observed and the approval id as the instruction id', async () => {
  const s = await stub();
  try {
    const r = await run(s.port, ['']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /answer shape : HTTP 403 with a JSON-RPC error \(pending_approval\): OBSERVED/);
    assert.match(r.out, /instruction id: ins_9f2c41ab/);
    assert.match(r.out, /approval id is     : the instruction id/);
    assert.match(r.out, /retry header       : X-Procyon-Approval-Id/);
    assert.ok(!r.out.includes(KEY), 'the key is never printed');
    assert.match(r.out, /instruction id     : ins_x+  \(shape only\)/, 'the paste-back masks the id');
    assert.match(r.out, /the tool RAN with approval id ins_9f2c41ab/, 'the retry line says the retry ran, not that no policy held it');
  } finally { await s.close(); }
});

test('a 200 whose text says pending_approval is reported as INFERRED, not as the 403 shape', async () => {
  const s = await stub({ mode: 'held200' });
  try {
    const r = await run(s.port, ['']);
    assert.match(r.out, /HTTP 200 whose text says pending_approval: INFERRED from the words/);
    assert.match(r.out, /held call answer   : HTTP 200 whose text/);
    assert.ok(!/OBSERVED/.test(r.out));
  } finally { await s.close(); }
});

test('the instruction id does NOT run but the console id does: reports the console id, not the instruction id', async () => {
  const s = await stub({ accepts: 'CONSOLE-77' });
  try {
    const r = await run(s.port, ['', 'CONSOLE-77']);
    assert.match(r.out, /retrying with the INSTRUCTION id/);
    assert.match(r.out, /retrying with the CONSOLE id \(CONSOLE-77\)/);
    assert.match(r.out, /approval id is     : the console id, NOT the instruction id/);
  } finally { await s.close(); }
});

test('neither id runs (not approved in time): says so instead of guessing', async () => {
  const s = await stub({ accepts: 'something-else' });
  try {
    const r = await run(s.port, ['', 'CONSOLE-1']);
    assert.match(r.out, /approval id is     : neither id worked/);
  } finally { await s.close(); }
});

test('a call that is not held says the policy did not match and asks for no approval', async () => {
  const s = await stub({ mode: 'open' });
  try {
    const r = await run(s.port, []);
    assert.match(r.out, /the tool RAN \(no human-approval policy held this call\)/);
    assert.match(r.out, /nothing to approve/);
    assert.match(r.out, /approval id is     : unknown/);
  } finally { await s.close(); }
});

test('without --yes it asks first: answering no sends nothing at all', async () => {
  const s = await stub();
  try {
    const r = await run(s.port, ['n'], []);
    assert.match(r.out, /Send it\? \[y\/N\]/);
    assert.match(r.out, /Nothing was sent/);
    assert.equal(s.hits.length, 0, 'no request reached the gateway');
  } finally { await s.close(); }
});

test('"skip" at the approval step stops before any retry; an unconfigured lab refuses with the exact settings to set', async () => {
  const s = await stub();
  try {
    const r = await run(s.port, ['skip']);
    assert.match(r.out, /Stopped before the retry/);
    assert.equal(s.hits.filter((m) => m === 'tools/call').length, 1, 'only the one held call was sent');
  } finally { await s.close(); }
  const none = await run(1, [], ['--yes'], { HMLAB_REAL_URL: '', HMLAB_REAL_AGENT_KEY: '', HMLAB_REAL_TOOL: '' });
  assert.equal(none.code, 2);
  assert.match(none.out, /HMLAB_REAL_URL/);
});

test('an unreachable gateway is a plain message and a non-zero exit, never the key', async () => {
  const s = await stub(); const port = s.port; await s.close();
  const r = await run(port, []);
  assert.equal(r.code, 1);
  assert.match(r.out, /could not complete the call/);
  assert.ok(!r.out.includes(KEY));
});

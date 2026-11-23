// Rule 27 for this lab: what a run leaves behind. Mock rows are the events the lab's own mock computed (simulated); Real rows are the one reply the
// lab received from a gateway door (response). The lab reads no product logs, so nothing here is ever `logged`. The Real door is an in-process fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createWorkspaces } from '../src/workspaces.js';
import { DEFAULT_BANDS } from '../src/policy.js';
import { assertRunObservability, classify, layerMatchers } from '../src/runObservability.js';
import { MAX_EVENTS, MAX_RUNS, beat, buildRunRecord, createRunLog, createRunStore, lineValue, observeNoReply, observeReal, observeTransfer } from '../src/runLog.js';

const KEY = 'agent-key-SECRET-obs-0123456789';
const NO_ENV = { STANDALONE_ENV: '/nonexistent/settings.env' };
const realEnv = (port, extra = {}) => ({ ...NO_ENV, HMLAB_REAL_URL: `http://127.0.0.1:${port}/door/mcp`, HMLAB_REAL_AGENT_KEY: KEY, HMLAB_REAL_TOOL: 'IndexMappingTool', ...extra });
const HELD = (id) => ({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'action requires human approval', data: { instruction_id: id, policy_ids: ['p:1'], reason: 'r', retry_header: 'X-Procyon-Approval-Id', status: 'pending_approval' } } });
const DONE = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'done' }] } };

// A fake gateway door. answer(rpcBody, req) -> [status, body | string, headers?] or 'drop' (the socket is destroyed); initialize and the notification are answered here.
async function door(answer, { delayMs = 0 } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method: body.method, approval: req.headers['x-procyon-approval-id'] || null });
      const send = (st, o, h = {}) => { res.writeHead(st, { 'content-type': 'application/json', ...h }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
      if (body.method === 'initialize') return req.headers.authorization === `Bearer ${KEY}` ? send(200, { jsonrpc: '2.0', id: 0, result: {} }) : send(401, { error: 'no' });
      if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      const out = answer(body, req);
      if (out === 'drop') return req.socket.destroy(); // the connection is lost: no reply
      const [st, o, h] = out;
      return send(st, o, h);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// One lab server with its decision lines captured and a clock the test moves.
async function withApp(fn, { env = NO_ENV, runLogWrite } = {}) {
  const lines = [];
  const clock = { t: 1_000_000 };
  let stamp = Date.parse('2026-11-22T10:00:00.000Z'); // the run log's own clock: every decision lands a few ms after the last, so row order is event order
  const workspaces = createWorkspaces({ bands: DEFAULT_BANDS, now: () => clock.t });
  const health = createHealth({ intervalMs: 3_600_000 }); await health.ready;
  const app = createApp({ health, configFile: '/nonexistent/customer.config.json', env, workspaces, runLogWrite: runLogWrite ?? ((l) => lines.push(l)), runLogClock: () => { stamp += 7; return stamp; } });
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app });
  const base = url.replace(/\/$/, '');
  const api = (ws = 'w1') => {
    const h = (extra = {}) => ({ 'content-type': 'application/json', origin: base, 'x-workspace': ws, ...extra });
    const out = async (r) => ({ status: r.status, body: await r.json() });
    return {
      post: (p, b = {}, headers) => fetch(`${base}${p}`, { method: 'POST', headers: h(headers), body: JSON.stringify(b) }).then(out),
      get: (p) => fetch(`${base}${p}`, { headers: h() }).then(out),
      transfer: (b) => api(ws).post('/api/transfer', { tool: 'create_transfer', ...b }),
      record: async () => (await api(ws).get('/api/run-observability')).body,
    };
  };
  try { await fn(api, lines, clock); } finally { health.stop(); await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); }
}

const sim = (rec) => rec.rows.filter((r) => r.origin !== 'not-logged');
const LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z hitl-mfa-lab decision step=[A-Za-z0-9._:/@-]+ layer=[A-Za-z0-9._:/@-]+ actor=[A-Za-z0-9._:/@-]+ result=(passed|stopped|unclear|no-reply) mode=(mock|real) run=[A-Za-z0-9._:/@-]+$/;
const stamps = (lines) => lines.map((l) => l.split(' ')[0]);

test('before any run: { record: null, message } in the current mode, never an error', async () => {
  await withApp(async (api) => {
    const r = await api().get('/api/run-observability');
    assert.equal(r.status, 200);
    assert.equal(r.body.record, null);
    assert.match(r.body.message, /No Mock run yet/);
  });
});

test('a permitted call: one row, simulated, closed run; the row time is the stdout time; every other layer says why it is not logged', async () => {
  await withApp(async (api, lines) => {
    const r = await api().transfer({ amount: 100 });
    assert.equal(r.status, 200);
    const rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.equal(rec.source, 'mock');
    assert.equal(sim(rec).length, 1);
    assert.deepEqual([sim(rec)[0].layer, sim(rec)[0].outcome, sim(rec)[0].origin], ['authorize', 'allowed', 'simulated']);
    assert.deepEqual(rec.coverage, { person: 'not-logged', agent: 'not-logged', authorize: 'simulated', privilege: 'not-logged', gateway: 'not-logged', resource: 'not-logged' });
    assert.match(rec.reasons.agent, /mints no agent token/);
    assert.match(rec.reasons.resource, /no tool server/);
    assert.equal(lines.length, 1);
    assert.match(lines[0], LINE);
    assert.deepEqual(stamps(lines), sim(rec).map((x) => x.at), 'the row time is the stdout time');
    assert.ok(rec.rows.every((x) => x.origin !== 'logged' && x.origin !== 'response'), 'a Mock record never holds a logged or response row');
    // after the verdict the run is closed: a human beat now joins no run, but still writes its line
    await api().post('/api/mfa/challenge', { amount: 100 });
    assert.equal(lines.length, 2);
    assert.match(lines[1], /run=-$/);
    assert.equal(sim(await api().record()).length, 1);
  });
});

test('a hard DENY is the amount-band gate refusing: refused, and it closes the run (a beat after it joins nothing), and it says no approval can clear it', async () => {
  await withApp(async (api, lines) => {
    assert.equal((await api().transfer({ amount: 5000 })).status, 403);
    let rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.equal(sim(rec)[0].outcome, 'refused');
    assert.match(sim(rec)[0].message, /No receipt, MFA or approval can clear it/);
    assert.equal(rec.summary.refused, 1);
    await api().post('/api/mfa/challenge', { amount: 5000 });
    rec = await api().record();
    assert.equal(sim(rec).length, 1, 'the DENY was the verdict: a later beat joins no run');
    assert.match(lines.at(-1), /step=mfa-challenge .* run=-$/);
  });
});

test('HITL consent: the hold is info (never counted as passed), the approver\'s answer is the decision, the retry is allowed; one run, in time order', async () => {
  await withApp(async (api, lines, clock) => {
    const held = await api().transfer({ amount: 300 });
    assert.equal(held.status, 428);
    let rec = await api().record();
    assert.equal(sim(rec).length, 1);
    assert.equal(sim(rec)[0].outcome, 'info');
    assert.equal(rec.summary.allowed, 0, 'a hold is not a pass');
    assert.match(sim(rec)[0].message, /A hold, not a refusal/);
    const runId = rec.runId;
    const ok = await api().post('/api/consent/respond', { challengeId: held.body.challengeId, decision: 'approved', respondedBy: 'Casey' });
    assert.equal(ok.status, 200);
    assert.equal((await api().transfer({ amount: 300 })).status, 200);
    rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.equal(rec.runId, runId, 'the retry joins the open run');
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['authorize:info', 'person:allowed', 'authorize:allowed']);
    assert.deepEqual(stamps(lines), sim(rec).map((x) => x.at));
    assert.deepEqual(rec.summary, { allowed: 2, refused: 0, blocked: 0, info: 1, unverified: 0 });
    assert.equal(rec.coverage.person, 'simulated');
    assert.equal(clock.t, 1_000_000);
  });
});

test('the approver says no: refused on Person and the run closes; the receipt is never minted, and a late beat joins nothing', async () => {
  await withApp(async (api, lines) => {
    const held = await api().transfer({ amount: 300 });
    await api().post('/api/consent/respond', { challengeId: held.body.challengeId, decision: 'denied' });
    const rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['authorize:info', 'person:refused']);
    await api().post('/api/mfa/challenge', { amount: 300 });
    assert.equal(sim(await api().record()).length, 2, 'after the verdict nothing joins the run');
    assert.match(lines.at(-1), /step=mfa-challenge .* run=-$/);
  });
});

test('MFA: the challenge is info, a wrong code is a refused row (the code never appears), the right one is information (issuing the credential is not a decision), then the retry', async () => {
  await withApp(async (api, lines) => {
    const held = await api().transfer({ amount: 600 });
    assert.equal(held.status, 428);
    const ch = await api().post('/api/mfa/challenge', { amount: 600 });
    const id = ch.body.challenge.id;
    assert.equal((await api().post('/api/mfa/verify', { challengeId: id, otp: '000000' })).status, 401);
    assert.equal((await api().post('/api/mfa/verify', { challengeId: id, otp: '123123' })).status, 200);
    assert.equal((await api().transfer({ amount: 600 })).status, 200);
    const rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['authorize:info', 'person:info', 'person:refused', 'person:info', 'authorize:allowed']);
    assert.match(sim(rec)[3].message, /Issuing the credential is not a decision/);
    assert.ok(!/minted/.test(sim(rec)[3].message), 'the IdP\'s verdict does not narrate a mint');
    assert.deepEqual(rec.summary, { allowed: 1, refused: 1, blocked: 0, info: 3, unverified: 0 });
    assert.ok(!JSON.stringify(rec).includes('123123') && !lines.join('\n').includes('123123') && !lines.join('\n').includes('000000'));
  });
});

test('PingID push: pending is info, the answer is the decision, "No, it is not me" closes the run; an unanswered push lapses once, then closes', async () => {
  await withApp(async (api, lines, clock) => {
    await api().transfer({ amount: 150, step_up_method: 'pingid-push' });
    const p = (await api().post('/api/mfa/push', { amount: 150 })).body.challenge;
    assert.equal((await api().post(`/api/mfa/push/${p.id}/respond`, { decision: 'denied' })).status, 200);
    await api().post(`/api/mfa/push/${p.id}/respond`, { decision: 'denied' }); // the same answer again is not a new decision
    let rec = await api().record();
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['authorize:info', 'person:info', 'person:refused']);
    assert.equal(lines.length, 3);

    await api().transfer({ amount: 150, step_up_method: 'pingid-push' });
    const q = (await api().post('/api/mfa/push', { amount: 150 })).body.challenge;
    clock.t += 61_000;
    for (let i = 0; i < 3; i += 1) assert.equal((await api().get(`/api/mfa/poll/${q.id}`)).body.status, 'failed');
    rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['authorize:info', 'person:info', 'person:info'], 'the lapse is one row, however many polls saw it');
    assert.match(sim(rec)[2].message, /the agent's poll found the PingID push unanswered after 60 seconds/i);
    assert.equal(lines.filter((l) => /step=push-lapsed/.test(l)).length, 1);
  });
});

test('CIBA: sent is info; the user\'s answer is the decision; letting it lapse (knob or the clock) is one info row and closes the run', async () => {
  await withApp(async (api, lines, clock) => {
    await api().transfer({ amount: 150, step_up_method: 'ciba' });
    const a = (await api().post('/api/ciba/bc-authorize', { amount: 150 })).body.auth_req_id;
    await api().post('/api/ciba/respond', { authReqId: a, decision: 'approved' });
    await api().post('/api/ciba/respond', { authReqId: a, decision: 'denied' }); // an approved request stays approved: not a second decision
    await api().transfer({ amount: 150, step_up_method: 'ciba' });
    let rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}:${x.message.slice(0, 18)}`), ['authorize:info:The amount-band ga', 'person:info:An out-of-band app', 'person:allowed:The user approved ', 'authorize:allowed:The amount-band ga']);

    await api().transfer({ amount: 150, step_up_method: 'ciba' });
    const b = (await api().post('/api/ciba/bc-authorize', { amount: 150 })).body.auth_req_id;
    clock.t += 301_000;
    for (let i = 0; i < 3; i += 1) assert.equal((await api().get(`/api/ciba/poll/${b}`)).body.status, 'expired');
    rec = await api().record();
    assert.deepEqual(sim(rec).map((x) => x.outcome), ['info', 'info', 'info']);
    assert.equal(lines.filter((l) => /step=ciba-lapsed/.test(l)).length, 1);

    await api().transfer({ amount: 150, step_up_method: 'ciba' });
    const c = (await api().post('/api/ciba/bc-authorize', { amount: 150 })).body.auth_req_id;
    assert.equal((await api().post('/api/ciba/expire', { authReqId: c })).status, 200);
    assert.equal((await api().post('/api/ciba/expire', { authReqId: c })).status, 409, 'a second expire is refused and records nothing');
    assert.equal(lines.filter((l) => /step=ciba-lapsed/.test(l)).length, 2);
  });
});

test('Privilege (mock): the hold is the Privilege policy\'s (info), PingID can fail without closing the run, the retry with the approval is allowed once, a replay is refused and held again', async () => {
  await withApp(async (api, lines) => {
    const held = await api().transfer({ amount: 150, step_up_method: 'privilege' });
    assert.equal(held.status, 403);
    const id = held.body.approval.instruction_id;
    assert.equal((await api().post(`/api/privilege/hitl/${id}/decide`, { decision: 'approve', pingid: { method: 'push', result: 'denied' } })).status, 403);
    assert.equal((await api().post(`/api/privilege/hitl/${id}/decide`, { decision: 'approve', pingid: { method: 'passcode', code: '000000' } })).status, 401);
    assert.equal((await api().post(`/api/privilege/hitl/${id}/decide`, { decision: 'approve', pingid: { method: 'passcode', code: '123123' } })).status, 200);
    const ok = await api().post('/api/transfer', { tool: 'create_transfer', amount: 150, step_up_method: 'privilege' }, { 'X-Procyon-Approval-Id': id });
    assert.equal(ok.status, 200);
    let rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.step ?? ''}${x.outcome}`), ['privilege:info', 'person:refused', 'person:refused', 'person:allowed', 'privilege:allowed']);
    assert.match(sim(rec)[0].message, /ai-transfer-hitl:1.*HTTP 403 pending_approval.*A hold, not a refusal/);
    assert.deepEqual(stamps(lines), sim(rec).map((x) => x.at));

    // a replay of the spent approval: a NEW call, refused by the Privilege check, then held again (one run: the retry joined nothing open, so it began one)
    const again = await api().post('/api/transfer', { tool: 'create_transfer', amount: 150, step_up_method: 'privilege' }, { 'X-Procyon-Approval-Id': id });
    assert.equal(again.status, 403);
    rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['privilege:refused', 'privilege:info']);
    assert.match(sim(rec)[0].message, /already_used/);
  });
});

test('Privilege (mock): rejecting needs no PingID, is the approver\'s refusal, and closes the run', async () => {
  await withApp(async (api) => {
    const held = await api().transfer({ amount: 150, step_up_method: 'privilege' });
    const id = held.body.approval.instruction_id;
    assert.equal((await api().post(`/api/privilege/hitl/${id}/decide`, { decision: 'reject' })).status, 200);
    const rec = await api().record();
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['privilege:info', 'person:refused']);
    assert.equal(rec.coverage.authorize, 'not-logged', 'the hold was the Privilege policy\'s, not the amount bands\'');
    assert.match(rec.reasons.authorize, /still checked the hard ceiling and did not refuse/, 'the layer does not say the gate made no decision: its ceiling check ran');
  });
});

test('a new fresh call closes the open run and starts the next; the open run is never evicted; ids are unique across runs, Reset and workspaces', async () => {
  await withApp(async (api) => {
    const ids = new Set();
    for (let i = 0; i < MAX_RUNS + 3; i += 1) { await api().transfer({ amount: 300 }); ids.add((await api().record()).runId); }
    assert.equal(ids.size, MAX_RUNS + 3, 'every held call is its own run');
    const rec = await api().record();
    assert.equal(sim(rec).length, 1, 'a held call that was superseded does not leak events into the next run');
    await api('w2').transfer({ amount: 100 });
    const other = await api('w2').record();
    assert.ok(!ids.has(other.runId), 'unique across workspaces');
    assert.equal((await api('w1').post('/api/reset')).status, 200);
    assert.equal((await api('w1').record()).record, null, 'Reset clears the workspace\'s runs');
    await api('w1').transfer({ amount: 100 });
    const after = (await api('w1').record()).runId;
    assert.ok(!ids.has(after) && after !== other.runId, 'unique across Reset');
  });
});

test('the run log keeps the open run however many runs follow it, and cuts a very long run from the middle, never the start, and says so', async () => {
  const lines = [];
  const log = createRunLog({ write: (l) => lines.push(l), clock: (() => { let t = Date.parse('2026-11-22T10:00:00Z'); return () => t++; })() });
  const store = createRunStore();
  const ev = (i, role) => ({ role, layer: 'person', step: 'consent', outcome: 'info', product: 'p', actor: 'a', message: `m${i}`, detail: {} });
  log.record(store, 'mock', ev(0, 'start'));
  const first = log.latest(store, 'mock');
  for (let i = 1; i < MAX_EVENTS + 25; i += 1) log.record(store, 'mock', ev(i, 'step'));
  assert.equal(first.events.length, MAX_EVENTS);
  assert.equal(first.events[0].message, 'm0', 'the first event is never dropped');
  assert.equal(first.events.at(-1).message, `m${MAX_EVENTS + 24}`);
  assert.equal(lines.length, MAX_EVENTS + 25, 'every event still wrote its line');
  for (let i = 0; i < MAX_RUNS + 2; i += 1) log.record(store, 'mock', ev(i, 'start'));
  assert.equal(store.mock.length, MAX_RUNS);
  assert.equal(log.latest(store, 'mock').open, true, 'the open run is the newest and is kept');
  assert.equal(MAX_RUNS, 5, 'the last five runs of a source are kept');
  const two = createRunStore();
  log.record(two, 'mock', ev(0, 'start'));
  log.record(two, 'mock', ev(1, 'start'));
  assert.equal(two.mock.length, 2, 'a run is not evicted by the next one: the superseded run is kept, closed');
  assert.deepEqual(two.mock.map((r) => r.open), [false, true]);
  assert.equal((await buildRunRecord({ run: first })).truncated, true, 'the cut is reported');
});

test('workspaces are isolated: another workspace sees nothing of this one', async () => {
  await withApp(async (api) => {
    await api('w1').transfer({ amount: 100 });
    assert.equal((await api('w2').record()).record, null);
    assert.equal((await api('w1').record()).source, 'mock');
  });
});

test('a recorder that throws never breaks the call or the lab\'s own audit, and the failure is on stderr as code and message only', async () => {
  const errs = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s, ...rest) => { if (String(s).startsWith('run-observability:')) { errs.push(String(s)); return true; } return real(s, ...rest); };
  try {
    await withApp(async (api) => {
      const r = await api().transfer({ amount: 100 });
      assert.equal(r.status, 200);
      assert.equal(r.body.decision, 'PERMIT');
      const runs = await api().get('/api/runs');
      assert.equal(runs.body.runs.length, 1, 'the lab\'s own audit still has the call');
      assert.equal((await api().post('/api/mfa/challenge', { amount: 100 })).status, 200, 'a beat is not broken either');
    }, { runLogWrite: () => { throw new Error('stdout is gone'); } });
  } finally { process.stderr.write = real; }
  assert.ok(errs.length >= 2);
  assert.ok(errs.every((e) => /^run-observability: Error: stdout is gone\n$/.test(e)));
});

test('hostile names cannot forge a second pair, a second line or an unmasked email or address in the line or the record', async () => {
  await withApp(async (api, lines) => {
    const held = await api().transfer({ amount: 300 });
    const nasty = 'evil result=passed\nFAKE decision step=amount-bands a@b.com 10.1.2.3 <img src=x onerror=alert(1)>';
    await api().post('/api/consent/respond', { challengeId: held.body.challengeId, decision: 'approved', respondedBy: nasty });
    const rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    for (const l of lines) { assert.ok(!l.includes('\n')); assert.match(l, LINE); assert.equal(l.split(' ').filter((p) => p.startsWith('result=')).length, 1); }
    const line = lines.find((l) => /step=consent /.test(l));
    assert.ok(!/a@b\.com|10\.1\.2\.3/.test(line), line);
    assert.ok(!/a@b\.com|10\.1\.2\.3/.test(JSON.stringify(rec)));
    assert.equal(lineValue('a b\nc=d'), 'a_b_c_d');
    assert.equal(lineValue(''), '-');
  });
});

test('the stdout lines use no word a shared matcher reads: every step, every outcome, hostile actors, through classify() for every product', async () => {
  const products = [...new Set(layerMatchers.map((m) => m.product))];
  assert.ok(products.length >= 5);
  const lines = [];
  await withApp(async (api) => {
    const t = (b) => api().transfer(b);
    for (const b of [{ amount: 100 }, { amount: 5000 }, { amount: 300 }, { amount: 600 }, { amount: 150, step_up_method: 'ciba' }, { amount: 150, step_up_method: 'pingid-push' }, { amount: 150, step_up_method: 'p1mfa' }]) await t(b);
    const WORDS = ['refused', 'denied', 'rejected', 'forbidden', 'failed', 'invalid', 'expired', 'mismatch', 'token', 'audience', 'scope', 'served', 'Observed By', 'REFUSED'];
    for (const who of ['presenter', 'a@b.com', '10.1.2.3', 'Bearer abcdefghijklmnopqrstuvwxyz', 'x'.repeat(500), 'evil\nFAKE=1', ...WORDS]) {
      const held = await t({ amount: 300 });
      await api().post('/api/consent/respond', { challengeId: held.body.challengeId, decision: 'approved', respondedBy: who });
    }
  }, { runLogWrite: (l) => lines.push(l) });
  // every kind of line the lab can write, built from the same functions the routes use
  const events = [
    observeTransfer({ amount: 1, result: { decision: 'PERMIT', reason: 'r' }, decision: 'PERMIT' }),
    observeTransfer({ amount: 1, result: { decision: 'DENY', reason: 'r' }, decision: 'DENY' }),
    observeTransfer({ amount: 1, result: { decision: 'STEP_UP', reason: 'r', obligation: { type: 'STEP_UP' } }, decision: 'STEP_UP', declaredStepUp: 'privilege', held: { id: 'ins_1' }, block: { status: 403 }, presented: 'x', check: { reason: 'expired' } }),
    observeTransfer({ amount: 1, result: { decision: 'STEP_UP', reason: 'r' }, decision: 'PERMIT', declaredStepUp: 'privilege', approved: { id: 'x', method: 'push' }, presented: 'x', receipt: 'x' }),
    ...Object.values(beat).flatMap((f) => [f({ amount: 1, decision: 'approved', ok: true, status: 'approved', id: 'i', method: 'push', why: 'w', by: 'a@b.com' }), f({ amount: 1, decision: 'denied', ok: false, status: 'denied', id: 'i', method: 'push', why: 'w' }), f({ amount: 1, decision: 'reject', ok: false, status: 'expired', id: 'i' })]),
    ...['held', 'refused', 'executed', 'unknown'].flatMap((outcome) => [200, 401, 403, 302].flatMap((http) => observeReal({ outcome, basis: 'observed', http, message: 'denied expired token', held: { instruction_id: 'ins_1' } }, { retry: false }))),
    ...observeReal({ outcome: 'held', basis: 'inferred', http: 200, held: { instruction_id: null } }, { retry: true }),
  ].flat().filter(Boolean);
  const sink = [];
  const log = createRunLog({ write: (l) => sink.push(l) });
  const store = createRunStore();
  for (const e of events) log.record(store, e.layer === 'gateway' || e.layer === 'resource' ? 'real' : 'mock', e);
  log.record(store, 'real', observeNoReply({ retry: false, why: 'ECONNREFUSED' })[0]);
  assert.ok(sink.length > 40 && lines.length > 10);
  const steps = new Set();
  for (const line of [...lines, ...sink]) {
    assert.match(line, LINE);
    steps.add(/ step=(\S+)/.exec(line)[1]);
    assert.ok(!/refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served/i.test(line), `a matcher word in the whole line, typed actor included: ${line}`);
    const at = Date.parse(line.split(' ')[0]);
    for (const product of products) {
      assert.equal(classify({ product, message: line, at, atExact: line.split(' ')[0] }, []), null, `${product}: ${line}`);
      assert.equal(classify({ product, message: `[${line.split(' ')[0]}] INFO: ${line.split(' ').slice(1).join(' ')}`, at: 0, atExact: '' }, []), null, `${product} behind a header`);
    }
  }
  assert.ok(lines.some((l) => /step=consent .* actor=_+ /.test(l)), 'a typed name that is only a matcher word is cut out, not kept');
  assert.equal(lineValue('Refused-By-Admin'), '_-By-Admin');
  assert.equal(lineValue('Observed'), 'Ob_');
  for (const s of ['amount-bands', 'receipt-check', 'hold', 'approval-check', 'consent', 'mfa-challenge', 'mfa-code', 'push-sent', 'push-answer', 'push-lapsed', 'ciba-sent', 'ciba-answer', 'ciba-lapsed', 'approval', 'pingid-confirm', 'door-reply', 'tool-result', 'door-no-reply']) assert.ok(steps.has(s), `${s} was written`);
});

// ---- Real: the one reply the lab received ------------------------------------------------------------------------------------------

test('Real: a held call is a response row on the gateway (info, never a pass), a repeat of the same hold adds nothing, the executed reply adds the gateway and the tool, and the run closes', async () => {
  const d = await door((body, req) => (req.headers['x-procyon-approval-id'] === 'ins_obs1' ? [200, DONE] : [403, HELD('ins_obs1')]));
  try {
    await withApp(async (api, lines) => {
      assert.equal((await api().get('/api/info')).body.source, 'real');
      const first = (await api().post('/api/privilege/real/call', {})).body;
      assert.equal(first.outcome, 'held');
      assert.deepEqual(first.runObservability, { began: true, recorded: true, afterReset: false }, 'the answer says the call began a run and added a row');
      for (let i = 0; i < 3; i += 1) {
        const again = (await api().post('/api/privilege/real/call', { approvalId: 'ins_obs1x' })).body; // retries the gateway still holds: the same hold again
        assert.equal(again.outcome, 'held');
        assert.deepEqual(again.runObservability, { began: true, recorded: false, afterReset: false }, 'a repeat of the same hold adds nothing, and the answer says so (the page reads again only when it did)');
      }
      let rec = await api().record();
      assert.deepEqual(assertRunObservability(rec), []);
      assert.equal(rec.source, 'real');
      assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}:${x.origin}`), ['gateway:info:response']);
      assert.equal(lines.length, 1, 'the same hold again is not a new decision');
      assert.equal(rec.summary.allowed, 0);
      assert.match(sim(rec)[0].message, /This is the reply the lab received, not a log line/);
      assert.equal(rec.coverage.person, 'not-logged');
      assert.match(rec.reasons.person, /never calls PingID/);
      assert.match(rec.reasons.authorize, /Privilege's own AI policy/);
      assert.match(rec.reasons.privilege, /no log reader/);
      assert.equal(rec.coverage.gateway, 'response');

      const done = await api().post('/api/privilege/real/call', { approvalId: 'ins_obs1' });
      assert.equal(done.body.outcome, 'executed');
      assert.equal(done.body.runObservability.recorded, true);
      rec = await api().record();
      assert.deepEqual(assertRunObservability(rec), []);
      assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['gateway:info', 'gateway:allowed', 'resource:info'], 'one HTTP 200 is one decision: the tool row is the lab\'s reading of the same reply');
      assert.deepEqual(rec.summary, { allowed: 1, refused: 0, blocked: 0, info: 2, unverified: 0 });
      assert.match(sim(rec)[2].message, /the lab's reading of one reply, not a second decision/);
      assert.deepEqual(stamps(lines), sim(rec).map((x) => x.at));
      assert.ok(rec.rows.every((x) => x.origin !== 'logged' && x.origin !== 'simulated'));
      assert.ok(!JSON.stringify(rec).includes(KEY) && !lines.join('\n').includes(KEY), 'the agent key is nowhere');

      // a call after the verdict is its own run (a start), and the old one is not extended
      const before = rec.runId;
      await api().post('/api/privilege/real/call', {});
      assert.notEqual((await api().record()).runId, before);
    }, { env: realEnv(d.port) });
  } finally { await d.close(); }
});

test('Real: 401, 403, a JSON-RPC error and isError are refused; a 200 that is not a JSON-RPC answer is info; a redirect is the lab\'s own stop (blocked); a 200 with pending_approval text is the lab\'s reading', async () => {
  const GATEWAY = /^The gateway refused the tools\/call/;
  const ERROR_REPLY = /got an error reply.*cannot tell a gateway decision from the tool's own error/;
  const cases = [
    [[401, { error: 'no' }], 'refused', GATEWAY],
    [[403, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } }], 'refused', GATEWAY],
    [[200, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'policy said no' } }], 'refused', ERROR_REPLY],
    [[200, { jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'tool failed' }] } }], 'refused', ERROR_REPLY],
    [[200, '<html>login</html>'], 'info', /cannot say what the gateway did/],
    [[302, '', { location: 'https://other.invalid/' }], 'blocked', /did not follow the gateway's redirect.*What Privilege did.*refused, observed; that panel is untouched/],
    [[200, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'pending_approval ins_inferred1' }] } }], 'info', /the lab READS this as a hold/],
  ];
  for (const [reply, expected, wording] of cases) {
    const d = await door(() => reply);
    try {
      await withApp(async (api) => {
        await api().post('/api/privilege/real/call', {});
        const rec = await api().record();
        assert.deepEqual(assertRunObservability(rec), []);
        assert.equal(sim(rec)[0].outcome, expected, JSON.stringify(reply));
        assert.ok(!sim(rec).some((x) => x.layer === 'resource'), 'only an executed reply is the tool\'s');
        assert.match(sim(rec)[0].message, wording, JSON.stringify(reply));
        if (expected === 'blocked') assert.equal(sim(rec)[0].product, 'lab (redirect not followed)', 'the lab, not the gateway, is the product of its own stop');
        else assert.ok(!/^lab /.test(sim(rec)[0].product));
      }, { env: realEnv(d.port) });
    } finally { await d.close(); }
  }
});

test('Real: a call that got no reply is an information row that says so (and a line, result=no-reply), and a call refused before any call began no run', async () => {
  await withApp(async (api, lines) => {
    const r = await api().post('/api/privilege/real/call', {});
    assert.equal(r.status, 502);
    assert.deepEqual(r.body.runObservability, { began: true, recorded: true, afterReset: false });
    const rec = await api().record();
    assert.deepEqual(assertRunObservability(rec), []);
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}:${x.origin}`), ['gateway:info:response']);
    assert.match(sim(rec)[0].message, /got no reply.*so there is no reply to show.*not a decision by the gateway/);
    assert.equal(sim(rec)[0].product, 'lab (no reply from the gateway)');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /step=door-no-reply layer=gateway actor=agent result=no-reply mode=real run=run-/);
    const runId = rec.runId;
    const bad = await api().post('/api/privilege/real/call', { approvalId: 'a b' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.runObservability, { began: false, recorded: false, afterReset: false }, 'the answer says no run began');
    assert.equal(lines.length, 1, 'a request refused before any call writes nothing');
    assert.equal((await api().record()).runId, runId, 'and begins no run');
    assert.equal((await api().post('/api/privilege/real/call', {}, { 'x-workspace': 'BAD WS' })).status, 400);
  }, { env: realEnv(1) });
});

test('Real: a held call whose automatic retry gets no reply shows it: an information row after the hold, the run still waiting, and the record says why nothing newer arrived', async () => {
  const d = await door((body, req) => (req.headers['x-procyon-approval-id'] ? 'drop' : [403, HELD('ins_drop1')]));
  try {
    await withApp(async (api, lines) => {
      assert.equal((await api().post('/api/privilege/real/call', {})).body.outcome, 'held');
      const retry = await api().post('/api/privilege/real/call', { approvalId: 'ins_drop1' });
      assert.equal(retry.status, 502);
      assert.deepEqual(retry.body.runObservability, { began: true, recorded: true, afterReset: false });
      const rec = await api().record();
      assert.deepEqual(assertRunObservability(rec), []);
      assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}:${x.origin}`), ['gateway:info:response', 'gateway:info:response']);
      assert.match(sim(rec)[1].message, /got no reply/);
      assert.deepEqual(rec.summary, { allowed: 0, refused: 0, blocked: 0, info: 2, unverified: 0 });
      assert.equal(rec.window.to, sim(rec)[1].at, 'the window ends at the no-reply row, which says why');
      assert.match(lines.at(-1), /result=no-reply/);
      assert.equal(new Set(lines.map((l) => /run=(\S+)/.exec(l)[1])).size, 1, 'one run: the retry joined the held run');
    }, { env: realEnv(d.port) });
  } finally { await d.close(); }
});

test('Real: a hold that comes back after its run closed is not dropped: it writes its line and starts its own run', async () => {
  const d = await door((body, req) => (req.headers['x-procyon-approval-id'] === 'ins_late2' ? [200, DONE] : [403, HELD('ins_late2')]));
  try {
    await withApp(async (api, lines) => {
      await api().post('/api/privilege/real/call', {});
      await api().post('/api/privilege/real/call', { approvalId: 'ins_late2' }); // executed: the run closes
      const before = lines.length;
      const closed = (await api().record()).runId;
      const late = await api().post('/api/privilege/real/call', { approvalId: 'ins_other' }); // a stale retry the gateway still holds
      assert.equal(late.body.outcome, 'held');
      assert.equal(lines.length, before + 1, 'the line is written');
      assert.match(lines.at(-1), /step=door-reply .* run=run-/);
      assert.notEqual((await api().record()).runId, closed, 'and the closed run is not extended');
    }, { env: realEnv(d.port) });
  } finally { await d.close(); }
});

test('the mode is the run\'s: a Mock run never comes back as a Real reply after the toggle, a Real run never as a Mock one, and a simulated scenario run in Real stays Mock', async () => {
  const d = await door(() => [403, HELD('ins_mode1')]);
  try {
    await withApp(async (api) => {
      await api().post('/api/mode', { source: 'mock' });
      await api().transfer({ amount: 100 });
      assert.equal((await api().record()).source, 'mock');
      assert.equal((await api().post('/api/mode', { source: 'real' })).status, 200);
      const none = await api().record();
      assert.equal(none.record, null, 'the Mock run is not returned in Real');
      assert.match(none.message, /No Real run yet/);
      await api().transfer({ amount: 100 }); // a simulated scenario while the toggle is Real: still a Mock run
      assert.equal((await api().record()).record, null);
      await api().post('/api/privilege/real/call', {});
      const real = await api().record();
      assert.equal(real.source, 'real');
      assert.ok(sim(real).every((x) => x.origin === 'response'));
      await api().post('/api/mode', { source: 'mock' });
      const mock = await api().record();
      assert.equal(mock.source, 'mock');
      assert.ok(sim(mock).every((x) => x.origin === 'simulated'));
      assert.notEqual(mock.runId, real.runId);
    }, { env: realEnv(d.port) });
  } finally { await d.close(); }
});

test('a bad workspace id is refused like every other route, and no run is begun for it', async () => {
  await withApp(async (api, lines) => {
    const r = await api('BAD WS').get('/api/run-observability');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_workspace');
    assert.equal(lines.length, 0);
  });
});

test('a Reset while a Real call is in flight: the late reply never appears in the record of the reset workspace (it is on stdout only)', async () => {
  const d = await door(() => [403, HELD('ins_late1')], { delayMs: 250 });
  try {
    await withApp(async (api, lines) => {
      const call = api().post('/api/privilege/real/call', {});
      await new Promise((r) => setTimeout(r, 80));
      assert.equal((await api().post('/api/reset')).status, 200);
      const answered = (await call).body;
      assert.equal(answered.outcome, 'held', 'the call itself still answers');
      assert.deepEqual(answered.runObservability, { began: false, recorded: false, afterReset: true }, 'and says the reply came after Reset');
      assert.equal((await api().record()).record, null, 'but the workspace Reset has no record of it');
      assert.equal(lines.length, 1);
      assert.match(lines[0], /step=door-reply layer=gateway .* mode=real run=run-/);
    }, { env: realEnv(d.port) });
  } finally { await d.close(); }
});

// ---- Review fixes: an answer joins the run that asked ------------------------------------------------------------------------------

test('an answer joins the run that asked, never the newest open run: a consent, MFA, push, CIBA or Privilege answer for a superseded run is on stdout only (run=-)', async () => {
  await withApp(async (api, lines) => {
    // consent: a $300 hold (run A), then a fresh $800 call (run B); A's challenge is approved
    const a = await api().transfer({ amount: 300 });
    const b = await api().transfer({ amount: 800 });
    assert.equal(b.status, 428);
    const runB = (await api().record()).runId;
    const before = lines.length;
    assert.equal((await api().post('/api/consent/respond', { challengeId: a.body.challengeId, decision: 'approved' })).status, 200);
    assert.equal(lines.length, before + 1);
    assert.match(lines.at(-1), /step=consent .* run=-$/);
    let rec = await api().record();
    assert.equal(rec.runId, runB);
    assert.equal(sim(rec).length, 1, 'run B holds only its own hold');
    assert.ok(!sim(rec).some((x) => /\$300/.test(x.message)));

    // MFA: the challenge issued in B binds to B; a fresh call C supersedes B; B's code is ignored
    const ch = (await api().post('/api/mfa/challenge', { amount: 800 })).body.challenge.id;
    await api().transfer({ amount: 900 });
    const runC = (await api().record()).runId;
    assert.notEqual(runC, runB);
    assert.equal((await api().post('/api/mfa/verify', { challengeId: ch, otp: '123123' })).status, 200);
    assert.match(lines.at(-1), /step=mfa-code .* run=-$/);
    assert.equal(sim(await api().record()).length, 1, 'run C is untouched');

    // push and CIBA: sent in C, D supersedes C, the answers for C are ignored
    const push = (await api().post('/api/mfa/push', { amount: 900 })).body.challenge.id;
    const ciba = (await api().post('/api/ciba/bc-authorize', { amount: 900 })).body.auth_req_id;
    assert.equal(sim(await api().record()).length, 3, 'both were sent in run C');
    await api().transfer({ amount: 950 });
    const runD = (await api().record()).runId;
    await api().post(`/api/mfa/push/${push}/respond`, { decision: 'approved' });
    assert.match(lines.at(-1), /step=push-answer .* run=-$/);
    await api().post('/api/ciba/respond', { authReqId: ciba, decision: 'approved' });
    assert.match(lines.at(-1), /step=ciba-answer .* run=-$/);
    rec = await api().record();
    assert.equal(rec.runId, runD);
    assert.equal(sim(rec).length, 1);
    assert.deepEqual(assertRunObservability(rec), []);

    // Privilege: request 1 (run P1), request 2 (run P2); request 1 is approved
    const h1 = await api().transfer({ amount: 150, step_up_method: 'privilege' });
    await api().transfer({ amount: 160, step_up_method: 'privilege' });
    const runP2 = (await api().record()).runId;
    await api().post(`/api/privilege/hitl/${h1.body.approval.instruction_id}/decide`, { decision: 'reject' });
    assert.match(lines.at(-1), /step=approval .* run=-$/);
    rec = await api().record();
    assert.equal(rec.runId, runP2);
    assert.equal(sim(rec).length, 1, 'rejecting request 1 does not close or fill the run of request 2');
  });
});

test('an answer for the run that is still open joins it', async () => {
  await withApp(async (api) => {
    const held = await api().transfer({ amount: 300 });
    const runId = (await api().record()).runId;
    await api().post('/api/consent/respond', { challengeId: held.body.challengeId, decision: 'approved' });
    const rec = await api().record();
    assert.equal(rec.runId, runId);
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['authorize:info', 'person:allowed']);
  });
});

test('a retry the gate blocks again (a lapsed credit) joins its run when the page marks it, so the run keeps the approver\'s answer; an unmarked repeat is a fresh call', async () => {
  await withApp(async (api, lines, clock) => {
    await api().transfer({ amount: 600 });
    const ch = (await api().post('/api/mfa/challenge', { amount: 600 })).body.challenge.id;
    await api().post('/api/mfa/verify', { challengeId: ch, otp: '123123' });
    const runId = (await api().record()).runId;
    clock.t += 301_000; // the 5-minute credit lapses
    const again = await api().post('/api/transfer', { tool: 'create_transfer', amount: 600 }, { 'X-Hmlab-Retry': '1' });
    assert.equal(again.status, 428, 'blocked again: nothing to present');
    let rec = await api().record();
    assert.equal(rec.runId, runId, 'the marked retry joined the run that holds the answer');
    assert.deepEqual(sim(rec).map((x) => `${x.layer}:${x.outcome}`), ['authorize:info', 'person:info', 'person:info', 'authorize:info']);
    assert.deepEqual(assertRunObservability(rec), []);
    assert.equal(new Set(lines.map((l) => /run=(\S+)/.exec(l)[1])).size, 1);
    // without the mark it is a fresh call (a re-click of the scenario): a new run, and the old one is closed
    await api().transfer({ amount: 600 });
    rec = await api().record();
    assert.notEqual(rec.runId, runId);
    assert.equal(sim(rec).length, 1);
  });
});

test('the record\'s window ends at the last decision and does not move when the record is read again', async () => {
  await withApp(async (api, lines) => {
    await api().transfer({ amount: 300 });
    const a = await api().record();
    await new Promise((r) => setTimeout(r, 40));
    const b = await api().record();
    assert.equal(a.window.to, b.window.to, 'reading later does not re-stamp the window');
    assert.equal(a.window.from, stamps(lines)[0]);
    assert.equal(a.window.to, stamps(lines).at(-1), 'it ends at the last decision, the time on the stdout line');
  });
});

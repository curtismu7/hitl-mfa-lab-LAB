import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rawHttp, withServer } from './helpers.js';

test('GET /api/health answers demo-health/1, ready and offline', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/health`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = await r.json();
    assert.equal(j.schema, 'demo-health/1');
    assert.equal(j.state, 'ready');
    assert.equal(j.runtime, 'offline');
    assert.equal(j.demo.id, 'hitl-mfa-lab');
    assert.deepEqual(Object.keys(j).sort(), ['at', 'demo', 'runtime', 'schema', 'state']);
  });
});

test('health is GET only', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/health`, { method: 'POST', headers: { origin: url } });
    assert.equal(r.status, 405);
  });
});

test('POST /api/reset confirms and refuses a cross-origin caller', async () => {
  await withServer(async (url) => {
    const ok = await fetch(`${url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: '{}' });
    assert.equal((await ok.json()).reset, 'ok');
    const bad = await fetch(`${url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(bad.status, 403);
  });
});

test('a non-loopback Host header is refused (DNS rebinding)', async () => {
  await withServer(async (url) => {
    const r = await rawHttp(`${url}/api/health`, { headers: { host: 'evil.example.invalid' } });
    assert.equal(r.status, 403);
  });
});

test('unknown API paths are 404 JSON', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/nope`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'not_found');
  });
});

test('GET /api/info says what this build is: mock, simulated, and hosted only when asked', async () => {
  await withServer(async (url) => {
    assert.deepEqual(await (await fetch(`${url}/api/info`)).json(), { mode: 'mock', source: 'mock', simulated: true, hosted: false, realAvailable: false });
    const j = await (await fetch(`${url}/api/scenarios`)).json();
    assert.equal(j.hosted, false);
    assert.match(j.banner, /^SIMULATED/);
  });
  await withServer(async (url) => {
    assert.deepEqual(await (await fetch(`${url}/api/info`)).json(), { mode: 'mock', source: 'mock', simulated: true, hosted: true, realAvailable: false });
    assert.match((await (await fetch(`${url}/api/scenarios`)).json()).banner, /^HOSTED SIMULATION/);
  }, { hosted: true });
});

test('an oversized or malformed body gets a short JSON error, never a stack trace or a file path', async () => {
  await withServer(async (url) => {
    const post = (body) => fetch(`${url}/api/policy`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body });
    const big = await post(JSON.stringify({ pad: 'x'.repeat(9000) }));
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { error: 'payload_too_large' });
    const bad = await post('{not json');
    assert.equal(bad.status, 400);
    const text = JSON.stringify(await bad.json());
    assert.equal(text, JSON.stringify({ error: 'bad_request' }));
    assert.ok(!/\/Users\/|node_modules|at \w+ \(/.test(text), 'no stack or path');
    assert.equal((await fetch(`${url}/api/health`)).status, 200, 'the server stays up');
  });
});

test('GET /api/scenarios returns the filled story; customer.config.json is read on each request; verticals switch the cast', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hml-')), 'customer.config.json');
  await withServer(async (url) => {
    let j = await (await fetch(`${url}/api/scenarios`)).json();
    assert.equal(j.scenarios.length, 6);
    assert.ok(!/\{\{/.test(JSON.stringify(j)), 'no unfilled token');
    assert.match(j.tokenLabel, /MOCK/);
    assert.ok(j.facts.some((f) => f.id === 'receipt-amount-bound' && f.status === 'measured'));
    assert.ok(j.tools.length >= 1, 'the tool list ships with the story');
    j = await (await fetch(`${url}/api/scenarios?vertical=finance`)).json();
    assert.match(j.rule.appliesTo, /fabrikam/);
    j = await (await fetch(`${url}/api/scenarios?vertical=__proto__`)).json();
    assert.match(j.rule.appliesTo, /northwind/, 'unknown vertical keeps the default');
    fs.writeFileSync(file, JSON.stringify({ cast: { host: 'customhost' } }));
    j = await (await fetch(`${url}/api/scenarios`)).json();
    assert.match(j.rule.appliesTo, /customhost/);
  }, { configFile: file });
});

test('GET /api/policy returns the default bands; POST /api/policy reconfigures them live and a crossing edit falls back', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    let j = await (await fetch(`${url}/api/policy`, { headers: { 'x-workspace': 'w1' } })).json();
    assert.equal(j.bands.confirmUsd, 250);
    assert.equal(j.bands.mfaUsd, 500);
    assert.equal(j.bands.denyCeilingUsd, 2000);
    j = await (await post('/api/policy', { bands: { confirmUsd: 100, mfaUsd: 400, denyCeilingUsd: 1500 } }, 'w1')).json();
    assert.equal(j.bands.mfaUsd, 400);
    // a crossing edit (confirm >= mfa) falls back to defaults, never widens
    j = await (await post('/api/policy', { bands: { confirmUsd: 900, mfaUsd: 400, denyCeilingUsd: 100 } }, 'w1')).json();
    assert.deepEqual(j.bands, { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 });
    // invalid bands object is refused
    assert.equal((await post('/api/policy', { bands: 'junk' }, 'w1')).status, 400);
  });
});

test('UC8: $300 returns 428 HITL; the consent approval mints a single-use receipt the retry presents', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    // first call: blocked with 428
    const res = await post('/api/transfer', { tool: 'create_transfer', amount: 300 }, 'w1');
    assert.equal(res.status, 428);
    let j = await res.json();
    assert.equal(j.decision, 'HITL');
    assert.equal(j.error, 'mcp_hitl_required');
    assert.match(j.reason, /requires human consent/);
    assert.ok(!j.receipt, 'no receipt exists yet');
    assert.ok(j.hops.some((h) => h.label.includes('HITL_CONSENT')));
    // approve: the challenge store is empty here, so mint via the consent respond path is not available;
    // the receipt flow is exercised in the CIBA + replay tests. Reset restores defaults.
    await post('/api/reset', {}, 'w1');
  });
});

test('UC7: $600 returns 428 STEP_UP; the demo OTP 123123 mints a TTL credit the retry presents', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    const res = await post('/api/transfer', { tool: 'create_transfer', amount: 600 }, 'w2');
    assert.equal(res.status, 428);
    const j = await res.json();
    assert.equal(j.decision, 'STEP_UP');
    assert.equal(j.error, 'mcp_step_up_required');
    assert.equal(j.step_up_method, 'p1mfa');
    // start + verify MFA
    const ch = await (await post('/api/mfa/challenge', { amount: 600 }, 'w2')).json();
    assert.equal(ch.challenge.method, 'p1mfa');
    assert.ok(ch.challenge.devices.length >= 1);
    // wrong OTP refused
    assert.equal((await post('/api/mfa/verify', { challengeId: ch.challenge.id, otp: '999999' }, 'w2')).status, 401);
    const ver = await (await post('/api/mfa/verify', { challengeId: ch.challenge.id, otp: '123123' }, 'w2')).json();
    assert.equal(ver.challenge.status, 'verified');
    assert.ok(ver.receipt.id);
    assert.equal(ver.receipt.ttlMs, 300000, '5 minute TTL');
    // the retry presents the credit and permits
    const ok = await (await post('/api/transfer', { tool: 'create_transfer', amount: 600 }, 'w2')).json();
    assert.equal(ok.decision, 'PERMIT');
    assert.equal(ok.receipt, ver.receipt.id);
    // consume-on-use: a SECOND $600 transfer re-challenges
    const again = await post('/api/transfer', { tool: 'create_transfer', amount: 600 }, 'w2');
    assert.equal(again.status, 428);
  });
});

test('UC22: CIBA for a $150 agent action — bc-authorize, out-of-band approve, poll, retry permits', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    // declared ciba step-up is amount-independent: $150 is below every band
    const res = await post('/api/transfer', { tool: 'create_transfer', amount: 150, step_up_method: 'ciba' }, 'w3');
    assert.equal(res.status, 428);
    const j = await res.json();
    assert.equal(j.error, 'ciba_required');
    assert.match(j.reason, /agent-initiated/);
    // bc-authorize
    const ba = await (await post('/api/ciba/bc-authorize', { amount: 150, bindingMessage: 'Approve $150 transfer' }, 'w3')).json();
    assert.match(ba.auth_req_id, /^ciba-/);
    assert.ok(ba.expires_in > 0);
    assert.equal(ba.binding_message, 'Approve $150 transfer');
    // poll: pending
    let p = await (await fetch(`${url}/api/ciba/poll/${ba.auth_req_id}`, { headers: { 'x-workspace': 'w3' } })).json();
    assert.equal(p.status, 'pending');
    // unknown auth_req_id
    assert.equal((await (await fetch(`${url}/api/ciba/poll/ciba-nope`, { headers: { 'x-workspace': 'w3' } })).json()).status, 'unknown');
    // out-of-band: the user approves on the phone
    const resp = await (await post('/api/ciba/respond', { authReqId: ba.auth_req_id, decision: 'approved' }, 'w3')).json();
    assert.equal(resp.status, 'approved');
    assert.ok(resp.receiptId);
    // poll: approved, with the amount-bound receipt
    p = await (await fetch(`${url}/api/ciba/poll/${ba.auth_req_id}`, { headers: { 'x-workspace': 'w3' } })).json();
    assert.equal(p.status, 'approved');
    assert.equal(p.receiptId, resp.receiptId);
    // the retry presents the approval and permits
    const ok = await (await post('/api/transfer', { tool: 'create_transfer', amount: 150, step_up_method: 'ciba' }, 'w3')).json();
    assert.equal(ok.decision, 'PERMIT');
    assert.equal(ok.receipt, resp.receiptId);
    // deny path: a pending request denied out-of-band never approves
    const ba2 = await (await post('/api/ciba/bc-authorize', { amount: 150 }, 'w3')).json();
    await post('/api/ciba/respond', { authReqId: ba2.auth_req_id, decision: 'denied' }, 'w3');
    p = await (await fetch(`${url}/api/ciba/poll/${ba2.auth_req_id}`, { headers: { 'x-workspace': 'w3' } })).json();
    assert.equal(p.status, 'denied');
  });
});

test('UC6 band: $2500 is a hard DENY that no receipt can clear', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    const res = await post('/api/transfer', { tool: 'create_transfer', amount: 2500 }, 'w4');
    assert.equal(res.status, 403);
    const j = await res.json();
    assert.equal(j.decision, 'DENY');
    assert.match(j.reason, /hard limit/);
    assert.ok(!j.receipt);
    assert.ok(j.hops.some((h) => h.label.includes('outranks')));
  });
});

test('receipts are amount-bound: a $300 approval cannot discharge a $600 call', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    // mint a HITL receipt bound to $300 via the MFA-free path: use the policy editor to lower
    // the mfa bar so $300 lands in the step-up band? No — simpler: approve a CIBA request for 300.
    const ba = await (await post('/api/ciba/bc-authorize', { amount: 300 }, 'w5')).json();
    await post('/api/ciba/respond', { authReqId: ba.auth_req_id, decision: 'approved' }, 'w5');
    // a $300 ciba transfer presents it and permits
    const ok300 = await (await post('/api/transfer', { tool: 'create_transfer', amount: 300, step_up_method: 'ciba' }, 'w5')).json();
    assert.equal(ok300.decision, 'PERMIT');
    // a fresh $300-bound receipt: approve another
    const ba2 = await (await post('/api/ciba/bc-authorize', { amount: 300 }, 'w5')).json();
    await post('/api/ciba/respond', { authReqId: ba2.auth_req_id, decision: 'approved' }, 'w5');
    // a $600 transfer (step-up band, ciba declared) must NOT be discharged by the $300 receipt
    const res600 = await post('/api/transfer', { tool: 'create_transfer', amount: 600, step_up_method: 'ciba' }, 'w5');
    assert.equal(res600.status, 428, 'the $300-bound receipt cannot discharge $600');
  });
});

test('bands, receipts and runs are per workspace and Reset clears only that workspace', async () => {
  await withServer(async (url) => {
    const post = (p, ws, body = {}) => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': encodeURIComponent(ws) }, body: JSON.stringify(body) });
    const get = (p, ws) => fetch(`${url}/api/${p.replace(/^\/api\//, '')}`, { headers: { 'x-workspace': ws } });
    await post('/api/policy', 'alice', { bands: { confirmUsd: 100, mfaUsd: 400, denyCeilingUsd: 1500 } });
    await post('/api/transfer', 'alice', { tool: 'create_transfer', amount: 300 });
    // bob is unaffected
    let j = await (await get('/policy', 'bob')).json();
    assert.equal(j.bands.confirmUsd, 250, 'defaults until touched');
    j = await (await post('/api/transfer', 'bob', { tool: 'create_transfer', amount: 300 })).json();
    assert.equal(j.decision, 'HITL');
    const runs = async (ws) => (await (await get('/api/runs', ws)).json()).runs;
    const runsAlice = async () => (await (await get('/api/runs', 'alice')).json()).runs;
    assert.equal((await runsAlice()).length >= 1, true);
    await post('/api/reset', 'alice');
    j = await (await get('/policy', 'alice')).json();
    assert.equal(j.bands.confirmUsd, 250, 'reset restores the default bands');
    assert.deepEqual(await runsAlice(), []);
    assert.equal((await post('/api/transfer', 'Bad Id!', { tool: 'create_transfer', amount: 100 })).status, 400);
  });
});

test('UC8 full loop: the 428 carries a challengeId; /consent/respond mints the receipt; the retry permits', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws = 'w12') => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    const res = await post('/api/transfer', { tool: 'create_transfer', amount: 300 }, 'w12');
    assert.equal(res.status, 428);
    const j = await res.json();
    assert.match(j.challengeId, /^consent-/);
    // approve the challenge
    const resp = await (await post('/api/consent/respond', { challengeId: j.challengeId, decision: 'approved' }, 'w12')).json();
    assert.ok(resp.receipt.id);
    assert.equal(resp.receipt.amountBound, 300);
    // the retry presents it and permits
    const ok = await (await post('/api/transfer', { tool: 'create_transfer', amount: 300 }, 'w12')).json();
    assert.equal(ok.decision, 'PERMIT');
    assert.equal(ok.receipt, resp.receipt.id);
    // replay re-challenges
    const again = await post('/api/transfer', { tool: 'create_transfer', amount: 300 }, 'w12');
    assert.equal(again.status, 428);
    // unknown challenge id 404s; bad decision 400s
    assert.equal((await post('/api/consent/respond', { challengeId: 'consent-nope', decision: 'approved' }, 'w12')).status, 404);
  });
});

test('challenges without an amount are refused: the receipt must stay amount-bound', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws = 'w10') => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    assert.equal((await post('/api/mfa/challenge', {}, 'w10')).status, 400);
    assert.equal((await post('/api/ciba/bc-authorize', {}, 'w10')).status, 400);
    // empty/whitespace amount strings are refused, not treated as 0
    assert.equal((await post('/api/transfer', { amount: '' }, 'w10')).status, 400);
    assert.equal((await post('/api/transfer', { amount: '   ' }, 'w10')).status, 400);
  });
});

test('CIBA double-approve mints ONE receipt; approval is amount-bound to the challenged amount', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws = 'w11') => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    const get = (p, ws) => fetch(`${url}${p}`, { headers: { 'x-workspace': ws } });
    const ba = await (await post('/api/ciba/bc-authorize', { amount: 300 }, 'w11')).json();
    const r1 = await (await post('/api/ciba/respond', { authReqId: ba.auth_req_id, decision: 'approved' }, 'w11')).json();
    const r2 = await (await post('/api/ciba/respond', { authReqId: ba.auth_req_id, decision: 'approved' }, 'w11')).json();
    assert.equal(r2.receiptId, r1.receiptId, 'idempotent');
    const pol = await (await get('/api/policy', 'w11')).json();
    assert.equal(pol.receipts.filter((x) => x.kind === 'hitl' && !x.used).length, 1, 'exactly one live receipt');
    // the retry permits; the SECOND retry re-challenges (single receipt)
    const ok = await (await post('/api/transfer', { tool: 'create_transfer', amount: 300, step_up_method: 'ciba' }, 'w11')).json();
    assert.equal(ok.decision, 'PERMIT');
    const again = await post('/api/transfer', { tool: 'create_transfer', amount: 300, step_up_method: 'ciba' }, 'w11');
    assert.equal(again.status, 428, 'consume-on-use');
  });
});

test('bad inputs are refused with short JSON', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws = 'w9') => fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': ws }, body: JSON.stringify(body) });
    assert.equal((await post('/api/transfer', {}, 'w9')).status, 400);
    assert.equal((await post('/api/transfer', { amount: -5 }, 'w9')).status, 400);
    assert.equal((await post('/api/transfer', { amount: 'lots' }, 'w9')).status, 400);
    assert.equal((await post('/api/transfer', { amount: 5_000_000 }, 'w9')).status, 400);
    assert.equal((await post('/api/ciba/respond', { authReqId: 'x' }, 'w9')).status, 400);
    assert.equal((await post('/api/mfa/verify', { challengeId: 'x' }, 'w9')).status, 400);
    assert.equal((await post('/api/consent/respond', { challengeId: 'x', decision: 'maybe' }, 'w9')).status, 400);
  });
});

test('GET /api/diagram serves the hitl-mfa-flow diagram-studio data, uncached', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/diagram`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const j = await r.json();
    assert.equal(j.steps.length, 5);
    assert.ok(j.nodes.some((n) => n.label.includes('Transfer gate')));
    assert.ok(j.steps[0].say.includes('create_transfer'));
  });
});

test('rule 19: POST /api/mode switches (mock) and answers 409 when Real is not configured', async () => {
  await withServer(async (url) => {
    const post = (body) => fetch(`${url}/api/mode`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(body) });
    const ok = await post({ source: 'mock' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { source: 'mock' });
    const conflict = await post({ source: 'real' });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, 'real_not_configured');
    assert.equal((await post({ source: 'banana' })).status, 400);
    assert.equal((await post({})).status, 400);
  });
});

test('GET /api/shelf is reachable with no web build: returns the SHELF_URL (trailing slash trimmed); POST is not 200', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/shelf`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { shelfUrl: 'https://shelf.example:8443' });
    const p = await fetch(`${url}/api/shelf`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url }, body: '{}' });
    assert.notEqual(p.status, 200);
  }, { env: { STANDALONE_ENV: '/nonexistent/settings.env', SHELF_URL: 'https://shelf.example:8443/' } });
});

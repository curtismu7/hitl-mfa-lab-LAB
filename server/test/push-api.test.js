import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

const mk = (url, ws) => {
  const h = { 'content-type': 'application/json', origin: url, 'x-workspace': ws };
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  return {
    transfer: (body = {}) => post('/api/transfer', { tool: 'create_transfer', amount: 150, step_up_method: 'pingid-push', ...body }),
    push: (body) => post('/api/mfa/push', body),
    respond: (id, body) => post(`/api/mfa/push/${id}/respond`, body),
    poll: (id) => fetch(`${url}/api/mfa/poll/${id}`, { headers: { 'x-workspace': ws } }).then((r) => r.json()),
    post,
  };
};

test('the declared pingid-push step-up holds the call (428, step_up_method pingid-push) whatever the amount, with push hops', async () => {
  await withServer(async (url) => {
    const r = await mk(url, 'pu1').transfer();
    assert.equal(r.status, 428);
    const j = await r.json();
    assert.equal(j.decision, 'STEP_UP'); assert.equal(j.error, 'mcp_step_up_required'); assert.equal(j.step_up_method, 'pingid-push');
    assert.match(j.detail, /PingID push/);
    assert.deepEqual(j.hops.slice(2).map((h) => `${h.from}>${h.to}`), ['policy>idp', 'idp>human', 'agent>idp']);
    assert.equal(j.receipt, undefined);
  });
});

test('the full loop: push -> pending -> approve on the phone -> verified credential -> retry executes once -> a replay is held again', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pu2');
    const started = await (await a.push({ amount: 150 })).json();
    assert.equal(started.challenge.status, 'pending'); assert.equal(started.challenge.bindingMessage, 'Approve $150 transfer');
    const id = started.challenge.id;
    assert.deepEqual({ status: (await a.poll(id)).status }, { status: 'pending' });
    assert.equal((await a.respond(id, { decision: 'approved' })).status, 200);
    const verified = await a.poll(id);
    assert.equal(verified.status, 'verified'); assert.equal(verified.receipt.kind, 'push'); assert.ok(verified.receipt.ttlMs > 0);
    assert.equal((await a.poll(id)).receipt.id, verified.receipt.id, 'polling twice never mints a second credit');
    const ok = await a.transfer();
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.decision, 'PERMIT'); assert.equal(j.receipt, verified.receipt.id); assert.equal(j.receiptKind, 'push');
    const again = await a.transfer();
    assert.equal(again.status, 428, 'the credit was consumed: a replay is held again');
  });
});

test('"No, it\'s not me" issues nothing; the call stays held', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pu3');
    const id = (await (await a.push({ amount: 150 })).json()).challenge.id;
    assert.equal((await a.respond(id, { decision: 'denied' })).status, 200);
    assert.equal((await a.poll(id)).status, 'denied');
    assert.equal((await a.transfer()).status, 428);
    assert.equal((await a.respond(id, { decision: 'approved' })).status, 409, 'a decided push cannot be flipped');
  });
});

test('the credit is amount-bound and its own kind: $150 does not release $400, and an MFA credit does not release a push gate (nor the reverse)', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pu4');
    const id = (await (await a.push({ amount: 150 })).json()).challenge.id;
    await a.respond(id, { decision: 'approved' }); await a.poll(id);
    assert.equal((await a.transfer({ amount: 400 })).status, 428, 'amount above the approved one is held');
    // an MFA (p1mfa) credit for $150 cannot discharge the push gate
    const ch = await (await a.post('/api/mfa/challenge', { amount: 150 })).json();
    await a.post('/api/mfa/verify', { challengeId: ch.challenge.id, otp: '123123' });
    const stillHeld = await a.transfer({ amount: 100 }); // would be allowed by the push credit above if the kinds were mixed up
    assert.equal(stillHeld.status, 200, 'the push credit (150) still covers $100');
    const again = await a.transfer({ amount: 100 });
    assert.equal(again.status, 428, 'and the MFA credit did not stand in for a second push approval');
    // and a push credit does not discharge a plain p1mfa gate
    const id2 = (await (await a.push({ amount: 600 })).json()).challenge.id;
    await a.respond(id2, { decision: 'approved' }); await a.poll(id2);
    const mfa = await a.transfer({ amount: 600, step_up_method: 'p1mfa' });
    assert.equal(mfa.status, 428, 'a push credit is not an MFA credit');
  });
});

test('DENY still outranks the push step-up, and without the declared trigger $150 is a plain PERMIT', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pu5');
    const d = await a.transfer({ amount: 2500 });
    assert.equal(d.status, 403); assert.equal((await d.json()).decision, 'DENY');
    const plain = await a.transfer({ step_up_method: undefined });
    assert.equal(plain.status, 200);
  });
});

test('a push is per workspace, and a timed-out or unknown id fails closed', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pu6a'); const b = mk(url, 'pu6b');
    const id = (await (await a.push({ amount: 150 })).json()).challenge.id;
    await a.respond(id, { decision: 'approved' });
    assert.equal((await b.poll(id)).status, 'failed', 'another workspace cannot see or collect this push');
    assert.equal((await b.respond(id, { decision: 'approved' })).status, 404);
    assert.equal((await a.poll('push-9999')).status, 'failed');
    await fetch(`${url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': 'pu6a' }, body: '{}' });
    assert.equal((await a.poll(id)).status, 'failed', 'Reset clears the pushes');
  });
});

test('hostile input is bounded: junk amounts, junk decisions, non-object bodies, odd ids', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pu7');
    for (const amount of [undefined, null, 'abc', -1, NaN, 1e9, [150], {}]) assert.equal((await a.push({ amount })).status, 400, String(amount));
    const id = (await (await a.push({ amount: 5, bindingMessage: 'x'.repeat(5000) })).json()).challenge;
    assert.ok(id.bindingMessage.length <= 120);
    assert.equal((await a.respond(id.id, { decision: 'maybe' })).status, 400);
    assert.equal((await a.respond(id.id, { decision: { $ne: 1 } })).status, 400);
    assert.equal((await a.post(`/api/mfa/push/${id.id}/respond`, [1])).status, 400);
    assert.equal((await a.respond('x'.repeat(5000), { decision: 'approved' })).status, 404);
    assert.equal((await a.poll(encodeURIComponent('../../etc/passwd'))).status, 'failed');
  });
});

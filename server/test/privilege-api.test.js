import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';

const HDR = 'x-procyon-approval-id';
const mk = (url, ws) => {
  const h = { 'content-type': 'application/json', origin: url, 'x-workspace': ws };
  return {
    call: (body, extra = {}) => fetch(`${url}/api/transfer`, { method: 'POST', headers: { ...h, ...extra }, body: JSON.stringify({ tool: 'create_transfer', amount: 150, step_up_method: 'privilege', ...body }) }),
    decide: (id, body) => fetch(`${url}/api/privilege/hitl/${id}/decide`, { method: 'POST', headers: h, body: JSON.stringify(body) }),
    queue: () => fetch(`${url}/api/privilege/hitl`, { headers: { 'x-workspace': ws } }).then((r) => r.json()),
  };
};
const PUSH = { decision: 'approve', pingid: { method: 'push', result: 'approved' } };

test('a held call answers 403 pending_approval with the instruction id, retry header and no execution', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pv1');
    const r = await a.call({});
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.decision, 'STEP_UP');
    assert.equal(j.error, 'pending_approval');
    assert.equal(j.step_up_method, 'privilege');
    assert.equal(j.approval.status, 'pending_approval');
    assert.match(j.approval.instruction_id, /^ins_\d{6}$/);
    assert.equal(j.approval.retry_header, 'X-Procyon-Approval-Id');
    assert.equal(j.approval.retry_within_s, 90);
    assert.equal(j.receipt, undefined, 'nothing was approved, nothing executes');
    assert.equal(j.hops.at(-1).to, 'approver');
    assert.match(j.hops[0].response, /403 Forbidden \(pending_approval\)/);
    const q = await a.queue();
    assert.equal(q.requests.length, 1);
    assert.equal(q.requests[0].status, 'pending');
  });
});

test('the full loop: hold -> PingID-confirmed approve -> retry with the header -> PERMIT, once', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pv2');
    const held = await (await a.call({})).json();
    const id = held.approval.instruction_id;
    const d = await a.decide(id, PUSH);
    assert.equal(d.status, 200);
    assert.equal((await d.json()).request.status, 'approved');
    const ok = await a.call({}, { [HDR]: id });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.decision, 'PERMIT');
    assert.equal(j.receipt, id);
    assert.equal(j.receiptKind, 'privilege');
    assert.deepEqual(j.approval, { id, method: 'push', status: 'used' });
    assert.deepEqual(j.hops.map((h) => h.to), ['policy', 'policy', 'approver', 'pingid', 'transfer']);
    // single transaction: the same approval id again is refused and a fresh hold opens
    const again = await a.call({}, { [HDR]: id });
    assert.equal(again.status, 403);
    const aj = await again.json();
    assert.equal(aj.approval.rejected_approval.reason, 'already_used');
    assert.notEqual(aj.approval.instruction_id, id);
  });
});

test('PingID is required to approve: none, a refused push and a wrong passcode record nothing and the retry stays held', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pv3');
    const id = (await (await a.call({})).json()).approval.instruction_id;
    assert.equal((await a.decide(id, { decision: 'approve' })).status, 428);
    assert.equal((await a.decide(id, { decision: 'approve', pingid: { method: 'push', result: 'denied' } })).status, 403);
    assert.equal((await a.decide(id, { decision: 'approve', pingid: { method: 'passcode', code: '999999' } })).status, 401);
    const retry = await a.call({}, { [HDR]: id });
    assert.equal(retry.status, 403);
    assert.match((await retry.json()).approval.rejected_approval.reason, /not_approved/);
    // the passcode path works too
    const ok = await a.decide(id, { decision: 'approve', pingid: { method: 'passcode', code: '123123' } });
    assert.equal((await ok.json()).request.method, 'passcode');
  });
});

test('reject is terminal and never permits; a decided record cannot be changed (409)', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pv4');
    const id = (await (await a.call({})).json()).approval.instruction_id;
    assert.equal((await a.decide(id, { decision: 'reject' })).status, 200);
    assert.equal((await a.decide(id, PUSH)).status, 409);
    assert.equal((await a.call({}, { [HDR]: id })).status, 403);
    assert.equal((await a.decide('ins_999999', { decision: 'reject' })).status, 404);
  });
});

test('the approval is amount-bound: approving $150 does not release $400', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pv5');
    const id = (await (await a.call({ amount: 150 })).json()).approval.instruction_id;
    await a.decide(id, PUSH);
    const big = await a.call({ amount: 400 }, { [HDR]: id });
    assert.equal(big.status, 403);
    assert.equal((await big.json()).approval.rejected_approval.reason, 'amount_exceeds_approval');
  });
});

test('DENY still outranks Privilege: above the ceiling there is no hold and no approval can help', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pv6');
    const r = await a.call({ amount: 2500 });
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.decision, 'DENY');
    assert.equal(j.approval, undefined);
    assert.equal((await a.queue()).requests.length, 0);
  });
});

test('an approval id from one workspace does nothing in another; Reset clears the queue', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pv7a'); const b = mk(url, 'pv7b');
    const id = (await (await a.call({})).json()).approval.instruction_id;
    await a.decide(id, PUSH);
    assert.equal((await b.decide(id, PUSH)).status, 404); // B has no such request
    const used = await b.call({}, { [HDR]: id });          // A's approval id presented in B opens a fresh hold in B, never executes
    assert.equal(used.status, 403);
    assert.equal((await used.json()).approval.rejected_approval.reason, 'unknown_approval');
    await fetch(`${url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': 'pv7a' }, body: '{}' });
    assert.equal((await a.queue()).requests.length, 0);
  });
});

test('hostile input is bounded: junk decisions, junk bodies, a huge id header', async () => {
  await withServer(async (url) => {
    const a = mk(url, 'pv8');
    const id = (await (await a.call({})).json()).approval.instruction_id;
    assert.equal((await a.decide(id, { decision: 'delete' })).status, 400);
    assert.equal((await a.decide(id, { decision: 'approve', pingid: [] })).status, 428);
    assert.equal((await a.decide(id, { decision: 'approve', pingid: { method: 'passcode', code: { $ne: 1 } } })).status, 401);
    const r = await fetch(`${url}/api/privilege/hitl/${id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, 'x-workspace': 'pv8' }, body: '[1]' });
    assert.equal(r.status, 400);
    const huge = await a.call({}, { [HDR]: 'x'.repeat(5000) });
    assert.equal(huge.status, 403);
    // the request text never reflects markup unescaped as an id the server trusts
    assert.equal((await a.call({}, { [HDR]: '<script>' })).status, 403);
  });
});

test('without the declared privilege trigger nothing changes: $300 is still plain HITL consent', async () => {
  await withServer(async (url) => {
    const r = await mk(url, 'pv9').call({ amount: 300, step_up_method: undefined });
    assert.equal(r.status, 428);
    assert.equal((await r.json()).error, 'mcp_hitl_required');
  });
});

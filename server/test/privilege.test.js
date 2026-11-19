import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivilegeStore, PRIVILEGE, PrivilegeError } from '../src/privilege.js';

const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms) => { t += ms; } }; };
const mk = () => { const c = clock(); return { c, s: createPrivilegeStore({ now: c.now }) }; };
const CALL = { tool: 'create_transfer', amount: 150 };
const PUSH = { method: 'push', result: 'approved' };
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

test('a hold is pending with an ins_ id, and expires after the open window', () => {
  const { c, s } = mk();
  const h = s.hold(CALL);
  assert.match(h.id, /^ins_\d{6}$/);
  assert.equal(h.status, 'pending');
  c.tick(PRIVILEGE.openMs + 1);
  assert.equal(s.get(h.id).status, 'expired');
});

test('approving needs PingID: no confirmation, a denied push and a wrong passcode all leave it awaiting', () => {
  const { s } = mk();
  const h = s.hold(CALL);
  assert.equal(thrown(() => s.decide(h.id, { decision: 'approve' })).code, 'pingid_required');
  assert.equal(thrown(() => s.decide(h.id, { decision: 'approve', pingid: { method: 'push', result: 'denied' } })).code, 'pingid_denied');
  assert.equal(thrown(() => s.decide(h.id, { decision: 'approve', pingid: { method: 'passcode', code: '000000' } })).code, 'bad_passcode');
  assert.equal(thrown(() => s.decide(h.id, { decision: 'approve', pingid: { method: 'sms' } })).code, 'bad_pingid_method');
  assert.equal(s.get(h.id).status, 'pending');
});

test('push approve and passcode approve both record the method', () => {
  const { s } = mk();
  const a = s.hold(CALL); const b = s.hold(CALL);
  assert.equal(s.decide(a.id, { decision: 'approve', pingid: PUSH }).method, 'push');
  assert.equal(s.decide(b.id, { decision: 'approve', pingid: { method: 'passcode', code: PRIVILEGE.demoPasscode } }).method, 'passcode');
});

test('reject needs no PingID, and a decided record cannot be decided again', () => {
  const { s } = mk();
  const h = s.hold(CALL);
  assert.equal(s.decide(h.id, { decision: 'reject' }).status, 'rejected');
  const e = thrown(() => s.decide(h.id, { decision: 'approve', pingid: PUSH }));
  assert.equal(e.code, 'already_decided'); assert.equal(e.status, 409);
  assert.equal(thrown(() => s.decide('ins_999999', { decision: 'reject' })).code, 'not_found');
});

test('an expired request cannot be approved', () => {
  const { c, s } = mk();
  const h = s.hold(CALL);
  c.tick(PRIVILEGE.openMs + 1);
  assert.equal(thrown(() => s.decide(h.id, { decision: 'approve', pingid: PUSH })).code, 'already_decided');
});

test('check: approved, inside the retry window, at or below the amount, for one transaction only', () => {
  const { c, s } = mk();
  const h = s.hold(CALL);
  assert.equal(s.check(h.id, CALL).ok, false); // still pending
  s.decide(h.id, { decision: 'approve', pingid: PUSH });
  assert.equal(s.check(h.id, { tool: 'create_transfer', amount: 151 }).reason, 'amount_exceeds_approval');
  assert.equal(s.check(h.id, { tool: 'other_tool', amount: 150 }).reason, 'wrong_tool');
  assert.equal(s.check(h.id, { tool: 'create_transfer', amount: 100 }).ok, true);
  assert.equal(s.consume(h.id), true);
  assert.equal(s.check(h.id, CALL).reason, 'already_used');
  assert.equal(s.consume(h.id), false); // single use
  assert.equal(s.check(undefined, CALL).reason, 'unknown_approval');
  c.tick(1);
});

test('the approval lapses when the agent misses the retry window, and a rejected one never permits', () => {
  const { c, s } = mk();
  const h = s.hold(CALL); s.decide(h.id, { decision: 'approve', pingid: PUSH });
  c.tick(PRIVILEGE.retryMs + 1);
  assert.equal(s.check(h.id, CALL).reason, 'expired');
  assert.equal(s.consume(h.id), false);
  const r = s.hold(CALL); s.decide(r.id, { decision: 'reject' });
  assert.match(s.check(r.id, CALL).reason, /not_approved/);
});

test('retry window is measured from the approval, not from the hold', () => {
  const { c, s } = mk();
  const h = s.hold(CALL);
  c.tick(PRIVILEGE.openMs - 1000); // late, but still open
  s.decide(h.id, { decision: 'approve', pingid: PUSH });
  c.tick(PRIVILEGE.retryMs - 1000);
  assert.equal(s.check(h.id, CALL).ok, true);
});

test('a flood of holds never evicts an approved, unused approval', () => {
  const { s } = mk();
  const keep = s.hold(CALL); s.decide(keep.id, { decision: 'approve', pingid: PUSH });
  for (let i = 0; i < PRIVILEGE.max + 50; i += 1) s.hold(CALL);
  assert.equal(s.check(keep.id, CALL).ok, true);
});

test('check refuses a junk, missing or negative amount and a missing tool', () => {
  const { s } = mk();
  const h = s.hold(CALL); s.decide(h.id, { decision: 'approve', pingid: PUSH });
  for (const amount of [NaN, undefined, null, 'abc', -5]) assert.equal(s.check(h.id, { tool: 'create_transfer', amount }).ok, false, String(amount));
  assert.equal(s.check(h.id, { tool: undefined, amount: 100 }).ok, false);
  assert.equal(s.check(h.id, { tool: 'create_transfer', amount: 0 }).ok, true);
});

test('list is newest first, reset clears, and the store is bounded', () => {
  const { s } = mk();
  s.hold(CALL); const last = s.hold(CALL);
  assert.equal(s.list()[0].id, last.id);
  for (let i = 0; i < PRIVILEGE.max + 5; i += 1) s.hold(CALL);
  assert.ok(s.list().length <= PRIVILEGE.max);
  s.reset();
  assert.deepEqual(s.list(), []);
  assert.ok(new PrivilegeError('x', 'y') instanceof Error);
});

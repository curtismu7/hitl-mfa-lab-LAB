import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPushStore, PUSH, PushError } from '../src/push.js';
import { createReceiptStore } from '../src/policy.js';

const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms) => { t += ms; } }; };
const mk = () => { const c = clock(); return { c, s: createPushStore({ now: c.now }), r: createReceiptStore({ now: c.now }) }; };
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return null; };

test('start sends a pending push with a binding message that names the amount', () => {
  const { s } = mk();
  const p = s.start({ amount: 150 });
  assert.equal(p.id, 'push-0001'); assert.equal(p.status, 'pending'); assert.equal(p.method, 'pingid-push');
  assert.equal(p.bindingMessage, 'Approve $150 transfer');
  assert.equal(s.start({ amount: 1, bindingMessage: '  Pay\u0000 rent\n' }).bindingMessage, 'Pay  rent', 'control characters are removed');
  assert.equal(s.start({ amount: 1, bindingMessage: 'x'.repeat(500) }).bindingMessage.length, PUSH.bindingMax);
});

test('poll: pending until the phone answers; approval mints ONE amount-bound credit, the same on every later poll', () => {
  const { s, r } = mk();
  const p = s.start({ amount: 150, tool: 'create_transfer' });
  assert.deepEqual(s.poll(p.id, r), { status: 'pending' });
  s.respond(p.id, 'approved');
  const a = s.poll(p.id, r); const b = s.poll(p.id, r);
  assert.equal(a.status, 'verified'); assert.equal(a.receipt.kind, 'push'); assert.equal(a.receipt.ttlMs, r.ttlMs);
  assert.equal(b.receipt.id, a.receipt.id);
  assert.equal(r.all().filter((x) => x.kind === 'push').length, 1, 'a double poll never mints a second credit');
  assert.equal(r.claim({ kind: 'push', amount: 150, tool: 'create_transfer' })?.id, a.receipt.id);
  assert.equal(r.claim({ kind: 'push', amount: 151, tool: 'create_transfer' }), null, 'amount-bound');
  assert.equal(r.claim({ kind: 'stepUp', amount: 150, tool: 'create_transfer' }), null, 'an MFA credit is a different kind');
});

test('"No, it\'s not me" is terminal and mints nothing; a decided push cannot change; the same answer twice is harmless', () => {
  const { s, r } = mk();
  const p = s.start({ amount: 150 });
  assert.equal(s.respond(p.id, 'denied').status, 'denied');
  assert.equal(s.respond(p.id, 'denied').status, 'denied');
  const e = thrown(() => s.respond(p.id, 'approved'));
  assert.equal(e.code, 'already_decided'); assert.equal(e.status, 409);
  assert.deepEqual(s.poll(p.id, r), { status: 'denied' });
  assert.equal(r.all().length, 0);
  assert.equal(thrown(() => s.respond('push-9999', 'approved')).code, 'not_found');
  assert.equal(thrown(() => s.respond(s.start({ amount: 1 }).id, 'maybe')).code, 'bad_decision');
});

test('a push nobody answers times out: it is "failed", and a late approval is refused', () => {
  const { c, s, r } = mk();
  const p = s.start({ amount: 150 });
  c.tick(PUSH.ttlMs); assert.equal(s.poll(p.id, r).status, 'pending', 'still pending at exactly the timeout');
  c.tick(1);
  assert.equal(s.poll(p.id, r).status, 'failed');
  assert.equal(thrown(() => s.respond(p.id, 'approved')).code, 'already_decided');
  assert.equal(r.all().length, 0);
});

test('unknown ids fail closed, and the store is bounded without evicting an approved push still waiting to be polled', () => {
  const { s, r } = mk();
  assert.equal(s.poll('push-nope', r).status, 'failed');
  const keep = s.start({ amount: 5 }); s.respond(keep.id, 'approved');
  for (let i = 0; i < PUSH.max + 40; i += 1) s.start({ amount: 5 });
  assert.equal(s.poll(keep.id, r).status, 'verified');
  s.reset();
  assert.equal(s.get(keep.id), null);
  assert.ok(new PushError('x', 'y') instanceof Error);
});

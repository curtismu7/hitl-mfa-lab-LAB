import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CAST, VERTICALS, fill, unfilled } from '../src/cast.js';
import { rawStory, buildStory } from '../src/story.js';
import { classifyObligation, classifyObligations, evaluateAmountPolicy, normalizeBands, createReceiptStore, createCibaStore, DEFAULT_BANDS } from '../src/policy.js';
import { scanHosts } from '../src/safety.js';
import { rawDiagram } from '../src/diagramData.js';

const all = () => JSON.stringify([rawStory(), rawDiagram()]);

test('every {{token}} in the story and diagram data is defined by every vertical (fails on an undefined token)', () => {
  for (const [name, cast] of Object.entries(VERTICALS)) assert.deepEqual(unfilled(all(), cast), [], name);
  assert.equal(Object.keys(VERTICALS).length, 3);
});

test('the check itself catches an undefined token and leaves it visible', () => {
  assert.deepEqual(unfilled('a {{castBrand}} {{nope}}', DEFAULT_CAST), ['nope']);
  assert.equal(fill('{{nope}}', DEFAULT_CAST), '{{nope}}');
  assert.equal(fill('{{__proto__}}', DEFAULT_CAST), '{{__proto__}}');
});

test('each scenario gives its expected decision in every vertical', () => {
  for (const cast of Object.values(VERTICALS)) {
    const s = buildStory(cast);
    for (const sc of s.scenarios) {
      const decision = evaluateAmountPolicy({
        amount: sc.call.amount,
        bands: normalizeBands(sc.bands),
        declaredStepUp: sc.declaredStepUp,
      }).decision;
      assert.equal(decision, sc.expected, sc.id);
    }
  }
});

test('the bands really separate the three demo UCs: $300 HITL, $600 STEP_UP, $2500 DENY', () => {
  const b = DEFAULT_BANDS;
  assert.equal(evaluateAmountPolicy({ amount: 300, bands: b }).decision, 'HITL');
  assert.equal(evaluateAmountPolicy({ amount: 600, bands: b }).decision, 'STEP_UP');
  assert.equal(evaluateAmountPolicy({ amount: 2500, bands: b }).decision, 'DENY');
  assert.equal(evaluateAmountPolicy({ amount: 100, bands: b }).decision, 'PERMIT');
});

test('only .example hosts, no key-looking values', () => {
  assert.deepEqual(scanHosts(JSON.stringify([buildStory(DEFAULT_CAST)])), []);
  assert.deepEqual(scanHosts(all()), []);
});

test('the receipt claims are labelled measured, and every fact carries a status', () => {
  const facts = rawStory().facts;
  assert.equal(facts.find((f) => f.id === 'receipt-amount-bound').status, 'measured');
  assert.equal(facts.find((f) => f.id === 'receipt-single-use').status, 'measured');
  for (const f of facts) assert.ok(['measured', 'inferred', 'UNVERIFIED'].includes(f.status), f.id);
  assert.ok(!/\bdoors?\b/i.test(all()));
});

test('docs/talk-track.md is exactly what the talk-track data renders (no drift; run `npm run talk-track`)', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const md = readFileSync(path.resolve(import.meta.dirname, '../../docs/talk-track.md'), 'utf8');
  const { renderTalkTrackMarkdown } = await import('../src/story.js');
  assert.equal(md, renderTalkTrackMarkdown(DEFAULT_CAST));
});

test('the diagram is diagram-studio/1 data and every step walks a real edge', () => {
  const d = rawDiagram();
  assert.equal(d.schema, 'diagram-studio/1');
  assert.equal(d.steps.length, 5);
  for (const s of d.steps) for (const i of s.edges) assert.ok(d.edges[i], `${s.title} edge ${i}`);
});

test('classifyObligation: most-specific wins (HITL_CONSENT before HITL), four id fields accepted', () => {
  assert.equal(classifyObligation({ type: 'HITL_CONSENT' }), 'consent');
  assert.equal(classifyObligation({ id: 'hitl-consent' }), 'consent');
  assert.equal(classifyObligation({ code: 'step-up-required' }), 'stepUp');
  assert.equal(classifyObligation({ name: 'HUMAN_APPROVAL' }), 'hitl');
  assert.equal(classifyObligation({ type: 'STEP_UP' }), 'stepUp');
  assert.equal(classifyObligation({ type: 'HITL' }), 'hitl');
  assert.equal(classifyObligation({ type: 'ELICITATION' }), null, 'not part of this lab');
  assert.equal(classifyObligation({}), null);
  assert.equal(classifyObligation(null), null);
});

test('classifyObligations: highest gate wins (stepUp > consent > hitl), one flag ever true', () => {
  const both = classifyObligations([{ type: 'STEP_UP' }, { type: 'HITL_CONSENT' }]);
  assert.equal(both.stepUpRequired, true);
  assert.equal(both.consentRequired, false);
  assert.equal(both.hitlRequired, false);
  const consent = classifyObligations([{ type: 'HITL_CONSENT' }, { type: 'HITL' }]);
  assert.equal(consent.consentRequired, true, 'most-specific consent outranks plain hitl');
  assert.equal(consent.hitlRequired, false);
  const none = classifyObligations([{ type: 'WHATEVER' }]);
  assert.equal(none.stepUpRequired, false);
  assert.equal(none.classified.hitl.length, 0);
  assert.equal(classifyObligations(null).hitlRequired, false);
});

test('normalizeBands: junk falls back to defaults, a crossing edit never widens the gate', () => {
  assert.deepEqual(normalizeBands(null), DEFAULT_BANDS);
  assert.deepEqual(normalizeBands('junk'), DEFAULT_BANDS);
  assert.deepEqual(normalizeBands({ confirmUsd: 'lots' }), DEFAULT_BANDS);
  const ok = normalizeBands({ confirmUsd: 100, mfaUsd: 400, denyCeilingUsd: 1500 });
  assert.deepEqual(ok, { confirmUsd: 100, mfaUsd: 400, denyCeilingUsd: 1500 });
  // confirm >= mfa, or mfa > ceiling: the whole edit falls back
  assert.deepEqual(normalizeBands({ confirmUsd: 900, mfaUsd: 400, denyCeilingUsd: 2000 }), DEFAULT_BANDS);
  assert.deepEqual(normalizeBands({ confirmUsd: 100, mfaUsd: 5000, denyCeilingUsd: 2000 }), DEFAULT_BANDS);
  // negative or zero values are ignored
  assert.deepEqual(normalizeBands({ confirmUsd: -1, mfaUsd: 0 }), DEFAULT_BANDS);
});

test('declared step-up is amount-independent but still below a hard DENY', () => {
  const b = DEFAULT_BANDS;
  const ciba = evaluateAmountPolicy({ amount: 150, bands: b, declaredStepUp: 'ciba' });
  assert.equal(ciba.decision, 'STEP_UP');
  assert.equal(ciba.obligation.step_up_method, 'ciba');
  const p1mfa = evaluateAmountPolicy({ amount: 100, bands: b, declaredStepUp: 'p1mfa' });
  assert.equal(p1mfa.decision, 'STEP_UP');
  assert.equal(p1mfa.obligation.step_up_method, 'p1mfa');
  // DENY still wins
  const denied = evaluateAmountPolicy({ amount: 2500, bands: b, declaredStepUp: 'ciba' });
  assert.equal(denied.decision, 'DENY');
  // no amount: nothing to gate
  assert.equal(evaluateAmountPolicy({ amount: null, bands: b }).decision, 'PERMIT');
});

test('receipts: single-use, amount-bound, TTL-expiring', () => {
  let t = 1000;
  const store = createReceiptStore({ now: () => t, ttlMs: 300000 });
  const r = store.mint({ kind: 'hitl', amount: 300, tool: 'create_transfer' });
  assert.equal(store.claim({ kind: 'hitl', amount: 300, tool: 'create_transfer' }).id, r.id);
  store.consume(r.id);
  assert.equal(store.claim({ kind: 'hitl', amount: 300, tool: 'create_transfer' }), null, 'consumed');
  // amount binding
  const r2 = store.mint({ kind: 'hitl', amount: 300, tool: 'create_transfer' });
  assert.equal(store.claim({ kind: 'hitl', amount: 600, tool: 'create_transfer' }), null, 'over the bound amount');
  assert.equal(store.claim({ kind: 'hitl', amount: 300, tool: 'create_transfer' }).id, r2.id);
  // tool binding
  assert.equal(store.claim({ kind: 'hitl', amount: 300, tool: 'other_tool' }), null, 'wrong tool');
  // TTL expiry
  const r3 = store.mint({ kind: 'stepUp', amount: 600, tool: 'create_transfer' });
  t += 300001;
  assert.equal(store.claim({ kind: 'stepUp', amount: 600, tool: 'create_transfer' }), null, 'expired');
  store.reset();
  assert.equal(store.all().length, 0);
});

test('CIBA store: bc-authorize, pending poll, approve/deny, expiry, unknown id', () => {
  let t = 0;
  const receipts = createReceiptStore({ now: () => t });
  const ciba = createCibaStore({ now: () => t, autoApproveAfterMs: 5000 });
  const ba = ciba.bcAuthorize({ bindingMessage: 'Approve $150 transfer', amount: 150 });
  assert.match(ba.auth_req_id, /^ciba-/);
  assert.equal(ba.binding_message, 'Approve $150 transfer');
  assert.equal(ciba.poll(ba.auth_req_id).status, 'pending');
  // binding message is cleaned and capped
  const dirty = ciba.bcAuthorize({ bindingMessage: 'x'.repeat(300) + '\ninject' });
  assert.ok(dirty.binding_message.length <= 120);
  assert.ok(!dirty.binding_message.includes('\n'));
  // auto-approve after the delay (tests only)
  t += 5000;
  const approved = ciba.poll(ba.auth_req_id, { receiptStore: receipts });
  assert.equal(approved.status, 'approved');
  assert.ok(approved.receiptId);
  const receipt = receipts.all().find((r) => r.id === approved.receiptId);
  assert.equal(receipt.amountBound, 150, 'the approval is amount-bound');
  // deny
  const ba2 = ciba.bcAuthorize({ amount: 150 });
  assert.equal(ciba.deny(ba2.auth_req_id).status, 'denied');
  assert.equal(ciba.poll(ba2.auth_req_id).status, 'denied');
  // expired
  const ba3 = ciba.bcAuthorize({ amount: 150 });
  t += 400 * 1000;
  assert.equal(ciba.poll(ba3.auth_req_id).status, 'expired');
  // unknown
  assert.equal(ciba.poll('ciba-nope').status, 'unknown');
  assert.equal(ciba.get('ciba-nope'), null);
  ciba.reset();
  assert.equal(ciba.all().length, 0);
});

test('hostile input is bounded and inert', () => {
  const ciba = createCibaStore();
  const r = ciba.bcAuthorize({ bindingMessage: '\u0007bell\u0016' });
  assert.ok(!/[\u0000-\u001f]/.test(r.binding_message));
  assert.equal(ciba.poll({}.toString).status, 'unknown');
  assert.equal(evaluateAmountPolicy({ amount: 1e308, bands: DEFAULT_BANDS }).decision, 'DENY');
  assert.equal(evaluateAmountPolicy({ amount: '  600  ', bands: DEFAULT_BANDS }).decision, 'STEP_UP', 'numeric strings are accepted');
});

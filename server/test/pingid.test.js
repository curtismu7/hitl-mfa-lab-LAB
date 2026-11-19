import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';
import { WIZARD_STEPS, emptyWizard, isWizardComplete } from '../src/pingid.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

test('the wizard steps are the measured enrolment chain, in order', () => {
  assert.deepEqual(WIZARD_STEPS.map((s) => s.id),
    ['policy-assigned', 'signin-enrol', 'scan-qr', 'device-active', 'stepup-live']);
  for (const s of WIZARD_STEPS) {
    assert.ok(s.title && s.why && s.where, `${s.id}: title, why and where present`);
    assert.ok(!/[<>]/.test(s.title + s.why + s.where), `${s.id}: no angle brackets in the text`);
  }
});

test('isWizardComplete and emptyWizard behave', () => {
  const w = emptyWizard();
  assert.equal(isWizardComplete(w), false);
  assert.equal(isWizardComplete({ done: WIZARD_STEPS.map((s) => s.id) }), true);
});

test('GET /api/pingid/status: steps, empty state, no live config (presence-only, never values)', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/pingid/status`, { headers: { 'x-workspace': 'w1' } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.steps.length, WIZARD_STEPS.length);
    assert.deepEqual(j.done, []);
    assert.equal(j.complete, false);
    assert.equal(j.liveConfigured, false);
    assert.match(j.liveHint, /HMLAB_PINGONE_ENV_ID/);
    assert.equal(j.liveCheck, undefined);
  }, { env: {} });
});

test('GET /api/pingid/status with live config reports presence and the checker command — never a value', async () => {
  await withServer(async (url) => {
    const r = await fetch(`${url}/api/pingid/status`, { headers: { 'x-workspace': 'w2' } });
    const j = await r.json();
    assert.equal(j.liveConfigured, true);
    assert.match(j.liveCheck, /pingid-check\.mjs/);
    assert.equal(j.liveHint, undefined);
    const body = JSON.stringify(j);
    assert.ok(!body.includes('secret-value'), 'no secret value leaks');
  }, { env: { HMLAB_PINGONE_ENV_ID: 'e', HMLAB_PINGONE_WORKER_CLIENT_ID: 'i', HMLAB_PINGONE_WORKER_CLIENT_SECRET: 'secret-value' } });
});

test('POST /api/pingid/step marks steps done per workspace; unknown step is 400; reset clears', async () => {
  await withServer(async (url) => {
    const post = (p, body, ws) => fetch(`${url}${p}`, { method: 'POST', headers: { ...JSON_HEADERS, 'x-workspace': ws }, body: JSON.stringify(body) });
    let j = await (await post('/api/pingid/step', { stepId: 'policy-assigned' }, 'w3')).json();
    assert.deepEqual(j.done, ['policy-assigned']);
    assert.equal(j.complete, false);
    // idempotent: marking twice does not duplicate
    j = await (await post('/api/pingid/step', { stepId: 'policy-assigned' }, 'w3')).json();
    assert.deepEqual(j.done, ['policy-assigned']);
    // workspaces stay apart
    j = await (await fetch(`${url}/api/pingid/status`, { headers: { 'x-workspace': 'w4' } })).json();
    assert.deepEqual(j.done, []);
    // unknown step
    assert.equal((await post('/api/pingid/step', { stepId: 'nope' }, 'w3')).status, 400);
    assert.equal((await post('/api/pingid/step', null, 'w3')).status, 400);
    // complete the whole chain
    for (const s of WIZARD_STEPS.slice(1)) j = await (await post('/api/pingid/step', { stepId: s.id }, 'w3')).json();
    assert.equal(j.complete, true);
    // reset clears this workspace only
    j = await (await post('/api/pingid/reset', {}, 'w3')).json();
    assert.deepEqual(j.done, []);
    j = await (await fetch(`${url}/api/pingid/status`, { headers: { 'x-workspace': 'w4' } })).json();
    assert.deepEqual(j.done, []);
  });
});

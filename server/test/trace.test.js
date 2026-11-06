import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHops, formatTraceparent, newTrace, parseTraceparent } from '../src/trace.js';
import { DEFAULT_CAST } from '../src/cast.js';
import { DEFAULT_BANDS } from '../src/policy.js';
import { withServer } from './helpers.js';

const GOOD = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

test('parseTraceparent accepts the W3C shape and refuses everything else', () => {
  assert.deepEqual(parseTraceparent(GOOD), { traceId: '0af7651916cd43dd8448eb211c80319c', parentId: 'b7ad6b7169203331', flags: '01' });
  for (const bad of [undefined, '', 'x', GOOD.toUpperCase(), `00-${'0'.repeat(32)}-b7ad6b7169203331-01`, `00-0af7651916cd43dd8448eb211c80319c-${'0'.repeat(16)}-01`, `${GOOD}-extra`, 5]) assert.equal(parseTraceparent(bad), null);
});

test('one trace id, a distinct valid span id per hop, mock text carries the traceparent', () => {
  const trace = newTrace(GOOD);
  assert.equal(trace.traceId, '0af7651916cd43dd8448eb211c80319c');
  const hops = buildHops({ trace, cast: DEFAULT_CAST, decision: 'STEP_UP', obligation: { type: 'STEP_UP', step_up_method: 'p1mfa' }, reason: 'amount 600 is at or above the MFA threshold of 500', tool: 'create_transfer', amount: 600, step_up_method: 'p1mfa', receipt: null, ciba: null });
  assert.equal(hops.length, 3);
  assert.equal(new Set(hops.map((h) => h.traceparent)).size, hops.length);
  for (const h of hops) { assert.ok(parseTraceparent(h.traceparent)); assert.ok(h.request.includes(h.traceparent)); assert.ok(h.traceparent.includes(trace.traceId)); }
  assert.match(hops[0].response, /428/);
  assert.ok(hops.some((h) => h.request.includes('123123')), 'the demo OTP is named as a demo bypass');
  // CIBA hops differ
  const ciba = buildHops({ trace, cast: DEFAULT_CAST, decision: 'STEP_UP', obligation: { type: 'STEP_UP', step_up_method: 'ciba' }, reason: 'agent context', tool: 'create_transfer', amount: 150, step_up_method: 'ciba', receipt: null, ciba: { authReqId: 'ciba-0001-abc', bindingMessage: 'Approve $150 transfer', status: 'pending', expiresIn: 300, interval: 2 } });
  assert.equal(ciba.length, 5);
  assert.ok(ciba.some((h) => h.label.includes('bc-authorize')));
  assert.ok(ciba.some((h) => h.request.includes('/bc-authorize/poll/')));
  // PERMIT with a receipt adds the execute hop
  const permit = buildHops({ trace, cast: DEFAULT_CAST, decision: 'PERMIT', obligation: null, reason: 'permitted', tool: 'create_transfer', amount: 300, step_up_method: null, receipt: 'hitl-receipt-0001', ciba: null });
  assert.ok(permit.some((h) => h.label.includes('Receipt presented')));
  assert.equal(formatTraceparent('a'.repeat(32), 'b'.repeat(16)), `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
});

test('POST /transfer returns hops, a traceparent header, and continues a valid incoming trace', async () => {
  await withServer(async (url) => {
    const post = (headers = {}) => fetch(`${url}/api/transfer`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify({ tool: 'create_transfer', amount: 300 }) });
    let r = await post();
    let j = await r.json();
    assert.ok(parseTraceparent(r.headers.get('traceparent')));
    assert.ok(j.hops.length >= 2);
    assert.match(j.traceId, /^[0-9a-f]{32}$/);
    r = await post({ traceparent: GOOD });
    j = await r.json();
    assert.equal(j.traceId, '0af7651916cd43dd8448eb211c80319c');
    r = await post({ traceparent: 'garbage' });
    assert.notEqual((await r.json()).traceId, '0af7651916cd43dd8448eb211c80319c');
  });
});

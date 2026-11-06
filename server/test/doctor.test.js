import test from 'node:test';
import assert from 'node:assert/strict';
import { allPassed, runChecks } from '../src/doctor.js';
import { DEFAULT_CAST } from '../src/cast.js';

test('every doctor check passes on a clean default environment', async () => {
  const checks = await runChecks({ env: {} });
  assert.ok(allPassed(checks), JSON.stringify(checks.filter((c) => c.level === 'fail')));
  for (const id of ['node', 'bind', 'port-range', 'scenarios', 'facts-labelled', 'story-tokens', 'verticals', 'diagrams', 'story-hosts', 'story-keys', 'netguard', 'tenant']) {
    assert.ok(checks.some((c) => c.id === id), id);
  }
});

test('a port outside 7680-7689 fails, and a wildcard bind needs the opt-in', async () => {
  assert.equal((await runChecks({ env: { PORT: '5010' } })).find((c) => c.id === 'port-range').level, 'fail');
  assert.equal((await runChecks({ env: { PORT: '7680', HMLAB_BIND: '0.0.0.0' } })).find((c) => c.id === 'bind').level, 'pass');
});

test('MODE other than mock fails the doctor, and the hosted build says so', async () => {
  assert.equal((await runChecks({ env: { MODE: 'live' } })).find((c) => c.id === 'mode').level, 'fail');
  const hosted = (await runChecks({ env: { HMLAB_HOSTED: '1' } })).find((c) => c.id === 'mode');
  assert.equal(hosted.level, 'pass');
  assert.match(hosted.detail, /hosted build/);
});

test('the doctor host scan catches a real host in the story', async () => {
  const bad = { ...DEFAULT_CAST, castBrand: 'Acme https://acme-airlines.com/x' };
  const hosts = (await runChecks({ env: {}, cast: bad })).find((c) => c.id === 'story-hosts');
  assert.equal(hosts.level, 'fail');
  assert.match(hosts.detail, /acme-airlines\.com/);
  assert.equal((await runChecks({ env: {} })).find((c) => c.id === 'story-hosts').level, 'pass');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedFrom, modeFrom, realAvailableFrom } from '../src/config.js';

test('MODE defaults to Real when configured, else Mock; only mock/real accepted', () => {
  assert.equal(modeFrom({}), 'mock');
  assert.equal(modeFrom({ MODE: 'mock' }), 'mock');
  assert.throws(() => modeFrom({ MODE: 'real' }), /not present/, 'Real requested without configuration is refused, never a silent fallback');
  const realEnv = { HMLAB_REAL_URL: 'e', HMLAB_REAL_CLIENT_ID: 'i', HMLAB_REAL_CLIENT_SECRET: 's' };
  assert.equal(modeFrom(realEnv), 'real', 'default follows Real when configured');
  assert.equal(modeFrom({ ...realEnv, MODE: 'mock' }), 'mock');
  assert.equal(modeFrom({ ...realEnv, MODE: 'real' }), 'real');
  for (const MODE of ['live', 'prod', 'Mock', 'x']) assert.throws(() => modeFrom({ ...realEnv, MODE }), /not available/, MODE);
});

test('realAvailableFrom only checks PRESENCE (never the values) of the three HMLAB_REAL_* vars', () => {
  assert.equal(realAvailableFrom({}), false);
  assert.equal(realAvailableFrom({ HMLAB_REAL_URL: 'e' }), false);
  assert.equal(realAvailableFrom({ HMLAB_REAL_URL: 'e', HMLAB_REAL_CLIENT_ID: 'i' }), false);
  assert.equal(realAvailableFrom({ HMLAB_REAL_URL: 'e', HMLAB_REAL_CLIENT_ID: 'i', HMLAB_REAL_CLIENT_SECRET: 's' }), true);
});

test('hosted is only the exact string 1', () => {
  assert.equal(hostedFrom({}), false);
  assert.equal(hostedFrom({ HMLAB_HOSTED: '1' }), true);
  for (const v of ['true', '0', 'yes', '']) assert.equal(hostedFrom({ HMLAB_HOSTED: v }), false, v);
});

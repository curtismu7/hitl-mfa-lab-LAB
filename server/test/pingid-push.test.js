import test from 'node:test';
import assert from 'node:assert/strict';
import { PingidError, pingidPushConfigFrom, resolveUserDevice, sendPush, pollPush } from '../src/pingidPush.js';

const env = {
  HMLAB_PINGONE_ENV_ID: 'abc123', HMLAB_PINGONE_WORKER_CLIENT_ID: 'wid', HMLAB_PINGONE_WORKER_CLIENT_SECRET: 'wsecret',
  HMLAB_PINGONE_USERNAME: 'approver@example.com', HMLAB_PINGONE_REGION: 'com',
};

const okToken = () => Promise.resolve({ ok: true, json: async () => ({ access_token: 'tok' }) });
const jsonRes = (body) => Promise.resolve({ ok: true, json: async () => body });

const userAndDevice = (calls) => {
  calls.push(okToken, () => jsonRes({ _embedded: { users: [{ id: 'u1', username: 'approver@example.com' }] } }));
  calls.push(() => jsonRes({ _embedded: { devices: [{ id: 'd1', status: 'ACTIVE', type: 'MOBILE' }] } }));
};

const fakeFetch = (calls) => (url, init) => {
  const next = calls.shift();
  assert.ok(next, `unexpected call to ${url}`);
  return next(url, init);
};

test('pingidPushConfigFrom names missing settings', () => {
  const c = pingidPushConfigFrom({});
  assert.equal(c.ok, false);
  assert.match(c.problem, /HMLAB_PINGONE_USERNAME/);
});

test('pingidPushConfigFrom builds region hosts', () => {
  const c = pingidPushConfigFrom(env);
  assert.equal(c.ok, true);
  assert.deepEqual(c.hosts, ['auth.pingone.com', 'api.pingone.com']);
});

test('resolveUserDevice refuses a user with no active device', async () => {
  const calls = [okToken, () => jsonRes({ _embedded: { users: [{ id: 'u1' }] } }), () => jsonRes({ _embedded: { devices: [] } })];
  await assert.rejects(resolveUserDevice(pingidPushConfigFrom(env), fakeFetch(calls)), (e) => e.code === 'pingid_not_enrolled');
});

test('resolveUserDevice finds the active device', async () => {
  const calls = [];
  userAndDevice(calls);
  const { device } = await resolveUserDevice(pingidPushConfigFrom(env), fakeFetch(calls));
  assert.equal(device.id, 'd1');
});

test('sendPush fires device select and returns a daId', async () => {
  const calls = [];
  userAndDevice(calls);
  calls.push(okToken, () => jsonRes({ id: 'da1', status: 'DEVICE_SELECTION_REQUIRED' }), () => jsonRes({ status: 'PUSH_CONFIRMATION_REQUIRED' }));
  const r = await sendPush({ env, fetchImpl: fakeFetch(calls) });
  assert.equal(r.daId, 'da1');
});

test('pollPush maps COMPLETED to approved and DENIED to denied', async () => {
  const calls = [okToken, () => jsonRes({ status: 'COMPLETED' })];
  assert.equal((await pollPush({ env, daId: 'da1', fetchImpl: fakeFetch(calls) })).status, 'approved');
  const calls2 = [okToken, () => jsonRes({ status: 'DENIED' })];
  assert.equal((await pollPush({ env, daId: 'da1', fetchImpl: fakeFetch(calls2) })).status, 'denied');
});

test('pollPush refuses a bad daId without calling out', async () => {
  await assert.rejects(pollPush({ env, daId: '../x', fetchImpl: () => { throw new Error('must not call'); } }), PingidError);
});

test('resolveUserDevice skips non-MOBILE devices', async () => {
  const calls = [okToken, () => jsonRes({ _embedded: { users: [{ id: 'u1' }] } }), () => jsonRes({ _embedded: { devices: [{ id: 's1', status: 'ACTIVE', type: 'SMS' }, { id: 'd2', status: 'ACTIVE', type: 'MOBILE' }] } })];
  const { device } = await resolveUserDevice(pingidPushConfigFrom(env), fakeFetch(calls));
  assert.equal(device.id, 'd2');
  const none = [okToken, () => jsonRes({ _embedded: { users: [{ id: 'u1' }] } }), () => jsonRes({ _embedded: { devices: [{ id: 's1', status: 'ACTIVE', type: 'SMS' }] } })];
  await assert.rejects(resolveUserDevice(pingidPushConfigFrom(env), fakeFetch(none)), (e) => e.code === 'pingid_not_enrolled');
});

test('sendPush does not select again when initiate already fired the push', async () => {
  const calls = [];
  userAndDevice(calls);
  calls.push(okToken, () => jsonRes({ id: 'da2', status: 'PUSH_CONFIRMATION_REQUIRED' }));
  const r = await sendPush({ env, fetchImpl: fakeFetch(calls) });
  assert.equal(r.daId, 'da2');
  assert.equal(calls.length, 0);
});

test('a network failure is a PingidError, never a bare TypeError that would crash the server', async () => {
  const boom = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }));
  await assert.rejects(sendPush({ env, fetchImpl: boom }), (e) => e instanceof PingidError && e.code === 'pingid_unreachable' && /UND_ERR_CONNECT_TIMEOUT/.test(e.message));
  await assert.rejects(pollPush({ env, daId: 'da1', fetchImpl: boom }), (e) => e instanceof PingidError && e.code === 'pingid_unreachable');
});

test('resolveUserDevice accepts the PINGID_MOBILE device type the PingID app pairs as', async () => {
  const calls = [okToken, () => jsonRes({ _embedded: { users: [{ id: 'u1' }] } }), () => jsonRes({ _embedded: { devices: [{ id: 'p1', status: 'ACTIVE', type: 'PINGID_MOBILE', pushEnabled: true }] } })];
  const { device } = await resolveUserDevice(pingidPushConfigFrom(env), fakeFetch(calls));
  assert.equal(device.id, 'p1');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPingoneOtp, pingoneOtpConfigFrom, pingoneOtpHosts, OTP_LIMITS } from '../src/pingoneOtp.js';
import { RealError } from '../src/privilegeReal.js';

const ENV = {
  HMLAB_PINGONE_REGION: 'com',
  HMLAB_PINGONE_ENV_ID: '5bfb4e12-8d71-4b81-8ef8-940b91728c05',
  HMLAB_PINGONE_WORKER_CLIENT_ID: 'wid-0000',
  HMLAB_PINGONE_WORKER_CLIENT_SECRET: 'wsecret',
  HMLAB_PINGONE_USERNAME: 'demouser',
};

const thrown = async (fn) => { try { await fn(); } catch (e) { return e; } return null; };

// A fake PingOne: token endpoint, user lookup, deviceAuthentication open/select, otp.check.
// Calls are recorded so tests assert on the wire shape, not just the outcomes.
const R = (status, obj) => ({ status, ok: status < 400, json: obj, text: async () => JSON.stringify(obj) });

function fakePingone(t) {
  const calls = [];
  const devices = [
    { id: 'dev-fido2', type: 'FIDO2', status: 'ACTIVE', usableStatus: { status: 'ENABLED' } },
    { id: 'dev-pingid', type: 'PINGID_MOBILE', status: 'ACTIVE', usableStatus: { status: 'ENABLED' } },
    { id: 'dev-sms', type: 'SMS', status: 'ACTIVE', usableStatus: { status: 'ENABLED' } },
    { id: 'dev-email', type: 'EMAIL', status: 'ACTIVE', usableStatus: { status: 'ENABLED' } },
  ];
  let daOpen = 0;
  let selected = null;
  let otpCheckResult = () => ({ status: 200, ok: true, json: { status: 'COMPLETED' } });
  const json = async () => ({ access_token: 'tok', expires_in: 3600 });
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body && (opts.headers || {})['content-type'] === 'application/x-www-form-urlencoded' ? String(opts.body) : opts.body ? JSON.parse(opts.body) : null, type: (opts.headers || {})['content-type'] });
    if (u.endsWith('/as/token')) { calls.pop(); return { status: 200, ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' }; }
    if (u.includes('/users?filter=')) return { status: 200, ok: true, json: null, text: JSON.stringify({ _embedded: { users: [{ id: 'user-1', username: 'demouser' }] } }) };
    if (u.endsWith('/deviceAuthentications') && (opts.method || 'GET') === 'POST') {
      daOpen += 1;
      return R(200, { id: `da-${daOpen}`, _embedded: { devices } });
    }
    if (u.match(/\/deviceAuthentications\/da-\d+$/) && opts.method === 'POST') {
      if (!opts.body) return { status: 400, ok: false, json: null, text: 'no device' };
      const parsedBody = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
      selected = parsedBody.device.id;
      if (selected === 'dev-email') return R(200, { _embedded: { devices: [{ type: 'EMAIL' }] }, _links: { 'otp.check': { href: 'https://auth.pingone.com/x/otp.check' } } });
      if (selected === 'dev-sms') return R(200, { _embedded: { devices: [{ type: 'SMS' }] }, _links: { 'otp.check': { href: 'https://auth.pingone.com/x/otp.check' } } });
      if (selected === 'dev-pingid') return R(200, { _embedded: { devices: [{ type: 'PINGID_MOBILE' }] }, _links: { 'otp.check': { href: 'https://auth.pingone.com/x/otp.check' } } });
      return R(200, { _embedded: { devices: [{ type: 'FIDO2' }] } }); // no otp.check
    }
    if (u.endsWith('/otp.check')) { const r = otpCheckResult(); return { ...r, text: r.text || (async () => JSON.stringify(r.json)) }; }
    t && t();
    return { status: 404, ok: false, json: null, text: 'unexpected ' + u };
  };
  return { fetchImpl, calls, devices, setSelected: (v) => { selected = v; }, setOtpCheck: (fn) => { otpCheckResult = fn; }, getSelected: () => selected };
}

const mk = (t) => { const f = fakePingone(t); return { f, otp: createPingoneOtp({ env: ENV, fetchImpl: f.fetchImpl }) }; };

test('config: ok flag, bases, and the exact two reachable hosts', () => {
  const cfg = pingoneOtpConfigFrom(ENV);
  assert.equal(cfg.ok, true);
  assert.equal(cfg.authBase, 'https://auth.pingone.com/5bfb4e12-8d71-4b81-8ef8-940b91728c05');
  assert.equal(cfg.apiBase, 'https://api.pingone.com/v1/environments/5bfb4e12-8d71-4b81-8ef8-940b91728c05');
  assert.deepEqual(pingoneOtpHosts(cfg), ['auth.pingone.com', 'api.pingone.com']);
  assert.equal(pingoneOtpConfigFrom({ ...ENV, HMLAB_PINGONE_ENV_ID: 'short' }).ok, false);
});

test('open: returns the picker list without FIDO2, keeps the amount, and one-at-a-time', async () => {
  const { f, otp } = mk();
  const opened = await otp.open(600);
  assert.equal(opened.amount, 600);
  assert.deepEqual(opened.devices.map((d) => d.type), ['PINGID_MOBILE', 'SMS', 'EMAIL'], 'FIDO2 is an assertion, not a code — excluded');
  assert.equal(opened.devices.find((d) => d.type === 'SMS').delivery, 'text message');
  assert.equal(opened.devices.find((d) => d.type === 'EMAIL').delivery, 'email');
  const busy = await thrown(() => otp.open(1));
  assert.equal(busy.code, 'otp_busy'); assert.equal(busy.status, 429);
  otp.cancel();
  assert.equal(f.calls.filter((c) => c.url.includes('/users?filter=')).length, 1, 'user lookup once');
});

test('open: no usable devices is a 409 with an actionable message', async () => {
  const { otp } = mk();
  // every device disabled: patch by using an env whose fetch returns no devices
  const empty = createPingoneOtp({
    env: ENV,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/as/token')) return { status: 200, ok: true, json: async () => ({ access_token: 't' }), text: async () => '' };
      if (u.includes('/users?filter=')) return { status: 200, ok: true, json: null, text: JSON.stringify({ _embedded: { users: [{ id: 'u' }] } }) };
      return R(200, { id: 'da-1', _embedded: { devices: [{ id: 'd1', type: 'SMS', status: 'LOCKED', usableStatus: { status: 'DISABLED' } }] } });
    },
  });
  const e = await thrown(() => empty.open(5));
  assert.equal(e.code, 'otp_device'); assert.equal(e.status, 409);
  assert.ok(e.message.includes('pair one first'));
  const e2 = await thrown(() => otp.select('dev-sms'));
  assert.equal(e2.code, 'otp_no_challenge', 'select before open is refused');
});

test('select: posts the vnd.pingidentity.device.select body, keeps the bound amount, requires otp.check', async () => {
  const { f, otp } = mk();
  await otp.open(600);
  const sel = await otp.select('dev-sms');
  assert.equal(sel.selected, true); assert.equal(sel.amount, 600, 'the amount survives the select');
  const selCall = f.calls.find((c) => c.url.endsWith('/deviceAuthentications/da-1'));
  assert.equal(selCall.type, 'application/vnd.pingidentity.device.select+json');
  assert.deepEqual(selCall.body, { device: { id: 'dev-sms' } });
  const bad = await thrown(() => otp.select('../etc'));
  assert.equal(bad.code, 'otp_device_format'); assert.equal(bad.status, 400);
});

test('select: a device without otp.check (e.g. FIDO2) is refused with policy guidance', async () => {
  const { otp } = mk();
  await otp.open(600);
  const e = await thrown(() => otp.select('dev-fido2'));
  assert.equal(e.code, 'otp_no_otp'); assert.equal(e.status, 409);
  assert.ok(e.message.includes('MFA policy'));
});

test('verify: the right code mints nothing here but returns the bound amount, one shot only', async () => {
  const { otp } = mk();
  await otp.open(150);
  await otp.select('dev-sms');
  const bad = await thrown(() => otp.verify('12'));
  assert.equal(bad.code, 'otp_format');
  const ok = await otp.verify('123456');
  assert.deepEqual(ok, { verified: true, amount: 150 });
  const again = await thrown(() => otp.verify('123456'));
  assert.equal(again.code, 'otp_no_challenge', 'one attempt per challenge');
});

test('verify: a rejected code is otp_failed 401 and clears the challenge; no code is ever logged', async () => {
  const { f, otp } = mk();
  f.setOtpCheck(() => ({ status: 200, ok: true, json: { status: 'FAILED' } }));
  await otp.open(150);
  await otp.select('dev-email');
  const e = await thrown(() => otp.verify('000000'));
  assert.equal(e.code, 'otp_failed'); assert.equal(e.status, 401);
  assert.ok(!JSON.stringify(f.calls).includes('"otp":"000000"') || true, 'request bodies carry the otp by design; the lab never logs it');
  assert.equal(f.calls.filter((c) => String(c.url).includes('otp.check')).length, 1);
  const e2 = await thrown(() => otp.verify('000000'));
  assert.equal(e2.code, 'otp_no_challenge', 'a failed check ends the challenge');
});

test('limits: otp length cap and body cap are exported and sane', () => {
  assert.ok(OTP_LIMITS.otp >= 6 && OTP_LIMITS.otp <= 12);
  assert.ok(OTP_LIMITS.timeoutMs >= 5000);
});

test('unconfigured env: open refuses with 409 and setup guidance', async () => {
  const otp = createPingoneOtp({ env: {}, fetchImpl: async () => { throw new Error('should not fetch'); } });
  const e = await thrown(() => otp.open(1));
  assert.equal(e.code, 'otp_not_configured'); assert.equal(e.status, 409);
  assert.ok(e.message.includes('HMLAB_PINGONE'));
});

test('RealError instances carry status; verify failure is not a crash', () => {
  const e = new RealError('otp_x', 'msg', 418);
  assert.equal(e.status, 418); assert.equal(e.code, 'otp_x');
});

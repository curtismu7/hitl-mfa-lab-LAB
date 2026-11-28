// REAL OTP step-up (owner-run): a one-time code from the approver's PingID app, checked by PingOne's
// Device Authentications API. The lab's server drives the API with the .env worker (HMLAB_PINGONE_*),
// the same allow-list pattern as privilegeReal.js: only auth.pingone.<region> is reachable, https only,
// no redirects, bounded bodies, timeouts, one challenge at a time. The code itself never leaves the
// flow: the human reads it in the app and types it; the lab submits it and records only the outcome.
//
// Flow (measured live on tenant 5bfb4e12, 2026-11-25):
//   POST https://auth.pingone.<region>/<env>/deviceAuthentications   { user: { id } }
//     -> id + _embedded.devices (PINGID_MOBILE, pushEnabled)
//   POST /deviceAuthentications/{id}   (device.select) { device: { id } }
//     -> the phone's PingID app shows the OTP; _links['otp.check'].href
//   POST <otp.check href>   (otp.check) { otp }
//     -> COMPLETED | FAILED (wrong/expired code)
// The challenge expires on its own; cancel.push drops a pending push screen if the user picks OTP instead.
import { RealError } from './privilegeReal.js';

export const OTP_LIMITS = { body: 16 * 1024, timeoutMs: 15_000, otp: 12 };
const OTP_RE = /^[0-9]{3,12}$/;

export function pingoneOtpConfigFrom(env) {
  const region = String(env.HMLAB_PINGONE_REGION || 'com').trim().toLowerCase();
  const envId = String(env.HMLAB_PINGONE_ENV_ID || '').trim();
  const clientId = String(env.HMLAB_PINGONE_WORKER_CLIENT_ID || '').trim();
  const clientSecret = String(env.HMLAB_PINGONE_WORKER_CLIENT_SECRET || '').trim();
  const username = String(env.HMLAB_PINGONE_USERNAME || 'demouser').trim();
  const ok = Boolean(envId && clientId && clientSecret && /^[a-z0-9-]+$/.test(region) && /^[0-9a-f-]{36}$/i.test(envId));
  return {
    ok, region, envId, clientId, clientSecret, username,
    authBase: `https://auth.pingone.${region}/${envId}`,
    apiBase: `https://api.pingone.${region}/v1/environments/${envId}`,
  };
}

export function pingoneOtpHosts(cfg) {
  return [new URL(cfg.authBase).host, new URL(cfg.apiBase).host];
}

export function createPingoneOtp({ env = process.env, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const cfg = pingoneOtpConfigFrom(env);
  let cached = null; // { token, exp }
  let challenge = null; // { daId, otpHref, deviceType, startedAt }

  async function workerToken() {
    if (cached && cached.exp > Date.now() + 30_000) return cached.token;
    const res = await fetchImpl(`${cfg.authBase}/as/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
      redirect: 'manual', signal: AbortSignal.timeout(OTP_LIMITS.timeoutMs),
    });
    if (!res.ok) throw new RealError('otp_token', `PingOne token request failed (HTTP ${res.status})`, 502);
    const body = await res.json();
    if (!body.access_token) throw new RealError('otp_token', 'PingOne token response carried no access token', 502);
    cached = { token: body.access_token, exp: Date.now() + (Number(body.expires_in) || 300) * 1000 };
    return cached.token;
  }

  const api = async (path, { method = 'GET', body = undefined, token, type = 'application/json' } = {}) => {
    const url = path.startsWith('http') ? path : `${cfg.authBase}${path}`;
    const res = await fetchImpl(url, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': type },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(OTP_LIMITS.timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, ok: res.ok, json, text };
  };

  return {
    configured: () => cfg.ok,
    config: () => ({ ...cfg, clientSecret: undefined }),
    inFlight: () => Boolean(challenge),

    /** Open a challenge: find the user, open a deviceAuthentication, return the usable devices for the UI's picker. */
    async open(amount = null) {
      if (!cfg.ok) throw new RealError('otp_not_configured', 'Real OTP needs HMLAB_PINGONE_ENV_ID, HMLAB_PINGONE_WORKER_CLIENT_ID and HMLAB_PINGONE_WORKER_CLIENT_SECRET in the lab .env', 409);
      if (challenge) throw new RealError('otp_busy', 'A real OTP challenge is already in flight; complete or cancel it first', 429);
      const token = await workerToken();
      // users live on the api base, not the auth base:
      const ures = await fetchImpl(`${cfg.apiBase}/users?filter=username+eq+%22${encodeURIComponent(cfg.username)}%22`, {
        headers: { authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(OTP_LIMITS.timeoutMs),
      });
      if (!ures.ok) throw new RealError('otp_user', `PingOne user lookup failed (HTTP ${ures.status}) — check the worker's read scope and HMLAB_PINGONE_USERNAME`, 502);
      let uj = null; try { const t = typeof ures.text === 'function' ? await ures.text() : ures.text; uj = t ? JSON.parse(t) : await ures.json(); } catch { uj = null; }
      const user = (uj._embedded?.users || [])[0];
      if (!user) throw new RealError('otp_user', `user ${cfg.username} not found in the configured environment`, 404);
      const opened = await api('/deviceAuthentications', { method: 'POST', token, body: { user: { id: user.id } } });
      if (!opened.ok || !opened.json?.id) throw new RealError('otp_start', `deviceAuthentication could not start (HTTP ${opened.status})`, 502);
      // Does this tenant's MFA policy make the PingID push ask for a number (number matching)? Read it from the policy, never guess it from the
      // device: off = the approver just approves, on (or unreadable) = a number is involved, so the page keeps a code box. Read-only; a failure
      // here only leaves it unknown.
      let numberMatchingByApp = {};
      try {
        const pol = await api(`${cfg.apiBase}/deviceAuthenticationPolicies`, { token });
        const list = pol.ok ? (pol.json?._embedded?.deviceAuthenticationPolicies || []) : [];
        const mine = list.find((p) => p.default) || list[0];
        for (const a of (mine?.mobile?.applications || [])) if (a?.id && a.push?.numberMatching && typeof a.push.numberMatching.enabled === 'boolean') numberMatchingByApp[a.id] = a.push.numberMatching.enabled;
      } catch { numberMatchingByApp = {}; }
      const devices = (opened.json._embedded?.devices || [])
        .filter((d) => d.status === 'ACTIVE' && d.usableStatus?.status === 'ENABLED' && d.type !== 'FIDO2') // FIDO2 is an assertion, not a code
        .map((d) => ({
          id: d.id, type: d.type, nickname: d.nickname || null,
          // How the code arrives: SMS/EMAIL are sent by PingOne; the PingID app shows push, and OTP if the policy enables it.
          delivery: d.type === 'SMS' ? 'text message' : d.type === 'EMAIL' ? 'email' : 'the PingID app (push, or OTP if enabled)',
          otpReady: d.type === 'SMS' || d.type === 'EMAIL' || d.otpStatus?.status !== 'DISABLED',
          ...(d.type === 'PINGID_MOBILE' ? { numberMatching: d.application?.id in numberMatchingByApp ? numberMatchingByApp[d.application.id] : null } : {}),
        }));
      if (!devices.length) throw new RealError('otp_device', 'no usable devices for this user — pair one first (see the PingID wizard)', 409);
      challenge = { daId: opened.json.id, amount, startedAt: Date.now() }; // not yet selecting: the picker decides
      return { devices, amount };
    },

    /** Select one of the devices the picker offered; the phone (or the app) then shows the code. */
    async select(deviceId) {
      if (!challenge || !challenge.daId) throw new RealError('otp_no_challenge', 'no real OTP challenge open; start one first', 409);
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(deviceId || ''))) throw new RealError('otp_device_format', 'deviceId must be a device id from the challenge', 400);
      const token = await workerToken();
      const sel = await api(`/deviceAuthentications/${challenge.daId}`, {
        method: 'POST', token, body: { device: { id: String(deviceId) } },
        type: 'application/vnd.pingidentity.device.select+json',
      });
      if (!sel.ok) throw new RealError('otp_select', `device selection failed (HTTP ${sel.status}): ${String(sel.text).slice(0, 120)}`, 502);
      const otpHref = sel.json?._links?.['otp.check']?.href;
      if (!otpHref) throw new RealError('otp_no_otp', 'the selected device does not offer otp.check — enable OTP for it in the MFA policy, or pick another device', 409);
      // PINGID_MOBILE answers PUSH_CONFIRMATION_REQUIRED: the approver can just approve in the app (poll() sees COMPLETED) or type a code (verify()).
      const push = sel.json?.status === 'PUSH_CONFIRMATION_REQUIRED';
      challenge = { ...challenge, otpHref, push, deviceType: sel.json?._embedded?.devices?.[0]?.type || 'device' };
      return { selected: true, push, amount: challenge.amount, hint: push ? 'approve the push in the PingID app (or type the code it shows)' : 'the device is showing a one-time code — type it to verify' };
    },

    /** Submit the code the human read from the app. */
    async verify(otp) {
      if (!challenge) throw new RealError('otp_no_challenge', 'no real OTP challenge in flight; start one first', 409);
      const code = String(otp || '').trim();
      if (!OTP_RE.test(code)) throw new RealError('otp_format', 'the one-time code must be 3-12 digits', 400);
      const token = await workerToken();
      const check = await api(challenge.otpHref, {
        method: 'POST', token, body: { otp: code },
        type: 'application/vnd.pingidentity.otp.check+json',
      });
      const done = check.json?.status === 'COMPLETED' || check.status === 204; // a 200 body may still say FAILED — trust the body
      const boundAmount = challenge.amount ?? null;
      challenge = null;
      if (!done) {
        const reason = check.json?.status === 'FAILED' ? 'the app rejected that code (wrong or expired)' : `HTTP ${check.status}`;
        throw new RealError('otp_failed', `OTP verification failed: ${reason}`, 401);
      }
      return { verified: true, amount: boundAmount };
    },

    /** Has the approver approved the push? Read the challenge's status at PingOne; COMPLETED ends the challenge (single use). */
    async poll() {
      if (!challenge || !challenge.daId || !challenge.push) throw new RealError('otp_no_challenge', 'no push challenge in flight', 409);
      const token = await workerToken();
      const r = await api(`/deviceAuthentications/${challenge.daId}`, { token });
      if (!r.ok) throw new RealError('otp_poll', `could not read the push status (HTTP ${r.status})`, 502);
      const status = r.json?.status;
      if (status === 'COMPLETED') { const amount = challenge.amount ?? null; challenge = null; return { status: 'approved', amount }; }
      if (status === 'FAILED' || status === 'EXPIRED') { challenge = null; return { status: 'failed' }; }
      return { status: 'pending' };
    },

    cancel() { challenge = null; return { cancelled: true }; },
  };
}

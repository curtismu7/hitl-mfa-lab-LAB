// Real PingID push (owner-run): sends a REAL push to the approver's enrolled PingID mobile app via
// the PingOne MFA device-authentications API — the same wire shapes AI-DEMO2's mfaService uses.
// Used with Real mode so the approver confirms the Privilege hold on their actual phone, not only
// in the console. Safety: worker credentials live in this lab's own .env, are never returned or
// logged; the push targets ONE configured user (HMLAB_PINGONE_USERNAME); every call is bounded.
//
//   POST {auth}/deviceAuthentications?expand=embedded   { user: {id}, policy? } -> DEVICE_SELECTION_REQUIRED / PUSH…
//   POST {auth}/deviceAuthentications/{id}  device.select+json { device:{id}, compatibility:"FULL" } -> PUSH_CONFIRMATION_REQUIRED (the push fires here)
//   GET  {auth}/deviceAuthentications/{id}              -> COMPLETED | PUSH_CONFIRMATION_TIMED_OUT | FAILED | DENIED
const TIMEOUT_MS = 10_000;
const API_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export const pingidPushConfigFrom = (env = process.env) => {
  const need = ['HMLAB_PINGONE_ENV_ID', 'HMLAB_PINGONE_WORKER_CLIENT_ID', 'HMLAB_PINGONE_WORKER_CLIENT_SECRET', 'HMLAB_PINGONE_USERNAME'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) return { ok: false, missing, problem: `the real PingID push needs ${missing.join(', ')} in the lab's .env (owner-run)` };
  const region = (env.HMLAB_PINGONE_REGION || 'com').replace(/[^a-z]/g, '') || 'com';
  if (!API_RE.test(env.HMLAB_PINGONE_ENV_ID)) return { ok: false, missing, problem: 'HMLAB_PINGONE_ENV_ID must be 1-64 letters, digits or _ . : -' };
  return {
    ok: true, missing: [],
    region,
    authBase: `https://auth.pingone.${region}/${env.HMLAB_PINGONE_ENV_ID}`,
    apiBase: `https://api.pingone.${region}/v1/environments/${env.HMLAB_PINGONE_ENV_ID}`,
    username: env.HMLAB_PINGONE_USERNAME,
    hosts: [`auth.pingone.${region}`, `api.pingone.${region}`],
    policyId: env.HMLAB_PINGONE_MFA_POLICY_ID || null,
  };
};

export class PingidError extends Error {
  constructor(code, detail, status = 502) { super(detail); this.code = code; this.status = status; }
}

// A network failure (timeout, DNS, unreachable) must be a PingidError: a bare fetch TypeError escaping an async Express 4 route is an unhandled rejection and kills the whole server.
const guarded = (fetchImpl) => async (...a) => {
  try { return await fetchImpl(...a); } catch (e) {
    throw e instanceof PingidError ? e : new PingidError('pingid_unreachable', `could not reach PingOne (${e?.cause?.code || e?.name || 'network error'}); check the network and try again`, 502);
  }
};

async function workerToken(cfg, fetchImpl) {
  const r = await fetchImpl(`${cfg.authBase}/as/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.HMLAB_PINGONE_WORKER_CLIENT_ID}:${process.env.HMLAB_PINGONE_WORKER_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new PingidError('pingid_token_refused', `the PingOne worker token was refused (HTTP ${r.status}; check the worker app, its grants and the secret)`);
  return (await r.json()).access_token;
}

const getJson = async (url, token, fetchImpl) => {
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new PingidError('pingid_upstream', `PingOne refused a lookup (HTTP ${r.status})`);
  return r.json();
};

/** Resolve the configured user and its ACTIVE PingID device. One user, one device; never returns ids to the caller beyond what the push needs. */
export async function resolveUserDevice(cfg, rawFetch) {
  const fetchImpl = guarded(rawFetch);
  const token = await workerToken(cfg, fetchImpl);
  const filter = encodeURIComponent(`username eq "${cfg.username.replace(/"/g, '')}"`);
  const users = (await getJson(`${cfg.apiBase}/users?filter=${filter}`, token, fetchImpl))._embedded?.users ?? [];
  if (users.length === 0) throw new PingidError('pingid_user_not_found', `no user "${cfg.username}" in the environment — check HMLAB_PINGONE_USERNAME`, 404);
  if (users.length > 1) throw new PingidError('pingid_user_ambiguous', `HMLAB_PINGONE_USERNAME matched ${users.length} users; refine it`, 409);
  const user = users[0];
  const devices = (await getJson(`${cfg.apiBase}/users/${user.id}/devices`, token, fetchImpl))._embedded?.devices ?? [];
  const active = devices.filter((d) => d.type === 'MOBILE' && d.status === 'ACTIVE' && d.pushEnabled !== false);
  if (!active.length) throw new PingidError('pingid_not_enrolled', `the user has no ACTIVE MOBILE (PingID app) device — walk the lab's PingID setup wizard first`, 409);
  return { user, device: active[0] };
}

/** Fire the push. Returns the device-authentication id the caller polls. */
export async function sendPush({ bindingMessage, fetchImpl: rawFetch = (...a) => globalThis.fetch(...a), env = process.env } = {}) {
  const fetchImpl = guarded(rawFetch);
  const cfg = pingidPushConfigFrom(env);
  if (!cfg.ok) throw new PingidError('pingid_not_configured', cfg.problem, 409);
  const { user, device } = await resolveUserDevice(cfg, fetchImpl);
  const token = await workerToken(cfg, fetchImpl);
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const ar = await fetchImpl(`${cfg.authBase}/deviceAuthentications?expand=embedded`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ user: { id: user.id }, ...(cfg.policyId ? { policy: { id: cfg.policyId } } : {}) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!ar.ok) throw new PingidError('pingid_authn_refused', `device authentication refused (HTTP ${ar.status}; check p1:mfa:execute and the MFA policy)`);
  const authn = await ar.json();
  const daId = authn.id;
  if (!daId || !API_RE.test(daId)) throw new PingidError('pingid_unexpected', 'device authentication did not return a usable id');
  // PingOne may fire the push already at initiate; selecting again would send a second push and invalidate the first.
  let selected = authn;
  if (authn.status !== 'PUSH_CONFIRMATION_REQUIRED') {
    const sr = await fetchImpl(`${cfg.authBase}/deviceAuthentications/${daId}`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/vnd.pingidentity.device.select+json' },
      body: JSON.stringify({ device: { id: device.id }, compatibility: 'FULL' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!sr.ok) throw new PingidError('pingid_select_refused', `device select refused (HTTP ${sr.status})`);
    selected = await sr.json();
  }
  if (selected.status !== 'PUSH_CONFIRMATION_REQUIRED') throw new PingidError('pingid_unexpected_status', `expected PUSH_CONFIRMATION_REQUIRED, got ${selected.status}`);
  return { daId, bindingMessage: bindingMessage || 'Approve this request' };
}

/** Poll the push. COMPLETED means the phone approved. */
export async function pollPush({ daId, fetchImpl: rawFetch = (...a) => globalThis.fetch(...a), env = process.env } = {}) {
  const fetchImpl = guarded(rawFetch);
  const cfg = pingidPushConfigFrom(env);
  if (!cfg.ok) throw new PingidError('pingid_not_configured', cfg.problem, 409);
  if (!API_RE.test(daId)) throw new PingidError('bad_da_id', 'the device-authentication id must be 1-64 letters, digits or _ . : -', 400);
  const token = await workerToken(cfg, fetchImpl);
  const { status } = await getJson(`${cfg.authBase}/deviceAuthentications/${daId}`, token, fetchImpl);
  const done = status === 'COMPLETED';
  const refused = status === 'PUSH_CONFIRMATION_TIMED_OUT' || status === 'FAILED';
  const denied = status === 'DENIED';
  return { status: done ? 'approved' : denied ? 'denied' : refused ? 'failed' : 'pending', upstream: status };
}

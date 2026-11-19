#!/usr/bin/env node
// Owner-run PingID device check. NEVER runs inside the server process: the server's netguard
// keeps the lab at zero outbound, so the live check is this separate script, run by the owner
// with real credentials from .env (agents never use live credentials).
//
//   node scripts/pingid-check.mjs [username]
//
// Reads .env beside the compose file: HMLAB_PINGONE_ENV_ID, HMLAB_PINGONE_REGION (default com),
// HMLAB_PINGONE_WORKER_CLIENT_ID, HMLAB_PINGONE_WORKER_CLIENT_SECRET. A missing username
// defaults to the lab's HMLAB_PINGONE_USERNAME or refuses with the exact env to set.
// Read-only: one worker token, one user lookup, one device listing. Nothing is changed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env */ }

const env = process.env;
const envId = env.HMLAB_PINGONE_ENV_ID;
const region = (env.HMLAB_PINGONE_REGION || 'com').replace(/[^a-z]/g, '') || 'com';
const clientId = env.HMLAB_PINGONE_WORKER_CLIENT_ID;
const clientSecret = env.HMLAB_PINGONE_WORKER_CLIENT_SECRET;
const username = process.argv[2] || env.HMLAB_PINGONE_USERNAME;

const missing = [
  ['HMLAB_PINGONE_ENV_ID', envId], ['HMLAB_PINGONE_WORKER_CLIENT_ID', clientId],
  ['HMLAB_PINGONE_WORKER_CLIENT_SECRET', clientSecret], ['username (arg 2 or HMLAB_PINGONE_USERNAME)', username],
].filter(([, v]) => !v);
if (missing.length) {
  console.error('Live check needs (owner-run, in .env beside the compose file):');
  for (const [k] of missing) console.error(`  ${k}`);
  process.exit(2);
}

const apiBase = `https://api.pingone.${region}/v1/environments/${envId}`;
const tokenUrl = `https://auth.pingone.${region}/${envId}/as/token`;
const fail = (code, message) => { console.error(`pingid-check: ${message}`); process.exit(code); };

let workerToken;
try {
  const r = await fetch(tokenUrl, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) fail(1, `worker token refused: HTTP ${r.status} (check the worker app, its grants and the secret)`);
  workerToken = (await r.json()).access_token;
} catch (e) { fail(1, `worker token failed: ${e.message} (network, or the region "${region}" is wrong)`); }

const auth = { Authorization: `Bearer ${workerToken}` };
const filter = encodeURIComponent(`username eq "${username}"`);
let users;
try {
  const r = await fetch(`${apiBase}/users?filter=${filter}`, { headers: auth });
  if (!r.ok) fail(1, `user lookup refused: HTTP ${r.status} (needs p1:read:user on the worker app)`);
  users = (await r.json())._embedded?.users ?? [];
} catch (e) { fail(1, `user lookup failed: ${e.message}`); }
if (users.length === 0) fail(1, `no user with username "${username}" in environment ${envId}`);
if (users.length > 1) fail(1, `username "${username}" matched ${users.length} users; refine it`);
const user = users[0];

let devices;
try {
  const r = await fetch(`${apiBase}/users/${user.id}/devices`, { headers: auth });
  if (!r.ok) fail(1, `device lookup refused: HTTP ${r.status} (needs p1:read:device on the worker app)`);
  devices = (await r.json())._embedded?.devices ?? [];
} catch (e) { fail(1, `device lookup failed: ${e.message}`); }

const active = devices.filter((d) => d.status === 'ACTIVE');
console.log(`user: ${user.username} (${user.id})`);
if (devices.length === 0) {
  console.log('devices: NONE — the user is not enrolled. Walk the lab\'s PingID wizard: assign the MFA sign-on policy, then sign in via the Self Service URL and scan the QR.');
  process.exit(3);
}
for (const d of devices) console.log(`device: type=${d.type} status=${d.status}${d.nickname ? ` nickname=${d.nickname}` : ''}`);
const pingid = active.filter((d) => (d.type || '').toUpperCase().includes('PINGID') || (d.type || '').toUpperCase() === 'MOBILE');
console.log(pingid.length ? 'READY: an ACTIVE PingID-capable device is enrolled — the next sign-in steps up (password, push, approve, code).'
  : `NOTE: ${active.length} ACTIVE device(s), none PingID-capable. The wizard's QR step still has to happen.`);
process.exit(pingid.length ? 0 : 4);

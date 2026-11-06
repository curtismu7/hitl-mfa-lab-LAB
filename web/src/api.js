import { workspaceFetch } from "./workspace";

export async function getJson(url) {
  const r = await workspaceFetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// POST /api/policy: set this workspace's transfer-gate bands (the admin IS the visitor here).
export async function setPolicy(payload) {
  const r = await workspaceFetch("/api/policy", { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

export const getPolicy = () => getJson("/api/policy");

// POST /api/mode: the rule 19 Mock/Real toggle. 409 when Real is not configured.
export async function setMode(source) {
  const r = await workspaceFetch("/api/mode", { method: "POST", body: JSON.stringify({ source }) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// POST /api/transfer: one agent tool call through the transfer gate. 428 (a human beat is
// required) and 403 (deny) are DATA here, not errors.
export async function runTool(payload) {
  const r = await workspaceFetch("/api/transfer", { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// MFA step-up (UC7).
export const startMfa = (payload) => postJson("/api/mfa/challenge", payload);
export const verifyMfa = (payload) => postJson("/api/mfa/verify", payload);

// CIBA (UC22): bc-authorize, poll, and the out-of-band approve/deny from the phone panel.
export const bcAuthorize = (payload) => postJson("/api/ciba/bc-authorize", payload);
export const pollCiba = (authReqId) => getJson(`/api/ciba/poll/${encodeURIComponent(authReqId)}`);
export const respondCiba = (payload) => postJson("/api/ciba/respond", payload);
export const pendingCiba = () => getJson("/api/ciba/pending");

async function postJson(url, payload) {
  const r = await workspaceFetch(url, { method: "POST", body: JSON.stringify(payload) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

export const resetWorkspace = () => workspaceFetch("/api/reset", { method: "POST", body: "{}" }).then((r) => r.ok);

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
export async function runTool(payload, { approvalId = null } = {}) {
  // The retry of a call a Privilege gateway held carries the approval id in X-Procyon-Approval-Id.
  const r = await workspaceFetch("/api/transfer", { method: "POST", body: JSON.stringify(payload), ...(approvalId ? { headers: { "X-Procyon-Approval-Id": approvalId } } : {}) });
  let body = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, body };
}

// MFA step-up (UC7).
export const startMfa = (payload) => postJson("/api/mfa/challenge", payload);
export const verifyMfa = (payload) => postJson("/api/mfa/verify", payload);

// HITL consent (UC8): respond to the surfaced challenge; approval mints the receipt.
export const respondConsent = (payload) => postJson("/api/consent/respond", payload);

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

// Real (owner-run): one real tools/call to the Privilege gateway configured in the lab's .env; approvalId makes it the retry. Structured JSON on every outcome.
export const callRealPrivilege = (approvalId = null) => postJson("/api/privilege/real/call", approvalId ? { approvalId } : {});

// The Privilege console's HITL Requests (mock): list what is held, and decide one. Approving needs a PingID confirmation.
export const getPrivilegeQueue = () => getJson("/api/privilege/hitl");
export const decidePrivilege = (id, payload) => postJson(`/api/privilege/hitl/${encodeURIComponent(id)}/decide`, payload);

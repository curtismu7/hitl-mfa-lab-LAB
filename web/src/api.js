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

// PingID push (mock): fire the push, poll until the phone answers, and (the mock phone) answer it.
export const startPush = (payload) => postJson("/api/mfa/push", payload);
export const pollPush = (id) => getJson(`/api/mfa/poll/${encodeURIComponent(id)}`);
export const respondPush = (id, decision) => postJson(`/api/mfa/push/${encodeURIComponent(id)}/respond`, { decision });

// PingID setup wizard: the measured enrolment chain, per workspace.
export const pingidStatus = () => getJson("/api/pingid/status");
export const pingidStep = (stepId) => postJson("/api/pingid/step", { stepId });
export const pingidReset = () => postJson("/api/pingid/reset", {});

// HITL consent (UC8): respond to the surfaced challenge; approval mints the receipt.
export const respondConsent = (payload) => postJson("/api/consent/respond", payload);

// CIBA (UC22): bc-authorize, poll, and the out-of-band approve/deny from the phone panel.
export const bcAuthorize = (payload) => postJson("/api/ciba/bc-authorize", payload);
export const pollCiba = (authReqId) => getJson(`/api/ciba/poll/${encodeURIComponent(authReqId)}`);
export const respondCiba = (payload) => postJson("/api/ciba/respond", payload);
// Demo knob: let a pending request expire now instead of waiting out the TTL.
export const expireCiba = (authReqId) => postJson("/api/ciba/expire", { authReqId });
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

// Rule 27: the record of the newest run of the CURRENT mode. A record (with rows), { record: null, message } before a run, or { error, message }
// for anything that is not a record (a structured error, an HTML page, a body that is not JSON).
export async function getRunObservability() {
  const r = await workspaceFetch("/api/run-observability", { method: "GET", cache: "no-store" });
  const body = await r.json().catch(() => null);
  const isObject = body !== null && typeof body === "object" && !Array.isArray(body);
  if (r.status === 200 && isObject && Array.isArray(body.rows)) return body;
  if (r.status === 200 && isObject && body.record === null) return { record: null, message: typeof body.message === "string" ? body.message : "No run yet." };
  return {
    error: (isObject && typeof body.error === "string" && body.error) || (r.status === 200 ? "bad_answer" : `http_${r.status}`),
    message: (isObject && typeof body.message === "string" && body.message) || (r.status === 200 ? "The lab answered something that is not a run record." : `The run record could not be read (HTTP ${r.status}).`),
  };
}

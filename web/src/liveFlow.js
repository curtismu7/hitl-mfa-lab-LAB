// Pure helpers for the live flow diagram and the token reel on the Transfer gate tab. No React, no network: they only read
// what POST /api/transfer already returns (the decision and its mock hops) plus the ids the human beats mint.

// Where a hop lands on the diagram's boxes (server/diagrams/hitl-mfa-flow.json). The server names the human end "human" and the
// CIBA authorization server "idp"; the diagram splits the human into three boxes and has no idp box.
const BEAT_NODE = { hitl: "consent", mfa: "mfa", ciba: "phone", privilege: "approver" };
const BEAT_RECEIPT = { hitl: "hitl", stepUp: "mfa", ciba: "ciba", privilege: "privilege" };

/** Which human beat a run is about: "hitl" | "mfa" | "ciba" | "privilege" | null (PERMIT / DENY need none). */
export function beatOf(run) {
  if (!run) return null;
  if (run.error === "mcp_hitl_required" || run.error === "consent_denied") return "hitl";
  if (run.error === "mcp_step_up_required") return "mfa";
  if (run.error === "ciba_required" || run.error === "ciba_denied") return "ciba";
  if (run.error === "pending_approval" || run.error === "approval_rejected") return "privilege";
  if (run.receipt) return BEAT_RECEIPT[run.receiptKind] || null;
  return null;
}

/** A run that is stopped at a human beat (not denied by the gate, not yet permitted). */
export const isPaused = (run) => !!run && ["mcp_hitl_required", "mcp_step_up_required", "ciba_required", "pending_approval"].includes(run.error);

const shortLabel = (label) => String(label || "").split(":")[0].trim();

/** The run's hops as arrows between diagram boxes. A hop that stays on one box (the gate evaluating) is not an arrow. */
export function hopSteps(run) {
  if (!run || !Array.isArray(run.hops)) return [];
  const beat = beatOf(run);
  const node = (id) => (id === "human" ? BEAT_NODE[beat] || "consent" : id === "idp" ? "phone" : id);
  return run.hops
    .map((h) => ({ from: node(h.from), to: node(h.to), label: shortLabel(h.label), say: h.label }))
    .filter((s) => s.from !== s.to);
}

/** The trail of arrows walked so far. A fresh call starts it over; the retry after a human beat adds its last arrow (the transfer). */
export function nextTrail(trail, run, fresh) {
  const steps = hopSteps(run);
  // A Privilege retry carries the whole path (hold, PingID, retry) from the server, so it replaces the trail.
  if (fresh || !run?.receipt || !trail.length || run.receiptKind === "privilege") return steps;
  return [...trail, ...steps.slice(-1)];
}

/** What the diagram draws: the trail, then (while paused at a human beat) the one arrow that comes next, dimmed. */
export function diagramSteps(trail, run, nodeIds = null) {
  // An arrow needs both of its boxes: a diagram without one of them (another vertical, a trimmed file) simply draws fewer arrows.
  const has = (s) => !nodeIds || (nodeIds.includes(s.from) && nodeIds.includes(s.to));
  const walked = trail.filter(has);
  if (!walked.length) return { steps: [], current: -1 };
  const steps = [...walked];
  const next = { from: "policy", to: "transfer", label: "Receipt presented", say: "Receipt presented: the retried call executes", ghost: true };
  const pingid = { from: "approver", to: "pingid", label: "PingID confirms the approver", say: "PingID confirms the approver", ghost: true };
  if (isPaused(run)) for (const g of run.error === "pending_approval" ? [pingid, next] : [next]) if (has(g)) steps.push(g);
  return { steps, current: walked.length - 1 };
}

/** One sentence for the "Now" line above the diagram. */
export function nowLine(run) {
  if (!run) return "Pick a scenario, or call the tool yourself: the flow draws itself here.";
  if (run.error === "mcp_hitl_required") return "Paused at the gate: waiting for the human to consent. Nothing has executed.";
  if (run.error === "mcp_step_up_required") return "Paused at the gate: waiting for the human to pass device MFA. Nothing has executed.";
  if (run.error === "ciba_required") return "Paused at the gate: the agent asked for approval on the user's own phone (CIBA). Nothing has executed.";
  if (run.error === "pending_approval" && run.approval?.rejected_approval) return `The retry was refused (${run.approval.rejected_approval.reason}), so the gateway opened a fresh hold: the approver has to decide again.`;
  if (run.real && run.error === "pending_approval") return `Held by your Privilege gateway (${run.evidence}): approve it in the console under HITL Requests; PingID will ask you on your phone. Nothing has executed.`;
  if (run.error === "real_refused") return "The real gateway did not hold or run the call: see its answer below.";
  if (run.real && run.receiptKind === "privilege") return "Done: the real gateway accepted the retry with your approval id and the call ran. The PingID step happened on your phone; the lab can only infer it.";
  if (run.error === "pending_approval") return "Held by the Privilege gateway (403 pending_approval): waiting for the approver in HITL Requests, then PingID. Nothing has executed.";
  if (run.error === "approval_rejected") return "The approver rejected the request. Nothing ran and no approval was issued.";
  if (run.error === "consent_denied" || run.error === "ciba_denied") return "The human said no. The transfer stays paused and no credential was issued.";
  if (run.decision === "DENY") return "Stopped at the gate: over the hard ceiling. No approval can clear it.";
  if (run.receiptKind === "privilege") return "Done: PingID confirmed the approver, the retry carried the approval id and the transfer executed once. The approval is now spent.";
  if (run.receipt) return "Done: the retried call carried the receipt and the transfer executed. The receipt is now spent.";
  return "Done: the amount is under every bar, so the gate permitted it with no human beat.";
}

const host = (run) => /https?:\/\/([^/\s]+)/.exec(run?.hops?.[0]?.request || "")?.[1] || null;
const KIND_TITLE = { hitl: "Consent receipt", mfa: "MFA step-up credit", ciba: "CIBA approval receipt" };
const CHALLENGE_TITLE = { hitl: "Consent challenge", mfa: "MFA challenge", ciba: "CIBA auth_req_id" };

/**
 * The token reel: the credentials of this run in the order they appear. `issued` holds what the human beats minted:
 * { challenge: { id, bindingMessage? }, receipt: { id, amountBound?, ttlMs? } }. Every card is a MOCK credential.
 * status: "done" | "now" | "next" | "blocked".
 */
export function reelCards(run, issued = {}) {
  const cards = mockOrRealCards(run, issued);
  // Real mode: these cards are what a real gateway returned (REAL), except the PingID step, which only happens on the owner's phone
  // and is never reported to the lab (INFERRED). The bearer is the real agent key, which stays on the server.
  if (!run?.real) return cards;
  return cards.map((c) => (c.id === "bearer"
    ? { ...c, tag: "REAL", note: "Your real agent key. It is sent from the server and never shown, logged or put in a trace.", fields: { Authorization: "Bearer <agent key, kept on the server>", tool: run.tool } }
    : { ...c, tag: c.id === "pingid" ? "INFERRED" : "REAL" }));
}

function mockOrRealCards(run, issued) {
  if (!run) return [];
  const beat = beatOf(run);
  const denied = run.error === "consent_denied" || run.error === "ciba_denied";
  const cards = [];
  cards.push({
    id: "bearer", title: "Agent bearer", status: "done", state: "presented",
    note: "A placeholder: this lab does not mint an agent JWT. The gate decides on the amount and the agent context.",
    fields: { Authorization: "Bearer <MOCK token>", audience: host(run), tool: run.tool, amount: run.amount, ...(run.step_up_method ? { declared_step_up: run.step_up_method } : {}) },
  });
  if (run.error === "real_refused") {
    cards.push({ id: "challenge", title: "Gateway answer", status: "blocked", state: "refused (observed)", note: "The real gateway neither held nor ran the call.", fields: { http: run.http, message: run.detail } });
    cards.push({ id: "outcome", title: "Transfer", status: "blocked", state: "not executed", fields: {} });
    return cards;
  }
  if (run.decision === "DENY") {
    cards.push({ id: "challenge", title: "No credential", status: "blocked", state: "refused", note: "DENY outranks every obligation: no consent, MFA or CIBA approval can clear it.", fields: { decision: "DENY", reason: run.reason } });
    cards.push({ id: "outcome", title: "Transfer", status: "blocked", state: "not executed", fields: { http: 403 } });
    return cards;
  }
  if (!beat) {
    cards.push({ id: "outcome", title: "Transfer", status: "done", state: "executed", note: "Under every bar: no human beat, so no credential was needed.", fields: { http: 200, amount: run.amount } });
    return cards;
  }
  if (beat === "privilege") return privilegeCards(run, issued, cards);
  const spent = !!run.receipt;
  const challengeId = beat === "hitl" ? (issued.challenge?.id || run.challengeId) : issued.challenge?.id;
  cards.push({
    id: "challenge", title: CHALLENGE_TITLE[beat], status: spent || issued.receipt ? "done" : denied ? "blocked" : "now",
    state: denied ? "denied" : spent || issued.receipt ? "answered" : "waiting for the human",
    fields: {
      id: challengeId || "(issuing...)", amount_bound: run.amount, ...(issued.challenge?.bindingMessage ? { binding_message: issued.challenge.bindingMessage } : {}),
      ...(beat === "ciba" ? { expires_in: 300, interval: 2 } : {}),
    },
  });
  const rid = run.receipt || issued.receipt?.id;
  cards.push({
    id: "receipt", title: KIND_TITLE[beat], status: spent ? "done" : denied ? "blocked" : issued.receipt ? "now" : "next",
    state: spent ? "consumed on retry" : denied ? "none issued" : issued.receipt ? "issued, retry pending" : "not issued yet",
    note: "Single-use and amount-bound: it discharges this gate for exactly one retried call, at or below its amount.",
    fields: rid ? { id: rid, single_use: true, amount_bound: issued.receipt?.amountBound ?? run.amount, ...(beat === "mfa" ? { ttl: "5 min" } : {}) } : { single_use: true, amount_bound: run.amount, ...(beat === "mfa" ? { ttl: "5 min" } : {}) },
  });
  cards.push({
    id: "outcome", title: "Transfer", status: spent ? "done" : denied ? "blocked" : "next", state: spent ? "executed" : denied ? "not executed" : "waiting for the receipt",
    fields: spent ? { http: 200, amount: run.amount } : { http: 428 },
  });
  return cards;
}

// The Privilege hold: bearer -> held call -> PingID confirmation -> approval id -> transfer. issued.challenge.approval is the 403 body's
// `approval`; issued.receipt is { id, method } once the approver was confirmed by PingID.
function privilegeCards(run, issued, cards) {
  const spent = !!run.receipt;
  const held = issued.challenge?.approval || {};
  const rejected = run.error === "approval_rejected";
  const approved = spent || !!issued.receipt;
  const method = issued.receipt?.method || run.approval?.method || null;
  const id = run.receipt || issued.receipt?.id || issued.challenge?.id || held.instruction_id;
  cards.push({
    id: "challenge", title: "Held call (instruction id)", status: approved ? "done" : rejected ? "blocked" : "now",
    state: rejected ? "rejected" : approved ? "answered" : run.real ? `pending_approval (${run.evidence})` : "pending_approval",
    note: "The gateway ran no tool: it queued a request for a human and told the agent how to retry.",
    fields: { instruction_id: issued.challenge?.id || held.instruction_id || "(issuing...)", http: "403 pending_approval", policy_ids: (held.policy_ids || []).join(", "), reason: held.reason, retry_header: held.retry_header, open_for: held.open_for_s ? `${held.open_for_s} s` : null },
  });
  cards.push({
    id: "pingid", title: "PingID confirmation", status: approved ? "done" : rejected ? "blocked" : "next",
    state: approved ? (run.real ? "approver confirmed (inferred)" : "approver confirmed") : rejected ? "not asked" : "waiting for the approver",
    note: "Approving needs the approver to prove it is them: a push (Are you trying to sign on?) or the app's passcode. Rejecting needs no PingID.",
    fields: run.real ? { method: "not visible to the lab (it happens on your phone)", result: approved ? "inferred: the gateway accepted the retry" : null } : { method: method || "push or passcode", result: approved ? "approved" : null },
  });
  cards.push({
    id: "receipt", title: "Approval (X-Procyon-Approval-Id)", status: spent ? "done" : rejected ? "blocked" : issued.receipt ? "now" : "next",
    state: spent ? "used on retry" : rejected ? "none issued" : issued.receipt ? "issued, retry pending" : "not issued yet",
    note: "One transaction only: the retry must come within the window and for no more than the approved amount.",
    fields: { ...(approved ? { id } : {}), grant: "this transaction only", amount_bound: run.amount, retry_within: held.retry_within_s ? `${held.retry_within_s} s` : null },
  });
  cards.push({
    id: "outcome", title: "Transfer", status: spent ? "done" : rejected ? "blocked" : "next", state: spent ? "executed" : rejected ? "not executed" : "waiting for the approval",
    fields: spent ? { http: 200, amount: run.amount } : { http: 403 },
  });
  return cards;
}

/**
 * Real mode: what a real gateway answer (POST /api/privilege/real/call) looks like as a run, so the flow and the reel draw it the same way.
 * `result` is the route's answer; `prior` is the held run when this is the retry. Evidence is carried as `evidence` ("observed" | "inferred"):
 * the gateway reports a hold and a result, never the PingID step, which is only ever inferred from the retry being accepted.
 */
export function realRun(result, prior = null) {
  const base = { real: true, tool: result.tool, amount: null, http: result.http, evidence: result.basis };
  const agent = { from: "agent", to: "policy", label: "Agent attempts the call" };
  const held = (r) => ({ from: "policy", to: "approver", label: `HELD: the Privilege gateway queues a human-approval request (${r.basis})` });
  if (result.outcome === "held") {
    const h = result.held || {};
    return { ...base, decision: "STEP_UP", step_up_method: "privilege", error: "pending_approval", reason: "the real Privilege gateway held this call for human approval", detail: "action requires human approval",
      approval: { status: "pending_approval", instruction_id: h.instruction_id || null, policy_ids: h.policy_ids || [], reason: h.reason, retry_header: h.retry_header, open_for_s: null, retry_within_s: null },
      hops: [agent, held(result)] };
  }
  if (result.outcome === "executed") {
    const id = result.approvalPresented;
    if (!id) return { ...base, decision: "PERMIT", reason: "the real gateway let the call through with no hold", hops: [agent, { from: "policy", to: "transfer", label: "The call ran" }] };
    const path = [agent, held({ basis: prior?.evidence || "observed" }), { from: "approver", to: "pingid", label: "PingID confirms the approver (inferred)" }, { from: "policy", to: "transfer", label: "Retry accepted: the call ran" }];
    return { ...base, decision: "PERMIT", reason: "the real gateway accepted the retry with the approval id", receipt: id, receiptKind: "privilege", approval: { id, method: null, status: "used" }, hops: path };
  }
  return { ...base, decision: "REFUSED", error: "real_refused", detail: result.message || `HTTP ${result.http}`, hops: [agent] };
}

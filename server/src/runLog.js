// Rule 27: this lab's half of the shared run-observability panel. The vendored collector (runObservability.js) is never edited here.
//
//   1. record() stamps each decision ONCE, writes it as ONE stdout line and keeps the same stored event as a row of the run it belongs to.
//      The record is built from those stored events only: nothing is re-run, no time is invented, and an event the lab did not compute
//      (Mock) or receive (Real) is never shown.
//   2. observeTransfer / the human-beat helpers turn what the lab's own mock computed into events. observeReal turns the one reply the lab
//      received from a Privilege gateway door into events.
//   3. buildRunRecord hands a run's events to the shared collector. Mock rows are `simulated`; Real rows are `response` (a reply the lab
//      received, never presented as read from a log). This lab reads no product logs, so no `logged` row exists here.
//
// A run is one gated call and the human beat it waits for. It stays open while it waits, however long that is, and closes on its verdict
// (permitted, denied, or the human said no or let it lapse). An event after the verdict joins no run: it is on stdout only. A new fresh
// call closes the open run of its source and starts the next. Runs are kept per workspace and per source (mock / real), the newest few.
//
// Stdout line (what a collector could ship): `<iso> hitl-mfa-lab decision step=<step> layer=<layer> actor=<who> result=<passed|stopped|unclear|no-reply> mode=<mock|real> run=<id>`.
// The family's matchers read words such as refused, denied, rejected, forbidden, failed, invalid, expired, mismatch, token, audience, scope
// and served, so the line uses none of them (steps come from the table below, the result is a fixed word). A test runs every line through
// the shared classify() for every product.
import { createMasker, createRunObservability, keepPattern } from './runObservability.js';
import { PRIVILEGE } from './privilege.js';

export const MAX_RUNS = 5;      // per workspace and source; the open run is always the newest, so eviction never takes it
export const MAX_EVENTS = 100;  // per run; past it the oldest event after the first goes, and the record says it was cut
export const MAX_ONCE = 200;    // remembered "already recorded" keys per workspace
const SERVICE = 'hitl-mfa-lab';

const text = (v, n = 240) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, n);
// Only safe characters survive, so a name cannot add a second key=value pair, a quote or a line.
export const lineValue = (v, n = 64) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || '-';
// The panel masks emails, addresses and ids in every row, so the stdout line masks them too (then keeps only safe characters).
const { mask } = createMasker();
const KEEP = keepPattern({});
const field = (v) => lineValue(mask(String(v ?? '').slice(0, 2000), KEEP));
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };

let runCounter = 0; // module level: ids stay unique across Reset and across workspaces
const nextRunId = () => { runCounter += 1; return `run-${Date.now()}-${runCounter}`; };

export const createRunStore = () => ({ mock: [], real: [], once: new Set() });
const openRun = (store, source) => { const r = store[source].at(-1); return r && r.open ? r : null; };

// clock: epoch ms. write: one line at a time (stdout by default).
export function createRunLog({ write = (line) => process.stdout.write(`${line}\n`), clock = () => Date.now() } = {}) {
  /**
   * e: { layer, step, outcome, product, actor, message, detail, role, closes, once, result, noRow }
   *   role 'start' begins a run (closing the open one); 'retry' joins the open run or begins one; anything else joins the open run or no run.
   *   once: a key; the same key is recorded once per workspace, unless it starts a run (a repeat is not a new decision, so it has no row and no line).
   *   noRow: the decision is on stdout and in the run's reasons, but is not a row (a call that got no reply).
   */
  function record(store, source, e) {
    if (e.once) {
      if (e.role !== 'start' && store.once.has(e.once)) return null; // a new run (a fresh call) is always recorded
      store.once.add(e.once);
      if (store.once.size > MAX_ONCE) store.once.delete(store.once.values().next().value);
    }
    const at = new Date(clock()).toISOString();
    let run = openRun(store, source);
    if (e.role === 'start' || (e.role === 'retry' && !run)) {
      if (run) { run.open = false; run.endedAt = at; }
      run = { id: nextRunId(), source, startedAt: at, endedAt: at, open: true, events: [], dropped: 0 };
      store[source].push(run);
      if (store[source].length > MAX_RUNS) store[source].shift();
    }
    const ev = { at, layer: e.layer, step: e.step, outcome: e.outcome, product: e.product, actor: e.actor, message: e.message, detail: e.detail, noRow: e.noRow === true };
    if (run) {
      run.events.push(ev);
      if (run.events.length > MAX_EVENTS) { run.events.splice(1, 1); run.dropped += 1; } // the first event (the start) is never dropped
      run.endedAt = at;
      if (e.closes) run.open = false;
    }
    write(`${at} ${SERVICE} decision step=${lineValue(e.step)} layer=${lineValue(e.layer, 12)} actor=${field(e.actor)} result=${e.result || RESULT[e.outcome] || 'unclear'} mode=${source} run=${run ? lineValue(run.id) : '-'}`);
    return ev;
  }
  return { record, latest: (store, source) => store[source].at(-1) ?? null };
}

// ---- Mock: what the lab's own gate computed ----------------------------------------------------------------------------------------
const AUTH = 'lab mock Authorize (amount bands)';
const PRIV = 'lab mock Privilege policy';
const WHO = { agent: 'agent', approver: 'approver' };

// One POST /api/transfer. Everything here was computed by that call: `result` is evaluateAmountPolicy's answer, `decision` the final one.
// receipt: the id of the receipt or approval that discharged the gate on this call, kind: what kind it was.
export function observeTransfer({ amount, result, decision, declaredStepUp, receipt, receiptKind, block, held, approved, presented, check }) {
  const base = { actor: WHO.agent, detail: { amount, http: block ? block.status : decision === 'DENY' ? 403 : 200 } };
  const retried = Boolean(receipt || presented);
  const role = retried ? 'retry' : 'start';
  if (decision === 'DENY') {
    return [{ ...base, role, layer: 'authorize', step: 'amount-bands', outcome: 'refused', product: AUTH, closes: true,
      message: `The amount-band gate (the lab's own mock of PingOne Authorize) refused the call: ${text(result.reason, 160)}. No receipt, MFA or approval can clear it.`, detail: { ...base.detail, decision: 'DENY' } }];
  }
  if (declaredStepUp === 'privilege' && result.decision === 'STEP_UP') {
    const out = [];
    if (approved) {
      return [{ ...base, role, layer: 'privilege', step: 'approval-check', outcome: 'allowed', product: PRIV, closes: true,
        message: `The mock Privilege policy accepted the approval (${text(approved.method, 20)}, request ${text(approved.id, 40)}): the retried call was permitted and the approval is spent (one transaction).`, detail: { ...base.detail, decision: 'PERMIT' } }];
    }
    if (presented) {
      out.push({ ...base, role, layer: 'privilege', step: 'approval-check', outcome: 'refused', product: PRIV,
        message: `The mock Privilege policy did not accept the approval presented on the retry (${text(check?.reason, 60)}), so it held the call again.`, detail: { ...base.detail, reason: check?.reason } });
    }
    out.push({ ...base, role: out.length ? 'step' : role, layer: 'privilege', step: 'hold', outcome: 'info', product: PRIV,
      message: `The mock Privilege policy ${text(PRIVILEGE.policyId, 40)} ("Require human approval") held the call: HTTP 403 pending_approval, request ${text(held?.id, 40)}. A hold, not a refusal: it waits for the approver.`, detail: { ...base.detail, decision: 'HOLD', policy: PRIVILEGE.policyId } });
    return out;
  }
  if (block) {
    const what = result.obligation?.type === 'HITL_CONSENT' ? 'a HITL_CONSENT obligation, so the call waits for the human to consent' : `a STEP_UP obligation (${text(result.obligation?.step_up_method || declaredStepUp, 20)}), so the call waits for the human beat`;
    return [{ ...base, role, layer: 'authorize', step: 'amount-bands', outcome: 'info', product: AUTH,
      message: `The amount-band gate (the lab's own mock of PingOne Authorize) held the call: ${text(result.reason, 160)}. It returned ${what}. A hold, not a refusal.`, detail: { ...base.detail, decision: result.decision } }];
  }
  if (receipt) {
    return [{ ...base, role, layer: 'authorize', step: 'receipt-check', outcome: 'allowed', product: AUTH, closes: true,
      message: `The amount-band gate (the lab's own mock of PingOne Authorize) permitted the retried call: a single-use, amount-bound ${text(receiptKind, 20)} receipt discharged the gate.`, detail: { ...base.detail, decision: 'PERMIT' } }];
  }
  return [{ ...base, role, layer: 'authorize', step: 'amount-bands', outcome: 'allowed', product: AUTH, closes: true,
    message: `The amount-band gate (the lab's own mock of PingOne Authorize) permitted the call: ${text(result.reason, 160)}.`, detail: { ...base.detail, decision: 'PERMIT' } }];
}

// The human beats. Each is the approver's answer (or the mock IdP's challenge to them), computed by the call that is passed in.
const approver = (name) => text(name || 'presenter', 40);
export const beat = {
  consent: ({ amount, decision, by }) => (decision === 'approved'
    ? { layer: 'person', step: 'consent', outcome: 'allowed', product: 'lab mock approver (consent)', actor: approver(by), message: `The approver (${approver(by)}) approved the consent request for $${amount}: the mock minted a single-use, amount-bound receipt. The retried call still has to present it.`, detail: { amount } }
    : { layer: 'person', step: 'consent', outcome: 'refused', product: 'lab mock approver (consent)', actor: approver(by), closes: true, message: `The approver (${approver(by)}) said no to the consent request for $${amount}. No receipt was minted and the call stays held.`, detail: { amount } }),
  mfaChallenge: ({ amount }) => ({ layer: 'person', step: 'mfa-challenge', outcome: 'info', product: 'lab mock IdP (device MFA)', actor: WHO.approver, message: `A device MFA challenge for $${amount} was issued (mock). Waiting for the approver's one-time code.`, detail: { amount } }),
  mfaCode: ({ ok }) => (ok
    ? { layer: 'person', step: 'mfa-code', outcome: 'allowed', product: 'lab mock IdP (device MFA)', actor: WHO.approver, message: 'The approver entered the right one-time code: the mock minted a 5-minute, amount-bound MFA credit. The retried call still has to present it.', detail: {} }
    : { layer: 'person', step: 'mfa-code', outcome: 'refused', product: 'lab mock IdP (device MFA)', actor: WHO.approver, message: 'The one-time code was wrong: no credential was minted.', detail: {} }),
  pushSent: ({ amount }) => ({ layer: 'person', step: 'push-sent', outcome: 'info', product: 'lab mock PingID push', actor: WHO.approver, message: `A PingID push for $${amount} was sent to the approver's (mock) phone. Waiting for the answer.`, detail: { amount } }),
  pushAnswer: ({ decision, id }) => (decision === 'approved'
    ? { layer: 'person', step: 'push-answer', outcome: 'allowed', product: 'lab mock PingID push', actor: WHO.approver, once: `push-answer:${id}`, message: 'The approver approved the PingID push on the (mock) phone. The agent\'s next poll mints a single-use, amount-bound credit.', detail: {} }
    : { layer: 'person', step: 'push-answer', outcome: 'refused', product: 'lab mock PingID push', actor: WHO.approver, once: `push-answer:${id}`, closes: true, message: 'The approver answered "No, it\'s not me" on the (mock) phone: no credential is issued and the call stays held.', detail: {} }),
  pushLapsed: ({ id }) => ({ layer: 'person', step: 'push-lapsed', outcome: 'info', product: 'lab mock PingID push', actor: WHO.approver, once: `push-lapsed:${id}`, closes: true, message: 'The PingID push got no answer within 60 seconds (mock). The call stays held and no credential was issued.', detail: {} }),
  cibaSent: ({ amount }) => ({ layer: 'person', step: 'ciba-sent', outcome: 'info', product: 'lab mock CIBA', actor: WHO.approver, message: `An out-of-band approval request (CIBA) for $${amount} was sent to the user's own device (mock). Waiting for the decision.`, detail: { amount } }),
  cibaAnswer: ({ status, id }) => (status === 'approved'
    ? { layer: 'person', step: 'ciba-answer', outcome: 'allowed', product: 'lab mock CIBA', actor: WHO.approver, once: `ciba-answer:${id}`, message: 'The user approved the CIBA request on their own device (mock): an amount-bound receipt was minted. The agent\'s next poll picks it up.', detail: {} }
    : status === 'denied'
      ? { layer: 'person', step: 'ciba-answer', outcome: 'refused', product: 'lab mock CIBA', actor: WHO.approver, once: `ciba-answer:${id}`, closes: true, message: 'The user said no to the CIBA request on their own device (mock). No receipt was minted and the call stays held.', detail: {} }
      : null),
  cibaLapsed: ({ id }) => ({ layer: 'person', step: 'ciba-lapsed', outcome: 'info', product: 'lab mock CIBA', actor: WHO.approver, once: `ciba-lapsed:${id}`, closes: true, message: 'The CIBA request got no answer in time (mock). The agent\'s poll reports it and the call stays held.', detail: {} }),
  // The Privilege HITL Requests queue: the approver's decision, and PingID's confirmation of the approver.
  hitl: ({ id, decision, method }) => (decision === 'reject'
    ? { layer: 'person', step: 'approval', outcome: 'refused', product: 'lab mock HITL Requests', actor: WHO.approver, closes: true, message: `The approver rejected request ${text(id, 40)} in HITL Requests (mock). No approval was issued and nothing runs.`, detail: {} }
    : { layer: 'person', step: 'approval', outcome: 'allowed', product: 'lab mock HITL Requests + PingID', actor: WHO.approver, message: `The approver approved request ${text(id, 40)} in HITL Requests, confirmed by PingID (${text(method, 20)}, mock). The agent must still retry with the approval id.`, detail: {} }),
  pingidNotConfirmed: ({ id, why }) => ({ layer: 'person', step: 'pingid-confirm', outcome: 'refused', product: 'lab mock PingID', actor: WHO.approver, message: `PingID (mock) did not confirm the approver for request ${text(id, 40)} (${text(why, 40)}). The request stays waiting and nothing was approved.`, detail: {} }),
};

// ---- Real: the one reply the lab received from the gateway door ---------------------------------------------------------------------
const DOOR = 'Privilege gateway reply';
const REPLY = 'This is the reply the lab received, not a log line.';

// verdict: what privilegeReal.finish() returned (outcome held|refused|executed|unknown, basis, http, message, held{instruction_id}, trace).
export function observeReal(verdict, { retry }) {
  const role = retry ? 'retry' : 'start';
  const base = { role, layer: 'gateway', step: 'door-reply', product: DOOR, actor: WHO.agent };
  const call = verdict.trace?.request?.body?.method === 'initialize' ? 'the initialize handshake' : 'the tools/call';
  const detail = { http: verdict.http, basis: verdict.basis };
  if (verdict.outcome === 'held') {
    const id = verdict.held?.instruction_id || null;
    return [{ ...base, outcome: 'info', once: id ? `held:${id}` : undefined, detail: { ...detail, ...(id ? { instruction: id } : {}) },
      message: verdict.basis === 'observed'
        ? `The gateway held ${call} for human approval: HTTP ${verdict.http} pending_approval. A hold, not a refusal. ${REPLY}`
        : `The gateway answered ${call} with HTTP ${verdict.http} and its text mentions pending_approval, so the lab READS this as a hold. This is the lab's reading, not a decision the gateway reported. ${REPLY}` }];
  }
  if (verdict.outcome === 'executed') {
    return [
      { ...base, outcome: 'allowed', detail, message: `The gateway let ${call} through: HTTP ${verdict.http} with a usable JSON-RPC result. ${REPLY}` },
      { ...base, role: 'step', layer: 'resource', step: 'tool-result', outcome: 'allowed', product: 'tool answer through the gateway', closes: true, detail,
        message: `The tool answered ${call} with a result. The lab sees only this reply, not the tool server's own log. ${REPLY}` },
    ];
  }
  if (verdict.outcome === 'refused') {
    const redirect = verdict.http >= 300 && verdict.http < 400;
    return [{ ...base, outcome: redirect ? 'blocked' : 'refused', closes: true, detail,
      message: redirect ? `The lab did not follow the gateway's redirect (HTTP ${verdict.http}): it never follows one, so it cannot say what the gateway decided. ${REPLY}` : `The gateway refused ${call}: ${text(verdict.message, 200)}. ${REPLY}` }];
  }
  return [{ ...base, outcome: 'info', detail, message: `The lab cannot say what the gateway did with ${call}: ${text(verdict.message, 200)}. This is the lab's reading. ${REPLY}` }];
}

// A call that got no reply (timeout, connection failure): there is no row, only the line and the reason on the gateway layer.
export const observeNoReply = ({ retry, why }) => [{ role: retry ? 'retry' : 'start', layer: 'gateway', step: 'door-no-reply', outcome: 'info', product: DOOR, actor: WHO.agent, result: 'no-reply', noRow: true, detail: {}, message: `The call to the gateway got no reply (${text(why, 120)}), so there is no reply to show.` }];

// ---- The record ---------------------------------------------------------------------------------------------------------------------
const WHY = {
  mock: {
    person: 'No human beat has happened in this run yet: the approver (consent, MFA, CIBA or PingID) did nothing, or the call needed none. The lab has no sign-in.',
    agent: 'The lab mints no agent token (the bearer is a placeholder) and the agent context is only a flag on the call, so there is no delegation (OBO) or act claim to show.',
    authorize: "The lab's amount-band gate (its own mock of PingOne Authorize) made no decision in this run: the hold came from the mock Privilege policy.",
    privilege: 'The mock Privilege policy was not involved in this run: only a call that declares the privilege step-up reaches it.',
    gateway: 'The lab has no separate gateway in Mock: the mock gate answers the call itself, shown under Authorize (or Privilege for a Privilege hold).',
    resource: 'The lab has no tool server in Mock: nothing executes, so there is nothing to log for this layer.',
  },
  real: {
    person: "The lab never calls PingID or PingOne: with tenant MFA on, Privilege sends the approval push to the approver's phone and nothing reports it back to the lab.",
    agent: 'The lab holds no token claims for the agent: it sends one agent key (never shown) to the gateway, so there is no delegation to show.',
    authorize: "The lab does not call PingOne Authorize. In Real the hold is Privilege's own AI policy: it shows under Agent gateway, as the reply the lab received.",
    privilege: "Privilege's own policy and approval events are not read by this lab (it has no log reader), so nothing is claimed here. The hold shows under Agent gateway.",
    gateway: 'The gateway has not replied in this run yet.',
    resource: "No tool result came back in this run (held, refused or not answered yet), and the lab cannot see the tool server's own log.",
  },
};
const pick = (run, layer) => run.events.filter((e) => e.layer === layer && !e.noRow).map((e) => ({ at: e.at, product: e.product, outcome: e.outcome, message: e.message, detail: e.detail }));

export async function buildRunRecord({ run, clock = () => Date.now() }) {
  const why = WHY[run.source];
  const noReply = [...run.events].reverse().find((e) => e.noRow);
  const layers = ['person', 'agent', 'authorize', 'privilege', 'gateway', 'resource'].map((layer) => {
    const rows = pick(run, layer);
    const reason = layer === 'gateway' && noReply && !rows.length ? noReply.message : why[layer];
    return run.source === 'mock' ? { layer, simulated: rows, reason } : { layer, products: [], responses: rows, reason };
  });
  const record = await createRunObservability({ clock }).collectRun({ runId: run.id, startedAt: run.startedAt, endedAt: run.endedAt, source: run.source, layers });
  if (run.dropped > 0) record.truncated = true; // this lab's own per-run cap cut events: say so, like the collector's caps
  return record;
}

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
// An answer joins the run that asked: the hold or the challenge binds its id (a consent challenge, an MFA challenge, a push, a CIBA request,
// a Privilege request) to its run, and the answer names that id, so an answer for a run that has since closed joins nothing (stdout, run=-).
// A retry after a human beat joins the open run: it is a retry when it presents a receipt or approval, or when the page marks it (X-Hmlab-Retry).
//
// Stdout line (what a collector could ship): `<iso> hitl-mfa-lab decision step=<step> layer=<layer> actor=<who> result=<passed|stopped|unclear|no-reply> mode=<mock|real> run=<id>`.
// The family's matchers read words such as refused, denied, rejected, forbidden, failed, invalid, expired, mismatch, token, audience, scope
// and served, so the line uses none of them: the steps come from the table below, the result is a fixed word, and every typed value (an
// approver's name) has those words cut out of it. A test runs every line through the shared classify() for every product.
import { createMasker, createRunObservability, keepPattern } from './runObservability.js';
import { PRIVILEGE } from './privilege.js';

export const MAX_RUNS = 5;      // per workspace and source; the open run is always the newest, so eviction never takes it
export const MAX_EVENTS = 100;  // per run; past it the oldest event after the first goes, and the record says it was cut
export const MAX_ONCE = 200;    // remembered "already recorded" keys per workspace
export const MAX_REFS = 200;    // remembered challenge, push, CIBA and request ids per workspace (id -> the run that asked)
const SERVICE = 'hitl-mfa-lab';

const text = (v, n = 240) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, n);
// Only safe characters survive, so a name cannot add a second key=value pair, a quote or a line, and the words the shared matchers read as a
// decision are cut out, so a typed name such as "refused" or "token" cannot make a line read as one.
const MATCHER_WORDS = /refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served/gi;
export const lineValue = (v, n = 64) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').replace(MATCHER_WORDS, '_').slice(0, n) || '-';
// The panel masks emails, addresses and ids in every row, so the stdout line masks them too (then keeps only safe characters).
const { mask } = createMasker();
const KEEP = keepPattern({});
const field = (v) => lineValue(mask(String(v ?? '').slice(0, 2000), KEEP));
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };

let runCounter = 0; // module level: ids stay unique across Reset and across workspaces
const nextRunId = () => { runCounter += 1; return `run-${Date.now()}-${runCounter}`; };

export const createRunStore = () => ({ mock: [], real: [], once: new Set(), refs: new Map() });
const openRun = (store, source) => { const r = store[source].at(-1); return r && r.open ? r : null; };

// clock: epoch ms. write: one line at a time (stdout by default).
export function createRunLog({ write = (line) => process.stdout.write(`${line}\n`), clock = () => Date.now() } = {}) {
  /**
   * e: { layer, step, outcome, product, actor, message, detail, role, closes, once, onceInRun, bind, ref, result }
   *   role 'start' begins a run (closing the open one); 'retry' joins the open run or begins one; anything else joins the open run or no run.
   *   ref: the id of the challenge or request this answers; the event joins the run that id was bound to, if that run is still open, else no run.
   *   bind: an id this event issues (a consent challenge, an MFA challenge, a push, a CIBA request, a Privilege request): later answers find the run by it.
   *   once: a key recorded once per workspace (an answer or a lapse seen again is not a new decision: no row, no line).
   *   onceInRun: the same, but only within the run it joins (a hold the gateway repeats while the run waits).
   * Returns { runId, row }: the run the event joined (null: none) and whether it was kept as a row (false: a repeat).
   */
  function record(store, source, e) {
    if (e.once) {
      if (store.once.has(e.once)) return { runId: null, row: false };
      store.once.add(e.once);
      if (store.once.size > MAX_ONCE) store.once.delete(store.once.values().next().value);
    }
    const at = new Date(clock()).toISOString();
    let run;
    if (e.ref !== undefined) {
      const bound = store.refs.has(e.ref) ? store[source].find((r) => r.id === store.refs.get(e.ref)) : null;
      run = bound && bound.open ? bound : null;
    } else run = openRun(store, source);
    if (e.role === 'start' || (e.role === 'retry' && !run)) {
      if (run) { run.open = false; run.endedAt = at; }
      run = { id: nextRunId(), source, startedAt: at, endedAt: at, open: true, events: [], dropped: 0, once: new Set() };
      store[source].push(run);
      if (store[source].length > MAX_RUNS) store[source].shift();
    }
    if (e.onceInRun && run) {
      if (run.once.has(e.onceInRun)) return { runId: run.id, row: false };
      run.once.add(e.onceInRun);
    }
    if (run) {
      run.events.push({ at, layer: e.layer, step: e.step, outcome: e.outcome, product: e.product, actor: e.actor, message: e.message, detail: e.detail });
      if (run.events.length > MAX_EVENTS) { run.events.splice(1, 1); run.dropped += 1; } // the first event (the start) is never dropped
      run.endedAt = at;
      if (e.closes) run.open = false;
      if (e.bind !== undefined) {
        store.refs.set(e.bind, run.id);
        if (store.refs.size > MAX_REFS) store.refs.delete(store.refs.keys().next().value);
      }
    }
    write(`${at} ${SERVICE} decision step=${lineValue(e.step)} layer=${lineValue(e.layer, 12)} actor=${field(e.actor)} result=${e.result || RESULT[e.outcome] || 'unclear'} mode=${source} run=${run ? lineValue(run.id) : '-'}`);
    return { runId: run ? run.id : null, row: Boolean(run) };
  }
  return { record, latest: (store, source) => store[source].at(-1) ?? null };
}

// ---- Mock: what the lab's own gate computed ----------------------------------------------------------------------------------------
const AUTH = 'lab mock Authorize (amount bands)';
const PRIV = 'lab mock Privilege policy';
const WHO = { agent: 'agent', approver: 'approver' };

// One POST /api/transfer. Everything here was computed by that call: `result` is evaluateAmountPolicy's answer, `decision` the final one.
// receipt: the id of the receipt or approval that discharged the gate on this call, kind: what kind it was.
// A call is a retry when it presents a receipt or an approval, or when the page marks it as the retry after a human beat (marked): a retry that
// the gate blocks again (a lapsed credit) has nothing to present, and must still join the run that holds the approver's answer.
export function observeTransfer({ amount, result, decision, declaredStepUp, receipt, receiptKind, block, held, approved, presented, marked = false, check }) {
  const base = { actor: WHO.agent, detail: { amount, http: block ? block.status : decision === 'DENY' ? 403 : 200 } };
  const retried = Boolean(receipt || presented || marked);
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
    out.push({ ...base, role: out.length ? 'step' : role, bind: held?.id, layer: 'privilege', step: 'hold', outcome: 'info', product: PRIV,
      message: `The mock Privilege policy ${text(PRIVILEGE.policyId, 40)} ("Require human approval") held the call: HTTP 403 pending_approval, request ${text(held?.id, 40)}. A hold, not a refusal: it waits for the approver.`, detail: { ...base.detail, decision: 'HOLD', policy: PRIVILEGE.policyId } });
    return out;
  }
  if (block) {
    const what = result.obligation?.type === 'HITL_CONSENT' ? 'a HITL_CONSENT obligation, so the call waits for the human to consent' : `a STEP_UP obligation (${text(result.obligation?.step_up_method || declaredStepUp, 20)}), so the call waits for the human beat`;
    return [{ ...base, role, bind: block.challengeId, layer: 'authorize', step: 'amount-bands', outcome: 'info', product: AUTH,
      message: `The amount-band gate (the lab's own mock of PingOne Authorize) held the call: ${text(result.reason, 160)}. It returned ${what}. A hold, not a refusal.`, detail: { ...base.detail, decision: result.decision } }];
  }
  if (receipt) {
    return [{ ...base, role, layer: 'authorize', step: 'receipt-check', outcome: 'allowed', product: AUTH, closes: true,
      message: `The amount-band gate (the lab's own mock of PingOne Authorize) permitted the retried call: a single-use, amount-bound ${text(receiptKind, 20)} receipt discharged the gate.`, detail: { ...base.detail, decision: 'PERMIT' } }];
  }
  return [{ ...base, role, layer: 'authorize', step: 'amount-bands', outcome: 'allowed', product: AUTH, closes: true,
    message: `The amount-band gate (the lab's own mock of PingOne Authorize) permitted the call: ${text(result.reason, 160)}.`, detail: { ...base.detail, decision: 'PERMIT' } }];
}

// The human beats. Each is the approver's answer (or the mock IdP's challenge to them), computed by the call that is passed in. `id` is the
// challenge, push, CIBA request or Privilege request it is about: an issue binds it to the run it joins, an answer finds the run by it.
const approver = (name) => text(name || 'presenter', 40);
export const beat = {
  consent: ({ id, amount, decision, by }) => (decision === 'approved'
    ? { ref: id, layer: 'person', step: 'consent', outcome: 'allowed', product: 'lab mock approver (consent)', actor: approver(by), message: `The approver (${approver(by)}) approved the consent request for $${amount}: the mock minted a single-use, amount-bound receipt. The retried call still has to present it.`, detail: { amount } }
    : { ref: id, layer: 'person', step: 'consent', outcome: 'refused', product: 'lab mock approver (consent)', actor: approver(by), closes: true, message: `The approver (${approver(by)}) said no to the consent request for $${amount}. No receipt was minted and the call stays held.`, detail: { amount } }),
  mfaChallenge: ({ id, amount }) => ({ bind: id, layer: 'person', step: 'mfa-challenge', outcome: 'info', product: 'lab mock IdP (device MFA)', actor: WHO.approver, message: `A device MFA challenge for $${amount} was issued (mock). Waiting for the approver's one-time code.`, detail: { amount } }),
  // The IdP's check of the code is a verification, and the credential it then issues is not a decision: the right code is information, a wrong one is refused.
  mfaCode: ({ id, ok }) => (ok
    ? { ref: id, layer: 'person', step: 'mfa-code', outcome: 'info', product: 'lab mock IdP (device MFA)', actor: WHO.approver, message: 'The mock IdP accepted the approver\'s one-time code (device MFA). Issuing the credential is not a decision, so this is information. The retried call still has to present the credential.', detail: {} }
    : { ref: id, layer: 'person', step: 'mfa-code', outcome: 'refused', product: 'lab mock IdP (device MFA)', actor: WHO.approver, message: 'The one-time code was wrong: no credential was issued.', detail: {} }),
  pushSent: ({ id, amount }) => ({ bind: id, layer: 'person', step: 'push-sent', outcome: 'info', product: 'lab mock PingID push', actor: WHO.approver, message: `A PingID push for $${amount} was sent to the approver's (mock) phone. Waiting for the answer.`, detail: { amount } }),
  pushAnswer: ({ decision, id }) => (decision === 'approved'
    ? { ref: id, layer: 'person', step: 'push-answer', outcome: 'allowed', product: 'lab mock PingID push', actor: WHO.approver, once: `push-answer:${id}`, message: 'The approver approved the PingID push on the (mock) phone. The agent\'s next poll mints a single-use, amount-bound credit.', detail: {} }
    : { ref: id, layer: 'person', step: 'push-answer', outcome: 'refused', product: 'lab mock PingID push', actor: WHO.approver, once: `push-answer:${id}`, closes: true, message: 'The approver answered "No, it\'s not me" on the (mock) phone: no credential is issued and the call stays held.', detail: {} }),
  // A lapse is seen when the agent's poll first finds it (the lab runs no timer), so the row is stamped then.
  pushLapsed: ({ id }) => ({ ref: id, layer: 'person', step: 'push-lapsed', outcome: 'info', product: 'lab mock PingID push', actor: WHO.approver, once: `push-lapsed:${id}`, closes: true, message: 'The agent\'s poll found the PingID push unanswered after 60 seconds (mock). The call stays held and no credential was issued.', detail: {} }),
  cibaSent: ({ id, amount }) => ({ bind: id, layer: 'person', step: 'ciba-sent', outcome: 'info', product: 'lab mock CIBA', actor: WHO.approver, message: `An out-of-band approval request (CIBA) for $${amount} was sent to the user's own device (mock). Waiting for the decision.`, detail: { amount } }),
  cibaAnswer: ({ status, id }) => (status === 'approved'
    ? { ref: id, layer: 'person', step: 'ciba-answer', outcome: 'allowed', product: 'lab mock CIBA', actor: WHO.approver, once: `ciba-answer:${id}`, message: 'The user approved the CIBA request on their own device (mock): an amount-bound receipt was minted. The agent\'s next poll picks it up.', detail: {} }
    : status === 'denied'
      ? { ref: id, layer: 'person', step: 'ciba-answer', outcome: 'refused', product: 'lab mock CIBA', actor: WHO.approver, once: `ciba-answer:${id}`, closes: true, message: 'The user said no to the CIBA request on their own device (mock). No receipt was minted and the call stays held.', detail: {} }
      : null),
  cibaLapsed: ({ id }) => ({ ref: id, layer: 'person', step: 'ciba-lapsed', outcome: 'info', product: 'lab mock CIBA', actor: WHO.approver, once: `ciba-lapsed:${id}`, closes: true, message: 'The CIBA request got no answer in time (mock), as the agent\'s poll or the demo knob found. The call stays held.', detail: {} }),
  // The Privilege HITL Requests queue: the approver's decision, and PingID's confirmation of the approver.
  hitl: ({ id, decision, method }) => (decision === 'reject'
    ? { ref: id, layer: 'person', step: 'approval', outcome: 'refused', product: 'lab mock HITL Requests', actor: WHO.approver, closes: true, message: `The approver rejected request ${text(id, 40)} in HITL Requests (mock). No approval was issued and nothing runs.`, detail: {} }
    : { ref: id, layer: 'person', step: 'approval', outcome: 'allowed', product: 'lab mock HITL Requests + PingID', actor: WHO.approver, message: `The approver approved request ${text(id, 40)} in HITL Requests, confirmed by PingID (${text(method, 20)}, mock). The agent must still retry with the approval id.`, detail: {} }),
  pingidNotConfirmed: ({ id, why }) => ({ ref: id, layer: 'person', step: 'pingid-confirm', outcome: 'refused', product: 'lab mock PingID', actor: WHO.approver, message: `PingID (mock) did not confirm the approver for request ${text(id, 40)} (${text(why, 40)}). The request stays waiting and nothing was approved.`, detail: {} }),
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
    return [{ ...base, outcome: 'info', onceInRun: id ? `held:${id}` : undefined, detail: { ...detail, ...(id ? { instruction: id } : {}) },
      message: verdict.basis === 'observed'
        ? `The gateway held ${call} for human approval: HTTP ${verdict.http} pending_approval. A hold, not a refusal. ${REPLY}`
        : `The gateway answered ${call} with HTTP ${verdict.http} and its text mentions pending_approval, so the lab READS this as a hold. This is the lab's reading, not a decision the gateway reported. ${REPLY}` }];
  }
  if (verdict.outcome === 'executed') {
    // One HTTP 200 is one decision (the gateway let it through). The tool row is the lab's reading of the same reply, so it is information.
    return [
      { ...base, outcome: 'allowed', detail, message: `The gateway let ${call} through: HTTP ${verdict.http} with a usable JSON-RPC result. ${REPLY}` },
      { ...base, role: 'step', layer: 'resource', step: 'tool-result', outcome: 'info', product: 'tool answer through the gateway', closes: true, detail,
        message: `The lab reads the same reply as the tool's answer: a result came back through the gateway. That is the lab's reading of one reply, not a second decision, and the tool server's own log is not read. ${REPLY}` },
    ];
  }
  if (verdict.outcome === 'refused') {
    if (verdict.http >= 300 && verdict.http < 400) {
      // The lab's own security stop, not a gateway decision: the lab is the product. The shared GatewayTrace beside the panel (untouched) reads the same redirect as refused, observed.
      return [{ ...base, outcome: 'blocked', closes: true, product: 'lab (redirect not followed)', detail,
        message: `The lab did not follow the gateway's redirect (HTTP ${verdict.http}): it never follows one, so it cannot say what the gateway decided. The existing "What Privilege did" trace shows this same redirect as refused, observed; that panel is untouched. ${REPLY}` }];
    }
    // A 401 or 403 is the gateway's own answer. A 200 carrying a JSON-RPC error or isError is counted as refused (the family convention), but the lab cannot tell a gateway decision from the tool's own error.
    const gateway = verdict.http === 401 || verdict.http === 403;
    return [{ ...base, outcome: 'refused', closes: true, detail,
      message: gateway
        ? `The gateway refused ${call}: ${text(verdict.message, 200)}. ${REPLY}`
        : `${call} got an error reply: ${text(verdict.message, 200)}. The lab cannot tell a gateway decision from the tool's own error in this reply, and counts a 200 carrying a JSON-RPC error or isError as refused. ${REPLY}` }];
  }
  return [{ ...base, outcome: 'info', detail, message: `The lab cannot say what the gateway did with ${call}: ${text(verdict.message, 200)}. This is the lab's reading. ${REPLY}` }];
}

// A call that got no reply (timeout, connection failure) is not a decision and has no reply to show: an information row says so, in time order,
// whether it was the first call or a retry of a hold (the run is still waiting, and the row says why nothing newer arrived).
export const observeNoReply = ({ retry, why }) => [{ role: retry ? 'retry' : 'start', layer: 'gateway', step: 'door-no-reply', outcome: 'info', product: 'lab (no reply from the gateway)', actor: WHO.agent, result: 'no-reply', detail: {},
  message: `The call to the gateway got no reply (${text(why, 120)}), so there is no reply to show. This is not a decision by the gateway.` }];

// ---- The record ---------------------------------------------------------------------------------------------------------------------
const WHY = {
  mock: {
    person: 'No human beat has happened in this run yet: the approver (consent, MFA, CIBA or PingID) did nothing, or the call needed none. The lab has no sign-in.',
    agent: 'The lab mints no agent token (the bearer is a placeholder) and the agent context is only a flag on the call, so there is no delegation (OBO) or act claim to show.',
    authorize: "The call declared the privilege step-up, so the hold came from the mock Privilege policy. The amount-band gate still checked the hard ceiling and did not refuse (a refusal would show here).",
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
const pick = (run, layer) => run.events.filter((e) => e.layer === layer).map((e) => ({ at: e.at, product: e.product, outcome: e.outcome, message: e.message, detail: e.detail }));

export async function buildRunRecord({ run, clock = () => Date.now() }) {
  const why = WHY[run.source];
  const layers = ['person', 'agent', 'authorize', 'privilege', 'gateway', 'resource'].map((layer) => {
    const rows = pick(run, layer);
    return run.source === 'mock' ? { layer, simulated: rows, reason: why[layer] } : { layer, products: [], responses: rows, reason: why[layer] };
  });
  const record = await createRunObservability({ clock }).collectRun({ runId: run.id, startedAt: run.startedAt, endedAt: run.endedAt, source: run.source, layers });
  if (run.dropped > 0) record.truncated = true; // this lab's own per-run cap cut events: say so, like the collector's caps
  return record;
}

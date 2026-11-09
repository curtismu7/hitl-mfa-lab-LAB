import { useCallback, useEffect, useRef, useState } from "react";
import Json from "./Json";
import FloatingDialog from "../floating-dialog/FloatingDialog";
import { runTool, getPolicy, setPolicy as postPolicy, startMfa, verifyMfa, bcAuthorize, pollCiba, respondCiba, respondConsent } from "../api";
import { visible } from "../safeText";

const STATUS_CLASS = { measured: "tag tag--ok", inferred: "tag", UNVERIFIED: "tag tag--warn" };
const DEMO_OTP = "123123"; // labelled demo bypass, shown in the MFA card

export function Hops({ hops, traceId }) {
  return (
    <section aria-label="Mock hops with traceparent" data-testid="hops">
      <h3>Hops (W3C traceparent) <span className="muted">trace {traceId}</span></h3>
      {hops.map((h) => (
        <details key={h.n} open={h.n === 1}>
          <summary>{h.n}. {h.label}</summary>
          <p className="muted">Request</p><Json value={h.request} label={`Request of hop ${h.n}`} />
          <p className="muted">Response</p><Json value={h.response} label={`Response of hop ${h.n}`} />
        </details>
      ))}
    </section>
  );
}

const WORDS = {
  PERMIT: ["allow", "PERMITTED — the policy allows this transfer; it executed"],
  HITL: ["deny", "PAUSED — the policy requires human consent before the transfer runs"],
  STEP_UP: ["deny", "PAUSED — the policy requires a human beat (MFA or out-of-band approval) first"],
  DENY: ["deny", "DENIED — the transfer exceeds the hard limit; no approval can clear it"],
};

export function Verdict({ run }) {
  if (!run) return <p className="muted" data-testid="verdict-empty">Pick a scenario to run it.</p>;
  const [cls, word] = WORDS[run.decision] || ["deny", run.decision];
  return (
    <div className={`verdict verdict--${cls}`} data-testid="verdict" role="status">
      <strong className="verdict__word">{word}</strong>
      {run.reason && <p className="reason" data-reason="bands">{visible(run.reason)}</p>}
      {run.receipt && <p data-testid="receipt">Receipt <code>{visible(run.receipt)}</code> presented — single-use, amount-bound{run.receiptKind === "ciba" ? " (CIBA approval)" : run.receiptKind === "stepUp" ? " (MFA credit)" : ""}.</p>}
      {run.error && <p data-testid="block">The agent is blocked: <code>{visible(run.error)}</code> — {visible(run.detail)}</p>}
    </div>
  );
}

/** Bands editor: the admin-editable, live amount bands. A crossing edit falls back server-side. */
function BandsEditor({ current, onSaved }) {
  const [bands, setBands] = useState(() => ({ ...current }));
  const [msg, setMsg] = useState(null);
  useEffect(() => setBands({ ...current }), [current]);
  const save = async (next) => {
    setMsg(null);
    const res = await postPolicy({ bands: next }).catch(() => ({ ok: false }));
    setMsg(res.ok ? "Bands saved — they are read on every request, so the very next call already uses them." : res.body?.detail || "Could not save the bands (a crossing edit falls back to the defaults).");
    if (res.ok) onSaved(res.body.bands);
    else { const j = await getPolicy().catch(() => null); if (j) { setBands({ ...j.bands }); onSaved(j.bands); } }
  };
  const field = (key, label, testId) => (
    <span className="inline">
      <label htmlFor={`band-${key}`}>{label}</label>
      <input id={`band-${key}`} type="number" min="1" max="1000000" value={bands[key]} data-testid={testId}
        onChange={(e) => setBands({ ...bands, [key]: e.target.value === "" ? "" : Number(e.target.value) })} />
    </span>
  );
  return (
    <section className="panel" aria-labelledby="bands-h" data-testid="bands-editor" id="policy">
      <h2 id="bands-h">Transfer-gate bands (admin-editable, live)</h2>
      <p className="muted">The amount bands of the mock policy, read on EVERY request: change them and the same call flips, with no restart. A crossing edit (confirm ≥ MFA, or MFA &gt; ceiling) falls back to the defaults — the gate never widens by accident.</p>
      {field("confirmUsd", "Confirm bar (consent) $", "band-confirm")}
      {field("mfaUsd", "MFA bar $", "band-mfa")}
      {field("denyCeilingUsd", "Hard ceiling $", "band-ceiling")}
      <button type="button" onClick={() => save(bands)} data-testid="bands-save">Save bands</button>
      {msg && <p className="muted" role="status" data-testid="bands-msg">{msg}</p>}
    </section>
  );
}

/** The agent call: pick an amount, run the gated transfer. A 428 opens the matching human beat.
 * onBlocked carries the FULL payload so the retry after the human beat repeats exactly the call
 * the human was shown — not some other amount the scenario happened to use. */
function AgentCall({ tools, onResult, onBlocked }) {
  const [tool, setTool] = useState(tools[0].name);
  const [amount, setAmount] = useState("300");
  const [declared, setDeclared] = useState("");
  const [fail, setFail] = useState(null);
  const run = async () => {
    setFail(null);
    const payload = { tool, amount: Number(amount) };
    if (declared) payload.step_up_method = declared;
    const res = await runTool(payload).catch(() => ({ ok: false, status: 0, body: {} }));
    if (res.ok || res.body.decision) {
      onResult(res.body);
      const beatPayload = { tool, amount: Number(amount) };
      if (declared) beatPayload.step_up_method = declared;
      if (res.body.error === "mcp_step_up_required" && res.body.step_up_method === "p1mfa") onBlocked("mfa", beatPayload);
      else if (res.body.error === "mcp_hitl_required") onBlocked("hitl", beatPayload, res.body.challengeId);
      else if (res.body.error === "ciba_required") onBlocked("ciba", beatPayload);
      else if (res.body.error === "mcp_hitl_required") onBlocked("hitl", beatPayload);
    } else setFail(`Could not call the gate (${res.body.detail || res.body.error || res.status}).`);
  };
  return (
    <section className="panel" aria-labelledby="call-h" data-testid="agent-call">
      <h2 id="call-h">Call the transfer tool as the agent</h2>
      <p className="muted">One agent-originated tools/call: the gate measures the amount against the bands (and the agent context) BEFORE anything executes.</p>
      <label htmlFor="call-tool">Tool</label>
      <select id="call-tool" value={tool} onChange={(e) => setTool(e.target.value)}>
        {tools.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.tier})</option>)}
      </select>
      <label htmlFor="call-amount">Amount (USD)</label>
      <input id="call-amount" type="number" min="0" max="1000000" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="call-amount" />
      <label htmlFor="call-declared">Declared step-up (UC7/UC22 trigger)</label>
      <select id="call-declared" value={declared} onChange={(e) => setDeclared(e.target.value)} data-testid="call-declared">
        <option value="">none (amount bands decide)</option>
        <option value="p1mfa">p1mfa (device MFA, amount-independent)</option>
        <option value="ciba">ciba (out-of-band on the phone, amount-independent)</option>
      </select>
      <button type="button" onClick={run} data-testid="call-run">Call as the agent</button>
      {fail && <p className="field-error" role="alert">{fail}</p>}
    </section>
  );
}

/** The HITL consent beat: a modal the agent "surfaces"; approving responds to the challenge
 * (which mints the single-use, amount-bound receipt) and the call auto-retries. */
function ConsentModal({ open, amount, challengeId, onApproved, onDenied, onClose }) {
  const [deciding, setDeciding] = useState(false);
  if (!open) return null;
  const decide = async (decision) => {
    if (deciding || !challengeId) return;
    setDeciding(true);
    const r = await respondConsent({ challengeId, decision }).catch(() => ({ ok: false, body: {} }));
    setDeciding(false);
    if (!r.ok) return;
    if (decision === "approved") onApproved();
    else onDenied();
  };
  return (
    <FloatingDialog isOpen onClose={onClose} title="Human approval required" testId="consent-modal"
      defaultWidth={480} defaultHeight={null} minHeight={200} footer={null}>
      <div className="modal__card">
        <p>The agent wants to transfer <strong data-testid="consent-amount">${amount}</strong>. The policy requires explicit human consent before it runs — the agent is paused.</p>
        <div className="modal__actions">
          <button type="button" data-testid="consent-approve" disabled={deciding} onClick={() => decide("approved")}>Approve</button>
          <button type="button" data-testid="consent-deny" disabled={deciding} onClick={() => decide("denied")}>Deny</button>
          <button type="button" className="link" onClick={onClose}>Dismiss</button>
        </div>
        <p className="muted">Approving mints a single-use, amount-bound receipt and the call is retried once. Denying leaves it paused.</p>
      </div>
    </FloatingDialog>
  );
}

/** The MFA beat: device challenge + the demo OTP. Verifying mints the TTL credit and auto-retries. */
function MfaModal({ open, amount, onVerified, onClose }) {
  const [challengeId, setChallengeId] = useState(null);
  const [otp, setOtp] = useState("");
  const [msg, setMsg] = useState(null);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    if (!open) { setChallengeId(null); setOtp(""); setMsg(null); return; }
    startMfa({ amount }).then((r) => {
      if (r.ok) setChallengeId(r.body.challenge.id);
      else setMsg(r.body.detail || "Could not start the MFA challenge.");
    }, () => setMsg("Could not start the MFA challenge."));
  }, [open, amount]);
  if (!open) return null;
  const verify = async () => {
    if (verifying) return;
    setMsg(null);
    setVerifying(true);
    const r = await verifyMfa({ challengeId, otp }).catch(() => ({ ok: false, body: {} }));
    setVerifying(false);
    if (r.ok) onVerified(r.body.receipt);
    else setMsg(r.body.detail || "Verification failed.");
  };
  return (
    <FloatingDialog isOpen onClose={onClose} title="MFA step-up required" testId="mfa-modal"
      defaultWidth={480} defaultHeight={null} minHeight={200} footer={null}>
      <div className="modal__card">
        <p>The policy requires device MFA for <strong>${amount}</strong>. The agent cannot satisfy it — a human must.</p>
        {challengeId ? (
          <>
            <label htmlFor="mfa-otp">One-time code (demo OTP: <code>{DEMO_OTP}</code>)</label>
            <input id="mfa-otp" type="text" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} data-testid="mfa-otp" />
            <div className="modal__actions">
              <button type="button" data-testid="mfa-verify" disabled={verifying} onClick={verify}>Verify</button>
              <button type="button" onClick={onClose}>Dismiss</button>
            </div>
          </>
        ) : <p className="muted">{msg || "Starting the challenge..."}</p>}
        {msg && challengeId && <p className="field-error" role="alert">{msg}</p>}
        <p className="muted">Verifying mints a step-up credit with a 5-minute TTL, and the call is retried once. The credit is single-use and amount-bound.</p>
      </div>
    </FloatingDialog>
  );
}

/** The CIBA beat: the agent's bc-authorize request, the phone panel (the human's own device),
 * and the agent polling. Approving on the phone mints the amount-bound receipt and auto-retries. */
function CibaModal({ open, amount, onApproved, onDenied, onClose }) {
  const [authReqId, setAuthReqId] = useState(null);
  const [binding, setBinding] = useState(null);
  const [msg, setMsg] = useState(null);
  const [decided, setDecided] = useState(false);
  // The callbacks arrive as fresh inline arrows on every parent render; holding them in a ref
  // keeps the bc-authorize effect stable (open + amount only) so the auth_req_id survives
  // any parent re-render — a re-mint would orphan a decision already sent.
  const callbacks = useRef({ onApproved, onDenied });
  useEffect(() => { callbacks.current = { onApproved, onDenied }; });
  useEffect(() => {
    if (!open) { setAuthReqId(null); setBinding(null); setMsg(null); setDecided(false); return; }
    let stop = false;
    let intervalId = null;
    bcAuthorize({ amount, bindingMessage: `Approve $${amount} transfer` }).then((r) => {
      if (stop) return;
      if (!r.ok) { setMsg(r.body.detail || "Could not start the CIBA request."); return; }
      setAuthReqId(r.body.auth_req_id);
      setBinding(r.body.binding_message);
      // The agent polls (every 2 s); the visitor decides on the phone panel.
      intervalId = setInterval(async () => {
        const p = await pollCiba(r.body.auth_req_id).catch(() => null);
        if (stop || !p) return;
        if (p.status === "approved") { clearInterval(intervalId); setDecided(true); callbacks.current.onApproved(p.receiptId); }
        if (p.status === "denied") { clearInterval(intervalId); setDecided(true); callbacks.current.onDenied(); }
      }, 2000);
    }, () => setMsg("Could not start the CIBA request."));
    return () => { stop = true; if (intervalId) clearInterval(intervalId); };
  }, [open, amount]);
  if (!open) return null;
  const decide = async (decision) => {
    if (decided) return;
    setMsg(null);
    setDecided(true);
    const r = await respondCiba({ authReqId, decision }).catch(() => ({ ok: false, body: {} }));
    if (!r.ok) { setDecided(false); setMsg(r.body.detail || "Could not deliver the decision."); }
    // The agent's next poll picks it up; the modal stays until then.
  };
  return (
    <FloatingDialog isOpen onClose={onClose} title="CIBA: approval requested out-of-band" testId="ciba-modal"
      defaultWidth={520} defaultHeight={null} minHeight={200} footer={null}>
      <div className="modal__card">
        <p>The agent has no browser to prompt in. The policy requested decoupled approval for <strong>${amount}</strong> — triggered by the agent context and the sensitivity of the action, not by the amount.</p>
        {authReqId ? (
          <div className="phone" data-testid="ciba-phone" aria-label="The user's phone (mock)">
            <p className="phone__msg">{visible(binding)}</p>
            <p className="muted">auth_req_id: <code>{visible(authReqId)}</code></p>
            <div className="modal__actions">
              <button type="button" data-testid="ciba-approve" disabled={decided} onClick={() => decide("approved")}>Approve on this device</button>
              <button type="button" data-testid="ciba-deny" disabled={decided} onClick={() => decide("denied")}>Deny</button>
            </div>
          </div>
        ) : <p className="muted">{msg || "Requesting approval (bc-authorize)..."}</p>}
        {msg && authReqId && <p className="field-error" role="alert">{msg}</p>}
        <p className="muted">The agent polls for the decision. Approving mints a single-use, amount-bound receipt and the call is retried once.</p>
        <button type="button" className="link" onClick={onClose}>Dismiss</button>
      </div>
    </FloatingDialog>
  );
}

export default function PolicyGate({ story, resetSignal, requestedId, onSelect }) {
  const known = (v) => story.scenarios.some((s) => s.id === v);
  const [id, setId] = useState(known(requestedId) ? requestedId : story.scenarios[0].id);
  useEffect(() => { if (known(requestedId)) setId(requestedId); }, [requestedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [bands, setBandsState] = useState(null);
  const [run, setRun] = useState(null);
  const [fail, setFail] = useState(null);
  const [beat, setBeat] = useState(null); // { kind: 'hitl'|'mfa'|'ciba', amount }
  const scenario = story.scenarios.find((s) => s.id === id) || story.scenarios[0];

  const loadBands = useCallback(async () => {
    const j = await getPolicy().catch(() => null);
    if (j) setBandsState(j.bands);
  }, []);
  useEffect(() => { loadBands(); }, [loadBands, resetSignal]);

  // Run a shipped scenario: set its bands, then make the call — exactly what the gate measures.
  const runToken = useRef(0);
  const runScenario = useCallback(async (sid, { applyBands = true } = {}) => {
    const token = ++runToken.current;
    const drop = () => token !== runToken.current;
    setFail(null);
    const sc = story.scenarios.find((s) => s.id === sid) || story.scenarios[0];
    if (applyBands) {
      const saved = await postPolicy({ bands: sc.bands }).catch(() => null);
      if (drop()) return;
      if (saved) setBandsState(saved.body.bands);
    }
    const payload = { tool: sc.call.tool, amount: sc.call.amount };
    if (sc.declaredStepUp) payload.step_up_method = sc.declaredStepUp;
    const res = await runTool(payload).catch(() => ({ ok: false, status: 0, body: {} }));
    if (drop()) return;
    if (res.ok || res.body.decision) {
      setRun(res.body);
      if (res.body.error === "mcp_step_up_required" && res.body.step_up_method === "p1mfa") setBeat({ kind: "mfa", payload });
      else if (res.body.error === "ciba_required") setBeat({ kind: "ciba", payload });
      else if (res.body.error === "mcp_hitl_required") setBeat({ kind: "hitl", payload, challengeId: res.body.challengeId });
    } else { setRun(null); setFail(`Could not evaluate (${res.body.detail || res.body.error || res.status}).`); }
  }, [story]);

  useEffect(() => { setRun(null); setBeat(null); }, [resetSignal]);
  useEffect(() => { runScenario(id); }, [id, resetSignal, runScenario]); // eslint-disable-line react-hooks/exhaustive-deps

  const onResult = useCallback((r) => setRun(r), []);
  const onBlocked = useCallback((kind, payload, challengeId) => setBeat({ kind, payload, challengeId }), []);
  // After a human beat is satisfied, retry the EXACT call that was blocked — the beat stores
  // the full payload (tool, amount, step_up_method), so the visitor's manual amount is what
  // the human approved and what the retry repeats.
  const retrySame = useCallback(() => {
    if (!beat?.payload) return;
    runTool(beat.payload).then((res) => { if (res.ok || res.body.decision) setRun(res.body); }, () => {});
  }, [beat]);

  return (
    <div className="gate">
      <section className="panel" aria-labelledby="sc-h">
        <h2 id="sc-h">Scenarios</h2>
        <div className="seg" role="group" aria-label="Scenario">
          {story.scenarios.map((s) => <button key={s.id} type="button" aria-pressed={s.id === id} onClick={() => { setBeat(null); setId(s.id); if (onSelect) onSelect(s.id); }}>{s.title}</button>)}
        </div>
        <p className="lesson" data-testid="lesson">{scenario.lesson}</p>
      </section>
      <section className="panel" aria-labelledby="res-h">
        <h2 id="res-h">Gate result</h2>
        {fail && <p className="field-error" role="alert">{fail}</p>}
        <Verdict run={run} />
        {run && <Hops hops={run.hops} traceId={run.traceId} />}
      </section>
      {bands && <BandsEditor current={bands} onSaved={(b) => { setBandsState(b); if (!beat) runScenario(id, { applyBands: false }); }} />}
      <AgentCall tools={story.tools} onResult={onResult} onBlocked={onBlocked} />
      <ConsentModal open={beat?.kind === "hitl"} amount={beat?.payload?.amount} challengeId={beat?.challengeId}
        onApproved={() => { setBeat(null); retrySame(); }}
        onDenied={() => { setBeat(null); setRun((r) => r && { ...r, error: "consent_denied", detail: "The human denied the request; the transfer stays paused." }); }}
        onClose={() => setBeat(null)} />
      <MfaModal open={beat?.kind === "mfa"} amount={beat?.payload?.amount}
        onVerified={() => { setBeat(null); retrySame(); }}
        onClose={() => setBeat(null)} />
      <CibaModal open={beat?.kind === "ciba"} amount={beat?.payload?.amount}
        onApproved={() => { setBeat(null); retrySame(); }}
        onDenied={() => { setBeat(null); setRun((r) => r && { ...r, error: "ciba_denied", detail: "The user denied out-of-band; the transfer stays paused." }); }}
        onClose={() => setBeat(null)} />
      <section className="panel" aria-labelledby="scen-h">
        <h2 id="scen-h">Scenario (decoded)</h2>
        <p className="tag tag--warn">{story.tokenLabel}</p>
        <Json value={{ bands: scenario.bands, call: scenario.call, declaredStepUp: scenario.declaredStepUp, expected: scenario.expected }} label="Scenario input" testId="scenario-prefs" />
        <h3>What we know, and how well</h3>
        <ul className="facts" data-testid="facts">
          {story.facts.map((f) => <li key={f.id}><span className={STATUS_CLASS[f.status] || "tag"}>{f.status}</span> {visible(f.text)} <span className="muted">({visible(f.source)})</span></li>)}
        </ul>
      </section>
    </div>
  );
}

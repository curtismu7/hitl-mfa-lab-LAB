import { useCallback, useEffect, useRef, useState } from "react";
import Json from "./Json";
import FloatingDialog from "../floating-dialog/FloatingDialog";
import PhoneDialog from "./PhoneDialog";
import LiveFlow from "./LiveFlow";
import GatewayTrace from "../gateway-trace/GatewayTrace.jsx";
import RunObs from "./RunObs";
import TokenReel from "./TokenReel";
import { nextTrail, realRun, reelCards } from "../liveFlow";
import { callRealPrivilege, getJson, decidePrivilege, getPrivilegeQueue, runTool, getPolicy, setPolicy as postPolicy, startMfa, verifyMfa, startRealOtp, selectRealOtpDevice, verifyRealOtp, bcAuthorize, pollCiba, respondCiba, expireCiba, respondConsent, startPush, pollPush, respondPush } from "../api";
import { visible } from "../safeText";
import PingIdSetup from "./PingIdSetup";

const STATUS_CLASS = { measured: "tag tag--ok", inferred: "tag", UNVERIFIED: "tag tag--warn" };
const DEMO_OTP = "123123"; // labelled demo bypass, shown in the MFA card

export function Hops({ hops, traceId }) {
  return (
    <section aria-label="Mock hops with traceparent" data-testid="hops">
      <h3>Hops (W3C traceparent) <span className="muted">trace {traceId}</span></h3>
      <div className="hops-grid">
      {hops.map((h) => (
        <details key={h.n} open={h.n === 1}>
          <summary>{h.n}. {h.label}</summary>
          <p className="muted">Request</p><Json value={h.request} label={`Request of hop ${h.n}`} />
          <p className="muted">Response</p><Json value={h.response} label={`Response of hop ${h.n}`} />
        </details>
      ))}
      </div>
    </section>
  );
}

const WORDS = {
  PERMIT: ["allow", "PERMITTED — the policy allows this transfer; it executed"],
  HITL: ["deny", "PAUSED — the policy requires human consent before the transfer runs"],
  STEP_UP: ["deny", "PAUSED — the policy requires a human beat (MFA or out-of-band approval) first"],
  REFUSED: ["deny", "REFUSED — the real gateway neither held nor ran the call"],
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
function AgentCall({ tools, onResult, onBlocked, onRunning, onNoRun, running = false }) {
  const [tool, setTool] = useState(tools[0].name);
  const [amount, setAmount] = useState("300");
  const [declared, setDeclared] = useState("");
  const [fail, setFail] = useState(null);
  const run = async () => {
    setFail(null);
    onRunning?.(true);
    const payload = { tool, amount: Number(amount) };
    if (declared) payload.step_up_method = declared;
    const res = await runTool(payload).catch(() => ({ ok: false, status: 0, body: {} }));
    onRunning?.(false);
    if (res.ok || res.body.decision) {
      onResult(res.body);
      const beatPayload = { tool, amount: Number(amount) };
      if (declared) beatPayload.step_up_method = declared;
      if (res.body.error === "mcp_step_up_required" && (res.body.step_up_method === "p1mfa" || res.body.step_up_method === "pingid-push")) onBlocked("mfa", beatPayload);
      else if (res.body.error === "mcp_hitl_required") onBlocked("hitl", beatPayload, res.body.challengeId);
      else if (res.body.error === "ciba_required") onBlocked("ciba", beatPayload);
      else if (res.body.error === "pending_approval") onBlocked("privilege", beatPayload, res.body.approval?.instruction_id);
      else if (res.body.error === "mcp_hitl_required") onBlocked("hitl", beatPayload);
    } else { setFail(`Could not call the gate (${res.body.detail || res.body.error || res.status}).`); onNoRun?.(); }
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
        <option value="pingid-push">pingid-push (PingID push on the approver's phone, amount-independent)</option>
        <option value="privilege">privilege (Privilege gateway hold, PingID-confirmed approver)</option>
      </select>
      {/* ui-pattern: allow P9 never shown with the Real panel: while the scenario is Real this whole component is replaced by a note */}
      <button type="button" className={`primary${running ? " running" : ""}`} disabled={running} onClick={run} data-testid="call-run">{running ? "Running…" : "Call as the agent"}</button>
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
    if (decision === "approved") onApproved(r.body.receipt);
    else onDenied();
  };
  return (
    <FloatingDialog isOpen placement="right" onClose={onClose} title="Human approval required" testId="consent-modal"
      defaultWidth={560} defaultHeight={null} minHeight={240} footer={null}>
      <div className="modal__card">
        <p>The agent wants to transfer <strong data-testid="consent-amount">${amount}</strong>. The policy requires explicit human consent before it runs — the agent is paused.</p>
        <div className="modal__actions">
          <button type="button" data-testid="consent-approve" className="primary" disabled={deciding} onClick={() => decide("approved")}>Approve</button>
          <button type="button" data-testid="consent-deny" disabled={deciding} onClick={() => decide("denied")}>Deny</button>
          <button type="button" className="link" onClick={onClose}>Dismiss</button>
        </div>
        <p className="muted">Approving mints a single-use, amount-bound receipt and the call is retried once. Denying leaves it paused.</p>
      </div>
    </FloatingDialog>
  );
}

/** The MFA beat: device challenge + the demo OTP. Verifying mints the TTL credit and auto-retries. */
function MfaModal({ open, amount, onVerified, onClose, onIssued }) {
  const [challengeId, setChallengeId] = useState(null);
  const [otp, setOtp] = useState("");
  const [msg, setMsg] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [realOtp, setRealOtp] = useState(null); // a real PingOne challenge is open: { devices, amount, selectedDevice }
  useEffect(() => {
    if (!open) { setChallengeId(null); setOtp(""); setMsg(null); setRealOtp(null); return; }
    // Real OTP when the lab is configured for it (PingOne worker in .env): the human picks the device, the code
    // arrives (text, email, or in the PingID app), and a human types it. Otherwise the labelled demo code.
    // A stale challenge (a reload mid-picker, a restart) must not dead-end the modal: cancel it and retry
    // once. Only fall back to the labelled demo code when the lab is genuinely not configured.
    getJson("/api/mfa/real-otp/status").then((st) => {
      if (!st.configured) throw new Error("not configured");
      const begin = () => startRealOtp({ amount }).then((r) => {
        if (!r.ok) throw Object.assign(new Error(r.body.detail || "Could not start the PingID challenge."), { code: r.body.error });
        setRealOtp({ devices: r.body.devices || [], amount: r.body.amount ?? amount, selectedDevice: null });
      });
      return begin().catch((e) => {
        if (e.code !== "otp_busy") throw e;
        return fetch("/api/mfa/real-otp/cancel", { method: "POST", headers: { "content-type": "application/json" } })
          .then(begin, begin);
      });
    }).catch((e) => {
      if (e && e.code === "otp_busy") { setMsg("A real OTP challenge is still open server-side; press Start over."); return; }
      setRealOtp(null);
      startMfa({ amount }).then((r) => {
        if (r.ok) { setChallengeId(r.body.challenge.id); if (onIssued) onIssued({ id: r.body.challenge.id }); }
        else setMsg(r.body.detail || "Could not start the MFA challenge.");
      }, () => setMsg("Could not start the MFA challenge."));
    });
  }, [open, amount]);
  if (!open) return null;
  const pickDevice = async (deviceId) => {
    if (!realOtp || realOtp.selectedDevice) return;
    setMsg(null);
    setRealOtp((s) => ({ ...s, picking: deviceId }));
    const r = await selectRealOtpDevice({ deviceId }).catch(() => ({ ok: false, body: {} }));
    setRealOtp((s) => ({ ...s, picking: null }));
    if (r.ok) setRealOtp((s) => ({ ...s, selectedDevice: deviceId }));
    else setMsg(r.body.detail || "Could not select that device.");
  };
  const restart = async () => {
    setMsg(null); setOtp("");
    await fetch("/api/mfa/real-otp/cancel", { method: "POST", headers: { "content-type": "application/json" } }).catch(() => {});
    setRealOtp(null);
    startRealOtp({ amount }).then((r) => {
      if (!r.ok) { setMsg(r.body.detail || "Could not restart the PingID challenge."); setRealOtp(null); return; }
      setRealOtp({ devices: r.body.devices || [], amount: r.body.amount ?? amount, selectedDevice: null });
    }, () => setMsg("Could not restart the PingID challenge."));
  };
  const verify = async () => {
    if (verifying) return;
    setMsg(null);
    setVerifying(true);
    if (realOtp) {
      const r = await verifyRealOtp({ otp }).catch(() => ({ ok: false, body: {} }));
      setVerifying(false);
      if (r.ok) onVerified(r.body.receipt);
      else setMsg(r.body.detail || "Verification failed.");
      return;
    }
    const r = await verifyMfa({ challengeId, otp }).catch(() => ({ ok: false, body: {} }));
    setVerifying(false);
    if (r.ok) onVerified(r.body.receipt);  // { id, ttlMs, kind }
    else setMsg(r.body.detail || "Verification failed.");
  };
  return (
    <FloatingDialog isOpen placement="right" onClose={onClose} title="MFA step-up required" testId="mfa-modal"
      defaultWidth={560} defaultHeight={null} minHeight={240} footer={null}>
      <div className="modal__card">
        <p>The policy requires device MFA for <strong>${amount}</strong>. The agent cannot satisfy it — a human must.</p>
        {(challengeId || realOtp) ? (
          <>
            {realOtp && !realOtp.selectedDevice ? (
              <>
                <p><strong>How should the code reach you?</strong> Pick a device; PingOne sends (or shows) the one-time code.</p>
                <div className="modal__actions" style={{ flexDirection: "column", alignItems: "stretch" }} data-testid="real-otp-devices">
                  {realOtp.devices.map((d) => (
                    <button key={d.id} type="button" data-testid={`real-otp-device-${d.type}`} disabled={realOtp.picking}
                      onClick={() => pickDevice(d.id)}>
                      <strong>{d.type}</strong>{d.nickname ? ` — ${d.nickname}` : ""} <span className="muted">({d.delivery})</span>
                    </button>
                  ))}
                </div>
                <p className="muted">The credit is amount-bound to ${realOtp.amount}: it discharges this call only.</p>
              </>
            ) : realOtp ? (
              <>
                <label htmlFor="mfa-otp">One-time code — <strong>real</strong>: {realOtp.devices.find((d) => d.id === realOtp.selectedDevice)?.type === "PINGID_MOBILE"
                  ? <>PingOne asked the PingID app to push it. <strong data-testid="mfa-pingid-hint">No push? Open the PingID app and type the passcode it shows.</strong></>
                  : <>it was sent to the device you picked.</>} Type it and Verify.</label>
                <input id="mfa-otp" type="text" inputMode="numeric" maxLength={8} value={otp} onChange={(e) => setOtp(e.target.value)} data-testid="mfa-otp" />
                <div className="modal__actions">
                  <button type="button" data-testid="mfa-verify" disabled={verifying || !otp.trim()} onClick={verify}>Verify</button>
                  <button type="button" onClick={onClose}>Dismiss</button>
                  <button type="button" data-testid="mfa-restart" disabled={verifying} onClick={restart}>Wrong number? Start over</button>
                </div>
              </>
            ) : (
              <>
                <label htmlFor="mfa-otp">One-time code (no PingOne configured — the demo OTP is <code>{DEMO_OTP}</code>)</label>
                <input id="mfa-otp" type="text" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} data-testid="mfa-otp" />
                <div className="modal__actions">
                  <button type="button" data-testid="mfa-verify" disabled={verifying} onClick={verify}>Verify</button>
                  <button type="button" onClick={onClose}>Dismiss</button>
                </div>
              </>
            )}
          </>
        ) : <p className="muted">{msg || "Starting the challenge..."}</p>}
        {msg && (challengeId || realOtp) && <p className="field-error" role="alert">{msg}</p>}
        <p className="muted">Verifying mints a step-up credit with a 5-minute TTL, and the call is retried once. The credit is single-use and amount-bound. {realOtp ? "The code is a real PingOne MFA code, delivered to the device you picked." : "This beat is simulated: the OTP is a labelled demo bypass, never a real PingOne MFA code."}</p>
      </div>
    </FloatingDialog>
  );
}

/** The PingID push beat. The server (mock) sends a push to the approver's phone; the agent polls until the phone answers. Approve mints a
 * single-use, amount-bound credit and the call is retried once; "No, it's not me" leaves it held. Here the phone is the labelled mock panel
 * below: nothing is sent to PingOne or a real device (that live path is owner-run and not wired into this server). */
function PushModal({ open, amount, onVerified, onDenied, onClose, onIssued }) {
  const [challengeId, setChallengeId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [binding, setBinding] = useState(null);
  const [fired, setFired] = useState(false);
  const [answered, setAnswered] = useState(false);
  // The callbacks arrive as fresh inline arrows on every parent render; holding them in a ref keeps the push and its polling stable.
  const callbacks = useRef({ onVerified, onDenied, onIssued });
  useEffect(() => { callbacks.current = { onVerified, onDenied, onIssued }; });
  useEffect(() => {
    if (!open) { setChallengeId(null); setMsg(null); setBinding(null); setFired(false); setAnswered(false); return; }
    let stop = false;
    startPush({ amount }).then((r) => {
      if (stop) return;
      if (r.ok) {
        setChallengeId(r.body.challenge.id); setBinding(r.body.challenge.bindingMessage || null); setFired(true);
        if (callbacks.current.onIssued) callbacks.current.onIssued({ id: r.body.challenge.id, bindingMessage: r.body.challenge.bindingMessage });
      } else setMsg(r.body.detail || "Could not send the PingID push.");
    }, () => { if (!stop) setMsg("Could not send the PingID push."); });
    return () => { stop = true; };
  }, [open, amount]);
  // Poll while pending; stop when the modal closes or an answer arrives.
  useEffect(() => {
    if (!open || !challengeId || !fired) return undefined;
    let stop = false; let timer = null;
    const tick = async () => {
      const r = await pollPush(challengeId).catch(() => null);
      if (stop) return;
      if (r?.status === "verified" && r.receipt) callbacks.current.onVerified(r.receipt);
      else if (r?.status === "denied") callbacks.current.onDenied();
      else if (r?.status === "failed") setMsg("The push timed out or failed: start the call again.");
      else timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 800);
    return () => { stop = true; clearTimeout(timer); };
  }, [open, challengeId, fired]);
  if (!open) return null;
  const answer = async (decision) => {
    if (answered || !challengeId) return;
    setAnswered(true); setMsg(null);
    const r = await respondPush(challengeId, decision).catch(() => ({ ok: false, body: {} }));
    if (!r.ok) { setAnswered(false); setMsg(r.body.detail || "The phone could not deliver that answer."); }
    // The agent's next poll picks the answer up; the dialog stays until then.
  };
  return (
    <FloatingDialog isOpen placement="right" onClose={onClose} title="PingID push approval required" testId="push-modal"
      defaultWidth={560} defaultHeight={null} minHeight={240} footer={null}>
      <div className="modal__card">
        <p>The policy requires a PingID push for <strong data-testid="push-amount">${amount}</strong>. A <strong>simulated</strong> push was sent to the in-page mock phone (this standalone beat never calls PingID; the PRIVILEGE scenario's approval push is the real one); the agent is polling for the answer.</p>
        {binding && <p className="muted">Binding message on the push: <code>{binding}</code></p>}
        {challengeId && (
          <div className="phone" data-testid="push-phone" aria-label="The approver's phone (mock)">
            <p className="phone__msg"><strong>PingID (mock phone)</strong> — Are you trying to sign on?</p>
            <div className="modal__actions">
              <button type="button" data-testid="push-approve" disabled={answered} onClick={() => answer("approved")}>Approve</button>
              <button type="button" data-testid="push-deny" disabled={answered} onClick={() => answer("denied")}>No, it's not me</button>
            </div>
          </div>
        )}
        <p data-testid="push-wait" className={msg ? "field-error" : "muted"} role={msg ? "alert" : undefined}>
          {msg || "Waiting for the answer on the phone..."}
        </p>
        <div className="modal__actions">
          <button type="button" onClick={onClose}>Dismiss</button>
        </div>
        <p className="muted">Approving mints a single-use, amount-bound credit and the call is retried once. This beat is simulated: the in-page phone stands in for PingID here, while the PRIVILEGE scenario's real approval push goes to the approvers through the tenant. See the PingID setup wizard for your own environment.</p>
      </div>
    </FloatingDialog>
  );
}

/** The CIBA beat: the agent's bc-authorize request, the phone panel (the human's own device),
 * and the agent polling. Approving on the phone mints the amount-bound receipt and auto-retries. */
function CibaModal({ open, amount, onApproved, onDenied, onClose, onIssued }) {
  const [authReqId, setAuthReqId] = useState(null);
  const [binding, setBinding] = useState(null);
  const [msg, setMsg] = useState(null);
  const [decided, setDecided] = useState(false);
  // The callbacks arrive as fresh inline arrows on every parent render; holding them in a ref
  // keeps the bc-authorize effect stable (open + amount only) so the auth_req_id survives
  // any parent re-render — a re-mint would orphan a decision already sent.
  const callbacks = useRef({ onApproved, onDenied });
  useEffect(() => { callbacks.current = { onApproved, onDenied, onIssued }; });
  useEffect(() => {
    if (!open) { setAuthReqId(null); setBinding(null); setMsg(null); setDecided(false); return; }
    let stop = false;
    let intervalId = null;
    bcAuthorize({ amount, bindingMessage: `Approve $${amount} transfer` }).then((r) => {
      if (stop) return;
      if (!r.ok) { setMsg(r.body.detail || "Could not start the CIBA request."); return; }
      setAuthReqId(r.body.auth_req_id);
      setBinding(r.body.binding_message);
      if (callbacks.current.onIssued) callbacks.current.onIssued({ id: r.body.auth_req_id, bindingMessage: r.body.binding_message });
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
    // "expired" is the demo knob (no waiting for the TTL): retire the pending request now.
    const r = await (decision === "expired" ? expireCiba(authReqId) : respondCiba({ authReqId, decision })).catch(() => ({ ok: false, body: {} }));
    if (!r.ok) { setDecided(false); setMsg(r.body.detail || "Could not deliver the decision."); }
    // The agent's next poll picks it up; the modal stays until then.
  };
  return (
    <FloatingDialog isOpen placement="right" onClose={onClose} title="CIBA: approval requested out-of-band" testId="ciba-modal"
      defaultWidth={600} defaultHeight={null} minHeight={260} footer={null}>
      <div className="modal__card">
        <p>The agent has no browser to prompt in. The policy requested decoupled approval for <strong>${amount}</strong> — triggered by the agent context and the sensitivity of the action, not by the amount.</p>
        {authReqId ? (
          <PhoneDialog isOpen onClose={onClose} title="Your phone — CIBA approval" testId="ciba" singletonKey="ciba-phone">
            <p className="phone__app">Banking</p>
            <p className="phone__msg">{visible(binding)}</p>
            <p className="muted">auth_req_id: <code>{visible(authReqId)}</code></p>
            <div className="modal__actions">
              <button type="button" data-testid="ciba-approve" disabled={decided} onClick={() => decide("approved")}>Approve on this device</button>
              <button type="button" data-testid="ciba-deny" disabled={decided} onClick={() => decide("denied")}>Deny</button>
              <button type="button" data-testid="ciba-expire" disabled={decided} onClick={() => decide("expired")}>Let it expire</button>
            </div>
          </PhoneDialog>
        ) : <p className="muted">{msg || "Requesting approval (bc-authorize)..."}</p>}
        {msg && authReqId && <p className="field-error" role="alert">{msg}</p>}
        <p className="muted">The agent polls for the decision. Approving mints a single-use, amount-bound receipt and the call is retried once.</p>
        <button type="button" className="link" onClick={onClose}>Dismiss</button>
      </div>
    </FloatingDialog>
  );
}

/** The Privilege beat: the approver's side of a held call. Shows the request in HITL Requests (mock); Approve makes PingID ask the approver
 * to confirm (a push, or the app's passcode) and only then is the approval issued. Reject needs no PingID. The agent retries with the id. */
function PrivilegeModal({ open, amount, requestId, onApproved, onRejected, onClose }) {
  const [row, setRow] = useState(null);
  const [stage, setStage] = useState("list"); // list | pingid
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [passcode, setPasscode] = useState("123123");
  useEffect(() => {
    if (!open) { setRow(null); setStage("list"); setCode(""); setMsg(null); setBusy(false); return; }
    getPrivilegeQueue().then((j) => { setRow(j.requests.find((r) => r.id === requestId) || null); if (j.policy?.demoPasscode) setPasscode(j.policy.demoPasscode); }, () => setMsg("Could not read HITL Requests."));
  }, [open, requestId]);
  if (!open) return null;
  const decide = async (body, onOk) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    const r = await decidePrivilege(requestId, body).catch(() => ({ ok: false, body: {} }));
    setBusy(false);
    if (r.ok) onOk(r.body.request);
    else setMsg(r.body.detail || "The gateway did not accept that decision.");
  };
  return (
    <FloatingDialog isOpen placement="right" onClose={onClose} title="Privilege HITL Requests: approval needed" testId="privilege-modal"
      defaultWidth={620} defaultHeight={null} minHeight={260} footer={null}>
      <div className="modal__card">
        <p>The Privilege gateway held the agent's <strong>${amount}</strong> transfer (403 <code>pending_approval</code>). In Mock mode you are the approver, in this page's mock of the console's <strong>HITL Requests</strong>; in Real mode the approval is yours in the real Privilege console, confirmed with a real PingID push.</p>
        <table className="tbl" data-testid="privilege-queue">
          <caption>Awaiting a decision</caption>
          <thead><tr><th>Request</th><th>Tool</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody><tr><td><code>{visible(requestId)}</code></td><td>{visible(row?.tool || "create_transfer")}</td><td>${amount}</td><td data-testid="privilege-status">{row?.status || "pending"}</td></tr></tbody>
        </table>
        {stage === "list" && (
          <div className="modal__actions">
            <button type="button" data-testid="privilege-approve" className="primary" disabled={busy} onClick={() => { setMsg(null); setStage("pingid"); }}>Approve</button>
            <button type="button" data-testid="privilege-reject" disabled={busy} onClick={() => decide({ decision: "reject" }, () => onRejected())}>Reject</button>
            <button type="button" className="link" onClick={onClose}>Dismiss</button>
          </div>
        )}
        {stage === "pingid" && (
          <PhoneDialog isOpen onClose={() => { setStage("list"); setMsg(null); }} title="PingID — the approver's phone" testId="pingid" singletonKey="pingid-phone">
            <p className="phone__app">PingID</p>
            <p className="phone__msg">Are you trying to sign on? (approving this request)</p>
            <div className="modal__actions">
              <button type="button" data-testid="pingid-approve" disabled={busy} onClick={() => decide({ decision: "approve", pingid: { method: "push", result: "approved" } }, (r) => onApproved({ id: requestId, method: r.method }))}>Approve</button>
              <button type="button" data-testid="pingid-deny" disabled={busy} onClick={() => decide({ decision: "approve", pingid: { method: "push", result: "denied" } }, () => {})}>No, it's not me</button>
            </div>
            <label htmlFor="pingid-code">Or type the PingID passcode (demo passcode: <code>{passcode}</code>)</label>
            <input id="pingid-code" type="text" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} data-testid="pingid-code" />
            <div className="modal__actions">
              <button type="button" data-testid="pingid-verify" disabled={busy} onClick={() => decide({ decision: "approve", pingid: { method: "passcode", code } }, (r) => onApproved({ id: requestId, method: r.method }))}>Verify passcode</button>
              <button type="button" onClick={() => { setStage("list"); setMsg(null); }}>Back</button>
            </div>
          </PhoneDialog>
        )}
        {msg && <p className="field-error" role="alert" data-testid="privilege-msg">{msg}</p>}
        <p className="muted">Approving needs PingID; rejecting does not. The approval covers one transaction, and the agent retries with it inside 90 seconds. A decided request cannot be changed.</p>
      </div>
    </FloatingDialog>
  );
}

export default function PolicyGate({ story, vertical = "retail", mode = "mock", resetSignal, requestedId, onSelect }) {
  const known = (v) => story.scenarios.some((s) => s.id === v);
  const [id, setId] = useState(known(requestedId) ? requestedId : story.scenarios[0].id);
  useEffect(() => { if (known(requestedId)) setId(requestedId); }, [requestedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [bands, setBandsState] = useState(null);
  const [run, setRun] = useState(null);
  const [fail, setFail] = useState(null);
  const [beat, setBeat] = useState(null); // { kind: 'hitl'|'mfa'|'ciba', amount }
  const [trail, setTrail] = useState([]); // the arrows the flow diagram has walked
  const [issued, setIssued] = useState({}); // what the human beats minted: { challenge, receipt }
  const [pattern, setPattern] = useState(null);
  const [realEx, setRealEx] = useState([]); // Real: the exchanges the shared "What Privilege did" panel shows
  const [realBusy, setRealBusy] = useState(false);
  const [realMsg, setRealMsg] = useState(null);
  const [realCfg, setRealCfg] = useState(null);
  const [realWait, setRealWait] = useState(null); // while a Real hold is being retried: { tries, stopped, lapsed }
  const [approvalInput, setApprovalInput] = useState("");
  const [obsGen, setObsGen] = useState(0); // rule 27: bumped when a new run starts, so the panel never shows the previous run's record as the new one
  const [obsNoRun, setObsNoRun] = useState(false); // the last attempt began no run (the server refused it before any decision)
  const [obsAfterReset, setObsAfterReset] = useState(false); // a real reply came back after Reset: the server wrote it to stdout only
  // Real mode (owner-run) makes ONE scenario real: the PRIVILEGE hold. Every other scenario stays simulated.
  const isReal = useCallback((sid) => mode === "real" && sid === "privilege-pingid", [mode]);
  const [pingidOpen, setPingidOpen] = useState(false);
  const scenario = story.scenarios.find((s) => s.id === id) || story.scenarios[0];

  useEffect(() => {
    let live = true;
    getJson(`/api/diagram?vertical=${encodeURIComponent(vertical)}&name=hitl-mfa-flow`).then((j) => { if (live) setPattern(j); }, () => { if (live) setPattern(null); });
    return () => { live = false; };
  }, [vertical]);

  const loadBands = useCallback(async () => {
    const j = await getPolicy().catch(() => null);
    if (j) setBandsState(j.bands);
  }, []);
  useEffect(() => { loadBands(); }, [loadBands, resetSignal]);

  // A fresh call starts the flow and the reel over; the retry after a human beat continues them.
  const showFresh = useCallback((body) => { setObsGen((g) => g + 1); setObsNoRun(false); setObsAfterReset(false); setRun(body); setTrail((t) => nextTrail(t, body, true)); const cid = body.challengeId || body.approval?.instruction_id; setIssued(cid ? { challenge: { id: cid, ...(body.approval ? { approval: body.approval } : {}) } } : {}); }, []);
  const showRetry = useCallback((body) => { setRun(body); setTrail((t) => nextTrail(t, body, false)); }, []);

  // Run a shipped scenario: set its bands, then make the call — exactly what the gate measures.
  const runToken = useRef(0);
  const [running, setRunning] = useState(false); // a scenario/agent call in flight: the buttons show it
  const runScenario = useCallback(async (sid, { applyBands = true } = {}) => {
    const token = ++runToken.current;
    const drop = () => token !== runToken.current;
    setFail(null);
    setRunning(true);
    if (isReal(sid)) { setRunning(false); setRun(null); setTrail([]); setIssued({}); setRealEx([]); setRealMsg(null); return; } // nothing is sent until the owner presses the button
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
    setRunning(false);
    if (res.ok || res.body.decision) {
      showFresh(res.body);
      if (res.body.error === "mcp_step_up_required" && (res.body.step_up_method === "p1mfa" || res.body.step_up_method === "pingid-push")) setBeat({ kind: "mfa", payload });
      else if (res.body.error === "ciba_required") setBeat({ kind: "ciba", payload });
      else if (res.body.error === "pending_approval") setBeat({ kind: "privilege", payload, challengeId: res.body.approval?.instruction_id });
      else if (res.body.error === "mcp_hitl_required") setBeat({ kind: "hitl", payload, challengeId: res.body.challengeId });
    } else { setRun(null); setTrail([]); setIssued({}); setObsNoRun(true); setObsAfterReset(false); setFail(`Could not evaluate (${res.body.detail || res.body.error || res.status}).`); }
  }, [story, showFresh, isReal]);

  useEffect(() => { setRun(null); setBeat(null); setTrail([]); setIssued({}); setObsNoRun(false); setObsAfterReset(false); }, [resetSignal]);
  // No auto-run: the visitor makes the agent call themselves. Switching chips only selects; the
  // run starts on their click. A chip switch clears the previous run instead of starting a new one.
  const lastId = useRef(id);
  useEffect(() => {
    if (lastId.current === id) return;
    lastId.current = id;
    setRun(null); setBeat(null); setTrail([]); setIssued({}); setObsNoRun(false); setObsAfterReset(false);
  }, [id]);

  const onResult = useCallback((r) => showFresh(r), [showFresh]);
  const onBlocked = useCallback((kind, payload, challengeId) => setBeat({ kind, payload, challengeId }), []);
  const onIssued = useCallback((challenge) => setIssued((i) => ({ ...i, challenge })), []);
  const onMinted = useCallback((receipt) => setIssued((i) => ({ ...i, receipt: typeof receipt === "string" ? { id: receipt } : receipt })), []);
  // After a human beat is satisfied, retry the EXACT call that was blocked — the beat stores
  // the full payload (tool, amount, step_up_method), so the visitor's manual amount is what
  // the human approved and what the retry repeats.
  const retrySame = useCallback((opts) => {
    if (!beat?.payload) return;
    // Same guard as runScenario: a newer scenario run or a Reset makes this (slower) retry's answer stale, so it is dropped.
    const token = ++runToken.current;
    runTool(beat.payload, { ...opts, retry: true }).then((res) => {
      if (token !== runToken.current || !(res.ok || res.body.decision)) return;
      // A Privilege retry that is refused (lapsed, wrong amount) opens a fresh hold: show it and ask the approver again.
      if (res.body.error === "pending_approval") { showFresh(res.body); setBeat({ kind: "privilege", payload: beat.payload, challengeId: res.body.approval?.instruction_id }); } else showRetry(res.body);
    }, () => {});
  }, [beat, showRetry, showFresh]);

  const realActive = isReal(id);
  useEffect(() => { if (realActive) getJson("/api/privilege/real").then(setRealCfg, () => setRealCfg(null)); }, [realActive]);
  useEffect(() => { if (realActive && run?.real && run?.error === "pending_approval") setApprovalInput(run.approval?.instruction_id || ""); }, [realActive, run]);
  // One real call. approvalId makes it the retry the owner sends after approving in their own console.
  // quiet = an automatic retry while the hold is pending: a still-held answer only counts the try (no new trace row, no message).
  const realCall = async (approvalId = null, { quiet = false } = {}) => {
    if (!quiet) { setRealBusy(true); setRealMsg(null); }
    const r = await callRealPrivilege(approvalId).catch(() => ({ ok: false, status: 0, body: {} }));
    if (!quiet) setRealBusy(false);
    const title = approvalId ? `tools/call retried with ${approvalId}` : "tools/call";
    if (quiet && r.ok && r.body.outcome === "held") { setRealWait((w) => ({ ...(w || {}), tries: ((w && w.tries) || 0) + 1 })); return; }
    if (quiet) setRealWait((w) => ({ ...(w || {}), stopped: true }));
    // The server says which run the call belongs to (runObservability): began = a run holds it, afterReset = a Reset came while it was in flight. A first call starts a run.
    const info = r.body.runObservability;
    const afterReset = Boolean(info?.afterReset);
    if (!approvalId) { setObsGen((g) => g + 1); setObsNoRun(!info?.began && !afterReset); }
    if (!r.ok) {
      setObsAfterReset(afterReset);
      setRealMsg(r.body.message || "The real call failed.");
      if (r.body.trace) setRealEx((e) => [...e, { step: e.length + 1, title, status: null, trace: r.body.trace }]);
      return;
    }
    const mapped = realRun(r.body, approvalId ? run : null);
    if (approvalId) {
      showRetry(mapped);
      if (r.body.outcome === "executed") setIssued((i) => ({ ...i, receipt: { id: approvalId, method: null } }));
      if (r.body.outcome === "held") setRealMsg("The gateway held it again: it did not accept that approval id (not approved yet, expired, or not the id for this call).");
    } else showFresh(mapped);
    setRealEx((e) => [...e, { step: e.length + 1, title, status: r.body.http, trace: r.body.trace }]);
    setObsAfterReset(afterReset); // after showFresh, which clears it for a new run
  };
  const realCallRef = useRef(realCall);
  realCallRef.current = realCall;
  // Real: once the gateway holds the call, PRIVILEGE sends the PingID push to the approvers (tenant MFA on). The lab never talks to PingID: it
  // retries the same call with the instruction id every few seconds (a still-held call answers the same hold) until it runs, is refused or lapses.
  const heldId = realActive && run?.real && run?.error === "pending_approval" ? run.approval?.instruction_id || null : null;
  const heldExpires = heldId ? run.approval?.expires_at || null : null;
  useEffect(() => { setRealWait(null); }, [heldId]);
  useEffect(() => {
    if (!heldId || realWait?.stopped) return undefined;
    const lapse = Date.parse(heldExpires || "");
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      if (Number.isFinite(lapse) && Date.now() > lapse) { setRealWait((w) => ({ ...(w || {}), stopped: true, lapsed: true })); return; }
      busy = true;
      try { await realCallRef.current(heldId, { quiet: true }); } finally { busy = false; }
    }, 3000);
    return () => clearInterval(timer);
  }, [heldId, heldExpires, realWait?.stopped]);

  const cards = reelCards(run, issued);
  // The phone is off camera: when the retry comes back executed with an approval id, the PingID push was approved on a real
  // phone. A small confirmation modal records the moment (the lab only sees that the approval landed, not who approved).
  const [pushConfirmed, setPushConfirmed] = useState(null); // { id }
  const pushConfirmedSeen = useRef(false);
  useEffect(() => {
    if (run?.real && run?.receipt && !pushConfirmedSeen.current) {
      pushConfirmedSeen.current = true;
      setPushConfirmed({ id: run.receipt });
    }
    if (!run?.real) pushConfirmedSeen.current = false;
  }, [run?.real, run?.receipt]);

  return (
    <div className="gate-flow">
      <section className="panel gate-step" aria-labelledby="sc-h" data-testid="step-pick">
        <h2 id="sc-h"><span className="gate-step__n">1</span> Pick a scenario</h2>
        <div className="seg" role="group" aria-label="Scenario">
          {story.scenarios.map((s) => (
            <button key={s.id} type="button" data-scenario={s.id} aria-pressed={s.id === id}
              className={running && s.id === id ? "running" : undefined}
              disabled={running}
              onClick={() => { setBeat(null); setId(s.id); if (onSelect) onSelect(s.id); runScenario(s.id); }}>{s.title}</button>
          ))}
        </div>
        <p className="lesson" data-testid="lesson">{scenario.lesson}</p>
      </section>

      <section className="panel gate-step" aria-labelledby="flow-h" data-testid="step-flow">
        <h2 id="flow-h"><span className="gate-step__n">2</span> Watch the flow</h2>
        <LiveFlow pattern={pattern} trail={trail} run={run} resetSignal={resetSignal} />
      </section>

      <section className="panel gate-step" aria-labelledby="reel-h" data-testid="step-reel">
        <h2 id="reel-h"><span className="gate-step__n">3</span> Token reel <span className="muted">credentials in the order they appear</span></h2>
        <TokenReel cards={cards} />
      </section>

      <section className="panel gate-step" aria-labelledby="res-h" data-testid="step-result">
        <h2 id="res-h"><span className="gate-step__n">4</span> Gate result</h2>
        {fail && <p className="field-error" role="alert">{fail}</p>}
        {realActive && (
          <div className="panel panel--real" data-testid="real-panel">
            <h3>Real: your Privilege gateway <span className="tag tag--warn">REAL</span></h3>
            <p className="muted">
              {realCfg?.ok ? <>Door <code>{realCfg.host}</code>, tool <code>{realCfg.tool}</code>. </> : null}
              The call below really goes to your gateway with your agent key (kept on the server, never shown here). The approval is Privilege's and yours: Privilege sends the PingID push to the approvers' phones, you approve there, and this lab never talks to PingID. It only sends the call, waits, and retries; what it shows of the approval it observes or infers.
            </p>
            <h4>PingID through Privilege (the real path)</h4>
            <p className="muted">Privilege itself asks PingID; this lab only sends the call and waits. Check these in your Privilege console first:</p>
            <ol className="muted" data-testid="real-checklist">
              <li>Settings, Tenant: <strong>MFA is Enabled</strong>.</li>
              <li>An AI policy on this door{realCfg?.tool ? <> for <code>{realCfg.tool}</code></> : null} is <strong>Active</strong> with outcome <strong>Require human approval</strong> (MCP server and target must match the tool).</li>
              <li>The approvers named in that policy have the PingID app paired. With tenant MFA on, the hold itself sends them the push.</li>
            </ol>
            <p className="muted">Then press <strong>Send the real call</strong>. Expect a hold (<code>pending_approval</code> with an instruction id). Privilege then sends the PingID push to the approvers' phones: approve it there. The lab retries by itself every 3 seconds until the call runs, is refused or the hold lapses. If no push arrives (tenant MFA off), approve in <strong>HITL Requests</strong>; the retry still picks it up.</p>
            {/* ui-pattern: allow P9 only shown while the scenario is Real, when the mock AgentCall (the other primary) is not rendered */}
            <button type="button" className="primary" data-testid="real-call" disabled={realBusy} onClick={() => realCall(null)}>Send the real call</button>
            {heldId && (
              <p className="muted" role="status" data-testid="real-waiting">
                {realWait?.lapsed ? "The hold lapsed before anyone approved it. Press Send the real call for a fresh hold."
                  : realWait?.stopped ? "Stopped waiting. Use the manual retry below, or send the real call again."
                  : <>Waiting for the approval: Privilege has sent the PingID push to the approvers. Retrying every 3 s ({realWait?.tries || 0} so far).{" "}
                    <button type="button" className="link" data-testid="real-stop-waiting" onClick={() => setRealWait((w) => ({ ...(w || {}), stopped: true }))}>Stop waiting</button></>}
              </p>
            )}
            {run?.error === "pending_approval" && (
              <>
                <label htmlFor="real-approval">Approval id to retry with (UNVERIFIED that it equals the instruction id: edit it if your console shows another)</label>
                <input id="real-approval" type="text" maxLength={64} value={approvalInput} onChange={(e) => setApprovalInput(e.target.value)} data-testid="real-approval" />
                <button type="button" data-testid="real-retry" disabled={realBusy || !approvalInput.trim()} onClick={() => realCall(approvalInput.trim())}>I approved it: retry with this id</button>
              </>
            )}
            {realMsg && <p className="field-error" role="alert" data-testid="real-msg">{realMsg}</p>}
            {pushConfirmed && (
              <FloatingDialog isOpen placement="right" onClose={() => setPushConfirmed(null)}
                title="PingID push approved" testId="pingid-confirmed-modal" defaultWidth={520} defaultHeight={null} minHeight={200} footer={null}>
                <div className="modal__card">
                  <p data-testid="pingid-confirmed">
                    <strong>The PingID push was approved.</strong> The approver confirmed it on their phone, the gateway accepted the retry with the
                    approval id, and the transfer executed.
                  </p>
                  <p className="muted">Approval id: <code data-testid="pingid-confirmed-id">{pushConfirmed.id}</code> — single-use and amount-bound: this exact call ran once, and the id cannot pass again.</p>
                  <div className="modal__actions">
                    <button type="button" className="primary" data-testid="pingid-confirmed-dismiss" onClick={() => setPushConfirmed(null)}>Dismiss</button>
                  </div>
                </div>
              </FloatingDialog>
            )}
          </div>
        )}
        <Verdict run={run} />
        {realActive
          ? (realEx.length ? <GatewayTrace exchanges={realEx} source="real" hot={["error"]} basisNote="This is your real gateway. A real gateway reports a status and a body, not a per-check breakdown: each decision below is observed in the response or inferred from the outcome, and the PingID step is never reported." /> : <p className="muted" data-testid="real-empty">Nothing has been sent yet. Press "Send the real call".</p>)
          : run && <Hops hops={run.hops} traceId={run.traceId} />}
      </section>

      <div className="panel gate-obs" data-testid="step-obs">
        <RunObs mode={mode} hasRun={realActive ? realEx.length > 0 : Boolean(run)} noRun={obsNoRun} afterReset={obsAfterReset} simulatedInReal={mode === "real" && !realActive} gen={obsGen} beat={beat} />
      </div>

      <details className="panel gate-more" data-testid="step-try">
        <summary>Try your own call, or change the bands</summary>
        <div className="gate">
          {bands && <BandsEditor current={bands} onSaved={(b) => { setBandsState(b); if (!beat) runScenario(id, { applyBands: false }); }} />}
          {realActive
            ? <p className="muted panel" data-testid="try-disabled">Not available while this scenario is Real: a call from here would run the simulated gate, not your gateway. Pick another scenario, or switch the header toggle to Mock.</p>
            : <AgentCall tools={story.tools} onResult={onResult} onBlocked={onBlocked} onRunning={setRunning} onNoRun={() => setObsNoRun(true)} running={running} />}
        </div>
      </details>

      <details className="panel gate-more" data-testid="step-pingid">
        <summary>PingID for real: configure a user who does not have PingID yet</summary>
        <p className="muted">The lab mocks the step-up. If the user does not have PingID yet, walk the measured enrolment chain, in your own PingOne environment, not here.</p>
        <button type="button" data-testid="pingid-setup-open" onClick={() => setPingidOpen(true)}>Configure PingID for a user</button>
      </details>
      <PingIdSetup open={pingidOpen} onClose={() => setPingidOpen(false)} resetSignal={resetSignal} />

      <ConsentModal open={beat?.kind === "hitl"} amount={beat?.payload?.amount} challengeId={beat?.challengeId}
        onApproved={(receipt) => { onMinted(receipt); setBeat(null); retrySame(); }}
        onDenied={() => { setBeat(null); setRun((r) => r && { ...r, error: "consent_denied", detail: "The human denied the request; the transfer stays paused." }); }}
        onClose={() => setBeat(null)} />
      <PrivilegeModal open={beat?.kind === "privilege" && !realActive} amount={beat?.payload?.amount} requestId={beat?.challengeId}
        onApproved={(a) => { onMinted({ id: a.id, method: a.method }); setBeat(null); retrySame({ approvalId: a.id }); }}
        onRejected={() => { setBeat(null); setRun((r) => r && { ...r, error: "approval_rejected", detail: "The approver rejected the request; nothing ran and no approval was issued." }); }}
        onClose={() => setBeat(null)} />
      <MfaModal open={beat?.kind === "mfa" && beat?.payload?.step_up_method !== "pingid-push"} amount={beat?.payload?.amount} onIssued={onIssued}
        onVerified={(receipt) => { onMinted(receipt); setBeat(null); retrySame(); }}
        onClose={() => setBeat(null)} />
      <PushModal open={beat?.kind === "mfa" && beat?.payload?.step_up_method === "pingid-push"} amount={beat?.payload?.amount} onIssued={onIssued}
        onVerified={(receipt) => { onMinted(receipt); setBeat(null); retrySame(); }}
        onDenied={() => { setBeat(null); setRun((r) => r && { ...r, error: "push_denied", detail: "The push was denied on the phone; the transfer stays paused." }); }}
        onClose={() => setBeat(null)} />
      <CibaModal open={beat?.kind === "ciba"} amount={beat?.payload?.amount} onIssued={onIssued}
        onApproved={(receiptId) => { onMinted(receiptId); setBeat(null); retrySame(); }}
        onDenied={() => { setBeat(null); setRun((r) => r && { ...r, error: "ciba_denied", detail: "The user denied out-of-band; the transfer stays paused." }); }}
        onClose={() => setBeat(null)} />

      <details className="panel gate-more" data-testid="step-evidence">
        <summary>Scenario (decoded) and what we know, and how well</summary>
        <p className="tag tag--warn">{story.tokenLabel}</p>
        <Json value={{ bands: scenario.bands, call: scenario.call, declaredStepUp: scenario.declaredStepUp, expected: scenario.expected }} label="Scenario input" testId="scenario-prefs" hot={["expected", "amount", "declaredStepUp"]} />
        <h3>What we know, and how well</h3>
        <ul className="facts" data-testid="facts">
          {story.facts.map((f) => <li key={f.id}><span className={STATUS_CLASS[f.status] || "tag"}>{f.status}</span> {visible(f.text)} <span className="muted">({visible(f.source)})</span></li>)}
        </ul>
      </details>
    </div>
  );
}

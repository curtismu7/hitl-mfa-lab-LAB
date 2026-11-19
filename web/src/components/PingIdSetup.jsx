import { useCallback, useEffect, useState } from "react";
import FloatingDialog from "../floating-dialog/FloatingDialog";
import { pingidStatus, pingidStep, pingidReset } from "../api";
import { visible } from "../safeText";

/** The PingID setup wizard (owner request 2026-11-19): "configure PingID for a user who does
 * not have it yet". The steps are the measured enrolment chain (2026-11-18): assign the MFA
 * sign-on policy, sign in (enrolment happens at sign-in), scan the QR / pairing key, verify
 * the device is ACTIVE, then the next sign-in steps up for real. Mock mode walks the steps as
 * guidance; when the owner has set the live PingOne env vars, the last step hands over to the
 * owner-run checker (scripts/pingid-check.mjs) — the lab server itself stays at zero outbound. */
export default function PingIdSetup({ open, onClose, resetSignal }) {
  const [status, setStatus] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => { pingidStatus().then((j) => { setStatus(j); setMsg(null); }, () => setMsg("Could not load the wizard state.")); }, []);
  useEffect(() => { if (open) load(); }, [open, resetSignal, load]);

  if (!open) return null;
  const mark = async (stepId) => {
    const r = await pingidStep(stepId).catch(() => null);
    if (r) setStatus((s) => ({ ...s, done: r.body.done, complete: r.body.complete }));
    else setMsg("Could not record the step.");
  };
  const reset = async () => {
    const r = await pingidReset().catch(() => null);
    if (r) setStatus((s) => ({ ...s, done: [], complete: false }));
    else setMsg("Could not reset the wizard.");
  };

  const done = status?.done ?? [];
  return (
    <FloatingDialog isOpen onClose={onClose} title="Configure PingID for a user" testId="pingid-wizard"
      defaultWidth={620} defaultHeight={null} minHeight={220} footer={null}>
      <div className="modal__card">
        <p>The lab mocks the step-up, but the real engine is PingID. If the user does not have it yet, walk the measured enrolment chain — the whole flow happens in your PingOne environment, not in this lab (this lab never calls out).</p>
        {status ? (
          <>
            <ol className="pingid-steps" data-testid="pingid-steps">
              {status.steps.map((s, i) => {
                const isDone = done.includes(s.id);
                return (
                  <li key={s.id} className={isDone ? "pingid-step pingid-step--done" : "pingid-step"}>
                    <h3>{i + 1}. {visible(s.title)} {isDone && <span className="tag tag--ok">done</span>}</h3>
                    <p>{visible(s.why)}</p>
                    <p className="muted">Where: {visible(s.where)}</p>
                    {!isDone && <button type="button" data-testid={`pingid-mark-${s.id}`} onClick={() => mark(s.id)}>Mark done</button>}
                  </li>
                );
              })}
            </ol>
            {status.complete && <p className="tag tag--ok" data-testid="pingid-complete">Enrolment chain complete — the next real sign-in should step up.</p>}
            {status.liveConfigured
              ? <p className="muted">Live device check (owner-run, read-only): run <code>{visible(status.liveCheck)}</code> with the username as the argument — it verifies type PINGID_MOBILE, status ACTIVE.</p>
              : <p className="muted">{visible(status.liveHint)}</p>}
            {msg && <p className="field-error" role="alert">{msg}</p>}
            <div className="modal__actions">
              <button type="button" onClick={reset}>Reset wizard</button>
              <button type="button" onClick={onClose}>Close</button>
            </div>
          </>
        ) : <p className="muted">{msg || "Loading the wizard..."}</p>}
      </div>
    </FloatingDialog>
  );
}

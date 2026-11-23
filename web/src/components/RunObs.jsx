// Rule 27: the shared run-observability panel under the Gate result. It reads this lab's own record (GET /api/run-observability) and never invents one:
// Mock rows are simulated, Real rows are the replies the lab received (this lab reads no product logs).
import { useEffect, useState } from "react";
import RunObservability from "../run-observability/RunObservability.jsx";
import { getRunObservability } from "../api";

// Where this lab's decisions live and where they can stream (the README says the same).
export const LAB_STREAMS = [
  { product: "HITL MFA Lab server (this lab)", lives: "the lab container's stdout: one line per decision (step, layer, actor, result, mode, run; never a token or a secret), stamped when the lab computed or received it", streams: "nowhere today: the family log collector's source list does not include this lab's container. If it did, the SIEM time would be Docker's wall-clock time per line" },
  { product: "Privilege gateway and console (Real)", lives: "the hosted gateway's own events: the Privilege SIEM index and the console Activity Logs", streams: "not read by this lab: it has no log reader, so Real shows only the replies the lab received" },
  { product: "PingID, PingOne Authorize", lives: "not called by this lab (the approval push in Real is Privilege's; the amount-band gate is a mock)", streams: "nothing to stream" },
];

const TITLE = "What each layer logged for this run";
const Note = ({ testId, children, role = "status" }) => (
  <section className="ro" data-testid={testId} role={role} aria-label={TITLE}>
    <h2>{TITLE}</h2>
    <p className="ro-muted">{children}</p>
  </section>
);

const LAB_NOTE = {
  mock: "In Mock the amount-band gate, this lab's own mock of PingOne Authorize, decides under Authorize, and a Privilege hold comes from the lab's mock Privilege policy under Privilege. There is no separate gateway and no tool server, and the agent bearer is a placeholder, so Agent has nothing to show. Person rows are the approver's answers, simulated. Nothing here was read from a product log; times are when the lab computed each decision.",
  real: "In Real only the PRIVILEGE (PingID) scenario is real. The gateway's reply is shown under Agent gateway as a reply this lab received, never as a log line, and the hold is Privilege's own policy. The lab never calls PingID, so the approver's answer is not shown here. This lab reads no product logs, so there is nothing to re-read; times are when the lab received each reply.",
};

// gen changes when a new run starts (a record is never shown under another run); a write anywhere (workspace.js) or a human beat re-reads the same run.
export default function RunObs({ mode, hasRun, noRun = false, afterReset = false, simulatedInReal = false, gen, beat = null }) {
  const [bump, setBump] = useState(0);
  const [state, setState] = useState(null); // { key, answer } once an answer for that mode and run came back
  const key = `${mode}|${gen}`;
  const wanted = hasRun && !noRun && !afterReset && !simulatedInReal;
  useEffect(() => {
    const on = () => setBump((n) => n + 1);
    window.addEventListener("hmlab-step", on);
    return () => window.removeEventListener("hmlab-step", on);
  }, []);
  useEffect(() => {
    if (!wanted) { setState(null); return undefined; }
    let live = true;
    getRunObservability().then(
      (answer) => { if (live) setState({ key, answer }); },
      (e) => { if (live) setState({ key, answer: { error: "unreachable", message: `Could not reach the server (${String(e?.message || "network error").slice(0, 80)}).` } }); },
    );
    return () => { live = false; };
  }, [wanted, key, bump, beat]);

  if (simulatedInReal) {
    return <Note testId="ro-simulated-in-real">This scenario is simulated even in Real mode, so there are no real replies to show, and a simulated run is never shown under a Real label. Pick the PRIVILEGE (PingID) scenario to see the real run, or switch the header toggle to Mock to see this run's simulated rows.</Note>;
  }
  if (afterReset) return <Note testId="ro-after-reset">A reply to the real call arrived after Reset, so the lab wrote it to its stdout log only: it is in no record. Press Send the real call again to start a run.</Note>;
  if (noRun) return <Note testId="ro-no-run">This attempt began no run (the lab refused it before any decision, or could not be reached), so there is no record for it, and the page does not show an older one.</Note>;
  if (wanted && state?.key !== key) return <Note testId="ro-loading">Collecting this run's logs…</Note>;
  if (wanted && state.answer.record === null) return <Note testId="ro-none">{state.answer.message}</Note>;
  return (
    <>
      <RunObservability record={wanted ? state.answer : null} source={mode} streams={LAB_STREAMS} />
      <p className="ro-muted ro-lab-note" data-testid="ro-lab-note">{LAB_NOTE[mode]}</p>
    </>
  );
}

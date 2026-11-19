import { describe, expect, it } from "vitest";
import { beatOf, diagramSteps, hopSteps, nextTrail, nowLine, realRun, reelCards } from "./liveFlow";

const hop = (n, from, to, label) => ({ n, from, to, label });
const NODES = ["agent", "policy", "consent", "mfa", "phone", "transfer"];
const hitl = { decision: "HITL", error: "mcp_hitl_required", challengeId: "consent-1", tool: "create_transfer", amount: 300, hops: [hop(1, "agent", "policy", "Agent attempts the transfer"), hop(2, "policy", "policy", "Gate evaluates"), hop(3, "policy", "human", "HITL_CONSENT: the agent must pause for a human")] };
const retried = { decision: "PERMIT", receipt: "hitl-receipt-0001", receiptKind: "hitl", tool: "create_transfer", amount: 300, hops: [hop(1, "agent", "policy", "Agent attempts the transfer"), hop(2, "policy", "policy", "Gate evaluates"), hop(3, "policy", "transfer", "Receipt presented: the transfer executes")] };
const deny = { decision: "DENY", reason: "over the ceiling", tool: "create_transfer", amount: 2500, hops: [hop(1, "agent", "policy", "Agent attempts"), hop(2, "policy", "policy", "Gate evaluates"), hop(3, "policy", "agent", "DENY outranks every obligation")] };
const ciba = { decision: "STEP_UP", error: "ciba_required", step_up_method: "ciba", tool: "create_transfer", amount: 150, hops: [hop(1, "agent", "policy", "a"), hop(2, "policy", "policy", "b"), hop(3, "policy", "idp", "CIBA: bc-authorize"), hop(4, "idp", "human", "Out-of-band approval"), hop(5, "agent", "idp", "Agent polls")] };

describe("beatOf", () => {
  it("names the human beat of a paused, denied-by-human or retried run", () => {
    expect(beatOf(hitl)).toBe("hitl");
    expect(beatOf({ error: "mcp_step_up_required" })).toBe("mfa");
    expect(beatOf(ciba)).toBe("ciba");
    expect(beatOf({ error: "consent_denied" })).toBe("hitl");
    expect(beatOf(retried)).toBe("hitl");
    expect(beatOf({ receipt: "x", receiptKind: "stepUp" })).toBe("mfa");
  });
  it("is null when no human is involved", () => {
    expect(beatOf(null)).toBeNull();
    expect(beatOf(deny)).toBeNull();
    expect(beatOf({ decision: "PERMIT", hops: [] })).toBeNull();
  });
});

describe("hopSteps", () => {
  it("maps the server's human end to the right box and drops hops that stay on one box", () => {
    expect(hopSteps(hitl).map((s) => `${s.from}>${s.to}`)).toEqual(["agent>policy", "policy>consent"]);
    expect(hopSteps({ ...hitl, error: "mcp_step_up_required" }).at(-1).to).toBe("mfa");
  });
  it("maps CIBA's idp and human ends onto the phone box", () => {
    expect(hopSteps(ciba).map((s) => `${s.from}>${s.to}`)).toEqual(["agent>policy", "policy>phone", "agent>phone"]);
  });
  it("uses the short label (text before the colon)", () => {
    expect(hopSteps(hitl).at(-1).label).toBe("HITL_CONSENT");
  });
});

describe("nextTrail + diagramSteps", () => {
  it("a fresh call restarts the trail; the retry keeps the human beat and adds the transfer", () => {
    const t1 = nextTrail([], hitl, true);
    const t2 = nextTrail(t1, retried, false);
    expect(t2.map((s) => `${s.from}>${s.to}`)).toEqual(["agent>policy", "policy>consent", "policy>transfer"]);
    expect(nextTrail(t2, deny, true).map((s) => s.to)).toEqual(["policy", "agent"]);
  });
  it("while paused it draws one dimmed next arrow and points at the last walked one", () => {
    const t = nextTrail([], hitl, true);
    const d = diagramSteps(t, hitl, NODES);
    expect(d.current).toBe(1);
    expect(d.steps.at(-1)).toMatchObject({ from: "policy", to: "transfer", ghost: true });
  });
  it("draws no next arrow once done or denied, and skips arrows whose boxes the diagram lacks", () => {
    const done = diagramSteps(nextTrail(nextTrail([], hitl, true), retried, false), retried, NODES);
    expect(done.steps.some((s) => s.ghost)).toBe(false);
    expect(done.current).toBe(2);
    const denyD = diagramSteps(nextTrail([], deny, true), deny, NODES);
    expect(denyD.steps.some((s) => s.ghost)).toBe(false);
    const trimmed = diagramSteps(nextTrail([], hitl, true), hitl, ["agent", "policy"]);
    expect(trimmed.steps).toHaveLength(1);
    expect(diagramSteps([], null, NODES)).toEqual({ steps: [], current: -1 });
  });
});

describe("reelCards", () => {
  it("is empty before any run", () => expect(reelCards(null)).toEqual([]));
  it("shows bearer, challenge (now), receipt (next), transfer (next) while paused at consent", () => {
    const c = reelCards(hitl, { challenge: { id: "consent-1" } });
    expect(c.map((x) => `${x.id}:${x.status}`)).toEqual(["bearer:done", "challenge:now", "receipt:next", "outcome:next"]);
    expect(c[1].fields.id).toBe("consent-1");
    expect(c[2].title).toBe("Consent receipt");
  });
  it("marks everything done, with the receipt consumed, after the retry", () => {
    const c = reelCards(retried, { challenge: { id: "consent-1" }, receipt: { id: "hitl-receipt-0001" } });
    expect(c.map((x) => x.status)).toEqual(["done", "done", "done", "done"]);
    expect(c[2]).toMatchObject({ state: "consumed on retry" });
    expect(c[2].fields.id).toBe("hitl-receipt-0001");
    expect(c[3].state).toBe("executed");
  });
  it("shows the MFA credit's 5-minute TTL and the CIBA auth_req_id", () => {
    const mfa = reelCards({ ...hitl, error: "mcp_step_up_required" }, { challenge: { id: "mfa-1" } });
    expect(mfa[1].title).toBe("MFA challenge");
    expect(mfa[2].fields.ttl).toBe("5 min");
    const cb = reelCards(ciba, { challenge: { id: "authreq-1", bindingMessage: "Approve $150 transfer" } });
    expect(cb[1].title).toBe("CIBA auth_req_id");
    expect(cb[1].fields).toMatchObject({ id: "authreq-1", expires_in: 300, interval: 2, binding_message: "Approve $150 transfer" });
  });
  it("shows (issuing...) until a beat that mints its own challenge id has one", () => {
    expect(reelCards({ ...hitl, error: "mcp_step_up_required", challengeId: undefined }, {})[1].fields.id).toBe("(issuing...)");
  });
  it("DENY issues no credential; a human no leaves the receipt unissued", () => {
    const d = reelCards(deny);
    expect(d.map((x) => `${x.id}:${x.status}`)).toEqual(["bearer:done", "challenge:blocked", "outcome:blocked"]);
    const no = reelCards({ ...hitl, error: "consent_denied" }, { challenge: { id: "consent-1" } });
    expect(no[1]).toMatchObject({ status: "blocked", state: "denied" });
    expect(no[2]).toMatchObject({ status: "blocked", state: "none issued" });
  });
  it("a PERMIT with no human beat is bearer then executed", () => {
    expect(reelCards({ decision: "PERMIT", tool: "create_transfer", amount: 50, hops: [] }).map((x) => x.id)).toEqual(["bearer", "outcome"]);
  });
  it("never puts a value in a field that came from nowhere", () => {
    for (const run of [hitl, retried, deny, ciba]) for (const c of reelCards(run)) expect(Object.values(c.fields).every((v) => v !== undefined)).toBe(true);
  });
});

describe("nowLine", () => {
  it("says something different for every state", () => {
    const lines = [null, hitl, { error: "mcp_step_up_required" }, ciba, { error: "consent_denied" }, deny, retried, { decision: "PERMIT" }].map(nowLine);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

import { blockedBy } from "./components/PatternDiagram";
describe("blockedBy", () => {
  const nodes = ["agent", "policy", "consent", "mfa", "phone", "transfer"].map((id) => ({ id }));
  const pos = { agent: { x: 0, y: 240 }, policy: { x: 300, y: 240 }, consent: { x: 600, y: 80 }, mfa: { x: 600, y: 240 }, phone: { x: 600, y: 400 }, transfer: { x: 900, y: 240 } };
  it("flags an arrow that would run through another box, and only that", () => {
    expect(blockedBy(nodes, pos, { from: "policy", to: "transfer" })).toBe(true);
    expect(blockedBy(nodes, pos, { from: "agent", to: "policy" })).toBe(false);
    expect(blockedBy(nodes, pos, { from: "policy", to: "consent" })).toBe(false);
    expect(blockedBy(nodes, pos, { from: "policy", to: "phone" })).toBe(false);
  });
});

describe("the Privilege hold", () => {
  const approval = { status: "pending_approval", instruction_id: "ins_000001", policy_ids: ["ai-transfer-hitl:1"], reason: "r", retry_header: "X-Procyon-Approval-Id", open_for_s: 120, retry_within_s: 90 };
  const held = { decision: "STEP_UP", error: "pending_approval", step_up_method: "privilege", tool: "create_transfer", amount: 150, approval, hops: [hop(1, "agent", "policy", "Agent attempts"), hop(2, "policy", "policy", "Gate evaluates"), hop(3, "policy", "approver", "HELD: the Privilege gateway queues a human-approval request")] };
  const done = { decision: "PERMIT", receipt: "ins_000001", receiptKind: "privilege", tool: "create_transfer", amount: 150, approval: { id: "ins_000001", method: "push", status: "used" }, hops: [hop(1, "agent", "policy", "a"), hop(2, "policy", "policy", "b"), hop(3, "policy", "approver", "HELD"), hop(4, "approver", "pingid", "PingID confirms the approver"), hop(5, "policy", "transfer", "Receipt presented")] };
  const NODES2 = [...NODES, "approver", "pingid"];

  it("is its own beat, paused until the approver decides", () => {
    expect(beatOf(held)).toBe("privilege");
    expect(beatOf(done)).toBe("privilege");
    expect(beatOf({ error: "approval_rejected" })).toBe("privilege");
  });
  it("draws the hold, then dims the PingID step and the transfer that come next", () => {
    const t = nextTrail([], held, true);
    expect(t.map((s) => `${s.from}>${s.to}`)).toEqual(["agent>policy", "policy>approver"]);
    const d = diagramSteps(t, held, NODES2);
    expect(d.steps.filter((s) => s.ghost).map((s) => `${s.from}>${s.to}`)).toEqual(["approver>pingid", "policy>transfer"]);
    expect(d.current).toBe(1);
  });
  it("after the retry the whole path is walked, with no dimmed arrow left", () => {
    const t = nextTrail(nextTrail([], held, true), done, false);
    expect(t.map((s) => `${s.from}>${s.to}`)).toEqual(["agent>policy", "policy>approver", "approver>pingid", "policy>transfer"]);
    expect(diagramSteps(t, done, NODES2).steps.some((s) => s.ghost)).toBe(false);
  });
  it("without the approver and PingID boxes (another diagram) it still draws what it can", () => {
    expect(diagramSteps(nextTrail([], held, true), held, NODES).steps.map((s) => s.to)).toEqual(["policy", "transfer"]);
  });
  it("the reel: held call now, PingID and approval waiting, then all done with the approval used", () => {
    const issued = { challenge: { id: "ins_000001", approval } };
    const c = reelCards(held, issued);
    expect(c.map((x) => `${x.id}:${x.status}`)).toEqual(["bearer:done", "challenge:now", "pingid:next", "receipt:next", "outcome:next"]);
    expect(c[1].fields).toMatchObject({ instruction_id: "ins_000001", http: "403 pending_approval", retry_header: "X-Procyon-Approval-Id", open_for: "120 s" });
    const d = reelCards(done, { ...issued, receipt: { id: "ins_000001", method: "push" } });
    expect(d.map((x) => x.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(d[2].fields).toMatchObject({ method: "push", result: "approved" });
    expect(d[3]).toMatchObject({ state: "used on retry" });
    expect(d[3].fields).toMatchObject({ id: "ins_000001", grant: "this transaction only", retry_within: "90 s" });
  });
  it("a reject leaves PingID unasked and nothing issued", () => {
    const c = reelCards({ ...held, error: "approval_rejected" }, { challenge: { id: "ins_000001", approval } });
    expect(c.slice(1).map((x) => `${x.id}:${x.status}:${x.state}`)).toEqual(["challenge:blocked:rejected", "pingid:blocked:not asked", "receipt:blocked:none issued", "outcome:blocked:not executed"]);
  });
  it("says it in words", () => {
    expect(nowLine(held)).toMatch(/Privilege gateway.*HITL Requests.*PingID/);
    expect(nowLine(done)).toMatch(/PingID confirmed/);
    expect(nowLine({ error: "approval_rejected" })).toMatch(/rejected/);
    expect(nowLine({ ...held, approval: { ...approval, rejected_approval: { id: "ins_000001", reason: "already_used" } } })).toMatch(/retry was refused \(already_used\).*fresh hold/);
  });
});

describe("Real mode runs", () => {
  const heldRes = { outcome: "held", basis: "observed", http: 403, tool: "IndexMappingTool", held: { instruction_id: "ins_real1", policy_ids: ["p:1"], reason: "r", retry_header: "X-Procyon-Approval-Id" } };
  const doneRes = { outcome: "executed", basis: "observed", http: 200, tool: "IndexMappingTool", approvalPresented: "ins_real1" };
  it("a held answer is a paused privilege run that carries the evidence", () => {
    const r = realRun(heldRes);
    expect(r).toMatchObject({ real: true, decision: "STEP_UP", error: "pending_approval", evidence: "observed", approval: { instruction_id: "ins_real1" } });
    expect(beatOf(r)).toBe("privilege");
    expect(hopSteps(r).map((s) => `${s.from}>${s.to}`)).toEqual(["agent>policy", "policy>approver"]);
    expect(nowLine(r)).toMatch(/your Privilege gateway \(observed\).*HITL Requests.*PingID/);
    expect(realRun({ ...heldRes, basis: "inferred" }).evidence).toBe("inferred");
  });
  it("the retry run walks hold, PingID (inferred) and transfer, and the reel says PingID is inferred, never reported", () => {
    const held = realRun(heldRes);
    const done = realRun(doneRes, held);
    expect(hopSteps(done).map((s) => `${s.from}>${s.to}`)).toEqual(["agent>policy", "policy>approver", "approver>pingid", "policy>transfer"]);
    expect(hopSteps(done)[2].label).toMatch(/inferred/);
    const c = reelCards(done, { challenge: { id: "ins_real1", approval: held.approval }, receipt: { id: "ins_real1", method: null } });
    expect(c.find((x) => x.id === "pingid")).toMatchObject({ state: "approver confirmed (inferred)" });
    expect(c.find((x) => x.id === "pingid").fields.method).toMatch(/not visible to the lab/);
    expect(c.find((x) => x.id === "pingid").fields.result).toMatch(/inferred/);
    expect(nowLine(done)).toMatch(/lab can only infer/);
    expect(reelCards(held, { challenge: { id: "ins_real1", approval: held.approval } })[1].state).toBe("pending_approval (observed)");
    // tags: REAL for what the gateway returned, INFERRED for the PingID step, and the bearer is the real key kept on the server
    expect(c.map((x) => `${x.id}:${x.tag}`)).toEqual(["bearer:REAL", "challenge:REAL", "pingid:INFERRED", "receipt:REAL", "outcome:REAL"]);
    expect(c[0].fields.Authorization).toMatch(/kept on the server/);
    expect(c[0].note).not.toMatch(/placeholder/);
  });
  it("an answer that is neither a hold nor a run is shown as refused, never as executed", () => {
    const r = realRun({ outcome: "refused", basis: "observed", http: 401, tool: "T", message: "the gateway refused the agent key (401)" });
    expect(r).toMatchObject({ decision: "REFUSED", error: "real_refused" });
    const c = reelCards(r);
    expect(c.map((x) => `${x.id}:${x.status}`)).toEqual(["bearer:done", "challenge:blocked", "outcome:blocked"]);
    expect(c[1].fields.message).toMatch(/401/);
    expect(nowLine(r)).toMatch(/did not hold or run/);
  });
  it("a call the gateway just ran (no policy hold) is an executed run with no approval", () => {
    const r = realRun({ outcome: "executed", basis: "observed", http: 200, tool: "T", approvalPresented: null });
    expect(r.decision).toBe("PERMIT"); expect(r.receipt).toBeUndefined();
  });
});

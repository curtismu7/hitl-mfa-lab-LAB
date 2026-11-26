import { describe, expect, it } from "vitest";
import { beatOf, diagramSteps, hopSteps, nextTrail, nowLine, reelCards } from "./liveFlow";

const hop = (n, from, to, label) => ({ n, from, to, label });
const NODES = ["agent", "policy", "consent", "mfa", "phone", "transfer"];
const held = { decision: "STEP_UP", error: "mcp_step_up_required", step_up_method: "pingid-push", tool: "create_transfer", amount: 150, hops: [hop(1, "agent", "policy", "Agent attempts"), hop(2, "policy", "policy", "Gate evaluates"), hop(3, "policy", "idp", "PingID: a push goes to the in-page mock phone (this beat is simulated)"), hop(4, "idp", "human", "The approver answers on the phone"), hop(5, "agent", "idp", "Agent polls for the answer")] };
const done = { decision: "PERMIT", receipt: "push-receipt-0001", receiptKind: "push", tool: "create_transfer", amount: 150, hops: [hop(1, "agent", "policy", "a"), hop(2, "policy", "policy", "b"), hop(3, "policy", "transfer", "Receipt presented")] };

describe("the PingID push beat", () => {
  it("is its own beat (not MFA), for the held call, the denial and the retried success", () => {
    expect(beatOf(held)).toBe("push");
    expect(beatOf({ ...held, error: "push_denied" })).toBe("push");
    expect(beatOf(done)).toBe("push");
    expect(beatOf({ error: "mcp_step_up_required", step_up_method: "p1mfa" })).toBe("mfa");
  });
  it("is drawn on the phone box: policy to phone, then the agent polling the phone, then the transfer", () => {
    expect(hopSteps(held).map((s) => `${s.from}>${s.to}`)).toEqual(["agent>policy", "policy>phone", "agent>phone"]);
    const t = nextTrail(nextTrail([], held, true), done, false);
    expect(t.map((s) => `${s.from}>${s.to}`)).toEqual(["agent>policy", "policy>phone", "agent>phone", "policy>transfer"]);
    expect(diagramSteps(t, done, NODES).steps.some((s) => s.ghost)).toBe(false);
    expect(diagramSteps(nextTrail([], held, true), held, NODES).steps.at(-1)).toMatchObject({ from: "policy", to: "transfer", ghost: true });
  });
  it("the reel names the push, shows its 60 s window and 5 min credit, and marks everything done after the retry", () => {
    const c = reelCards(held, { challenge: { id: "push-0001", bindingMessage: "Approve $150 transfer" } });
    expect(c.map((x) => `${x.id}:${x.status}`)).toEqual(["bearer:done", "challenge:now", "receipt:next", "outcome:next"]);
    expect(c[1].title).toBe("PingID push challenge");
    expect(c[1].fields).toMatchObject({ id: "push-0001", binding_message: "Approve $150 transfer", expires_in: 60 });
    expect(c[2].title).toBe("PingID push credit");
    expect(c[2].fields.ttl).toBe("5 min");
    const d = reelCards(done, { challenge: { id: "push-0001" }, receipt: { id: "push-receipt-0001" } });
    expect(d.map((x) => x.status)).toEqual(["done", "done", "done", "done"]);
    expect(d[2]).toMatchObject({ state: "consumed on retry" });
  });
  it("a refused push leaves the credit unissued; the words say so", () => {
    const no = reelCards({ ...held, error: "push_denied" }, { challenge: { id: "push-0001" } });
    expect(no[1]).toMatchObject({ status: "blocked", state: "denied" });
    expect(no[2]).toMatchObject({ status: "blocked", state: "none issued" });
    expect(nowLine(held)).toMatch(/PingID push went to the approver/);
    expect(nowLine({ ...held, error: "push_denied" })).toMatch(/No, it's not me/);
  });
});

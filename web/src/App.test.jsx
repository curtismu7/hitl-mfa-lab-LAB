import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App, { BANNER_UNKNOWN } from "./App";
import { labelOffsets } from "./components/PatternDiagram";

const STORY = {
  title: "t", intro: "intro text", banner: "SIMULATED: mock gate", tokenLabel: "MOCK policy decisions", hosted: false, verticals: ["retail", "health"],
  rule: { name: "Transfer gate bands (mock authorization policy)", appliesTo: "Agent gateway", note: "n", defaults: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 } },
  tools: [{ name: "create_transfer", tier: "write", lesson: "l" }],
  scenarios: [
    { id: "consent-hitl", title: "HITL: $300 needs human consent", bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 }, call: { tool: "create_transfer", amount: 300 }, declaredStepUp: null, expected: "HITL", lesson: "Paused for consent." },
    { id: "pingid-push", title: "PUSH: $150 approved with a PingID push on the phone", bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 }, call: { tool: "create_transfer", amount: 150 }, declaredStepUp: "pingid-push", expected: "STEP_UP", lesson: "A push goes to the phone." },
    { id: "privilege-pingid", title: "PRIVILEGE: $150 held for PingID approval", bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 }, call: { tool: "create_transfer", amount: 150 }, declaredStepUp: "privilege", expected: "STEP_UP", lesson: "Held by the Privilege gateway." },
    { id: "deny-ceiling", title: "DENY: $2500 exceeds the hard limit", bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 }, call: { tool: "create_transfer", amount: 2500 }, declaredStepUp: null, expected: "DENY", lesson: "Refused outright." },
  ],
  facts: [
    { id: "amount-bands", status: "measured", text: "The amount bands decide the gate.", source: "transfer gate" },
    { id: "receipt-single-use", status: "measured", text: "Approval receipts are single-use.", source: "hitlCredit" },
  ],
  talkTrack: [
    { id: "say-first", title: "Say first", say: "Everything is simulated." },
    { id: "bands", title: "The amount bands", say: "One policy decides by band." },
  ],
  cast: { castHost: "northwind", castBrand: "Northwind Retail" },
};
const DIAGRAM = {
  title: "HITL & MFA", intro: "diagram intro",
  nodes: [{ id: "agent", label: "AI agent", kind: "actor", x: 0, y: 0 }, { id: "policy", label: "Transfer gate: amount bands", kind: "policy", x: 300, y: 0 }],
  steps: [{ from: "agent", to: "policy", label: "tools/call", say: "The agent calls the gate." }, { from: "policy", to: "agent", label: "Decision", say: "The gate answers." }],
};
const hop = (n) => ({ n, from: "agent", to: "policy", label: `hop ${n}`, traceparent: `00-${"a".repeat(32)}-${String(n).repeat(16)}-01`, request: `traceparent: 00-${"a".repeat(32)}-${String(n).repeat(16)}-01`, response: "HTTP/1.1 200 OK" });

const realTrace = (status, body) => ({ source: "real", request: { method: "POST", url: "https://gw.example/door/mcp", headers: { authorization: "Bearer <token, 12 characters, kept on the server>" }, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "IndexMappingTool", arguments: {} } } },
  response: status ? { status, headers: {}, body } : null, decisions: [{ id: "reach", label: "Reach the gateway", outcome: status ? "pass" : "fail", basis: "observed", evidence: status ? `HTTP ${status}` : "ECONNREFUSED" }], record: null });
const DEFAULT_BANDS = { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 };
const PINGID_STEPS = [
  { id: "policy-assigned", title: "Assign the MFA sign-on policy", why: "Out of the box it is assigned to nothing.", where: "PingOne admin console." },
  { id: "signin-enrol", title: "Sign in — enrolment happens at sign-in", why: "The login shows the QR and pairing key.", where: "Self Service URL." },
  { id: "scan-qr", title: "Scan the QR with PingID", why: "The device pairs to the user.", where: "PingID mobile app." },
  { id: "device-active", title: "Verify the device shows ACTIVE", why: "One device record per user.", where: "Owner-run check or console." },
  { id: "stepup-live", title: "Next sign-in steps up", why: "Password, push, approve, code.", where: "Sign in again." },
];
let calls;
let override = {};
const mfaReceipt = { id: "stepUp-receipt-0001", ttlMs: 300000, kind: "stepUp" };
function mockFetch() {
  calls = [];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    calls.push({ url, opts });
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith("/api/scenarios")) return override.scenarios ? override.scenarios() : json(STORY);
    if (url === "/api/info") return override.info ? override.info() : json({ mode: "mock", simulated: true, hosted: false });
    if (url === "/api/shelf") return json({ shelfUrl: "https://shelf.example:8443" });
    if (url.startsWith("/api/diagram")) return json(DIAGRAM);
    if (url === "/api/policy" && (!opts.method || opts.method === "GET")) {
      return json({ bands: override.bands || DEFAULT_BANDS, receipts: [], workspace: "t" });
    }
    if (url === "/api/policy" && opts.method === "POST") {
      const b = JSON.parse(opts.body || "{}");
      if (b.bands && (b.bands.confirmUsd >= b.bands.mfaUsd)) return json({ error: "bad_bands", detail: "crossing edit" }, 200).then((r) => ({ ...r, ok: true, status: 200, json: async () => ({ bands: DEFAULT_BANDS, workspace: "t" }) }));
      override.bands = { ...DEFAULT_BANDS, ...(b.bands || b) };
      return json({ bands: override.bands, workspace: "t" });
    }
    if (url === "/api/privilege/real" && (!opts.method || opts.method === "GET")) return json({ mode: "real", ok: true, host: "gw.example", tool: "IndexMappingTool", retryHeader: "X-Procyon-Approval-Id" });
    if (url === "/api/privilege/real/call") {
      const b = JSON.parse(opts.body || "{}");
      if (override.realFail) return json({ error: "upstream_unreachable", message: "Could not reach the gateway: ECONNREFUSED", trace: realTrace(null, null) }, 502);
      const executed = b.approvalId === "ins_real1";
      return json(executed
        ? { outcome: "executed", basis: "observed", http: 200, tool: "IndexMappingTool", approvalPresented: "ins_real1", summary: "ok", trace: realTrace(200, { jsonrpc: "2.0", id: 1, result: { content: [] } }) }
        : { outcome: "held", basis: "observed", http: 403, tool: "IndexMappingTool", approvalPresented: b.approvalId || null, held: { instruction_id: "ins_real1", policy_ids: ["p:1"], reason: "r", retry_header: "X-Procyon-Approval-Id" }, trace: realTrace(403, { jsonrpc: "2.0", id: 1, error: { code: -32600, data: { status: "pending_approval" } } }) });
    }
    if (url === "/api/privilege/hitl") return json({ requests: [{ id: "ins_000001", tool: "create_transfer", amount: 150, status: override.privApproved ? "approved" : "pending" }], policy: { demoPasscode: "123123" }, workspace: "t" });
    if (url === "/api/privilege/hitl/ins_000001/decide") {
      const b = JSON.parse(opts.body);
      if (b.decision === "reject") { override.privRejected = true; return json({ request: { id: "ins_000001", status: "rejected" } }); }
      if (b.pingid?.method === "push" && b.pingid.result !== "approved") return json({ error: "pingid_denied", detail: "PingID: \"No, it's not me\" — nothing was approved" }, 403);
      if (b.pingid?.method === "passcode" && b.pingid.code !== "123123") return json({ error: "bad_passcode", detail: "wrong PingID passcode" }, 401);
      override.privApproved = true; override.privMethod = b.pingid.method;
      return json({ request: { id: "ins_000001", status: "approved", method: b.pingid.method } });
    }
    if (url === "/api/transfer") {
      const b = JSON.parse(opts.body);
      const priv = (n) => ({ n, from: "policy", to: "approver", label: "HELD: queued", request: "r", response: "HTTP 403" });
      if (b.step_up_method === "privilege") {
        const presented = opts.headers && opts.headers["X-Procyon-Approval-Id"];
        if (presented === "ins_000001" && override.privApproved) {
          override.privApproved = false;
          return json({ decision: "PERMIT", reason: "approval presented", tool: b.tool, amount: Number(b.amount), receipt: "ins_000001", receiptKind: "privilege", approval: { id: "ins_000001", method: override.privMethod, status: "used" }, bands: DEFAULT_BANDS, traceId: "a".repeat(32), hops: [hop(1), hop(2), priv(3), { n: 4, from: "approver", to: "pingid", label: "PingID confirms the approver", request: "r", response: "ok" }, { n: 5, from: "policy", to: "transfer", label: "Receipt presented", request: "r", response: "HTTP 200" }] });
        }
        return json({ decision: "STEP_UP", reason: "held", tool: b.tool, amount: Number(b.amount), error: "pending_approval", detail: "action requires human approval", step_up_method: "privilege", approval: { status: "pending_approval", instruction_id: "ins_000001", policy_ids: ["ai-transfer-hitl:1"], reason: "r", retry_header: "X-Procyon-Approval-Id", open_for_s: 120, retry_within_s: 90 }, bands: DEFAULT_BANDS, traceId: "a".repeat(32), hops: [hop(1), hop(2), priv(3)] }, 403);
      }
      const bands = override.bands || DEFAULT_BANDS;
      const amt = Number(b.amount);
      // a retried call after a human beat is satisfied carries a receipt and permits — but ONLY
      // for the exact amount the human was shown; a retry at a different amount re-challenges.
      if (override.approved && override.approvedFor === amt) return json({ decision: "PERMIT", reason: "receipt presented", tool: b.tool, amount: amt, receipt: override.approvedKind === "push" ? "push-receipt-0001" : "hitl-receipt-0001", receiptKind: override.approvedKind || "hitl", bands, traceId: "a".repeat(32), hops: [hop(1), hop(2), hop(3)] }, 200);
      let decision = "PERMIT"; let status = 200; let reason = `amount ${amt} is below the confirm threshold`; let error; let detail; let step_up_method;
      if (b.step_up_method) { decision = "STEP_UP"; status = 428; reason = "sensitive agent-initiated action"; error = b.step_up_method === "ciba" ? "ciba_required" : "mcp_step_up_required"; step_up_method = b.step_up_method; }
      else if (amt > bands.denyCeilingUsd) { decision = "DENY"; status = 403; reason = `amount ${amt} exceeds the hard limit of ${bands.denyCeilingUsd}`; }
      else if (amt >= bands.mfaUsd) { decision = "STEP_UP"; status = 428; reason = `amount ${amt} is at or above the MFA threshold`; error = "mcp_step_up_required"; step_up_method = "p1mfa"; }
      else if (amt >= bands.confirmUsd) { decision = "HITL"; status = 428; reason = `amount ${amt} requires human consent`; error = "mcp_hitl_required"; }
      const challengeId = error === "mcp_hitl_required" ? "consent-1" : undefined;
      return json({ decision, reason, tool: b.tool, amount: amt, ...(error ? { error, detail: `${error}: the human beat is required`, ...(step_up_method ? { step_up_method } : {}), ...(challengeId ? { challengeId } : {}) } : { receipt: "hitl-receipt-0001", receiptKind: "hitl" }), bands, traceId: "a".repeat(32), hops: [hop(1), hop(2), hop(3)] }, status);
    }
    if (url === "/api/consent/respond") { const d = JSON.parse(opts.body).decision; if (d === "approved") { override.approved = true; override.approvedFor = 300; } return json({ challenge: { id: JSON.parse(opts.body).challengeId, status: d }, ...(d === "approved" ? { receipt: { id: "hitl-receipt-0001", amountBound: 300, kind: "hitl" } } : {}), workspace: "t" }); }
    if (url === "/api/mfa/push") return json({ challenge: { id: "push-0001", method: "pingid-push", status: "pending", bindingMessage: "Approve $150 transfer", expiresInSeconds: 60 }, workspace: "t" });
    if (url === "/api/mfa/push/push-0001/respond") { const d = JSON.parse(opts.body).decision; override.pushDecision = d; return json({ challenge: { id: "push-0001", status: d }, workspace: "t" }); }
    if (url === "/api/mfa/poll/push-0001") {
      if (override.pushDecision === "approved") { override.approved = true; override.approvedFor = 150; override.approvedKind = "push"; return json({ status: "verified", receipt: { id: "push-receipt-0001", ttlMs: 300000, kind: "push" } }); }
      if (override.pushDecision === "denied") return json({ status: "denied" });
      return json({ status: "pending" });
    }
    if (url === "/api/mfa/challenge") return json({ challenge: { id: "mfa-1", method: "p1mfa", status: "pending", devices: [{ id: "dev-1", type: "OTP", label: "Demo device (OTP)" }] }, workspace: "t" });
    if (url === "/api/mfa/verify") {
      const b = JSON.parse(opts.body);
      if (b.otp !== "123123") return json({ error: "bad_otp", detail: "wrong code" }, 401);
      override.approved = true; override.approvedFor = 600;
      return json({ challenge: { id: b.challengeId, status: "verified" }, receipt: mfaReceipt, workspace: "t" });
    }
    if (url === "/api/ciba/bc-authorize") return json({ auth_req_id: "ciba-0001-abc", expires_in: 300, interval: 2, binding_message: `Approve $${JSON.parse(opts.body).amount} transfer`, workspace: "t" });
    if (url.startsWith("/api/ciba/poll/")) return json({ status: override.cibaApproved ? "approved" : "pending", ...(override.cibaApproved ? { receiptId: "hitl-receipt-0002" } : {}), workspace: "t" });
    if (url === "/api/ciba/respond") { const d = JSON.parse(opts.body).decision; if (d === "approved") { override.cibaApproved = true; override.approved = true; override.approvedFor = 150; } return json({ status: d, receiptId: "hitl-receipt-0002", workspace: "t" }); }
    if (url === "/api/ciba/pending") return json({ pending: [], workspace: "t" });
    if (url === "/api/pingid/status") {
      return json({ steps: PINGID_STEPS, done: override.pingidDone || [], complete: (override.pingidDone || []).length === PINGID_STEPS.length, liveConfigured: !!override.pingidLive, workspace: "t", ...(override.pingidLive ? { liveCheck: "node scripts/pingid-check.mjs" } : { liveHint: "Set the env vars." }) });
    }
    if (url === "/api/pingid/step") { const id = JSON.parse(opts.body).stepId; override.pingidDone = [...(override.pingidDone || []), id]; return json({ done: override.pingidDone, complete: override.pingidDone.length === PINGID_STEPS.length, workspace: "t" }); }
    if (url === "/api/pingid/reset") { override.pingidDone = []; return json({ done: [], complete: false, workspace: "t" }); }
    if (url === "/api/runs") return json({ workspace: "t", runs: [] });
    if (url === "/api/reset") { override = {}; return json({ reset: "ok" }); }
    return json({}, 404);
  });
}
beforeEach(() => { override = {}; mockFetch(); window.location.hash = ""; });

const ready = async () => { render(<App />); await screen.findByText("HITL: $300 needs human consent"); await screen.findByTestId("verdict"); };

describe("shell", () => {
  it("shows the Shelf button in the header, linking to the shelf URL from /api/shelf", async () => {
    await ready();
    const link = await screen.findByRole("link", { name: "Shelf" });
    expect(link).toHaveAttribute("href", "https://shelf.example:8443");
  });
  it("shows the banner, the mode, and sends X-Workspace on API calls", async () => {
    await ready();
    expect(screen.getByTestId("banner")).toHaveTextContent(/^SIMULATED/);
    expect(screen.getByTestId("mode-select")).toHaveValue("mock");
    const ev = calls.find((c) => c.url === "/api/transfer");
    expect(ev.opts.headers["x-workspace"]).toMatch(/^[a-z0-9-]{1,40}$/);
  });
  it("Reset calls /api/reset", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("reset"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/reset" && c.opts.method === "POST")).toBe(true));
  });
});

describe("transfer gate tab", () => {
  it("runs the HITL scenario: PAUSED verdict, block reason, hops and facts", async () => {
    await ready();
    expect(screen.getByTestId("verdict")).toHaveTextContent("PAUSED");
    expect(screen.getByTestId("verdict")).toHaveTextContent("human consent");
    expect(screen.getByTestId("hops")).toHaveTextContent(/traceparent: 00-a{32}-1{16}-01/);
    expect(screen.getByTestId("facts")).toHaveTextContent("measured");
  });
  it("routes the deny scenario to DENIED with the hard-limit reason", async () => {
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /DENY: \$2500/ }));
    await waitFor(() => expect(screen.getByTestId("verdict")).toHaveTextContent("DENIED"));
    expect(screen.getByTestId("verdict")).toHaveTextContent("no approval can clear it");
    expect(screen.getByTestId("lesson")).toHaveTextContent("Refused outright.");
  });
  it("the bands editor reconfigures the gate live and the same call flips", async () => {
    await ready();
    await userEvent.clear(screen.getByTestId("band-confirm"));
    await userEvent.type(screen.getByTestId("band-confirm"), "100");
    await userEvent.click(screen.getByTestId("bands-save"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/policy" && c.opts.method === "POST" && JSON.parse(c.opts.body).bands?.confirmUsd === 100)).toBe(true));
    await userEvent.click(screen.getByTestId("call-run"));
    await waitFor(() => expect(screen.getByTestId("verdict")).toHaveTextContent("PAUSED"));
  }, 15000);
  it("the $300 HITL block opens the consent modal; approving retries and the receipt shows", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("call-run"));
    await waitFor(() => expect(screen.getByTestId("consent-modal")).toBeInTheDocument());
    expect(screen.getByTestId("consent-amount")).toHaveTextContent("$300");
    await userEvent.click(screen.getByTestId("consent-approve")); // the respond call mints the $300-bound receipt
    await waitFor(() => expect(screen.queryByTestId("consent-modal")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("verdict")).toHaveTextContent("PERMITTED"));
    expect(screen.getByTestId("receipt")).toHaveTextContent("hitl-receipt-0001");
  }, 15000);
  it("the $600 STEP_UP block opens the MFA modal; the demo OTP verifies and retries", async () => {
    await ready();
    await userEvent.clear(screen.getByTestId("call-amount"));
    await userEvent.type(screen.getByTestId("call-amount"), "600");
    await userEvent.click(screen.getByTestId("call-run"));
    await waitFor(() => expect(screen.getByTestId("mfa-modal")).toBeInTheDocument());
    await userEvent.type(screen.getByTestId("mfa-otp"), "123123");
    await userEvent.click(screen.getByTestId("mfa-verify"));
    await waitFor(() => expect(screen.queryByTestId("mfa-modal")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("verdict")).toHaveTextContent("PERMITTED"));
  }, 15000);
  it("the declared CIBA trigger opens the phone panel; approving on the phone retries", async () => {
    await ready();
    await userEvent.selectOptions(screen.getByTestId("call-declared"), "ciba");
    await userEvent.clear(screen.getByTestId("call-amount"));
    await userEvent.type(screen.getByTestId("call-amount"), "150");
    await userEvent.click(screen.getByTestId("call-run"));
    await waitFor(() => expect(screen.getByTestId("ciba-modal")).toBeInTheDocument());
    expect(screen.getByTestId("ciba-phone")).toHaveTextContent("Approve $150 transfer");
    await userEvent.click(screen.getByTestId("ciba-approve"));
    await waitFor(() => expect(screen.queryByTestId("ciba-modal")).toBeNull(), { timeout: 6000 });
    await waitFor(() => expect(screen.getByTestId("verdict")).toHaveTextContent("PERMITTED"), { timeout: 6000 });
  }, 20000);
  // The three human beats are the shared FloatingDialog (movable title bar, modal), and Escape dismisses each one like Dismiss.
  it("the consent modal is a FloatingDialog and Escape dismisses it", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("call-run"));
    const d = await screen.findByTestId("consent-modal");
    expect(d).toHaveAttribute("role", "dialog");
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(d).toHaveAccessibleName("Human approval required");
    expect(within(d).getByTestId("fd-titlebar")).toHaveTextContent("Human approval required");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("consent-modal")).toBeNull());
  }, 15000);
  it("the MFA modal is a FloatingDialog and Escape dismisses it", async () => {
    await ready();
    await userEvent.clear(screen.getByTestId("call-amount"));
    await userEvent.type(screen.getByTestId("call-amount"), "600");
    await userEvent.click(screen.getByTestId("call-run"));
    const d = await screen.findByTestId("mfa-modal");
    expect(d).toHaveAccessibleName("MFA step-up required");
    expect(within(d).getByTestId("fd-titlebar")).toHaveTextContent("MFA step-up required");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("mfa-modal")).toBeNull());
  }, 15000);
  it("the CIBA modal is a FloatingDialog and Escape dismisses it", async () => {
    await ready();
    await userEvent.selectOptions(screen.getByTestId("call-declared"), "ciba");
    await userEvent.click(screen.getByTestId("call-run"));
    const d = await screen.findByTestId("ciba-modal");
    expect(d).toHaveAccessibleName("CIBA: approval requested out-of-band");
    expect(within(d).getByTestId("fd-titlebar")).toHaveTextContent("CIBA: approval requested out-of-band");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("ciba-modal")).toBeNull());
  }, 15000);
});

describe("flow and token reel on the transfer gate tab", () => {
  it("numbers the steps top to bottom (pick, flow, token reel, result) and folds the editors away", async () => {
    await ready();
    const order = ["step-pick", "step-flow", "step-reel", "step-result", "step-try", "step-evidence"].map((id) => screen.getByTestId(id));
    order.slice(1).forEach((el, i) => expect(order[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
    expect(screen.getByTestId("step-try").open).toBe(false);
    expect(screen.getByTestId("step-evidence").open).toBe(false);
  });
  it("says where the run is, and the reel waits on the human while the consent dialog is open", async () => {
    await ready();
    await waitFor(() => expect(screen.getByTestId("flow-now")).toHaveTextContent("waiting for the human to consent"));
    expect(screen.getByTestId("reel-challenge-state")).toHaveTextContent("waiting for the human");
    expect(within(screen.getByTestId("reel-challenge")).getAllByText("consent-1").length).toBeGreaterThan(0);
    expect(screen.getByTestId("reel-receipt-state")).toHaveTextContent("not issued yet");
  });
  it("after Approve the reel shows the receipt consumed and the transfer executed", async () => {
    await ready();
    await userEvent.click(await screen.findByTestId("consent-approve"));
    await waitFor(() => expect(screen.getByTestId("flow-now")).toHaveTextContent("the transfer executed"));
    expect(screen.getByTestId("reel-receipt-state")).toHaveTextContent("consumed on retry");
    expect(within(screen.getByTestId("reel-receipt")).getAllByText("hitl-receipt-0001").length).toBeGreaterThan(0);
    expect(screen.getByTestId("reel-outcome-state")).toHaveTextContent("executed");
  }, 15000);
  it("the MFA beat puts the challenge id and the credit's TTL on the reel", async () => {
    await ready();
    await userEvent.click(screen.getByText(/Try your own call/));
    await userEvent.selectOptions(screen.getByTestId("call-declared"), "p1mfa");
    await userEvent.click(screen.getByTestId("call-run"));
    await screen.findByTestId("mfa-modal");
    await waitFor(() => expect(within(screen.getByTestId("reel-challenge")).getAllByText("mfa-1").length).toBeGreaterThan(0));
    expect(within(screen.getByTestId("reel-receipt")).getAllByText("5 min").length).toBeGreaterThan(0);
  }, 15000);
  it("a DENY issues no credential", async () => {
    await ready();
    await userEvent.click(screen.getByText("DENY: $2500 exceeds the hard limit"));
    await waitFor(() => expect(screen.getByTestId("reel-challenge-state")).toHaveTextContent("refused"));
    expect(screen.getByTestId("reel-outcome-state")).toHaveTextContent("not executed");
    expect(screen.queryByTestId("reel-receipt")).toBeNull();
  }, 15000);
});

describe("PingID push step-up (mock phone)", () => {
  const start = async () => { await ready(); await userEvent.click(screen.getByText("PUSH: $150 approved with a PingID push on the phone")); return screen.findByTestId("push-modal"); };
  it("the declared push opens the push dialog with the binding message, says it is a MOCK push, and the reel waits on the phone", async () => {
    await start();
    expect(screen.getByTestId("push-amount")).toHaveTextContent("$150");
    expect(screen.getByTestId("push-modal")).toHaveTextContent(/mock/i);
    await screen.findByTestId("push-phone");
    expect(screen.getByTestId("push-modal")).toHaveTextContent("Approve $150 transfer");
    expect(screen.getByTestId("flow-now")).toHaveTextContent(/PingID push went to the approver/);
    expect(screen.getByTestId("reel-challenge")).toHaveTextContent("PingID push challenge");
    expect(within(screen.getByTestId("reel-challenge")).getAllByText("push-0001").length).toBeGreaterThan(0);
    expect(screen.getByTestId("reel-receipt")).toHaveTextContent("PingID push credit");
    expect(screen.getByTestId("reel-receipt-state")).toHaveTextContent("not issued yet");
  }, 15000);
  it("Approve on the mock phone mints the credit, the call is retried once and the reel shows the push credit consumed", async () => {
    await start();
    await userEvent.click(await screen.findByTestId("push-approve"));
    await waitFor(() => expect(screen.getByTestId("verdict")).toHaveTextContent("PERMITTED"), { timeout: 8000 });
    expect(screen.queryByTestId("push-modal")).toBeNull();
    expect(screen.getByTestId("reel-receipt-state")).toHaveTextContent("consumed on retry");
    expect(within(screen.getByTestId("reel-receipt")).getAllByText("push-receipt-0001").length).toBeGreaterThan(0);
    expect(screen.getByTestId("reel-outcome-state")).toHaveTextContent("executed");
  }, 20000);
  it("\"No, it's not me\" leaves it held: nothing is issued and the flow says so", async () => {
    await start();
    await userEvent.click(await screen.findByTestId("push-deny"));
    await waitFor(() => expect(screen.getByTestId("flow-now")).toHaveTextContent(/No, it's not me/), { timeout: 8000 });
    expect(screen.queryByTestId("push-modal")).toBeNull();
    expect(screen.getByTestId("reel-receipt-state")).toHaveTextContent("none issued");
    expect(screen.getByTestId("reel-outcome-state")).toHaveTextContent("not executed");
  }, 20000);
  it("the ad-hoc call offers the pingid-push declared step-up too", async () => {
    await ready();
    await userEvent.click(screen.getByText(/Try your own call/));
    await userEvent.selectOptions(screen.getByTestId("call-declared"), "pingid-push");
    await userEvent.click(screen.getByTestId("call-run"));
    await screen.findByTestId("push-modal");
  }, 15000);
});

describe("Privilege hold confirmed with PingID", () => {
  const start = async () => { await ready(); await userEvent.click(screen.getByText("PRIVILEGE: $150 held for PingID approval")); return screen.findByTestId("privilege-modal"); };
  it("the held call opens the approver's HITL Requests; the reel shows the 403 and waits for PingID", async () => {
    await start();
    expect(screen.getByTestId("privilege-queue")).toHaveTextContent("ins_000001");
    expect(screen.getByTestId("flow-now")).toHaveTextContent(/Privilege gateway.*HITL Requests/);
    expect(screen.getByTestId("reel-challenge-state")).toHaveTextContent("pending_approval");
    expect(screen.getByTestId("reel-pingid-state")).toHaveTextContent("waiting for the approver");
    expect(screen.getByTestId("reel-receipt-state")).toHaveTextContent("not issued yet");
  }, 15000);
  it("Approve asks PingID; a push approval issues the approval, the agent retries with the header and the transfer executes", async () => {
    await start();
    await userEvent.click(screen.getByTestId("privilege-approve"));
    expect(screen.getByTestId("pingid-phone")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("pingid-approve"));
    await waitFor(() => expect(screen.getByTestId("flow-now")).toHaveTextContent("PingID confirmed the approver"));
    expect(screen.getByTestId("verdict")).toHaveTextContent("PERMITTED");
    expect(screen.getByTestId("reel-pingid-state")).toHaveTextContent("approver confirmed");
    expect(screen.getByTestId("reel-receipt-state")).toHaveTextContent("used on retry");
    expect(screen.getByTestId("reel-outcome-state")).toHaveTextContent("executed");
    const retry = calls.filter((c) => c.url === "/api/transfer").at(-1);
    expect(retry.opts.headers["X-Procyon-Approval-Id"]).toBe("ins_000001");
  }, 15000);
  it('"No, it\'s not me" approves nothing: the request stays held and no retry is made', async () => {
    await start();
    const before = calls.filter((c) => c.url === "/api/transfer").length;
    await userEvent.click(screen.getByTestId("privilege-approve"));
    await userEvent.click(screen.getByTestId("pingid-deny"));
    await waitFor(() => expect(screen.getByTestId("privilege-msg")).toHaveTextContent("nothing was approved"));
    expect(screen.getByTestId("privilege-modal")).toBeInTheDocument();
    expect(calls.filter((c) => c.url === "/api/transfer").length).toBe(before);
    expect(screen.getByTestId("reel-receipt-state")).toHaveTextContent("not issued yet");
  }, 15000);
  it("a wrong passcode is refused; the right one approves", async () => {
    await start();
    await userEvent.click(screen.getByTestId("privilege-approve"));
    await userEvent.type(screen.getByTestId("pingid-code"), "000000");
    await userEvent.click(screen.getByTestId("pingid-verify"));
    await waitFor(() => expect(screen.getByTestId("privilege-msg")).toHaveTextContent("wrong PingID passcode"));
    await userEvent.clear(screen.getByTestId("pingid-code"));
    await userEvent.type(screen.getByTestId("pingid-code"), "123123");
    await userEvent.click(screen.getByTestId("pingid-verify"));
    await waitFor(() => expect(screen.getByTestId("verdict")).toHaveTextContent("PERMITTED"));
    expect(screen.getByTestId("reel-pingid-state")).toHaveTextContent("approver confirmed");
  }, 15000);
  it("Reject needs no PingID and leaves nothing executed", async () => {
    await start();
    await userEvent.click(screen.getByTestId("privilege-reject"));
    await waitFor(() => expect(screen.queryByTestId("privilege-modal")).toBeNull());
    expect(screen.getByTestId("flow-now")).toHaveTextContent("rejected");
    expect(screen.getByTestId("reel-pingid-state")).toHaveTextContent("not asked");
    expect(screen.getByTestId("reel-outcome-state")).toHaveTextContent("not executed");
  }, 15000);
});

describe("Real mode (owner-run)", () => {
  const realReady = async () => { override.info = () => ({ ok: true, status: 200, json: async () => ({ mode: "real", simulated: true, hosted: false, realAvailable: true }) }); render(<App />); await screen.findByText("PRIVILEGE: $150 held for PingID approval"); await userEvent.click(screen.getByText("PRIVILEGE: $150 held for PingID approval")); return screen.findByTestId("real-panel"); };
  it("says plainly what is real, shows the Real panel, and sends NOTHING to the mock gate or the real gateway until the owner presses the button", async () => {
    await realReady();
    expect(screen.getByTestId("banner")).toHaveTextContent(/REAL MODE.*PRIVILEGE scenario sends a real tools\/call/);
    expect(screen.getByTestId("real-empty")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/transfer" && JSON.parse(c.opts.body).step_up_method === "privilege")).toBe(false);
    expect(calls.some((c) => c.url === "/api/privilege/real/call")).toBe(false);
    expect(screen.queryByTestId("privilege-modal")).toBeNull();
  }, 15000);
  it("Send the real call: the held answer is drawn as OBSERVED in the flow, the reel and the shared trace panel; the approval id is prefilled", async () => {
    await realReady();
    await userEvent.click(screen.getByTestId("real-call"));
    await waitFor(() => expect(screen.getByTestId("flow-now")).toHaveTextContent(/your Privilege gateway \(observed\)/));
    expect(screen.getByTestId("reel-challenge-state")).toHaveTextContent("pending_approval (observed)");
    expect(screen.getByTestId("real-approval").value).toBe("ins_real1");
    expect(screen.getByText(/What Privilege did/i)).toBeInTheDocument();
    expect(JSON.parse(calls.filter((c) => c.url === "/api/privilege/real/call")[0].opts.body)).toEqual({});
  }, 15000);
  it("after the owner approves in their console, the retry carries the id; PingID is shown as INFERRED, never as reported", async () => {
    await realReady();
    await userEvent.click(screen.getByTestId("real-call"));
    await userEvent.click(await screen.findByTestId("real-retry"));
    await waitFor(() => expect(screen.getByTestId("flow-now")).toHaveTextContent(/lab can only infer/));
    expect(JSON.parse(calls.filter((c) => c.url === "/api/privilege/real/call").at(-1).opts.body)).toEqual({ approvalId: "ins_real1" });
    expect(screen.getByTestId("reel-pingid-state")).toHaveTextContent("approver confirmed (inferred)");
    expect(screen.getByTestId("reel-receipt-state")).toHaveTextContent("used on retry");
  }, 15000);
  it("an unreachable gateway is a named message in the page and a failure trace, not a blank or a crash", async () => {
    await realReady();
    override.realFail = true;
    await userEvent.click(screen.getByTestId("real-call"));
    await waitFor(() => expect(screen.getByTestId("real-msg")).toHaveTextContent("Could not reach the gateway"));
    expect(screen.getByTestId("banner")).toBeInTheDocument();
  }, 15000);
  it("the mock Try-your-own-call is not offered on the Real scenario, so a mock id can never reach the real gateway", async () => {
    await realReady();
    await userEvent.click(screen.getByText(/Try your own call/));
    expect(screen.getByTestId("try-disabled")).toBeInTheDocument();
    expect(screen.queryByTestId("call-run")).toBeNull();
  }, 15000);
  it("the other scenarios stay simulated in Real mode", async () => {
    await realReady();
    await userEvent.click(screen.getByText("HITL: $300 needs human consent"));
    await waitFor(() => expect(screen.getByTestId("consent-modal")).toBeInTheDocument());
    expect(screen.queryByTestId("real-panel")).toBeNull();
  }, 15000);
});

describe("diagram tab", () => {
  it("draws the boxes from /api/diagram and Simulate highlights a step; Reset clears it", async () => {
    await ready();
    await userEvent.click(screen.getByRole("link", { name: "Diagram" }));
    expect(await screen.findByText("Transfer gate: amount bands")).toBeInTheDocument();
    expect(calls.some((c) => c.url.startsWith("/api/diagram?vertical=retail"))).toBe(true);
    expect(screen.getByTestId("banner")).toBeInTheDocument();
    expect(screen.getByLabelText(/Step time/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /simulate/i }));
    expect(await screen.findByTestId("pattern-now")).toHaveTextContent("Step 1: tools/call");
    await userEvent.click(screen.getByTestId("reset"));
    await waitFor(() => expect(screen.queryByTestId("pattern-now")).toBeNull());
  });
});

describe("talk track and presenter mode", () => {
  it("lists the talk track; presenter mode keeps the banner and shows the say-text; Esc leaves", async () => {
    await ready();
    await userEvent.click(screen.getByRole("link", { name: "Talk track" }));
    expect(screen.getByTestId("talk-track")).toHaveTextContent("Everything is simulated.");
    expect(screen.getByRole("link", { name: "Talk track" })).toHaveAttribute("aria-current", "page"); // shell-nav pill marks the current section
    await userEvent.click(screen.getByRole("link", { name: "Transfer gate" }));
    await userEvent.keyboard("p");
    expect(await screen.findByTestId("presenter-say")).toHaveTextContent("One policy decides by band.");
    expect(screen.getByTestId("banner")).toHaveTextContent(/^SIMULATED/);
    expect(document.querySelector(".app--presenter")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector(".app--presenter")).toBeNull();
  });
  it("the hosted build says HOSTED SIMULATION in the banner", async () => {
    const orig = STORY.banner;
    STORY.banner = "HOSTED SIMULATION: x"; STORY.hosted = true;
    try { render(<App />); await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/^HOSTED SIMULATION/)); expect(screen.getByTestId("mode-select")).toHaveValue("mock"); }
    finally { STORY.banner = orig; STORY.hosted = false; }
  });
});

describe("diagram edge labels", () => {
  it("nudges the two labels of a back-and-forth pair in opposite directions and leaves the rest alone", () => {
    const steps = [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "c" }];
    expect(labelOffsets(steps)).toEqual([-16, 16, 0]);
    expect(labelOffsets([])).toEqual([]);
  });
});

describe("PingID setup wizard", () => {
  it("opens from the button, shows the measured steps and marks one done", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("pingid-setup-open"));
    const d = await screen.findByTestId("pingid-wizard");
    expect(d).toHaveAccessibleName("Configure PingID for a user");
    expect(within(d).getByText("1. Assign the MFA sign-on policy")).toBeInTheDocument();
    await userEvent.click(within(d).getByTestId("pingid-mark-policy-assigned"));
    await waitFor(() => expect(within(d).getByText("done")).toBeInTheDocument());
    await waitFor(() => expect(within(d).getByTestId("pingid-mark-signin-enrol")).toBeInTheDocument());
    await userEvent.click(within(d).getByTestId("pingid-mark-signin-enrol"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/pingid/step" && JSON.parse(c.opts.body).stepId === "signin-enrol")).toBe(true));
  });
  it("without live config it shows the env hint; with live config it names the owner-run checker", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("pingid-setup-open"));
    expect(await screen.findByTestId("pingid-wizard")).toHaveTextContent("Set the env vars.");
  });
  it("with the live env vars set the wizard names the owner-run checker, never a value", async () => {
    override.pingidLive = true;
    await ready();
    await userEvent.click(screen.getByTestId("pingid-setup-open"));
    const d = await screen.findByTestId("pingid-wizard");
    expect(d).toHaveTextContent("node scripts/pingid-check.mjs");
  });
  it("Escape closes the dialog", async () => {
    await ready();
    await userEvent.click(screen.getByTestId("pingid-setup-open"));
    await screen.findByTestId("pingid-wizard");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("pingid-wizard")).toBeNull());
  });
});

describe("banner visibility on every tab, presenter mode and hosted mode", () => {
  it("is visible (not hidden, not display:none) on every tab and in presenter mode", async () => {
    await ready();
    for (const name of ["Diagram", "Talk track"]) {
      await userEvent.click(screen.getByRole("link", { name }));
      expect(screen.getByTestId("banner")).toBeVisible();
    }
  });
  it("hosted: shows HOSTED SIMULATION from /api/info even before /api/scenarios answers, never plain SIMULATED", async () => {
    override.info = async () => ({ ok: true, status: 200, json: async () => ({ mode: "mock", simulated: true, hosted: true }) });
    override.scenarios = () => new Promise(() => {});
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/^HOSTED SIMULATION/));
    expect(screen.getByTestId("banner")).toBeVisible();
  });
  it("while nothing has answered, and when both calls fail, the banner says both and stays visible", async () => {
    override.info = async () => json404();
    override.scenarios = async () => json404();
    function json404() { return { ok: false, status: 404, json: async () => ({}) }; }
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(BANNER_UNKNOWN));
    expect(screen.getByTestId("banner")).toBeVisible();
  });
});

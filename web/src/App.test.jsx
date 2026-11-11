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

const DEFAULT_BANDS = { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 };
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
    if (url === "/api/transfer") {
      const b = JSON.parse(opts.body);
      const bands = override.bands || DEFAULT_BANDS;
      const amt = Number(b.amount);
      // a retried call after a human beat is satisfied carries a receipt and permits — but ONLY
      // for the exact amount the human was shown; a retry at a different amount re-challenges.
      if (override.approved && override.approvedFor === amt) return json({ decision: "PERMIT", reason: "receipt presented", tool: b.tool, amount: amt, receipt: "hitl-receipt-0001", receiptKind: "hitl", bands, traceId: "a".repeat(32), hops: [hop(1), hop(2), hop(3)] }, 200);
      let decision = "PERMIT"; let status = 200; let reason = `amount ${amt} is below the confirm threshold`; let error; let detail; let step_up_method;
      if (b.step_up_method) { decision = "STEP_UP"; status = 428; reason = "sensitive agent-initiated action"; error = b.step_up_method === "ciba" ? "ciba_required" : "mcp_step_up_required"; step_up_method = b.step_up_method; }
      else if (amt > bands.denyCeilingUsd) { decision = "DENY"; status = 403; reason = `amount ${amt} exceeds the hard limit of ${bands.denyCeilingUsd}`; }
      else if (amt >= bands.mfaUsd) { decision = "STEP_UP"; status = 428; reason = `amount ${amt} is at or above the MFA threshold`; error = "mcp_step_up_required"; step_up_method = "p1mfa"; }
      else if (amt >= bands.confirmUsd) { decision = "HITL"; status = 428; reason = `amount ${amt} requires human consent`; error = "mcp_hitl_required"; }
      const challengeId = error === "mcp_hitl_required" ? "consent-1" : undefined;
      return json({ decision, reason, tool: b.tool, amount: amt, ...(error ? { error, detail: `${error}: the human beat is required`, ...(step_up_method ? { step_up_method } : {}), ...(challengeId ? { challengeId } : {}) } : { receipt: "hitl-receipt-0001", receiptKind: "hitl" }), bands, traceId: "a".repeat(32), hops: [hop(1), hop(2), hop(3)] }, status);
    }
    if (url === "/api/consent/respond") { const d = JSON.parse(opts.body).decision; if (d === "approved") { override.approved = true; override.approvedFor = 300; } return json({ challenge: { id: JSON.parse(opts.body).challengeId, status: d }, ...(d === "approved" ? { receipt: { id: "hitl-receipt-0001", amountBound: 300, kind: "hitl" } } : {}), workspace: "t" }); }
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

describe("diagram tab", () => {
  it("draws the boxes from /api/diagram and Simulate highlights a step; Reset clears it", async () => {
    await ready();
    await userEvent.click(screen.getByRole("tab", { name: "Diagram" }));
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
    await userEvent.click(screen.getByRole("tab", { name: "Talk track" }));
    expect(screen.getByTestId("talk-track")).toHaveTextContent("Everything is simulated.");
    await userEvent.click(screen.getByRole("tab", { name: "Transfer gate" }));
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

describe("banner visibility on every tab, presenter mode and hosted mode", () => {
  it("is visible (not hidden, not display:none) on every tab and in presenter mode", async () => {
    await ready();
    for (const name of ["Diagram", "Talk track"]) {
      await userEvent.click(screen.getByRole("tab", { name }));
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

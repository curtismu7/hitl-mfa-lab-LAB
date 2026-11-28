// What the Help dialog says. Plain, and as hedged as the rest of the lab (rule 2): what was measured, what is simulated, what is UNVERIFIED.
export const HELP_SECTIONS = [
  {
    heading: "What this lab is",
    body: [
      "An agent attempts a money movement; one mock authorization policy decides by amount band — PERMIT below the confirm bar, human consent (HITL) in the confirm band, MFA step-up at the MFA bar, hard DENY above the ceiling — and CIBA requests out-of-band approval on the user's own device for a sensitive agent-initiated action, regardless of amount.",
      "It is the standalone mock of the AI-DEMO2 HITL track (UC7 / UC8 / UC22). Same decision contract, no real policy engine or tenant."
    ]
  },
  {
    heading: "What was measured, and what was not",
    body: [
      "Measured live in AI-DEMO2 and replayed here with mock values: $300 → HITL, $600 → step-up, $2500 → DENY, and the PingID sign-in enrolment path (assign the MFA sign-on policy, sign in, scan the QR — measured end to end 2026-11-18).",
      "Simulated here: the policy bands, the MFA challenge, the CIBA out-of-band approval, the Privilege hold and the PingID push. The demo OTP is 123123 — a labelled bypass so a presenter can complete MFA.",
      "UNVERIFIED: with Real mode on, whether our gateway answers 403 or a 200 saying pending_approval, and whether the approval id equals the instruction id. What was measured for real is the sign-in step-up, not an API-driven push."
    ]
  },
  {
    heading: "How to use the page",
    body: [
      "Tabs: Transfer gate, Diagram, Talk track. The header has the Mock/Real select, a Vertical select (retail and friends), theme, Present, Talk track, Help and Reset.",
      "On Transfer gate: pick one of the eight scenarios (HITL: $300 needs human consent, MFA: $600 steps up to device MFA, CIBA: $150, approved out-of-band on the phone, PUSH, DENY: $2500 exceeds the hard limit, PRIVILEGE, REPLAY, BOUND) — or type your own Amount (USD) and press Call as the agent. Transfer-gate bands (admin-editable, live) lets you edit the bands and Save bands; the same call flips with no restart.",
      "When the gate raises HITL, an Approve / Deny consent modal appears. Approvals are receipts: single-use, amount-bound, and the MFA credit expires after five minutes.",
      "Talk track is the presenter script; Present (P key) shows the per-tab say lines alongside the page."
    ]
  },
  {
    heading: "Mock and Real",
    body: [
      "Mock is fully offline: mock gate, mock MFA, mock CIBA, mock Privilege hold, mock PingID. Nothing here calls a real gateway, identity provider or tenant by default.",
      "Real is owner-run and makes ONE scenario real: the PRIVILEGE scenario sends a real tools/call to the Privilege gateway in this lab's .env, and the approval is the tenant's own (HITL Requests plus a real PingID push). While Real is on the lab may reach exactly that one host; Mock closes it. Unconfigured, the toggle is disabled with a how-to tooltip and POST /api/mode answers 409."
    ]
  }
];

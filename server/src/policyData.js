// The story as data: an agent's money movement gated by a mock authorization policy —
// amount bands, HITL consent, MFA step-up, CIBA out-of-band approval. Mirrors the AI-DEMO2
// UC7/UC8/UC22 contract in mock. Text is {{token}} templated (see cast.js). Every host ends
// in .example. No real credential, tenant or customer.

export const BANNER = 'SIMULATED: a mock authorization policy, mock MFA step-up and a mock CIBA out-of-band approval. Nothing here calls a real identity provider, policy engine or tenant.';
export const HOSTED_BANNER = 'HOSTED SIMULATION: a mock authorization policy, mock MFA step-up and a mock CIBA out-of-band approval. Nothing here calls a real identity provider, policy engine or tenant.';

export const TITLE = "HITL & MFA: {{castBrand}}'s agent asks a human before money moves";
export const INTRO = 'An agent attempts a transfer. The mock policy decides by amount band — PERMIT below the confirm bar, human consent in the confirm band, MFA step-up at the MFA bar, hard DENY above the ceiling — and CIBA requests out-of-band approval on the user\'s own device for a sensitive agent-initiated action, regardless of amount. Approval receipts are single-use and amount-bound.';

// status: measured = seen live in AI-DEMO2 (transfer gate + CIBA page); inferred = our reading; UNVERIFIED = not confirmed.
export const FACTS = [
  { id: 'amount-bands', status: 'measured', text: 'The amount bands decide the gate: below the confirm bar PERMITs, the confirm band returns a HITL_CONSENT obligation, at or above the MFA bar a STEP_UP obligation, and above the hard ceiling a DENY. Verified live: $300 → HITL, $600 → step-up, $2500 → DENY.', source: 'AI-DEMO2 simulatedAuthorizeService + the transfer gate, enforced live 2026-11-06' },
  { id: 'obligation-classifier', status: 'measured', text: 'One classifier maps obligation objects to the enforcement flags: most-specific wins (HITL_CONSENT before HITL), and highest-gate-wins across the list (step-up > consent > HITL) so a caller can never double-gate.', source: 'AI-DEMO2 authorizeObligations (the drift it fixed: two engines classified the same obligation differently)' },
  { id: 'step-up-outranks', status: 'measured', text: 'DENY > STEP_UP > HITL: a hard limit-DENY overrides everything, and a step-up obligation outranks a consent gate so the $600 demo shows MFA, not the $300 consent modal.', source: 'AI-DEMO2 mcpToolAuthorizationService _applyTransactionPolicy' },
  { id: 'ciba-amount-free', status: 'measured', text: 'CIBA is triggered by the agent context plus the sensitivity of the action, NOT by amount: a $150 transfer in-browser needs no step-up, but an AGENT moving money gets out-of-band approval on the user\'s own device. A compromised browser or rogue agent cannot self-approve.', source: 'AI-DEMO2 UC22 CIBA demo, $150 by design' },
  { id: 'receipt-single-use', status: 'measured', text: 'Approval receipts are single-use and consume-on-use: an approved challenge discharges its gate for ONE retried call, then the credit is spent. An unrelated request never burns it.', source: 'AI-DEMO2 hitlCredit (consume-on-use anti-starvation design)' },
  { id: 'receipt-amount-bound', status: 'measured', text: 'A receipt minted for a specific amount only discharges consent for a call at or below that amount: approving a $300 transfer cannot silently authorize a $600 one.', source: 'AI-DEMO2 hitlCredit amount-binding (2026-07-24 review)' },
  { id: 'step-up-ttl', status: 'measured', text: 'The MFA step-up credit has a TTL (5 minutes in the app): it satisfies the gate on the immediate retry and expires afterwards.', source: 'AI-DEMO2 routes/mfa.js STEP_UP_TTL_MS' },
  { id: 'otp-demo', status: 'measured', text: 'The demo OTP is 123123 — a labelled demo bypass, never a real credential.', source: 'AI-DEMO2 routes/mfa.js demo bypass' },
  { id: 'pingid-policy-first', status: 'measured', text: 'Step-up MFA has a prerequisite the setup docs often miss: the MFA sign-on policy (with its PingID authentication action) must be ASSIGNED to the apps users sign into. Out of the box the policy exists but is assigned to nothing, so the enrolment prompt never appears.', source: 'live PingOne tenant, measured 2026-11-18: Multi_Factor policy existed with no assignments on any app' },
  { id: 'pingid-enrol-at-signin', status: 'measured', text: 'PingID enrolment happens at sign-in: the hosted login accepts the password, then redirects to a "Welcome to PingID — Start" screen with a QR code and a manual pairing key (three groups of four digits). The first login doubles as the first push-approval test.', source: 'live PingOne tenant, measured 2026-11-18: both demo personas enrolled this way' },
  { id: 'pingid-worker-no-pairing', status: 'measured', text: 'Worker-app API pairing is not available: WORKER applications can only be granted the openid resource, so the pairing-key endpoint (p1:create:pairingKey) is refused. The QR/login path is the only enrolment route that needs no console access.', source: 'live PingOne tenant, measured 2026-11-18: POST /users/{id}/pairingKey 403 for a WORKER token' },
  { id: 'pingid-device-active', status: 'measured', text: 'Enrolment is verifiable by API: GET the user\'s devices and expect type PINGID_MOBILE, status ACTIVE (one device record per user; the same physical phone can hold both persona entries). Needs only p1:read:device on the worker token.', source: 'live PingOne tenant, measured 2026-11-18: both personas returned PINGID_MOBILE / ACTIVE' },
  { id: 'pingid-stepup-live', status: 'measured', text: 'With the policy assigned and the device ACTIVE, the next sign-in steps up for real: password accepted → PingID authenticator page → push on the phone → approve → the authorization code is issued. A callback 404 on the test app after approval is harmless — the enrolment and the sign-in both completed by then.', source: 'live PingOne tenant, measured 2026-11-18: full chain run, code in the redirect URL' },
];

// The policy, as data. A visitor edits the amount bands in the UI; the server normalizes them
// and a crossing edit falls back to defaults — the bands stay ordered, the gate never widens.
export const RULE = {
  name: 'Transfer gate bands (mock authorization policy)',
  appliesTo: 'Agent gateway https://gateway.{{castHost}}.example/mcp/tool (create_transfer)',
  note: 'Mock shape of the amount-band policy. Not exported from, or checked against, a real policy engine.',
  defaults: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 },
};

export const TOOLS = [
  { name: 'create_transfer', tier: 'write', lesson: 'The amount-bearing write tool every scenario drives.' },
];

// Six scenarios: the walkthrough of the gate (UC8, UC7, UC22, UC6-adjacent, receipts).
export const SCENARIOS = [
  {
    id: 'consent-hitl',
    title: 'HITL: $300 needs human consent',
    bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 },
    call: { tool: 'create_transfer', amount: 300 },
    declaredStepUp: null,
    expected: 'HITL',
    lesson: 'The amount clears the confirm bar but not the MFA bar: the agent pauses, a consent modal is surfaced, and only an explicit human approval (a single-use receipt) lets it proceed.',
  },
  {
    id: 'mfa-step-up',
    title: 'MFA: $600 steps up to device MFA',
    bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 },
    call: { tool: 'create_transfer', amount: 600 },
    declaredStepUp: null,
    expected: 'STEP_UP',
    lesson: 'The amount clears the MFA bar: step-up OUTRANKS the consent gate — the human must complete device MFA (demo OTP 123123), then the policy re-evaluates to PERMIT.',
  },
  {
    id: 'ciba-150',
    title: 'CIBA: $150, approved out-of-band on the phone',
    bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 },
    call: { tool: 'create_transfer', amount: 150 },
    declaredStepUp: 'ciba',
    expected: 'STEP_UP',
    lesson: 'Note the amount — below every band. A person in-browser would sail through. But an AGENT moving money is a sensitive agent-initiated action, so approval is requested out-of-band (bc-authorize, then poll) on the user\'s phone. Amount-independent by design.',
  },
  {
    id: 'deny-ceiling',
    title: 'DENY: $2500 exceeds the hard limit',
    bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 },
    call: { tool: 'create_transfer', amount: 2500 },
    declaredStepUp: null,
    expected: 'DENY',
    lesson: 'Above the ceiling the policy denies outright. DENY outranks every obligation — no receipt, no MFA, no approval can clear it.',
  },
  {
    id: 'receipt-replay',
    title: 'REPLAY: the same approved receipt cannot be used twice',
    bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 },
    call: { tool: 'create_transfer', amount: 300, replay: true },
    declaredStepUp: null,
    expected: 'HITL',
    lesson: 'An approved $300 consent receipt discharges the gate ONCE (consume-on-use). Retrying the same transfer after the credit is spent re-challenges — a stolen receipt cannot approve a second transfer.',
  },
  {
    id: 'receipt-amount-bound',
    title: 'BOUND: approving $300 does not authorize $600',
    bands: { confirmUsd: 250, mfaUsd: 500, denyCeilingUsd: 2000 },
    call: { tool: 'create_transfer', amount: 600, reuseReceiptFor: 300 },
    declaredStepUp: null,
    expected: 'STEP_UP',
    lesson: 'The receipt is amount-bound: a credit approved for $300 discharges only calls at or below $300. The $600 call ignores it and steps up to MFA.',
  },
];

// The talk track, as data, so the web talk-track view and presenter mode read the same words as docs/talk-track.md.
export const TALK_TRACK = [
  { id: 'say-first', title: 'Say first', say: 'Everything here is simulated: the policy bands, the MFA challenge and the CIBA out-of-band approval are mock, mirroring what we ran live in AI-DEMO2.' },
  { id: 'bands', title: 'The amount bands', say: 'One policy decides by band: below the confirm bar the call permits, the confirm band requires human consent, at the MFA bar it requires device MFA, above the hard ceiling it denies. Verified live: $300 consent, $600 step-up, $2500 deny.' },
  { id: 'precedence', title: 'Precedence', say: 'DENY beats STEP_UP, and STEP_UP beats HITL — highest gate wins. One enforcement flag is ever true, so the same policy intent cannot gate twice in one engine and pass in another.' },
  { id: 'ciba', title: 'CIBA out-of-band', say: 'For a sensitive agent-initiated action the policy requests out-of-band approval: bc-authorize mints an auth_req_id, the user approves on their own device, the agent polls until approved. The demo amount is $150 on purpose — the trigger is the agent context, not the amount. A rogue agent cannot self-approve.' },
  { id: 'receipts', title: 'Receipts', say: 'Approvals are receipts, not vibes: single-use, consume-on-use, and amount-bound — approving $300 cannot later authorize $600. The MFA credit expires after five minutes.' },
  { id: 'otp', title: 'The demo OTP', say: 'The step-up code is 123123 — a labelled demo bypass so a presenter can complete MFA without a real device.' },
  { id: 'pingid', title: 'PingID is the real step-up engine behind this', say: 'This lab mocks the step-up, but the same contract runs for real with PingID: assign the MFA sign-on policy to the app (out of the box it exists but is assigned to nothing — the enrolment prompt never appears), the user signs in, scans the QR or types the pairing key, and the device shows ACTIVE. Worker-app API pairing is refused — WORKER apps get only the openid resource — so the sign-in path is the enrolment route. The next sign-in steps up: password, push, approve, code. Measured end to end 2026-11-18.' },
  { id: 'unverified', title: 'What we do not claim', say: 'The mock bands and challenge values are demo values; the decision contract follows what we enforced live. No real push infrastructure is simulated beyond the approval panel.' },
  { id: 'close', title: 'Close', say: 'Reset clears your workspace: bands, challenges, receipts and runs. Nothing was sent anywhere.' },
];

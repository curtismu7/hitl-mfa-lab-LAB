# HITL MFA Lab

**Tier: Demo.** An agent attempts a money movement; a mock authorization policy decides by amount band and agent context — PERMIT below the confirm bar, human consent (HITL) in the confirm band, MFA step-up at the MFA bar, hard DENY above the ceiling — and CIBA requests out-of-band approval on the user's own device for a sensitive agent-initiated action, regardless of amount. This is the standalone mock of the AI-DEMO2 HITL track (UC7 / UC8 / UC22 and the `authorizeObligations` / `hitlCredit` / CIBA services) — same decision contract, no real policy engine or tenant.

Three ideas:

1. **The amount bands.** One policy decides by band: below the confirm bar the call permits, the confirm band requires explicit human consent, at or above the MFA bar it requires device MFA, above the hard ceiling it denies. Verified live in AI-DEMO2: $300 → HITL, $600 → step-up, $2500 → DENY. The bands are admin-editable and read on EVERY request — change them and the same call flips, with no restart.
2. **Highest gate wins.** DENY > STEP_UP > HITL, and most-specific obligation classification (HITL_CONSENT before HITL) so one policy intent can never gate twice in one engine and pass in another.
3. **Approvals are receipts, not vibes.** Single-use (consume-on-use, so a replay re-challenges), amount-bound (approving $300 cannot discharge $600), and the MFA credit expires after five minutes. CIBA is triggered by the agent context plus the sensitivity of the action, NOT by amount: a $150 transfer in-browser needs no step-up, but an AGENT moving money gets out-of-band approval on the user's phone — a compromised browser or rogue agent cannot self-approve.

Mock + Real (rule 19): Mock is fully offline (mock gate, mock MFA, mock CIBA). Real toggle mechanics follow rule 19: unconfigured, it is disabled with a how-to tooltip and `POST /api/mode` answers 409. In this build Real is RESERVED — the toggle reports a configured `HMLAB_REAL_*` env, but no live policy-engine data path is wired yet; Mock is the story.

## Run it

- `./scripts/run.sh` — host-run on port 7680 (Node >= 26), opens the browser.
- Docker: `HOST_PORT=7680 docker compose up --build -d` (published on 127.0.0.1 only).
- Through the shared lab-proxy: `https://local.ping-devops.com:8443/hitl-mfa-lab/` (never a raw loopback URL).
- Tests: `npm ci && npm test` — 66 server + 18 web + 5 packaging tests.

## Scenarios

1. **HITL: $300 needs human consent** — the agent pauses, a consent modal is surfaced, and only an explicit human approval (a single-use receipt) lets it proceed (UC8).
2. **MFA: $600 steps up to device MFA** — step-up outranks the consent gate; the demo OTP is 123123, a labelled demo bypass (UC7).
3. **CIBA: $150, approved out-of-band on the phone** — bc-authorize, the on-page phone panel, the agent polls; amount-independent by design (UC22).
4. **DENY: $2500 exceeds the hard limit** — DENY outranks every obligation; nothing can clear it (the UC6 band).
5. **REPLAY: the same approved receipt cannot be used twice** — consume-on-use; the retry re-challenges.
6. **BOUND: approving $300 does not authorize $600** — the receipt is amount-bound; the $600 call steps up.

## Surface

- `GET/POST /api/policy` — read / set this workspace's bands (normalized; a crossing edit falls back to the defaults, never wider).
- `POST /api/transfer` — the gated tool call; 428 = a human beat is required, 403 = deny, 200 = permitted (the decision, reason, receipt and W3C-traceparent hops are the answer).
- `POST /api/mfa/challenge`, `POST /api/mfa/verify` — the MFA beat (demo OTP `123123`).
- `POST /api/ciba/bc-authorize`, `GET /api/ciba/poll/:authReqId`, `POST /api/ciba/respond` — the CIBA beat.
- `GET /api/scenarios` — the story as data. `GET /api/diagram` — the diagram-studio data. `GET /api/health` — `demo-health/1`.
- Workspaces: every visitor carries an `X-Workspace` id; Reset clears only that workspace.

Safety: loopback Host check (+ `LAB_ALLOWED_HOSTS` behind the lab-proxy), same-origin writes, no outbound network, bounded payloads, `nosniff`, read-only container fs, non-root. The demo OTP and every decision value are labelled demo values. See `docs/safety.md` and `docs/talk-track.md` (generated from the same data the UI reads).

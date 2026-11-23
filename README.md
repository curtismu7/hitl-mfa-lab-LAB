# HITL MFA LAB

Tier: Demo
Repo: https://github.com/curtismu7/hitl-mfa-lab-LAB

An agent attempts a money movement; a mock authorization policy decides by amount band and agent context — PERMIT below the confirm bar, human consent (HITL) in the confirm band, MFA step-up at the MFA bar, hard DENY above the ceiling — and CIBA requests out-of-band approval on the user's own device for a sensitive agent-initiated action, regardless of amount. This is the standalone mock of the AI-DEMO2 HITL track (UC7 / UC8 / UC22 and the `authorizeObligations` / `hitlCredit` / CIBA services) — same decision contract, no real policy engine or tenant.

Three ideas:

1. **The amount bands.** One policy decides by band: below the confirm bar the call permits, the confirm band requires explicit human consent, at or above the MFA bar it requires device MFA, above the hard ceiling it denies. Verified live in AI-DEMO2: $300 → HITL, $600 → step-up, $2500 → DENY. The bands are admin-editable and read on EVERY request — change them and the same call flips, with no restart.
2. **Highest gate wins.** DENY > STEP_UP > HITL, and most-specific obligation classification (HITL_CONSENT before HITL) so one policy intent can never gate twice in one engine and pass in another.
3. **Approvals are receipts, not vibes.** Single-use (consume-on-use, so a replay re-challenges), amount-bound (approving $300 cannot discharge $600), and the MFA credit expires after five minutes. CIBA is triggered by the agent context plus the sensitivity of the action, NOT by amount: a $150 transfer in-browser needs no step-up, but an AGENT moving money gets out-of-band approval on the user's phone — a compromised browser or rogue agent cannot self-approve.

Mock + Real (rule 19): Mock is fully offline (mock gate, mock MFA, mock CIBA, mock Privilege hold and PingID). Real is owner-run and makes ONE scenario real: with `HMLAB_REAL_URL`, `HMLAB_REAL_AGENT_KEY` and `HMLAB_REAL_TOOL` in this lab's `.env`, the PRIVILEGE scenario sends a real MCP `tools/call` to your Privilege gateway door and shows the real answer through the shared "What Privilege did" panel (each decision observed or inferred). The approval is Privilege's: with tenant MFA on, the hold itself makes Privilege send a PingID push to the policy's approvers, and you approve on the phone (or in HITL Requests). **The lab never calls PingID or PingOne**; it retries the same call every 3 s with the approval id in `X-Procyon-Approval-Id` until the call runs, is refused or the hold lapses (a still-held call just answers the same hold). A gateway published on the Docker host as plain http can be used with `HMLAB_REAL_ALLOW_HTTP_HOSTS=<that host name>` plus `HMLAB_REAL_ALLOW_PRIVATE=1`. Every other scenario stays simulated. While Real is on the lab may reach exactly that one host (netguard allowlist, https, no redirects); Mock closes it. Unconfigured, the toggle is disabled with a how-to tooltip and `POST /api/mode` answers 409. Not yet run against a real tenant: whether our gateway answers 403 or a 200 saying `pending_approval`, and whether the approval id equals the instruction id, are UNVERIFIED (both answers are read; the id box is editable).

Scaffold copied from mcp-gateway-lab-LAB (fork rule 4 attribution); every surface here is this lab's own. No cross-repo imports.

## Run it

- `./scripts/run.sh` — host-run on port 7680 (Node >= 26), opens the browser.
- Docker: `HOST_PORT=7680 docker compose up --build -d` (published on 127.0.0.1 only).
- Through the shared lab-proxy: `https://local.ping-devops.com:8443/hitl-mfa-lab/` (never a raw loopback URL).
- Tests: `npm ci && npm test` — 160 server + 249 web + 32 packaging and pin tests.

## Run from a clone

Prerequisites: Node 26 or newer. Docker only if you use the Docker form. Mock mode needs no tenant, no credentials and no settings file.

```
git clone https://github.com/curtismu7/hitl-mfa-lab-LAB.git
cd hitl-mfa-lab-LAB
npm ci
npm run build
npm run doctor
npm start
```

Open http://127.0.0.1:7680/ (the server serves the built UI itself). `GET http://127.0.0.1:7680/api/health` answers `demo-health/1`. `./scripts/run.sh` does the same steps in one go.

## Ports, and what to do if the port is taken

```
Ports: hitl-mfa-lab-LAB listens on 7680 (set with PORT, default 7680).
Port range for this app: 7680-7689.

If the port is taken:
1. Find what is using it:
   lsof -iTCP:7680 -sTCP:LISTEN -n -P
2. If it is an old copy of this app, stop that process: kill <PID>.
3. If it is something else, stop it, or start this app on another port in 7680-7689:
   PORT=<other port> npm start
   (Docker: HOST_PORT=<other port> docker compose up --build -d)
4. Do not use 8080, 5173, 3900, 4000, 4400, 4510, 4600-4601, 4840, 18080, 19080 or 19090.
```

`npm run doctor` reports a port that is taken or outside 7680-7689.

## What a run leaves behind (rule 27)

Under the Gate result the page shows the shared run-observability panel (`web/src/run-observability/`, vendored byte for byte from AI-DEMO-Standalone `shared/run-observability` and pinned by `run-observability.sha256`; never edited here): one run in time order across six layers, each row with its timestamp and an honest origin tag. A run is one gated call plus the human beat it waits for. It stays open while the approver decides, however long that takes, and closes on its verdict (permitted, denied, the human said no or let it lapse); a later event joins no run. A new call starts the next run. The panel never shows a Mock run under Real or the reverse.

| Layer | Mock (`simulated`) | Real, the PRIVILEGE scenario (`response`) |
|---|---|---|
| Person | the approver's answers: consent, device MFA code, PingID push, CIBA, HITL Requests with PingID. A pending request is information; the answer is the decision | not logged: the lab never calls PingID or PingOne. With tenant MFA on, the approval push is Privilege's and nothing reports it back |
| Agent | not logged: the lab mints no agent token (the bearer is a placeholder) and the agent context is a flag on the call, so there is no delegation or act claim to show | not logged: the lab sends one agent key (never shown) and holds no claims |
| Authorize | the amount-band gate, which is this lab's own mock of PingOne Authorize: PERMIT allowed, DENY refused, a consent or step-up hold is information (a hold is not a refusal) | not logged: the lab does not call PingOne Authorize; the hold is Privilege's own policy |
| Privilege | the mock Privilege policy `ai-transfer-hitl:1`: the hold is information, a presented approval is allowed or refused | not logged: this lab has no log reader |
| Agent gateway | not logged: there is no separate gateway in Mock; the mock gate answers the call itself | the one reply the lab received from the door: a hold is information, 401/403, a JSON-RPC error or `isError` is refused, a usable result is allowed, a redirect the lab did not follow is blocked |
| Resource server | not logged: there is no tool server in Mock, nothing executes | only an executed reply: the tool answered through the gateway |

Time is when the lab recorded the decision (Mock) or received the reply (Real): each decision is stamped once, and the row time is the stdout time. Only a scenario that is real in Real mode has Real rows; the other six stay simulated, and the panel says so instead of showing a simulated run under a Real label. A call that got no reply (a timeout, a refused connection) has no row: the gateway layer says why. A retry that gets the same hold again adds no row.

**Where these logs live and where they can stream.** The lab's server writes one stdout line per decision, in the lab container's log:

```
<iso> hitl-mfa-lab decision step=<step> layer=<layer> actor=<who> result=passed|stopped|unclear|no-reply mode=mock|real run=<id>
```

Every value is cut to safe characters and masked like the row, and no token, key or code is ever in it. It streams nowhere today: the family log collector (`shared/ping-log-collector/vector.yaml`) does not list this lab's container. If it did, the SIEM `@timestamp` would be Docker's wall-clock time for each line. This lab reads no product logs, so it vendors only the shared core (no readers file), sets no `RUN_OBS_*` variable and never mounts the Docker socket. Not logged today: PingOne Authorize has no container log (the amount-band gate here is a mock), the Privilege gateway's own policy and approval events are not read (the hosted gateway's events live in the Privilege SIEM index and the console Activity Logs), gateway refusal and block line shapes are unconfirmed, and the PingOne audit reader does not exist.

## Scenarios

1. **HITL: $300 needs human consent** — the agent pauses, a consent modal is surfaced, and only an explicit human approval (a single-use receipt) lets it proceed (UC8).
2. **MFA: $600 steps up to device MFA** — step-up outranks the consent gate; the demo OTP is 123123, a labelled demo bypass (UC7).
3. **CIBA: $150, approved out-of-band on the phone** — bc-authorize, the on-page phone panel, the agent polls; amount-independent by design (UC22).
4. **DENY: $2500 exceeds the hard limit** — DENY outranks every obligation; nothing can clear it (the UC6 band).
5. **PRIVILEGE: $150 held for PingID approval** — an AI policy on a (mock) Privilege gateway holds the call: 403 `pending_approval`, an instruction id, nothing runs. The approver decides it in HITL Requests; approving needs PingID (a push, or the passcode, demo `123123`); the agent retries with `X-Procyon-Approval-Id` inside 90 s and the transfer runs once. The approval is amount-bound the same way receipts are: it covers a call at or below the approved amount, never above. Shapes follow the owner's 2026-11-17 recording of a Privilege tenant; on our own tenant the 403 shape and the PingID confirmation are UNVERIFIED. Amount-independent, still below a hard DENY.
6. **REPLAY: the same approved receipt cannot be used twice** — consume-on-use; the retry re-challenges.
7. **BOUND: approving $300 does not authorize $600** — the receipt is amount-bound; the $600 call steps up.

## Surface

- `GET/POST /api/policy` — read / set this workspace's bands (normalized; a crossing edit falls back to the defaults, never wider).
- `POST /api/transfer` — the gated tool call; 428 = a human beat is required, 403 = deny, 200 = permitted (the decision, reason, receipt and W3C-traceparent hops are the answer).
- `POST /api/mfa/challenge`, `POST /api/mfa/verify` — the MFA beat (demo OTP `123123`).
- `POST /api/ciba/bc-authorize`, `GET /api/ciba/poll/:authReqId`, `POST /api/ciba/respond` — the CIBA beat.
- `POST /api/mfa/push`, `GET /api/mfa/poll/:id`, `POST /api/mfa/push/:id/respond` — the PingID push beat (mock): a push goes to the approver's phone (the in-page mock phone answers it), the agent polls, approval mints a single-use, amount-bound credit (`push`) for the retry. Declared with `step_up_method: "pingid-push"` (the PUSH scenario). Nothing is sent to PingOne or a real phone; the measured real chain is the sign-in step-up (see the PingID setup wizard).
- `npm run privilege-verify` — owner-run: one real held call against your gateway and your approval, then prints the answer shape (403 JSON-RPC vs 200 text) and which id the retry needs. Settles the two UNVERIFIED facts about your tenant. Needs the `HMLAB_REAL_*` settings and your phone; agents never run it.
- `GET /api/privilege/real`, `POST /api/privilege/real/call` (`{}` or `{ approvalId }`) — Real only (409 in Mock): the one real call and its retry; structured JSON on every outcome, 502 when the gateway is unreachable.
- `GET /api/privilege/hitl`, `POST /api/privilege/hitl/:id/decide` — the mock Privilege console's HITL Requests: list what the gateway holds, and decide one (`{ decision: "approve", pingid: { method: "push", result } | { method: "passcode", code } }` or `{ decision: "reject" }`). `POST /api/transfer` with `step_up_method: "privilege"` is the held call; the retry sends `X-Procyon-Approval-Id`.
- `GET /api/run-observability` — the record of the newest run of the CURRENT mode in this workspace (`{ record: null, message }` before a run; `{ error, message }` JSON on a failure). Rule 27, see below.
- `GET /api/scenarios` — the story as data. `GET /api/diagram` — the diagram-studio data. `GET /api/health` — `demo-health/1`.
- Workspaces: every visitor carries an `X-Workspace` id; Reset clears only that workspace.

Safety: loopback Host check (+ `LAB_ALLOWED_HOSTS` behind the lab-proxy), same-origin writes, no outbound network, bounded payloads, `nosniff`, read-only container fs, non-root. The demo OTP and every decision value are labelled demo values. See `docs/safety.md` and `docs/talk-track.md` (generated from the same data the UI reads).

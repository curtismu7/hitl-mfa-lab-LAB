<!--
  All the WORDING for the HITL MFA (PingID approval) recording. Edit the text under each heading — nothing else needs to change.
  take.py reads this file and fills in the live values (an instruction id, an amount, the HTTP status) around
  whatever you write here; it never touches this file itself. SCRIPT.md is the source for every claim below.

  Rules for editing safely:
  - Don't rename a "# Opening Slide" / "# Closing Slide" / "# Slide: <key>" / "# Step: <key>" heading, and don't rename
    a "## Title" / "## Text" / "## Lead" / "## Verdict" / "## Column A: ..." / "## Column B: ..." heading.
    Those names are how take.py finds the right piece of text. Editing the WORDS after them is always safe.
  - A "## Column A: <label>" or "## Column B: <label>" heading's <label> IS shown on the slide as that
    column's own heading — edit it freely, just keep "Column A:" / "Column B:" at the start of the line.
  - Keep each bullet under a column on its own line starting with "- ".
  - "---" on its own line separates one section from the next. Keep those.

  Which steps the real take uses: intro, pick, hold, instruction, push, approve, retry, executed, boundary, audit.
  The SAMPLE take (mock gateway, mock phone) uses the sample_* steps with the same numbers.
-->

# Opening Slide

## Title
Who approves the agent's sensitive action — a console, or your phone?

## Lead
A policy says this agent action needs a person. Two ways that person can approve it:

## Column A: Approve in a console
- A person signs into a console, finds the held request, clicks approve
- The approval lives in a browser session — the same kind of session a compromised browser or a rogue agent could reach
- The person has to go to where the request is, instead of the request coming to them

## Column B: This demo: approve on your phone
- The gateway holds the call instead of refusing it, and the approval request travels to the human's own device
- PingID confirms the approver there: a push notification, or a passcode from the app
- PingID's own guidance: if you get an approval request you didn't initiate, deny it immediately and contact the help desk

## Verdict
This demo uses the device: the approval should live where the person is. PingID push is a documented Privilege approval channel, and Privilege's release notes say approvals are single-use and call-bound — an approval authorizes exactly one call and can't be replayed.

---

# Slide: real_vs_sim

## Title
What is real in this run, and what is simulated

## Lead
The lab's banner says which is which before anything is sent:

## Column A: What is real
- The MCP tools/call the agent sends, and the policy decision to hold it
- The hold's answer on the wire: HTTP 403 with a JSON-RPC error carrying pending_approval and an instruction id
- In the real take: the gateway call itself, to the Privilege gateway door configured in this lab

## Column B: What is simulated
- The Privilege gateway's hold and the PingID push, in the mock take — modelled on a real tenant's behavior, run entirely in the lab
- The approver's phone, drawn on the page; nothing is sent to PingOne or a real device
- On a real tenant, whether the retry id equals the instruction id, and the exact 403 shape, are unverified — the lab reads both at runtime

## Verdict
The lab never calls PingID or PingOne. In the real take the one real call goes to the configured gateway and its answer is shown as received; the approval still happens in the owner's own console, on their phone.

---

# Slide: retry_rule

## Title
The retry rule: a receipt, not a new credential

## Lead
The agent may not simply call again after a hold. The pattern:

## Column A: What the retry carries
- The same call, retried with the approval id in the X-Procyon-Approval-Id header, inside a 90-second window
- Like CIBA poll mode, the caller repeats and is told which world it is in: pending, expired, or denied
- The Bearer credential still travels in the Authorization header on every request (RFC 6750, section 2.1)

## Column B: What the approval id is not
- It is the receipt for one human decision, not a bearer token — presenting it is not authenticating
- It is single-use: once redeemed for a successful call it is no longer valid, and a replay re-challenges
- It is bound to its transaction: a larger amount under the same id does not pass

## Verdict
CIBA Core 1.0 is cited because the retry loop mirrors the spec's poll mode (repeat at an interval; pending, expired, and denied answered differently), not because Privilege speaks CIBA on this hop — the hold/retry protocol here is Privilege's own.

---

# Slide: sample_note

<!-- Sample take only. Never shown in the real take. -->

## Title
SAMPLE: simulated, not a real run

## Lead
This preview runs the lab's mock gateway and mock phone so you can review wording and pacing. The real take sends one real call to the configured Privilege gateway.

## Column A: What is simulated in this preview
- The gateway hold is the lab's mock, shaped like a real tenant's 403 from a screen recording
- The PingID push is answered on the labelled mock phone drawn on the page
- Nothing touches Privilege, PingOne or a real device

## Column B: What is real in this preview
- The script, the captions, the four slides and the timing
- The hold's wire shape: 403, JSON-RPC -32600, pending_approval, an instruction id
- The single-use, amount-bound approval logic the lab enforces on every retry

## Verdict
Review the wording and pacing; the real take is recorded after this.

---

# Closing Slide

## Title
What this run just showed

## Lead
A held tool call, an instruction id, a human decision with PingID on their own device, one bounded retry, one execution — and a second call still held.

## Column A: What we did
- Sent the agent's tools/call and watched the gateway hold it: 403, pending_approval, an instruction id, nothing run
- Followed the request to the approver: PingID confirmed the person on their own device, push or passcode
- Retried once with the approval id in the header, inside the 90-second window, and the transfer ran
- Tried a larger amount under the same approval and watched it held again

## Column B: Why it matters
- A compromised browser or a rogue agent cannot self-approve: the approval lives on the user's device, confirmed by PingID
- The approval is single-use — an approval authorizes exactly one call and can't be replayed (Privilege's release notes)
- It is bound to its transaction — a transaction grant for one call does not cover the next
- CIBA Core 1.0 formalizes this shape: the user approves on an Authentication Device and never provides credentials to the device the request started on

## Verdict
Held, not refused; approved where the person is; spent once. Privilege: Ping's release notes (Oct 10 and Oct 31, 2026) and AI gateway docs. Pattern: OIDC CIBA Core 1.0 sections 1, 2, 3 and 11; RFC 6750 section 2.1.

---

# Step: intro

## Text
This is the HITL MFA lab. The banner says what is real: the gateway call and its policy are this demo's decision surface; the Privilege hold and the PingID confirmation are simulated here — nothing leaves this page.

## Title
The lab, and what it says is real

---

# Step: pick

## Text
The agent calls a money-movement tool through the gateway. This is the PRIVILEGE scenario: one real tools/call to the gateway door configured in this lab, with a Bearer credential in the Authorization header — nothing unusual yet.

## Title
The agent's call goes out

---

# Step: hold

## Text
The policy says this action needs a person. The gateway does not refuse — it holds: HTTP 403, JSON-RPC error -32600, pending_approval, and nothing runs. Privilege's release notes call this holding an action for a person instead of refusing it.

## Title
Held, not refused: 403 pending_approval

---

# Step: instruction

## Text
The hold carries an instruction id — shown here, and editable in this lab because whether the retry id equals it on a real tenant is unverified. It is the queue handle a human will decide on, and the token the agent's retry will present.

## Title
The instruction id: the handle and the receipt

---

# Step: push

## Text
The approval moves to the human's own device: Privilege sends the PingID push to the approvers' phones. This lab only sends the call, waits, and retries — it never talks to PingID itself. This is the pattern CIBA formalizes: the user approves on an Authentication Device, separate from wherever the request started.

## Title
The push goes to the approver's phone

---

# Step: approve

## Text
Waiting for the approver to decide on their phone. Approve confirms the person; a "No, it's not me" answer approves nothing, and the call keeps being held. The lab re-sends the call every 3 seconds while the hold is open, so the moment the approval lands, the next retry carries it.

## Title
The approver decides on their phone

---

# Step: retry

## Text
The call was retried with the approval id in the X-Procyon-Approval-Id header, inside the 90-second window. The gateway checked: approved, unused, in time, and for this tool at this amount.

## Title
The retry: the approval id in the header

---

# Step: executed

## Text
The transfer ran — once. The approval is consumed on use, so replaying the same id re-challenges rather than passing.

## Title
Executed once, and the approval is spent

---

# Step: boundary

## Text
Now the boundary: the same approval id is presented again, for a call it was not minted for. Held again — an approval covers its call, not the next one. Privilege's release notes call this a transaction grant bound to the exact call.

## Title
The boundary: the same id does not pass twice

---

# Step: audit

## Text
Every beat is a record: the call, the hold, the approval, the retry — the gateway records all interactions in one audit trail, and the MCP Server app's tool calls are audited under Activity > Activity Logs.

## Title
What Privilege did, in one trail

---

# Step: sample_intro

<!-- Sample take only (SAMPLE=1, mock gateway and mock phone). Replaces the "intro" text so the sample never claims to be live. -->

## Text
This preview runs the lab's mock side: a mock transfer gate, a mock Privilege gateway hold and a mock PingID phone, all on this page. Nothing here touches Privilege, PingOne or a real device. The real take sends one real call to the configured gateway.

## Title
SAMPLE: the mock side of the same flow

---

# Step: sample_pick

## Text
The agent calls a money-movement tool through the gate: one MCP tools/call with a Bearer credential — nothing unusual yet. Picking the PRIVILEGE scenario sends it.

## Title
The agent's call goes out (mock gateway)

---

# Step: sample_hold

## Text
The mock gateway holds it exactly as the recorded real tenant did: HTTP 403, JSON-RPC -32600, pending_approval, nothing runs. In the real take this answer comes from the configured gateway itself.

## Title
Held, not refused: 403 pending_approval (mock)

---

# Step: sample_instruction

## Text
The hold carries an instruction id, and the HITL Requests queue — the mock console — shows what is awaiting a decision: tool, amount, and how long the request stays open: 120 seconds here.

## Title
The instruction id, in HITL Requests

---

# Step: sample_push

## Text
The approval moves to the human's own device: a PingID push lands on the mock phone below. This is the pattern CIBA formalizes — the user approves on an Authentication Device, separate from wherever the request started.

## Title
The push lands on the (mock) phone

---

# Step: sample_approve

## Text
Approve. PingID confirms the approver is the person — a push, or a passcode from the app (the demo passcode is 123123, a labelled demo bypass). A "No, it's not me" answer approves nothing; the request keeps waiting.

## Title
Approve on the phone

---

# Step: sample_retry

## Text
Approving issued the approval, and the lab retried the call with it in the X-Procyon-Approval-Id header, inside the 90-second window. The gate checked: approved, unused, in time.

## Title
The retry: the approval id in the header

---

# Step: sample_executed

## Text
The transfer ran — once. The approval is consumed on use, so replaying the same id re-challenges rather than passing.

## Title
Executed once, and the approval is spent

---

# Step: sample_boundary

## Text
Now the boundary: a larger amount, presented to the gate under the same approval. Held again — an approval covers its call, not the next one; the lab calls this a transaction grant bound to the exact call.

## Title
The boundary: the same approval does not pass twice

---

# Step: sample_audit

## Text
Every beat of this mock run is recorded too: the call, the hold, the approval, the retry — each hop with its request and response. A real gateway writes the same trail for every interaction it sees.

## Title
Each beat, recorded in order

---

# Step: sample_closing_lead

<!-- Sample take only. Replaces the closing slide's lead so the sample never claims a live call. -->

## Text
A preview run against the mock gateway and the mock phone. The real take sends one real call to the configured Privilege gateway, and the owner approves the PingID push on their own phone.

## Title
Sample closing lead

---

# Step: sample_closing_bullet

<!-- Sample take only. Replaces the closing slide's first "what we did" bullet. -->

## Text
Ran the PRIVILEGE scenario on the mock side: the hold was minted by the lab's mock gateway and answered on the mock phone

## Title
Sample closing bullet

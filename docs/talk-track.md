# Talk track

<!-- Generated from server/src/policyData.js by `npm run talk-track`. Do not edit by hand. -->

## Say first

Everything here is simulated: the policy bands, the MFA challenge and the CIBA out-of-band approval are mock, mirroring what we ran live in AI-DEMO2.

## The amount bands

One policy decides by band: below the confirm bar the call permits, the confirm band requires human consent, at the MFA bar it requires device MFA, above the hard ceiling it denies. Verified live: $300 consent, $600 step-up, $2500 deny.

## Precedence

DENY beats STEP_UP, and STEP_UP beats HITL — highest gate wins. One enforcement flag is ever true, so the same policy intent cannot gate twice in one engine and pass in another.

## CIBA out-of-band

For a sensitive agent-initiated action the policy requests out-of-band approval: bc-authorize mints an auth_req_id, the user approves on their own device, the agent polls until approved. The demo amount is $150 on purpose — the trigger is the agent context, not the amount. A rogue agent cannot self-approve.

## Receipts

Approvals are receipts, not vibes: single-use, consume-on-use, and amount-bound — approving $300 cannot later authorize $600. The MFA credit expires after five minutes.

## The demo OTP

The step-up code is 123123 — a labelled demo bypass so a presenter can complete MFA without a real device.

## What we do not claim

The mock bands and challenge values are demo values; the decision contract follows what we enforced live. No real push infrastructure is simulated beyond the approval panel.

## Close

Reset clears your workspace: bands, challenges, receipts and runs. Nothing was sent anywhere.

## The scenarios

1. **HITL: $300 needs human consent.** The amount clears the confirm bar but not the MFA bar: the agent pauses, a consent modal is surfaced, and only an explicit human approval (a single-use receipt) lets it proceed.
2. **MFA: $600 steps up to device MFA.** The amount clears the MFA bar: step-up OUTRANKS the consent gate — the human must complete device MFA (demo OTP 123123), then the policy re-evaluates to PERMIT.
3. **CIBA: $150, approved out-of-band on the phone.** Note the amount — below every band. A person in-browser would sail through. But an AGENT moving money is a sensitive agent-initiated action, so approval is requested out-of-band (bc-authorize, then poll) on the user's phone. Amount-independent by design.
4. **DENY: $2500 exceeds the hard limit.** Above the ceiling the policy denies outright. DENY outranks every obligation — no receipt, no MFA, no approval can clear it.
5. **REPLAY: the same approved receipt cannot be used twice.** An approved $300 consent receipt discharges the gate ONCE (consume-on-use). Retrying the same transfer after the credit is spent re-challenges — a stolen receipt cannot approve a second transfer.
6. **BOUND: approving $300 does not authorize $600.** The receipt is amount-bound: a credit approved for $300 discharges only calls at or below $300. The $600 call ignores it and steps up to MFA.

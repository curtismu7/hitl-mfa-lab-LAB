// The authorization-policy engine, mirroring the AI-DEMO2 UC7/UC8/UC22 contract in mock.
// Three sources (all read-only shapes from the app):
//   - simulatedAuthorizeService: amount bands on write tools — PERMIT below the confirm band,
//     HITL_CONSENT in the confirm band, STEP_UP at/above the MFA threshold, DENY above the ceiling.
//   - authorizeObligations: one classifier for obligation objects; most-specific wins
//     (HITL_CONSENT before HITL); highest-gate-wins across the list (stepUp > consent > hitl).
//   - hitlCredit + mfa step-up: single-use, amount-bound, TTL receipts that discharge their gate
//     exactly once on the retried call.
// UC22 (CIBA) is amount-INDEPENDENT by design: the trigger is the agent context plus the
// sensitivity of the action, never a dollar figure.
// Pure functions + in-process stores: no I/O, no clocks inside the decisions (timestamps injected).

export const LIMITS = { amount: 1_000_000, note: 200, authReqId: 64, bindingMessage: 120, challenges: 200 };

export const DEFAULT_BANDS = {
  confirmUsd: 250,      // >= confirm and < mfa: HITL consent (UC8 band, $300 demo)
  mfaUsd: 500,          // >= mfa and <= ceiling: MFA step-up (UC7 band, $600 demo)
  denyCeilingUsd: 2000, // > ceiling: hard deny (UC6 band, $2500 demo)
};

export class PolicyInputError extends Error {
  constructor(code, detail) { super(detail); this.code = code; }
}

const toAmount = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v.trim()); return Number.isFinite(n) && n >= 0 ? n : null; }
  return null;
};

// ── Obligation classifier (authorizeObligations shape) ──────────────────────
// Most-specific match wins: HITL_CONSENT before HITL. Accepts type/id/code/name,
// normalized away separators/case — 'step-up-required' matches 'STEP_UP'.
export function classifyObligation(ob) {
  const raw = String((ob && (ob.type || ob.id || ob.code || ob.name)) || '').toUpperCase();
  if (!raw) return null;
  const key = raw.replace(/[^A-Z0-9]/g, '');
  if (key.includes('HITLCONSENT')) return 'consent';
  if (key.includes('STEPUP')) return 'stepUp';
  if (key.includes('HITL') || key.includes('HUMANAPPROVAL')) return 'hitl';
  return null;
}

/** Highest-gate-wins across the list: stepUp > consent > hitl. Only one enforcement flag is
 * ever true, so a caller cannot accidentally double-gate. DENY never reaches this classifier. */
export function classifyObligations(obligations) {
  const classified = { stepUp: [], hitl: [], consent: [] };
  if (Array.isArray(obligations)) {
    for (const ob of obligations) {
      const kind = classifyObligation(ob);
      if (kind) classified[kind].push(ob);
    }
  }
  if (classified.stepUp.length) return { stepUpRequired: true, consentRequired: false, hitlRequired: false, classified };
  if (classified.consent.length) return { stepUpRequired: false, consentRequired: true, hitlRequired: false, classified };
  if (classified.hitl.length) return { stepUpRequired: false, consentRequired: false, hitlRequired: true, classified };
  return { stepUpRequired: false, consentRequired: false, hitlRequired: false, classified };
}

// ── Amount-band policy (simulatedAuthorizeService shape) ────────────────────
/**
 * The decision core for an amount-bearing write tool.
 * @returns {{ decision: 'PERMIT'|'HITL'|'STEP_UP'|'DENY', obligation: object|null, reason: string }}
 *   DENY wins over everything; STEP_UP outranks HITL (the UC7 $600 band); HITL is the
 *   confirm band (the UC8 $300 band); PERMIT below the confirm band.
 */
export function evaluateAmountPolicy({ amount, bands = DEFAULT_BANDS, declaredStepUp = null }) {
  const amt = toAmount(amount);
  if (amt === null) return { decision: 'PERMIT', obligation: null, reason: 'no amount to gate' };
  if (amt > bands.denyCeilingUsd) {
    return { decision: 'DENY', obligation: null, reason: `amount ${amt} exceeds the hard limit of ${bands.denyCeilingUsd}` };
  }
  // A use case may DECLARE its step-up method ('ciba' | 'p1mfa') — amount-independent,
  // honoured regardless of band (still below a hard DENY). This is the UC22/UC7 trigger.
  if (declaredStepUp === 'ciba' || declaredStepUp === 'p1mfa') {
    return {
      decision: 'STEP_UP',
      obligation: { type: 'STEP_UP', step_up_method: declaredStepUp },
      reason: declaredStepUp === 'ciba'
        ? 'sensitive agent-initiated action: out-of-band approval requested (amount-independent)'
        : 'policy requires device MFA for this action',
    };
  }
  if (amt >= bands.mfaUsd) {
    return { decision: 'STEP_UP', obligation: { type: 'STEP_UP', step_up_method: 'p1mfa' }, reason: `amount ${amt} is at or above the MFA threshold of ${bands.mfaUsd}` };
  }
  if (amt >= bands.confirmUsd) {
    return { decision: 'HITL', obligation: { type: 'HITL_CONSENT' }, reason: `amount ${amt} requires human consent before it runs` };
  }
  return { decision: 'PERMIT', obligation: null, reason: `amount ${amt} is below the confirm threshold of ${bands.confirmUsd}` };
}

/** Normalize a bands object; junk falls back to defaults, never to a WIDER gate. */
export function normalizeBands(raw) {
  const b = { ...DEFAULT_BANDS };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return b;
  for (const k of ['confirmUsd', 'mfaUsd', 'denyCeilingUsd']) {
    const v = toAmount(raw[k]);
    if (v !== null && v > 0) b[k] = v;
  }
  // Keep the bands ordered: confirm < mfa <= ceiling. A crossing edit falls back per-field.
  if (!(b.confirmUsd < b.mfaUsd && b.mfaUsd <= b.denyCeilingUsd)) return { ...DEFAULT_BANDS };
  return b;
}

// ── Single-use, amount-bound, TTL receipts (hitlCredit + step-up shapes) ────
export function createReceiptStore({ now = Date.now, ttlMs = 5 * 60 * 1000 } = {}) {
  let seq = 0;
  const receipts = new Map(); // id -> { kind: 'hitl'|'stepUp'|'ciba', amountBound, tool, at, taskId, used }
  return {
    ttlMs,
    mint({ kind, amount = null, tool = null, taskId = null }) {
      seq += 1;
      const id = `${kind}-receipt-${String(seq).padStart(4, '0')}`;
      const r = { id, kind, amountBound: amount, tool, taskId, at: now(), used: false };
      receipts.set(id, r);
      return r;
    },
    // Claim for evaluation: live (TTL), unused, and — when bound — only for a call at or
    // below the approved amount (approving $300 cannot silently authorize $600).
    claim({ kind, amount = null, tool = null }) {
      for (const r of receipts.values()) {
        if (r.kind !== kind || r.used) continue;
        if (now() - r.at > ttlMs) continue;
        if (tool && r.tool && r.tool !== tool) continue;
        if (r.amountBound != null && amount != null && Number(amount) > Number(r.amountBound)) continue;
        return r;
      }
      return null;
    },
    consume(id) {
      const r = receipts.get(id);
      if (r && !r.used) { r.used = true; return true; }
      return false;
    },
    all() { return [...receipts.values()]; },
    reset() { receipts.clear(); seq = 0; },
  };
}

// ── CIBA: bc-authorize + poll (cibaService/routes/ciba shape, mock) ─────────
export function createCibaStore({ now = Date.now, expiresIn = 300, interval = 2, autoApproveAfterMs = null } = {}) {
  let seq = 0;
  const requests = new Map(); // authReqId -> { status, bindingMessage, amount, tool, createdAt, approvedAt, receiptId }
  return {
    expiresIn, interval,
    /** bc-authorize: mints the auth_req_id. The approval request carries the binding message
     * the user sees on their device — and the amount is bound into the eventual receipt. */
    bcAuthorize({ bindingMessage = 'Approve', amount = null, tool = 'create_transfer' } = {}) {
      seq += 1;
      const authReqId = `ciba-${String(seq).padStart(4, '0')}-${Math.random().toString(36).slice(2, 8)}`;
      const cleanMsg = String(bindingMessage).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, LIMITS.bindingMessage) || 'Approve';
      requests.set(authReqId, { status: 'pending', bindingMessage: cleanMsg, amount, tool, createdAt: now(), approvedAt: null, receiptId: null });
      return { auth_req_id: authReqId, expires_in: expiresIn, interval, binding_message: cleanMsg };
    },
    // Single poll: 'pending' | 'approved' | 'denied' | 'expired'. The USER approves out-of-band
    // (the UI's phone panel); autoApproveAfterMs (tests only) approves after a delay.
    poll(authReqId, { receiptStore = null } = {}) {
      const r = requests.get(String(authReqId).slice(0, LIMITS.authReqId));
      if (!r) return { status: 'unknown' };
      if (r.status === 'pending' && now() - r.createdAt > expiresIn * 1000) r.status = 'expired';
      if (r.status === 'pending' && autoApproveAfterMs != null && now() - r.createdAt >= autoApproveAfterMs) {
        return this.approve(authReqId, { receiptStore });
      }
      return r.status === 'approved'
        ? { status: 'approved', receiptId: r.receiptId, bindingMessage: r.bindingMessage }
        : { status: r.status, bindingMessage: r.bindingMessage };
    },
    approve(authReqId, { receiptStore = null } = {}) {
      const r = requests.get(String(authReqId).slice(0, LIMITS.authReqId));
      if (!r) return { status: 'unknown' };
      // Idempotent: an already-approved request returns its EXISTING receipt — a double-approve
      // must never mint a second single-use receipt (one human approval, one discharge).
      if (r.status === 'approved') return { status: 'approved', receiptId: r.receiptId, bindingMessage: r.bindingMessage };
      if (r.status === 'denied') return { status: 'denied' };
      // The TTL applies to the approval too: an approve after expires_in is an expiry, not a mint.
      if (now() - r.createdAt > expiresIn * 1000) { r.status = 'expired'; return { status: 'expired' }; }
      r.status = 'approved';
      r.approvedAt = now();
      // The CIBA approval IS a human-in-the-loop event: mint an amount-bound receipt that
      // discharges the HITL consent gate on the immediate retry (hitlCredit shape).
      if (receiptStore) {
        const receipt = receiptStore.mint({ kind: 'hitl', amount: r.amount, tool: r.tool, taskId: r.authReqId || authReqId });
        r.receiptId = receipt.id;
      }
      return { status: 'approved', receiptId: r.receiptId, bindingMessage: r.bindingMessage };
    },
    deny(authReqId) {
      const r = requests.get(String(authReqId).slice(0, LIMITS.authReqId));
      if (!r) return { status: 'unknown' };
      // An already-approved request stays approved: its receipt exists and deny must not
      // flip the audit state under it.
      if (r.status === 'approved') return { status: 'approved', receiptId: r.receiptId };
      r.status = 'denied';
      return { status: 'denied' };
    },
    get(authReqId) { return requests.get(String(authReqId).slice(0, LIMITS.authReqId)) || null; },
    all() { return [...requests.entries()].map(([authReqId, r]) => ({ authReqId, ...r })); },
    reset() { requests.clear(); seq = 0; },
  };
}

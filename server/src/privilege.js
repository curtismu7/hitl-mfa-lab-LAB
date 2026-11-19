// MOCK of a Privilege AI gateway "Require human approval" policy, confirmed with PingID. Shapes follow the owner's screen recording of
// 2026-11-17 (a different tenant): a held tools/call answers 403 / JSON-RPC -32600 `pending_approval` with an instruction id; an approver
// decides it in HITL Requests; PingID confirms the approver (push or passcode); the agent retries with the approval id in the
// `X-Procyon-Approval-Id` header within the retry window; the grant is for ONE transaction. Nothing here calls a real gateway or PingID.
// Pure and clock-injected like policy.js: no I/O, no timers.

export const PRIVILEGE = {
  header: 'X-Procyon-Approval-Id',
  policyId: 'ai-transfer-hitl:1',
  reason: 'Agent transfers above the demo threshold need a human',
  openMs: 120_000,  // a request stays open for a decision this long (recording: 120 s)
  retryMs: 90_000,  // after approval the agent has this long to retry (recording: 90 s)
  demoPasscode: '123123', // labelled demo bypass for the PingID passcode, never a real credential
  max: 100,
};

export class PrivilegeError extends Error {
  constructor(code, detail, status = 400) { super(detail); this.code = code; this.status = status; }
}

export function createPrivilegeStore({ now = Date.now, openMs = PRIVILEGE.openMs, retryMs = PRIVILEGE.retryMs } = {}) {
  let seq = 0;
  const reqs = new Map(); // id -> { id, tool, amount, createdAt, status, decidedAt, method, used }
  // pending -> approved | rejected | expired (terminal); approved -> used | expired (retry window passed). A decided record never changes back.
  const live = (r) => {
    const t = now();
    if (r.status === 'pending' && t - r.createdAt > openMs) r.status = 'expired';
    if (r.status === 'approved' && !r.used && t - r.decidedAt > retryMs) r.status = 'expired';
    return r;
  };
  const view = (r) => ({
    id: r.id, tool: r.tool, amount: r.amount, status: live(r).status, createdAt: r.createdAt, decidedAt: r.decidedAt || null, method: r.method || null,
    expiresAt: new Date(r.createdAt + openMs).toISOString(),
    retryUntil: r.decidedAt && r.status === 'approved' ? new Date(r.decidedAt + retryMs).toISOString() : null,
  });
  return {
    openMs, retryMs,
    /** The gateway holds a call: one request awaiting a decision. */
    hold({ tool, amount }) {
      seq += 1;
      const id = `ins_${String(seq).padStart(6, '0')}`;
      const r = { id, tool, amount: Number(amount), createdAt: now(), status: 'pending', decidedAt: null, method: null, used: false };
      reqs.set(id, r);
      if (reqs.size > PRIVILEGE.max) {
        // Evict the oldest FINISHED record first, then the oldest still-awaiting one, and an approved-but-unused approval last: a flood of
        // bad retries must not push out an approval that is waiting to be used.
        const rank = { used: 0, rejected: 0, expired: 0, pending: 1, approved: 2 };
        const all = [...reqs.values()];
        const worst = Math.min(...all.map((x) => rank[live(x).status]));
        reqs.delete(all.find((x) => rank[x.status] === worst).id);
      }
      return view(r);
    },
    get(id) { const r = reqs.get(id); return r ? view(r) : null; },
    list() { return [...reqs.values()].map(view).reverse(); },
    /**
     * An approver decides. Approve needs a PingID confirmation: { method: 'push', result: 'approved'|'denied' } or
     * { method: 'passcode', code }. A "No, it's not me" push or a wrong passcode records nothing (the request stays awaiting).
     * Reject needs no PingID. A decided or expired request cannot be decided again.
     */
    decide(id, { decision, pingid = null } = {}) {
      const r = reqs.get(id);
      if (!r) throw new PrivilegeError('not_found', 'no such request', 404);
      live(r);
      if (r.status !== 'pending') throw new PrivilegeError('already_decided', `the request is already ${r.status}: a decided record cannot be changed`, 409);
      if (decision === 'reject') { r.status = 'rejected'; r.decidedAt = now(); return view(r); }
      if (decision !== 'approve') throw new PrivilegeError('bad_decision', "decision must be 'approve' or 'reject'");
      if (!pingid || typeof pingid !== 'object') throw new PrivilegeError('pingid_required', 'approving needs a PingID confirmation (push or passcode)', 428);
      if (pingid.method === 'push') {
        if (pingid.result !== 'approved') throw new PrivilegeError('pingid_denied', 'PingID: "No, it\'s not me" — nothing was approved', 403);
      } else if (pingid.method === 'passcode') {
        if (typeof pingid.code !== 'string' || pingid.code.trim() !== PRIVILEGE.demoPasscode) throw new PrivilegeError('bad_passcode', `wrong PingID passcode — the demo passcode is ${PRIVILEGE.demoPasscode}`, 401);
      } else throw new PrivilegeError('bad_pingid_method', "pingid.method must be 'push' or 'passcode'");
      r.status = 'approved'; r.decidedAt = now(); r.method = pingid.method;
      return view(r);
    },
    /** The retry presents an approval id. ok only if approved, unused, inside the retry window, and for at most the approved amount. */
    check(id, { tool, amount }) {
      const r = id ? reqs.get(String(id).slice(0, 64)) : null;
      if (!r) return { ok: false, reason: 'unknown_approval' };
      live(r);
      if (r.used) return { ok: false, reason: 'already_used' };
      if (r.status !== 'approved') return { ok: false, reason: r.status === 'expired' ? 'expired' : `not_approved (${r.status})` };
      if (r.tool !== tool) return { ok: false, reason: 'wrong_tool' };
      // `!(a <= b)` so a NaN, missing or junk amount is refused rather than slipping through a `>` comparison.
      const n = typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== '') ? Number(amount) : NaN;
      if (!(n >= 0 && n <= r.amount)) return { ok: false, reason: 'amount_exceeds_approval' };
      return { ok: true, approval: view(r) };
    },
    consume(id) { const r = reqs.get(id); if (r && !r.used && live(r).status === 'approved') { r.used = true; r.status = 'used'; return true; } return false; },
    reset() { reqs.clear(); seq = 0; },
  };
}

// MOCK of a PingID push step-up: the agent's call is held, a push goes to the approver's phone, the approver approves ("Approve") or refuses
// ("No, it's not me") on the phone, and the agent polls. Approval mints a single-use, amount-bound credit (kind 'push') that the retry presents.
// Nothing here calls PingOne or PingID: the "phone" is the in-page mock phone panel. In your own PingOne environment the same push goes to a real phone
// (see the PingID setup wizard; that live path is owner-run and not wired into this server). Pure and clock-injected like policy.js.

export const PUSH = { ttlMs: 60_000, max: 100, bindingMax: 120 };

export class PushError extends Error {
  constructor(code, detail, status = 400) { super(detail); this.code = code; this.status = status; }
}

const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max);

export function createPushStore({ now = Date.now, ttlMs = PUSH.ttlMs } = {}) {
  let seq = 0;
  const pushes = new Map(); // id -> { id, amount, tool, bindingMessage, createdAt, status, decidedAt, receiptId }
  // pending -> approved | denied | expired (terminal). A decided record never changes; repeating the SAME decision is harmless.
  const live = (p) => { if (p.status === 'pending' && now() - p.createdAt > ttlMs) p.status = 'expired'; return p; };
  const view = (p) => ({ id: p.id, method: 'pingid-push', status: live(p).status, amount: p.amount, bindingMessage: p.bindingMessage, expiresInSeconds: Math.round(ttlMs / 1000), createdAt: p.createdAt });
  return {
    ttlMs,
    /** Send the push: one challenge awaiting the approver. */
    start({ amount, tool = 'create_transfer', bindingMessage = null }) {
      seq += 1;
      const id = `push-${String(seq).padStart(4, '0')}`;
      const p = { id, amount: Number(amount), tool, bindingMessage: cleanText(bindingMessage, PUSH.bindingMax) || `Approve $${amount} transfer`, createdAt: now(), status: 'pending', decidedAt: null, receiptId: null };
      pushes.set(id, p);
      if (pushes.size > PUSH.max) {
        // Evict the oldest finished one first; an approved push still waiting for its poll is the last to go.
        const rank = { denied: 0, expired: 0, pending: 1, approved: 2 };
        const all = [...pushes.values()];
        const worst = Math.min(...all.map((x) => rank[live(x).status]));
        pushes.delete(all.find((x) => rank[x.status] === worst).id);
      }
      return view(p);
    },
    get(id) { const p = pushes.get(id); return p ? view(p) : null; },
    /** The approver's answer on the phone. */
    respond(id, decision) {
      const p = pushes.get(id);
      if (!p) throw new PushError('not_found', 'no such push', 404);
      live(p);
      const want = decision === 'approved' ? 'approved' : decision === 'denied' ? 'denied' : null;
      if (!want) throw new PushError('bad_decision', "decision must be 'approved' or 'denied'");
      if (p.status === want) return view(p);
      if (p.status !== 'pending') throw new PushError('already_decided', `the push is already ${p.status}: a decided push cannot be changed`, 409);
      p.status = want; p.decidedAt = now();
      return view(p);
    },
    /** The agent polls. The first poll after approval mints the credit; later polls return the SAME one (one approval, one credit). */
    poll(id, receiptStore) {
      const p = pushes.get(id);
      if (!p) return { status: 'failed', detail: 'unknown or expired push' };
      live(p);
      if (p.status === 'pending') return { status: 'pending' };
      if (p.status === 'denied') return { status: 'denied' };
      if (p.status === 'expired') return { status: 'failed', detail: 'the push timed out with no answer' };
      if (!p.receiptId) p.receiptId = receiptStore.mint({ kind: 'push', amount: p.amount, tool: p.tool, taskId: p.id }).id;
      return { status: 'verified', receipt: { id: p.receiptId, ttlMs: receiptStore.ttlMs, kind: 'push' } };
    },
    reset() { pushes.clear(); seq = 0; },
  };
}

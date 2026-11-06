// Rule 13: a workspace id keeps one visitor's state apart from another's. Per workspace: the policy bands,
// the receipts, the CIBA requests, the recent runs. Bounded in count, size and age.
import { createReceiptStore, createCibaStore } from './policy.js';

export const WORKSPACE_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_WORKSPACE = 'default';
export const MAX_RUNS = 20;

export function workspaceFrom(req) {
  const raw = req.headers['x-workspace'];
  if (raw === undefined) return DEFAULT_WORKSPACE;
  return typeof raw === 'string' && WORKSPACE_RE.test(raw) ? raw : null;
}

export function createWorkspaces({ max = 500, ttlMs = 60 * 60 * 1000, now = Date.now, bands, receiptStore, cibaStore } = {}) {
  const map = new Map(); // id -> { runs, at, bands, receipts, ciba }
  const sweep = () => {
    const t = now();
    // Evict by oldest TOUCH (insertion order lies: a long-lived active workspace is touched
    // constantly), and consider every entry — no early break.
    const expired = [...map.entries()].filter(([, v]) => t - v.at > ttlMs).sort((a, b) => a[1].at - b[1].at);
    for (const [id] of expired) map.delete(id);
    const byAge = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
    while (map.size > max) { const [id] = byAge.shift(); map.delete(id); }
  };
  const blank = () => ({
    runs: [],
    bands: bands ? { ...bands } : null, // null = never touched; the app falls back to the policy defaults
    receipts: receiptStore ? receiptStore : createReceiptStore({ now }),
    ciba: cibaStore ? cibaStore : createCibaStore({ now }),
  });
  return {
    state(id) {
      sweep();
      let v = map.get(id);
      if (!v) { v = blank(); map.set(id, v); }
      v.at = now();
      return v;
    },
    setBands(id, b) {
      const v = this.state(id);
      v.bands = { ...b };
      return v.bands;
    },
    runs(id) { sweep(); const v = map.get(id); return { workspace: id, runs: v ? v.runs : [] }; },
    record(id, run) {
      const v = this.state(id);
      v.runs = [...v.runs, { ...run, at: now() }].slice(-MAX_RUNS);
      sweep();
      return v.runs;
    },
    resetWorkspace(id) { map.delete(id); },
    size() { return map.size; },
  };
}

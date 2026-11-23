// Rule 13: each browser tab gets its own workspace id, kept in sessionStorage, and sends it as X-Workspace on every API call
// that touches server state. Storage can be blocked, so a failure falls back to a per-load id.
const KEY = "gcl.workspace";
let memo = null;

export function workspaceId() {
  if (memo) return memo;
  try { const saved = window.sessionStorage.getItem(KEY); if (saved && /^[a-z0-9-]{1,40}$/.test(saved)) return (memo = saved); } catch { /* blocked */ }
  const bytes = new Uint8Array(8);
  (window.crypto || { getRandomValues: (a) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(bytes);
  memo = `w-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  try { window.sessionStorage.setItem(KEY, memo); } catch { /* blocked */ }
  return memo;
}

// Rule 27: every write (a step, a human beat, a failed one too) tells the run-observability panel to read its record again. A read (a poll) does not,
// and a caller that knows better passes announce: false and calls announceStep itself (the real call's automatic retry: a still-held answer adds nothing).
export const announceStep = () => { try { window.dispatchEvent(new Event("hmlab-step")); } catch { /* no window */ } };
export const workspaceFetch = (url, { announce = true, ...opts } = {}) => {
  const p = fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}), "x-workspace": workspaceId() } });
  if (announce && opts.method && opts.method !== "GET") p.then(announceStep, announceStep);
  return p;
};

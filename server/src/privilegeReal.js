// REAL mode (owner-run): one real MCP `tools/call` to the Privilege gateway door configured in this lab's own .env, and the real answer.
// What it does: initialize (the MCP handshake), then tools/call of the configured tool; a held call answers HTTP 403 / JSON-RPC -32600
// `pending_approval` with an instruction id (shape from the owner's 2026-11-17 recording; whether OUR tenant answers 403 or a 200 whose text says
// pending_approval is UNVERIFIED, so both are read and labelled observed / inferred). The approver decides in the real console, on their phone, with
// PingID: nothing here can do that for them. The retry re-sends the call with the approval id in X-Procyon-Approval-Id.
// Safety: the only address reachable is HMLAB_REAL_URL's host (netguard allowlist, set only while Real is on); https only (http on loopback);
// no redirect is ever followed; the body is bounded; there is a timeout; one call in flight; the agent key is never returned, logged or put in a trace.
import { realConfigFrom } from './config.js';
import { PRIVILEGE } from './privilege.js';
import { formatTraceparent, newTrace } from './trace.js';
import { bearerForDisplay, failureTrace, realTrace } from './gatewayTrace.js';

export const REAL_LIMITS = { body: 256 * 1024, timeoutMs: 15_000, totalMs: 25_000, summary: 600, approvalId: 64 };
const PROTOCOL_VERSION = '2025-06-18';
const APPROVAL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export class RealError extends Error {
  constructor(code, detail, status = 502) { super(detail); this.code = code; this.status = status; }
}

/** The key as it could come back: raw, URL-encoded, base64 and base64url (padded or not). */
function keyForms(key) {
  if (!key) return [];
  const b64 = Buffer.from(key).toString('base64');
  return [...new Set([key, encodeURIComponent(key), b64, b64.replace(/=+$/, ''), b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')])].filter(Boolean).sort((x, y) => y.length - x.length);
}
const scrubString = (str, forms) => forms.reduce((acc, f) => acc.split(f).join('<agent key>'), str);

/** Replace the key (every form) in every string AND every object key, deeply. */
export function scrubDeep(value, key) {
  const forms = keyForms(key);
  if (!forms.length) return value;
  const walk = (v) => {
    if (typeof v === 'string') return scrubString(v, forms);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrubString(k, forms), walk(x)]));
    return v;
  };
  return walk(value);
}

/** Last line of defence: if the serialized answer still holds the key in any form, withhold it rather than send it. */
function assertClean(value, key) {
  const text = JSON.stringify(value);
  if (keyForms(key).some((f) => text.includes(f))) throw new RealError('key_leak_blocked', 'the gateway answer contained the agent key, so it was withheld', 502);
  return value;
}

// Streamable HTTP may answer text/event-stream: the JSON-RPC message is in a `data:` line.
function parseBody(text, contentType) {
  if (/text\/event-stream/i.test(contentType || '')) {
    const msgs = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) { try { msgs.push(JSON.parse(data)); } catch { /* not JSON */ } }
    }
    return msgs.find((m) => m && m.id === 1) || msgs.at(-1) || text;
  }
  try { return JSON.parse(text); } catch { return text; }
}

async function readBounded(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) return { text: await res.text().then((t) => t.slice(0, max)), truncated: false };
  const dec = new TextDecoder();
  let text = ''; let size = 0; let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { truncated = true; try { await reader.cancel(); } catch { /* closing */ } break; }
    text += dec.decode(value, { stream: true });
  }
  return { text: text + dec.decode(), truncated };
}

const textOf = (body) => {
  const parts = body?.result?.content;
  return Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ').trim() : '';
};

const isRpc = (b) => b !== null && typeof b === 'object' && !Array.isArray(b) && b.jsonrpc === '2.0';

/** What a gateway answer means. basis: observed = read from the response; inferred = read from its words. A 200 only counts as the call
 * having RUN when it is a complete JSON-RPC answer to our call (id 1, with a result): an HTML page, an empty body, `{}` or a cut-off
 * body from a proxy, WAF or wrong URL is "unknown", never "executed". */
export function classify(status, body, { truncated = false } = {}) {
  const rpcErr = isRpc(body) ? body.error : null;
  if (rpcErr?.data?.status === 'pending_approval' || (status === 403 && /pending_approval|requires human approval/i.test(JSON.stringify(rpcErr || {})))) {
    const d = rpcErr?.data || {};
    return { outcome: 'held', basis: 'observed', held: { instruction_id: d.instruction_id || null, expires_at: d.expires_at || null, retry_header: d.retry_header || PRIVILEGE.header, policy_ids: Array.isArray(d.policy_ids) ? d.policy_ids.slice(0, 5) : [], reason: d.reason || null } };
  }
  const text = isRpc(body) ? textOf(body) : '';
  if (status === 200 && !truncated && isRpc(body) && body.id === 1 && /pending_approval/i.test(text)) {
    return { outcome: 'held', basis: 'inferred', held: { instruction_id: /ins_[A-Za-z0-9_-]{1,60}/.exec(text)?.[0] || null, expires_at: null, retry_header: PRIVILEGE.header, policy_ids: [], reason: null } };
  }
  if (status === 401) return { outcome: 'refused', basis: 'observed', message: 'the gateway refused the agent key (401)' };
  if (status >= 300 && status < 400) return { outcome: 'refused', basis: 'observed', message: `the gateway answered a redirect (${status}); it was not followed` };
  if (rpcErr) return { outcome: 'refused', basis: 'observed', message: String(rpcErr.message || 'JSON-RPC error').slice(0, 200) };
  if (status === 403) return { outcome: 'refused', basis: 'observed', message: 'the gateway refused the call (403)' };
  if (status === 200) {
    if (truncated) return { outcome: 'unknown', basis: 'observed', message: 'the answer was too large to read in full, so the lab cannot say what the gateway did' };
    if (!isRpc(body) || body.id !== 1 || body.result === undefined) return { outcome: 'unknown', basis: 'observed', message: 'HTTP 200, but not a JSON-RPC answer to this call (a proxy, login page or wrong URL?): the lab cannot say the tool ran' };
    if (body.result?.isError) return { outcome: 'refused', basis: 'observed', message: text.slice(0, 200) || 'the tool reported an error' };
    return { outcome: 'executed', basis: 'observed', summary: text.slice(0, REAL_LIMITS.summary) };
  }
  return { outcome: 'unknown', basis: 'observed', message: `unexpected HTTP ${status}` };
}

export function createPrivilegeReal({ env = process.env, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  let inFlight = false;
  const cfgView = () => { const c = realConfigFrom(env); return c.ok ? { ok: true, host: c.host, origin: c.origin, tool: c.tool, url: `${c.origin}${new URL(c.url).pathname}` } : { ok: false, problem: c.problem }; };
  return {
    configView: cfgView,
    /** One real call. `approvalId` makes it the retry. Never throws the key; throws RealError for refusals the route maps to JSON. */
    async call({ approvalId = null } = {}) {
      const cfg = realConfigFrom(env);
      if (!cfg.ok) throw new RealError('real_not_configured', cfg.problem, 409);
      if (approvalId !== null && !(typeof approvalId === 'string' && APPROVAL_RE.test(approvalId))) throw new RealError('bad_approval_id', 'the approval id must be 1-64 letters, digits or _ . : -', 400);
      if (inFlight) throw new RealError('busy', 'a real call is already in flight', 429);
      inFlight = true; // everything after this is inside the try below, so the flag always resets
      const key = env.HMLAB_REAL_AGENT_KEY;
      let shownUrl = cfg.origin; let authorization = ''; let rpc = null; let tp = null;
      const setup = [];
      let sessionId = null;
      const overall = AbortSignal.timeout(REAL_LIMITS.totalMs); // the whole call, not just each request
      const send = async (method, body, extra = {}) => {
        const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, traceparent: tp, ...extra };
        if (sessionId) headers['mcp-session-id'] = sessionId;
        if (method !== 'initialize') headers['mcp-protocol-version'] = PROTOCOL_VERSION;
        const res = await fetchImpl(cfg.url, { method: 'POST', headers, redirect: 'manual', signal: AbortSignal.any([overall, AbortSignal.timeout(REAL_LIMITS.timeoutMs)]), body: JSON.stringify(body) });
        const { text, truncated } = await readBounded(res, REAL_LIMITS.body);
        return { status: res.status, ct: res.headers.get('content-type') || '', sid: res.headers.get('mcp-session-id'), rid: res.headers.get('x-request-id'), text, truncated };
      };
      try {
        const trace = newTrace(null);
        tp = formatTraceparent(trace.traceId, trace.span());
        shownUrl = `${cfg.origin}${new URL(cfg.url).pathname}`;
        authorization = bearerForDisplay('kept-on-server', () => key);
        rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: cfg.tool, arguments: cfg.args } };
        {
          const init = await send('initialize', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'hitl-mfa-lab', version: '0.1.0' } } });
          setup.push({ label: 'initialize', status: init.status });
          if (init.sid) sessionId = init.sid;
          if (init.status === 401 || init.status === 403) return finish(cfg, shownUrl, authorization, rpc, tp, setup, init, null, key, approvalId);
          if (init.status >= 200 && init.status < 300) {
            const ack = await send('notifications/initialized', { jsonrpc: '2.0', method: 'notifications/initialized' });
            setup.push({ label: 'notifications/initialized', status: ack.status });
          }
        }
        const out = await send('tools/call', rpc, approvalId ? { [PRIVILEGE.header.toLowerCase()]: approvalId } : {});
        return finish(cfg, shownUrl, authorization, rpc, tp, setup, null, out, key, approvalId);
      } catch (e) {
        if (e instanceof RealError) throw e;
        const cause = `${e?.cause?.message || ''} ${e?.message || ''}`;
        const msg = scrubDeep(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `no answer in time (${REAL_LIMITS.timeoutMs / 1000} s per request, ${REAL_LIMITS.totalMs / 1000} s in all)` : /redirect/i.test(cause) ? 'the gateway answered a redirect, which is never followed' : /network blocked/.test(cause) ? String(cause.match(/network blocked[^\n]*/)?.[0] || 'network blocked') : (e?.cause?.code || e?.code || 'the gateway could not be reached'), key);
        const err = new RealError('upstream_unreachable', `Could not reach the gateway: ${msg}`, 502);
        err.trace = scrubDeep(failureTrace({ url: shownUrl, authorization, rpc, error: msg, requestHeaders: { traceparent: tp, ...(approvalId ? { [PRIVILEGE.header]: approvalId } : {}) } }), key);
        throw err;
      } finally { inFlight = false; }
    },
  };
}

function finish(cfg, shownUrl, authorization, rpc, tp, setup, initFail, out, key, approvalId) {
  const answer = out || initFail;
  const body = scrubDeep(parseBody(answer.text, answer.ct), key);
  const verdict = classify(answer.status, body, { truncated: answer.truncated });
  const headers = { ...(answer.ct ? { 'content-type': answer.ct } : {}), ...(answer.rid ? { 'x-request-id': answer.rid } : {}) };
  const detail = verdict.outcome === 'held' ? 'held for human approval (pending_approval)' : verdict.message;
  const trace = scrubDeep(realTrace({ url: shownUrl, authorization, rpc: initFail ? { jsonrpc: '2.0', id: 0, method: 'initialize' } : rpc, status: answer.status, headers, body, detail, requestHeaders: { traceparent: tp, ...(approvalId ? { [PRIVILEGE.header]: approvalId } : {}) }, at: new Date().toISOString(), requestId: answer.rid || undefined, setup }), key);
  return assertClean(scrubDeep({ ...verdict, http: answer.status, truncated: !!answer.truncated, tool: cfg.tool, approvalPresented: approvalId || null, trace }, key), key);
}

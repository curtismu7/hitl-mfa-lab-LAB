// Deployment configuration: the MODE switch (rule 18) and the Mock/Real toggle (rule 19).
// One image serves the local standalone and the hosted SE build.
// Mock is the only fully-offline mode. Real is OWNER-RUN: the lab sends one real MCP tools/call to the Privilege gateway door you
// configure in its own .env (beside the compose file) and shows the real answer. Agents never use live credentials.
//   HMLAB_REAL_URL        the door's MCP URL (https; http only on loopback). The ONLY address Real mode may reach.
//   HMLAB_REAL_AGENT_KEY  a Privilege agent access key. Write-only: never returned, logged or put in a trace.
//   HMLAB_REAL_TOOL       the tool the gateway's "Require human approval" policy holds
//   HMLAB_REAL_ARGS       optional JSON object of that tool's arguments (default {})
// When Real is not configured, POST /api/mode answers 409 and the toggle is disabled with a how-to tooltip.
import { isLoopbackHost } from './safety.js';
import { isPrivateAddress } from './netguard.js';

const TOOL_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** What the Real settings say. Never contains the key: only whether it is present. */
export function realConfigFrom(env = process.env) {
  const url = env.HMLAB_REAL_URL;
  const tool = env.HMLAB_REAL_TOOL;
  const any = Boolean(url || env.HMLAB_REAL_AGENT_KEY || tool);
  // A hosted (shared SE) build never makes real calls: any visitor could trigger them. Real is for the owner's own local lab.
  if (env.HMLAB_HOSTED === '1') return { ok: false, any, problem: 'Real mode is not available on a hosted build' };
  if (!url || !env.HMLAB_REAL_AGENT_KEY || !tool) return { ok: false, any, problem: 'HMLAB_REAL_URL, HMLAB_REAL_AGENT_KEY and HMLAB_REAL_TOOL are all needed for Real mode' };
  let u;
  try { u = new URL(url); } catch { return { ok: false, any, problem: 'HMLAB_REAL_URL is not a valid URL' }; }
  // Plain http is for loopback, or for ONE named host the owner lists in HMLAB_REAL_ALLOW_HTTP_HOSTS (e.g. a gateway published on the Docker host
  // as host.docker.internal) AND only together with HMLAB_REAL_ALLOW_PRIVATE=1, because such a name resolves to a private address.
  const httpHosts = String(env.HMLAB_REAL_ALLOW_HTTP_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const httpOk = u.protocol === 'http:' && (isLoopbackHost(u.hostname) || (env.HMLAB_REAL_ALLOW_PRIVATE === '1' && httpHosts.includes(u.hostname.toLowerCase())));
  if (u.protocol !== 'https:' && !httpOk) return { ok: false, any, problem: 'HMLAB_REAL_URL must be https (http is allowed on loopback, or on a host named in HMLAB_REAL_ALLOW_HTTP_HOSTS together with HMLAB_REAL_ALLOW_PRIVATE=1)' };
  if (u.username || u.password) return { ok: false, any, problem: 'HMLAB_REAL_URL must not carry credentials' };
  const privateOk = env.HMLAB_REAL_ALLOW_PRIVATE === '1';
  const literal = /^\[?[0-9a-f:.]+\]?$/i.test(u.hostname) && (u.hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname));
  if (literal && u.protocol === 'https:' && isPrivateAddress(u.hostname) && !privateOk) return { ok: false, any, problem: 'HMLAB_REAL_URL is a private or link-local address; set HMLAB_REAL_ALLOW_PRIVATE=1 only if your gateway really lives on a private network' };
  if (!TOOL_RE.test(tool)) return { ok: false, any, problem: 'HMLAB_REAL_TOOL must be 1-64 letters, digits or _ . : -' };
  let args = {};
  if (env.HMLAB_REAL_ARGS) {
    try { args = JSON.parse(String(env.HMLAB_REAL_ARGS).slice(0, 2001)); } catch { return { ok: false, any, problem: 'HMLAB_REAL_ARGS is not valid JSON' }; }
    if (String(env.HMLAB_REAL_ARGS).length > 2000 || args === null || typeof args !== 'object' || Array.isArray(args)) return { ok: false, any, problem: 'HMLAB_REAL_ARGS must be a JSON object under 2000 characters' };
  }
  return { ok: true, any, url: u.toString(), host: u.hostname.toLowerCase(), origin: u.origin, tool, args, privateOk, allowHttp: u.protocol === 'http:' && !isLoopbackHost(u.hostname) };
}

// Whether Real is configured (never the values).
export function realAvailableFrom(env = process.env) {
  return realConfigFrom(env).ok;
}

// The launch mode (rule 18). Default: Real if configured, else Mock.
export function modeFrom(env = process.env) {
  if (env.MODE === undefined || env.MODE === '') return realAvailableFrom(env) ? 'real' : 'mock';
  const m = env.MODE;
  if (m !== 'mock' && m !== 'real') throw new Error(`MODE=${String(m).slice(0, 20)} is not available: this app has mock and real modes`);
  if (m === 'real' && !realAvailableFrom(env)) throw new Error('MODE=real requested but the Real configuration (HMLAB_REAL_* env) is not present');
  return m;
}

// HMLAB_HOSTED=1 marks the SE build: the banner says HOSTED SIMULATION. It changes wording only, except that a hosted build never allows Real (see realConfigFrom).
export const hostedFrom = (env = process.env) => env.HMLAB_HOSTED === '1';

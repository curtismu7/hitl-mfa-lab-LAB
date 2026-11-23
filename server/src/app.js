// One Express app. /api = health, policy bands (admin-editable), the gated transfer tool, the HITL
// consent panel, MFA step-up, CIBA bc-authorize/poll, diagram, info and reset. Server state is per
// workspace id (X-Workspace) so one visitor's Reset never touches another's. Loopback Host check and
// same-origin writes on everything. Serves web/dist when it exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { mountShelfRoute } from './shelfLink.js';
import { loadCast, verticalFrom, VERTICALS } from './cast.js';
import { hostedFrom, modeFrom, realAvailableFrom, realConfigFrom } from './config.js';
import { allowHost, clearAllowedHosts } from './netguard.js';
import { RealError, createPrivilegeReal } from './privilegeReal.js';
import { buildStory } from './story.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import {
  DEFAULT_BANDS, PolicyInputError, classifyObligations, createCibaStore, createReceiptStore,
  evaluateAmountPolicy, normalizeBands, LIMITS,
} from './policy.js';
import { buildHops, newTrace } from './trace.js';
import { PRIVILEGE, PrivilegeError } from './privilege.js';
import { PushError } from './push.js';
import { WIZARD_STEPS, isWizardComplete } from './pingid.js';
import { createWorkspaces, workspaceFrom } from './workspaces.js';
import { RunObsError } from './runObservability.js';
import { beat, buildRunRecord, createRunLog, observeNoReply, observeReal, observeTransfer } from './runLog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');

const DEMO_OTP = '123123'; // labelled demo bypass (AI-DEMO2 routes/mfa.js)

export function createApp({
  health = createHealth(), configFile = CONFIG, hosted = false,
  workspaces = createWorkspaces({ bands: DEFAULT_BANDS }),
  challenges = [],
  env = process.env,
  runLogWrite, runLogClock, // where the one-line-per-decision output goes (stdout by default), and the clock that stamps it (tests move it)
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use('/health', health.router);
  mountShelfRoute(api, { env });
  // Rule 19: the mode is runtime server state. Real (owner-run) is the only thing that may leave the machine, and only to the one configured gateway:
  // choosing Real opens the netguard allowlist for that host, choosing Mock (or starting in Mock) closes it again.
  const real = createPrivilegeReal({ env });
  // Rule 27: each decision is stamped once and written as one stdout line (run-observability: runLog.js). A recorder that fails must never break the call it describes.
  const runLog = createRunLog({ write: runLogWrite, clock: runLogClock });
  // target: a workspace id, or the run store itself (a Real call keeps the store it started with, so a Reset while it is in flight orphans it and the late reply joins no run).
  const obs = (target, source, events) => {
    for (const e of [events].flat()) {
      if (!e) continue;
      try { runLog.record(typeof target === 'string' ? workspaces.state(target).obs : target, source, e); } catch (err) { process.stderr.write(`run-observability: ${err?.code || err?.name || 'error'}: ${String(err?.message).replace(/\s+/g, ' ').slice(0, 120)}\n`); }
    }
  };
  let source;
  try { source = modeFrom(env); } catch { source = 'mock'; } // the doctor already reports a bad MODE
  const applyMode = (next) => {
    source = next;
    clearAllowedHosts();
    const c = realConfigFrom(env);
    if (next === 'real' && c.ok) allowHost(c.host, { privateOk: c.privateOk, http: c.allowHttp });
  };
  applyMode(source);
  const castFor = (req) => loadCast(configFile, verticalFrom(req.query.vertical));
  // customer.config.json is read on every request so editing it shows up on reload.
  api.get('/scenarios', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ...buildStory(castFor(req), { hosted }), verticals: Object.keys(VERTICALS), hosted }); });
  api.get('/diagram', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(buildDiagram(castFor(req), DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0])); });
  // What this build is, for the banner and for verifying a deploy by content (not by a 200).
  api.get('/info', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ mode: source, source, simulated: true, hosted, realAvailable: realAvailableFrom(env), version: (() => { try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || null; } catch { return null; } })() }); });
  // Rule 19: the Mock/Real toggle. Exactly { source: "mock"|"real" }; 409 when Real is not configured.
  api.post('/mode', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['mock', 'real'].includes(body.source)) {
      return res.status(400).json({ error: 'bad_source', detail: 'body must be exactly { source: "mock" | "real" }' });
    }
    if (body.source === 'real' && !realAvailableFrom(env)) {
      return res.status(409).json({ error: 'real_not_configured', detail: `Real mode needs the Privilege gateway settings in this lab's .env (HMLAB_REAL_URL, HMLAB_REAL_AGENT_KEY, HMLAB_REAL_TOOL; owner-run). ${realConfigFrom(env).problem}. Mock keeps working.` });
    }
    applyMode(body.source);
    return res.json({ source });
  });

  // Real (owner-run): one real MCP tools/call to the configured Privilege gateway door, and its real answer. The approver decides in the real
  // console with PingID; the retry sends the approval id. Only while the mode is Real; the key is never in any answer.
  api.get('/privilege/real', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ mode: source, retryHeader: PRIVILEGE.header, ...real.configView() }); });
  api.post('/privilege/real/call', async (req, res) => {
    if (source !== 'real') return res.status(409).json({ error: 'not_real_mode', message: 'Switch the header toggle to Real first: this call goes to a real gateway.' });
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request', message: 'body must be a JSON object' });
    const approvalId = body.approvalId === undefined || body.approvalId === null || body.approvalId === '' ? null : body.approvalId;
    const store = workspaces.state(ws).obs;
    try {
      const verdict = await real.call({ approvalId });
      obs(store, 'real', observeReal(verdict, { retry: approvalId !== null }));
      return res.json(verdict);
    } catch (e) {
      if (e instanceof RealError) {
        // A call that got no reply began a run (it was made); every other refusal happened before any call, so no run began.
        if (e.code === 'upstream_unreachable') obs(store, 'real', observeNoReply({ retry: approvalId !== null, why: e.message }));
        return res.status(e.status).json({ error: e.code, message: e.message, ...(e.trace ? { trace: e.trace } : {}) });
      }
      throw e;
    }
  });

  const withWorkspace = (handler) => (req, res) => {
    const ws = workspaceFrom(req);
    if (!ws) return res.status(400).json({ error: 'bad_workspace' });
    res.set('Cache-Control', 'no-store');
    return handler(ws, req, res);
  };

  // The workspace's current bands + receipt/challenge state.
  api.get('/policy', withWorkspace((ws, req, res) => {
    const v = workspaces.state(ws);
    res.json({ bands: v.bands || DEFAULT_BANDS, receipts: v.receipts.all().map((r) => ({ id: r.id, kind: r.kind, amountBound: r.amountBound, used: r.used })), workspace: ws });
  }));

  // Set the workspace's bands (admin-editable, live). A crossing edit falls back to defaults.
  api.post('/policy', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (body.bands !== undefined && (typeof body.bands !== 'object' || Array.isArray(body.bands) || body.bands === null)) {
      return res.status(400).json({ error: 'bad_bands', detail: 'bands must be a JSON object' });
    }
    const bands = normalizeBands(body.bands ?? body);
    workspaces.setBands(ws, bands);
    return res.json({ bands, workspace: ws });
  }));

  // The gated transfer (UC7/UC8/UC6 band): one tools/call evaluated by the amount bands, with the
  // visitor's receipts applied. 428 = a human beat is required; 403 = deny; 200 = permitted.
  api.post('/transfer', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (typeof body.amount !== 'number' && typeof body.amount !== 'string') return res.status(400).json({ error: 'amount_required', detail: 'body.amount must be a number' });
    if (typeof body.amount === 'string' && body.amount.trim() === '') return res.status(400).json({ error: 'amount_required', detail: 'body.amount must be a number' });
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > LIMITS.amount) return res.status(400).json({ error: 'bad_amount', detail: 'amount must be a non-negative number within range' });
    const tool = typeof body.tool === 'string' && body.tool ? body.tool.slice(0, 64) : 'create_transfer';
    const declaredStepUp = body.step_up_method === 'ciba' || body.step_up_method === 'p1mfa' || body.step_up_method === 'privilege' || body.step_up_method === 'pingid-push' ? body.step_up_method : null;
    // The retry of a held Privilege call carries the approval id in X-Procyon-Approval-Id (body.approval_id also works for scripts).
    const presentedApproval = typeof req.headers[PRIVILEGE.header.toLowerCase()] === 'string' ? req.headers[PRIVILEGE.header.toLowerCase()].slice(0, 64) : (typeof body.approval_id === 'string' ? body.approval_id.slice(0, 64) : null);
    const v = workspaces.state(ws);
    const bands = v.bands || DEFAULT_BANDS;

    const result = evaluateAmountPolicy({ amount, bands, declaredStepUp });
    const obligation = result.obligation;
    const flags = obligation ? classifyObligations([obligation]) : { stepUpRequired: false, consentRequired: false, hitlRequired: false, classified: { stepUp: [], hitl: [], consent: [] } };

    let receipt = null;
    let block = null;
    let held = null;     // Privilege: the request this call just opened
    let approved = null; // Privilege: the approval this call presented
    let chk = null;      // Privilege: the check of an approval id presented on a retry
    let decision = result.decision;
    if (result.decision === 'PERMIT' || result.decision === 'DENY') {
      // No receipt needed (or none can help).
    } else if (flags.stepUpRequired && declaredStepUp === 'privilege') {
      // A Privilege AI-gateway hold: 403 pending_approval until an approver decides (PingID-confirmed) and the retry presents the id.
      chk = v.privilege.check(presentedApproval, { tool, amount });
      if (chk.ok && v.privilege.consume(presentedApproval)) {
        receipt = presentedApproval;
        approved = chk.approval;
        decision = 'PERMIT';
      } else {
        held = v.privilege.hold({ tool, amount });
        block = {
          status: 403, error: 'pending_approval', detail: 'action requires human approval', step_up_method: 'privilege',
          approval: {
            status: 'pending_approval', instruction_id: held.id, policy_ids: [PRIVILEGE.policyId], reason: PRIVILEGE.reason,
            retry_header: PRIVILEGE.header, expires_at: held.expiresAt, open_for_s: PRIVILEGE.openMs / 1000, retry_within_s: PRIVILEGE.retryMs / 1000,
            ...(presentedApproval ? { rejected_approval: { id: presentedApproval, reason: chk.reason } } : {}),
          },
        };
      }
    } else if (flags.stepUpRequired) {
      const kind = declaredStepUp === 'ciba' ? 'ciba' : declaredStepUp === 'pingid-push' ? 'push' : 'stepUp';
      // A CIBA approval IS a human-in-the-loop event: the approval receipt (kind 'hitl', minted by
      // the out-of-band approve) discharges the ciba step-up on the retry — same beat, one receipt
      // (hitlCredit shape). The MFA credit (kind 'stepUp') discharges the device-MFA step-up.
      const credit = v.receipts.claim({ kind, amount, tool }) || (kind === 'ciba' ? v.receipts.claim({ kind: 'hitl', amount, tool }) : null);
      if (credit) {
        // The receipt discharges the gate: the retried call proceeds (the AI-DEMO2 contract —
        // the policy re-evaluates to PERMIT once the human beat is satisfied).
        v.receipts.consume(credit.id);
        receipt = credit.id;
        decision = 'PERMIT';
      } else {
        block = {
          status: 428,
          error: kind === 'ciba' ? 'ciba_required' : 'mcp_step_up_required',
          detail: kind === 'ciba'
            ? 'CIBA: the agent must request out-of-band approval (bc-authorize) and present the polled approval.'
            : kind === 'push'
              ? 'PingID push: the approver must approve the push on their phone before the transfer runs.'
              : 'MFA step-up: the human must complete device MFA before the transfer runs.',
          step_up_method: declaredStepUp || 'p1mfa',
        };
      }
    } else if (flags.consentRequired) {
      const credit = v.receipts.claim({ kind: 'hitl', amount, tool });
      if (credit) {
        v.receipts.consume(credit.id);
        receipt = credit.id;
        decision = 'PERMIT';
      } else {
        // Mint the consent challenge: the UI surfaces it, and /consent/respond mints the receipt.
        const challenge = { id: `consent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, workspace: ws, amount, tool, status: 'pending', createdAt: Date.now() };
        challenges.push(challenge);
        if (challenges.length > LIMITS.challenges) challenges.shift();
        block = { status: 428, error: 'mcp_hitl_required', detail: 'HITL consent: the transfer runs only after an explicit human approval.', challengeId: challenge.id };
      }
    }

    workspaces.record(ws, { tool, amount, decision, reason: result.reason, receipt, blocked: block ? block.error : null });
    const receiptKind = declaredStepUp === 'privilege' ? 'privilege' : declaredStepUp === 'pingid-push' ? 'push' : declaredStepUp === 'ciba' ? 'ciba' : flags.stepUpRequired ? 'stepUp' : 'hitl';
    obs(ws, 'mock', observeTransfer({ amount, result, decision, declaredStepUp, receipt, receiptKind, block, held, approved, presented: declaredStepUp === 'privilege' ? presentedApproval : null, check: chk }));
    const trace = newTrace(req.headers.traceparent);
    const privilege = declaredStepUp === 'privilege' ? { held, approval: approved, header: PRIVILEGE.header, policyId: PRIVILEGE.policyId, reason: PRIVILEGE.reason } : null;
    const hops = buildHops({ trace, cast: castFor(req), decision, obligation, reason: result.reason, tool, amount, step_up_method: declaredStepUp || obligation?.step_up_method, receipt, ciba: null, privilege });
    res.set('traceparent', hops[0].traceparent);
    if (block) {
      return res.status(block.status).json({
        decision, reason: result.reason, tool, amount,
        error: block.error, detail: block.detail, ...(block.step_up_method ? { step_up_method: block.step_up_method } : {}), ...(block.challengeId ? { challengeId: block.challengeId } : {}), ...(block.approval ? { approval: block.approval } : {}),
        bands, workspace: ws, traceId: trace.traceId, hops,
      });
    }
    return res.status(decision === 'DENY' ? 403 : 200).json({
      decision, reason: result.reason, tool, amount,
      ...(receipt ? { receipt, receiptKind } : {}),
      ...(approved ? { approval: { id: approved.id, method: approved.method, status: 'used' } } : {}),
      bands, workspace: ws, traceId: trace.traceId, hops,
    });
  }));

  // HITL consent: list pending challenges and approve/deny one. Approval mints the single-use,
  // amount-bound receipt the retry presents (the AI-DEMO2 challenge-store contract).
  api.get('/consent', withWorkspace((ws, _req, res) => {
    const v = workspaces.state(ws);
    res.json({ pending: v.receipts.all().filter((r) => r.kind === 'hitl' && !r.used), all: v.receipts.all(), workspace: ws });
  }));
  api.post('/consent/respond', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (typeof body.challengeId !== 'string' || !body.challengeId) return res.status(400).json({ error: 'challenge_required', detail: 'body.challengeId must be non-empty text' });
    if (body.decision !== 'approved' && body.decision !== 'denied') return res.status(400).json({ error: 'bad_decision', detail: "decision must be 'approved' or 'denied'" });
    const v = workspaces.state(ws);
    const challenge = challenges.find((c) => c.id === body.challengeId.slice(0, 64));
    if (!challenge || challenge.workspace !== ws || challenge.status !== 'pending') return res.status(404).json({ error: 'not_found' });
    challenge.status = body.decision;
    challenge.decidedBy = typeof body.respondedBy === 'string' ? body.respondedBy.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 40) || 'presenter' : 'presenter';
    obs(ws, 'mock', beat.consent({ amount: challenge.amount, decision: body.decision, by: challenge.decidedBy }));
    if (body.decision === 'approved') {
      const receipt = v.receipts.mint({ kind: 'hitl', amount: challenge.amount, tool: challenge.tool, taskId: challenge.id });
      return res.json({ challenge, receipt: { id: receipt.id, amountBound: receipt.amountBound, kind: receipt.kind }, workspace: ws });
    }
    return res.json({ challenge, workspace: ws });
  }));

  // MFA step-up (UC7): start a device challenge, submit the demo OTP, mint the TTL credit.
  // The challenge carries the amount so the minted credit is amount-bound: an unbounded
  // receipt could discharge ANY transfer up to the deny ceiling.
  api.post('/mfa/challenge', withWorkspace((ws, req, res) => {
    const body = req.body || {};
    const amount = typeof body.amount === 'number' && Number.isFinite(body.amount) && body.amount >= 0 && body.amount <= LIMITS.amount ? body.amount : null;
    if (amount === null) return res.status(400).json({ error: 'amount_required', detail: 'body.amount must be a number within range — the credit is amount-bound' });
    const v = workspaces.state(ws);
    const challenge = { id: `mfa-${Date.now().toString(36)}`, workspace: ws, amount, tool: 'create_transfer', status: 'pending', method: 'p1mfa', createdAt: Date.now() };
    challenges.push(challenge);
    if (challenges.length > LIMITS.challenges) challenges.shift();
    obs(ws, 'mock', beat.mfaChallenge({ amount }));
    return res.json({ challenge: { id: challenge.id, method: challenge.method, status: challenge.status, devices: [{ id: 'dev-1', type: 'OTP', label: 'Demo device (OTP)' }] }, workspace: ws });
  }));
  api.post('/mfa/verify', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (typeof body.challengeId !== 'string' || !body.challengeId) return res.status(400).json({ error: 'challenge_required' });
    if (typeof body.otp !== 'string' || !body.otp) return res.status(400).json({ error: 'otp_required', detail: 'body.otp must be the demo code (123123)' });
    const challenge = challenges.find((c) => c.id === body.challengeId.slice(0, 64));
    if (!challenge || challenge.workspace !== ws || challenge.status !== 'pending') return res.status(404).json({ error: 'not_found' });
    if (body.otp.trim() !== DEMO_OTP) { obs(ws, 'mock', beat.mfaCode({ ok: false })); return res.status(401).json({ error: 'bad_otp', detail: 'wrong code — the demo OTP is 123123' }); }
    challenge.status = 'verified';
    obs(ws, 'mock', beat.mfaCode({ ok: true }));
    const v = workspaces.state(ws);
    const receipt = v.receipts.mint({ kind: 'stepUp', amount: challenge.amount, tool: challenge.tool, taskId: challenge.id });
    return res.json({ challenge: { id: challenge.id, status: 'verified' }, receipt: { id: receipt.id, ttlMs: v.receipts.ttlMs, kind: receipt.kind }, workspace: ws });
  }));

  // PingID push step-up (mock): the push goes to the approver's phone, the approver answers on it (the in-page mock phone) and the agent polls.
  // Approval mints a single-use, amount-bound credit (kind 'push'). Nothing here calls PingOne or PingID.
  api.post('/mfa/push', withWorkspace((ws, req, res) => {
    const body = req.body || {};
    const amount = typeof body.amount === 'number' && Number.isFinite(body.amount) && body.amount >= 0 && body.amount <= LIMITS.amount ? body.amount : null;
    if (amount === null) return res.status(400).json({ error: 'amount_required', detail: 'body.amount must be a number within range: the approval is amount-bound' });
    const v = workspaces.state(ws);
    const challenge = v.push.start({ amount, tool: 'create_transfer', bindingMessage: typeof body.bindingMessage === 'string' ? body.bindingMessage : null });
    obs(ws, 'mock', beat.pushSent({ amount }));
    return res.json({ challenge, workspace: ws });
  }));
  api.get('/mfa/poll/:id', withWorkspace((ws, req, res) => {
    const v = workspaces.state(ws);
    const id = String(req.params.id).slice(0, 64);
    const r = v.push.poll(id, v.receipts);
    if (r.status === 'failed' && v.push.get(id)?.status === 'expired') obs(ws, 'mock', beat.pushLapsed({ id }));
    return res.json({ ...r, workspace: ws });
  }));
  api.post('/mfa/push/:id/respond', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    const v = workspaces.state(ws);
    try {
      const challenge = v.push.respond(String(req.params.id).slice(0, 64), body.decision);
      obs(ws, 'mock', beat.pushAnswer({ decision: challenge.status, id: challenge.id }));
      return res.json({ challenge, workspace: ws });
    } catch (e) {
      if (e instanceof PushError) return res.status(e.status).json({ error: e.code, detail: e.message });
      throw e;
    }
  }));

  // CIBA (UC22): bc-authorize mints the auth_req_id; the user approves/denies out-of-band in the
  // phone panel; the agent polls. Approval mints the amount-bound HITL receipt.
  api.post('/ciba/bc-authorize', withWorkspace((ws, req, res) => {
    const body = req.body || {};
    const amount = typeof body.amount === 'number' && Number.isFinite(body.amount) && body.amount >= 0 && body.amount <= LIMITS.amount ? body.amount : null;
    if (amount === null) return res.status(400).json({ error: 'amount_required', detail: 'body.amount must be a number within range — the approval receipt is amount-bound' });
    const v = workspaces.state(ws);
    const r = v.ciba.bcAuthorize({ bindingMessage: typeof body.bindingMessage === 'string' ? body.bindingMessage : `Approve $${amount ?? ''} transfer`.trim(), amount, tool: 'create_transfer' });
    obs(ws, 'mock', beat.cibaSent({ amount }));
    return res.json({ ...r, workspace: ws });
  }));
  api.get('/ciba/poll/:authReqId', withWorkspace((ws, req, res) => {
    const v = workspaces.state(ws);
    const r = v.ciba.poll(req.params.authReqId, { receiptStore: v.receipts });
    if (r.status === 'expired') obs(ws, 'mock', beat.cibaLapsed({ id: String(req.params.authReqId).slice(0, 64) }));
    return res.json({ ...r, workspace: ws });
  }));
  api.post('/ciba/respond', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (typeof body.authReqId !== 'string' || !body.authReqId) return res.status(400).json({ error: 'auth_req_id_required' });
    if (body.decision !== 'approved' && body.decision !== 'denied') return res.status(400).json({ error: 'bad_decision', detail: "decision must be 'approved' or 'denied'" });
    const v = workspaces.state(ws);
    const r = body.decision === 'approved' ? v.ciba.approve(body.authReqId, { receiptStore: v.receipts }) : v.ciba.deny(body.authReqId);
    const id = body.authReqId.slice(0, 64);
    obs(ws, 'mock', r.status === 'expired' ? beat.cibaLapsed({ id }) : beat.cibaAnswer({ status: r.status, id }));
    return res.json({ ...r, workspace: ws });
  }));
  api.get('/ciba/pending', withWorkspace((ws, _req, res) => {
    const v = workspaces.state(ws);
    res.json({ pending: v.ciba.all().filter((r) => r.status === 'pending'), workspace: ws });
  }));

  // ---- PingID setup wizard ----
  // Mock guidance: the steps are the measured enrolment chain; "done" marks are per workspace.
  // The live check never runs in here — the netguard keeps this process at zero outbound. It
  // reports configuration PRESENCE only and hands back the owner-run checker script command.
  const pingidLiveConfig = (e) => Boolean(e.HMLAB_PINGONE_ENV_ID && e.HMLAB_PINGONE_WORKER_CLIENT_ID && e.HMLAB_PINGONE_WORKER_CLIENT_SECRET);
  api.get('/pingid/status', withWorkspace((ws, _req, res) => {
    const v = workspaces.state(ws);
    const liveConfigured = pingidLiveConfig(env);
    res.json({
      steps: WIZARD_STEPS, done: v.pingid.done, complete: isWizardComplete(v.pingid),
      liveConfigured, workspace: ws,
      ...(liveConfigured ? { liveCheck: 'node scripts/pingid-check.mjs' } : { liveHint: 'Set HMLAB_PINGONE_ENV_ID, HMLAB_PINGONE_WORKER_CLIENT_ID and HMLAB_PINGONE_WORKER_CLIENT_SECRET in .env (owner-run) to enable the live device check.' }),
    });
  }));
  api.post('/pingid/step', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (!WIZARD_STEPS.some((s) => s.id === body.stepId)) return res.status(400).json({ error: 'unknown_step' });
    const v = workspaces.state(ws);
    if (!v.pingid.done.includes(body.stepId)) v.pingid.done.push(body.stepId);
    return res.json({ done: v.pingid.done, complete: isWizardComplete(v.pingid), workspace: ws });
  }));
  api.post('/pingid/reset', withWorkspace((ws, _req, res) => {
    workspaces.state(ws).pingid = { done: [] };
    return res.json({ done: [], complete: false, workspace: ws });
  }));
  // Demo knob: let a pending CIBA request expire now instead of waiting out the TTL. Same end
  // state the clock produces: the next poll reports expired and the agent's call stays paused.
  api.post('/ciba/expire', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (typeof body.authReqId !== 'string' || !body.authReqId) return res.status(400).json({ error: 'auth_req_id_required' });
    const v = workspaces.state(ws);
    if (!v.ciba.expire(body.authReqId)) {
      const known = v.ciba.get(body.authReqId);
      if (!known) return res.status(404).json({ error: 'not_found', status: 'unknown' });
      return res.status(409).json({ error: 'not_pending', status: known.status });
    }
    obs(ws, 'mock', beat.cibaLapsed({ id: body.authReqId.slice(0, 64) }));
    return res.json({ status: 'expired', workspace: ws });
  }));

  // The Privilege console's "HITL Requests" queue (mock): what the gateway is holding, and the approver's decision. Approving needs
  // a PingID confirmation (push or passcode); rejecting does not. A decided request cannot be changed.
  api.get('/privilege/hitl', withWorkspace((ws, _req, res) => {
    const v = workspaces.state(ws);
    res.json({ requests: v.privilege.list(), policy: { id: PRIVILEGE.policyId, reason: PRIVILEGE.reason, retryHeader: PRIVILEGE.header, openForSeconds: PRIVILEGE.openMs / 1000, retryWithinSeconds: PRIVILEGE.retryMs / 1000, demoPasscode: PRIVILEGE.demoPasscode }, workspace: ws });
  }));
  api.post('/privilege/hitl/:id/decide', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    const v = workspaces.state(ws);
    try {
      const request = v.privilege.decide(String(req.params.id).slice(0, 64), { decision: body.decision, pingid: body.pingid && typeof body.pingid === 'object' && !Array.isArray(body.pingid) ? body.pingid : null });
      obs(ws, 'mock', beat.hitl({ id: request.id, decision: body.decision, method: request.method }));
      return res.json({ request, workspace: ws });
    } catch (e) {
      if (e instanceof PrivilegeError) {
        // PingID not confirming the approver is a decision of the mock; every other refusal here is a malformed or late request, not a beat.
        if (e.code === 'pingid_denied' || e.code === 'bad_passcode') obs(ws, 'mock', beat.pingidNotConfirmed({ id: String(req.params.id).slice(0, 64), why: e.code === 'pingid_denied' ? "No, it's not me" : 'wrong passcode' }));
        return res.status(e.status).json({ error: e.code, detail: e.message });
      }
      throw e;
    }
  }));

  api.get('/runs', withWorkspace((ws, _req, res) => res.json(workspaces.runs(ws))));
  // Rule 27: what each layer left behind for the newest run of the CURRENT mode in this workspace (a run of the other mode is never returned).
  // No run yet: 200 { record: null, message }. A failure: { error, message } JSON (rule 23).
  api.get('/run-observability', withWorkspace(async (ws, _req, res) => {
    const run = runLog.latest(workspaces.state(ws).obs, source);
    if (!run) return res.json({ record: null, message: `No ${source === 'real' ? 'Real' : 'Mock'} run yet in this workspace: run a scenario.` });
    try {
      return res.json(await buildRunRecord({ run }));
    } catch (e) {
      if (e instanceof RunObsError) return res.status(e.status).json({ error: e.code, message: e.message });
      process.stderr.write(`run-observability: ${e?.code || e?.name || 'error'}: ${String(e?.message).replace(/\s+/g, ' ').slice(0, 120)}\n`);
      return res.status(500).json({ error: 'run_observability_failed', message: 'The run record could not be built.' });
    }
  }));
  // Reset clears this workspace's bands (back to defaults), receipts, challenges and runs.
  api.post('/reset', withWorkspace((ws, _req, res) => {
    workspaces.resetWorkspace(ws);
    for (let i = challenges.length - 1; i >= 0; i--) if (challenges[i].workspace === ws) challenges.splice(i, 1);
    res.json({ reset: 'ok', workspace: ws });
  }));
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);
  // Errors become short JSON. Express's default handler would send an HTML stack trace with absolute file paths.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode);
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
    return res.status(500).json({ error: 'internal_error' });
  });

  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }
  return app;
}

export function startHttpServer({ port, host, app = createApp() } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.once('error', reject);
  });
}

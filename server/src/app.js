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
import { loadCast, verticalFrom, VERTICALS } from './cast.js';
import { hostedFrom, modeFrom, realAvailableFrom } from './config.js';
import { buildStory } from './story.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import {
  DEFAULT_BANDS, PolicyInputError, classifyObligations, createCibaStore, createReceiptStore,
  evaluateAmountPolicy, normalizeBands, LIMITS,
} from './policy.js';
import { buildHops, newTrace } from './trace.js';
import { createWorkspaces, workspaceFrom } from './workspaces.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');

const DEMO_OTP = '123123'; // labelled demo bypass (AI-DEMO2 routes/mfa.js)

export function createApp({
  health = createHealth(), configFile = CONFIG, hosted = false,
  workspaces = createWorkspaces({ bands: DEFAULT_BANDS }),
  challenges = [],
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use('/health', health.router);
  const castFor = (req) => loadCast(configFile, verticalFrom(req.query.vertical));
  // customer.config.json is read on every request so editing it shows up on reload.
  api.get('/scenarios', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ...buildStory(castFor(req), { hosted }), verticals: Object.keys(VERTICALS), hosted }); });
  api.get('/diagram', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(buildDiagram(castFor(req), DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0])); });
  // What this build is, for the banner and for verifying a deploy by content (not by a 200).
  api.get('/info', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ mode: modeFrom(), source: modeFrom(), simulated: true, hosted, realAvailable: realAvailableFrom() }); });
  // Rule 19: the Mock/Real toggle. Exactly { source: "mock"|"real" }; 409 when Real is not configured.
  api.post('/mode', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !['mock', 'real'].includes(body.source)) {
      return res.status(400).json({ error: 'bad_source', detail: 'body must be exactly { source: "mock" | "real" }' });
    }
    if (body.source === 'real' && !realAvailableFrom()) {
      return res.status(409).json({ error: 'real_not_configured', detail: 'Real mode needs a live policy engine configuration (HMLAB_REAL_* env, owner-run). Mock keeps working.' });
    }
    return res.json({ source: body.source });
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
    const declaredStepUp = body.step_up_method === 'ciba' || body.step_up_method === 'p1mfa' ? body.step_up_method : null;
    const v = workspaces.state(ws);
    const bands = v.bands || DEFAULT_BANDS;

    const result = evaluateAmountPolicy({ amount, bands, declaredStepUp });
    const obligation = result.obligation;
    const flags = obligation ? classifyObligations([obligation]) : { stepUpRequired: false, consentRequired: false, hitlRequired: false, classified: { stepUp: [], hitl: [], consent: [] } };

    let receipt = null;
    let block = null;
    let decision = result.decision;
    if (result.decision === 'PERMIT' || result.decision === 'DENY') {
      // No receipt needed (or none can help).
    } else if (flags.stepUpRequired) {
      const kind = declaredStepUp === 'ciba' ? 'ciba' : 'stepUp';
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
        block = { status: 428, error: 'mcp_hitl_required', detail: 'HITL consent: the transfer runs only after an explicit human approval.' };
      }
    }

    workspaces.record(ws, { tool, amount, decision, reason: result.reason, receipt, blocked: block ? block.error : null });
    const trace = newTrace(req.headers.traceparent);
    const hops = buildHops({ trace, cast: castFor(req), decision, obligation, reason: result.reason, tool, amount, step_up_method: declaredStepUp || obligation?.step_up_method, receipt, ciba: null });
    res.set('traceparent', hops[0].traceparent);
    if (block) {
      return res.status(block.status).json({
        decision, reason: result.reason, tool, amount,
        error: block.error, detail: block.detail, ...(block.step_up_method ? { step_up_method: block.step_up_method } : {}),
        bands, workspace: ws, traceId: trace.traceId, hops,
      });
    }
    return res.status(decision === 'DENY' ? 403 : 200).json({
      decision, reason: result.reason, tool, amount,
      ...(receipt ? { receipt, receiptKind: declaredStepUp === 'ciba' ? 'ciba' : flags.stepUpRequired ? 'stepUp' : 'hitl' } : {}),
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
    return res.json({ challenge: { id: challenge.id, method: challenge.method, status: challenge.status, devices: [{ id: 'dev-1', type: 'OTP', label: 'Demo device (OTP)' }] }, workspace: ws });
  }));
  api.post('/mfa/verify', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (typeof body.challengeId !== 'string' || !body.challengeId) return res.status(400).json({ error: 'challenge_required' });
    if (typeof body.otp !== 'string' || !body.otp) return res.status(400).json({ error: 'otp_required', detail: 'body.otp must be the demo code (123123)' });
    const challenge = challenges.find((c) => c.id === body.challengeId.slice(0, 64));
    if (!challenge || challenge.workspace !== ws || challenge.status !== 'pending') return res.status(404).json({ error: 'not_found' });
    if (body.otp.trim() !== DEMO_OTP) return res.status(401).json({ error: 'bad_otp', detail: 'wrong code — the demo OTP is 123123' });
    challenge.status = 'verified';
    const v = workspaces.state(ws);
    const receipt = v.receipts.mint({ kind: 'stepUp', amount: challenge.amount, tool: challenge.tool, taskId: challenge.id });
    return res.json({ challenge: { id: challenge.id, status: 'verified' }, receipt: { id: receipt.id, ttlMs: v.receipts.ttlMs, kind: receipt.kind }, workspace: ws });
  }));

  // CIBA (UC22): bc-authorize mints the auth_req_id; the user approves/denies out-of-band in the
  // phone panel; the agent polls. Approval mints the amount-bound HITL receipt.
  api.post('/ciba/bc-authorize', withWorkspace((ws, req, res) => {
    const body = req.body || {};
    const amount = typeof body.amount === 'number' && Number.isFinite(body.amount) && body.amount >= 0 && body.amount <= LIMITS.amount ? body.amount : null;
    if (amount === null) return res.status(400).json({ error: 'amount_required', detail: 'body.amount must be a number within range — the approval receipt is amount-bound' });
    const v = workspaces.state(ws);
    const r = v.ciba.bcAuthorize({ bindingMessage: typeof body.bindingMessage === 'string' ? body.bindingMessage : `Approve $${amount ?? ''} transfer`.trim(), amount, tool: 'create_transfer' });
    return res.json({ ...r, workspace: ws });
  }));
  api.get('/ciba/poll/:authReqId', withWorkspace((ws, req, res) => {
    const v = workspaces.state(ws);
    const r = v.ciba.poll(req.params.authReqId, { receiptStore: v.receipts });
    return res.json({ ...r, workspace: ws });
  }));
  api.post('/ciba/respond', withWorkspace((ws, req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'bad_request' });
    if (typeof body.authReqId !== 'string' || !body.authReqId) return res.status(400).json({ error: 'auth_req_id_required' });
    if (body.decision !== 'approved' && body.decision !== 'denied') return res.status(400).json({ error: 'bad_decision', detail: "decision must be 'approved' or 'denied'" });
    const v = workspaces.state(ws);
    const r = body.decision === 'approved' ? v.ciba.approve(body.authReqId, { receiptStore: v.receipts }) : v.ciba.deny(body.authReqId);
    return res.json({ ...r, workspace: ws });
  }));
  api.get('/ciba/pending', withWorkspace((ws, _req, res) => {
    const v = workspaces.state(ws);
    res.json({ pending: v.ciba.all().filter((r) => r.status === 'pending'), workspace: ws });
  }));

  api.get('/runs', withWorkspace((ws, _req, res) => res.json(workspaces.runs(ws))));
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

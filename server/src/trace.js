// Rule 14: W3C Trace Context on every (mock) hop. One trace id per gate decision, a new span id per hop. A valid incoming
// `traceparent` header continues its trace; anything else starts a new one. Nothing is sent anywhere: these are the raw
// request/response panes the UI shows. Values are random, mock, and carry no meaning outside this app.
import { randomBytes } from 'node:crypto';

const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO32 = '0'.repeat(32);
const ZERO16 = '0'.repeat(16);

export function parseTraceparent(v) {
  if (typeof v !== 'string' || v.length !== 55) return null;
  const m = TP.exec(v);
  // all-ones flags are forbidden by the W3C spec
  return m && m[1] !== ZERO32 && m[2] !== ZERO16 && m[3] !== 'ff' ? { traceId: m[1], parentId: m[2], flags: m[3] } : null;
}
export const formatTraceparent = (traceId, spanId, flags = '01') => `00-${traceId}-${spanId}-${flags}`;

export function newTrace(incoming, rand = randomBytes) {
  const p = parseTraceparent(incoming);
  const span = () => rand(8).toString('hex').replace(/^0{16}$/, '0000000000000001');
  return { traceId: p ? p.traceId : rand(16).toString('hex').replace(/^0{32}$/, `${'0'.repeat(31)}1`), parentId: p ? p.parentId : null, span };
}

// One held call on the Privilege gateway (shape from the owner's 2026-11-17 recording): 403, JSON-RPC -32600, pending_approval.
function heldHop(n, req, privilege, traceparent, amount) {
  const id = req?.id || '<instruction_id>';
  return {
    n, from: 'policy', to: 'approver', label: 'HELD: the Privilege gateway queues a human-approval request', traceparent,
    request: `policy ${privilege?.policyId || ''}: Require human approval (mock)\ntraceparent: ${traceparent}\naction: mcp:InvokeUnattended\n${amount ? `amount: ${amount}` : ''}`,
    response: `HTTP 403 pending_approval (JSON-RPC -32600)\ninstruction_id: ${id}\nreason: ${privilege?.reason || ''}\nretry_header: ${privilege?.header || ''}\nexpires_at: ${req?.expiresAt || ''}`,
  };
}

// The mock hops of one gated transfer, with the raw request and response text of each.
// Hops differ by decision: PERMIT goes straight through; HITL/STEP_UP/CIBA add the human beat.
export function buildHops({ trace, cast, decision, obligation, reason, tool, amount, step_up_method, receipt, ciba, privilege = null }) {
  const host = `gateway.${cast.castHost}.example`;
  const span = () => trace.span();
  const tp = (id) => formatTraceparent(trace.traceId, id);
  const ids = [span(), span(), span(), span(), span()];
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { amount } } });
  const gateStatus = decision === 'PERMIT' ? '200 (policy permits)' : decision === 'DENY' ? '403 Forbidden' : privilege?.held ? '403 Forbidden (pending_approval)' : '428 Precondition Required';
  const hops = [
    { n: 1, from: 'agent', to: 'policy', label: 'Agent attempts the transfer', traceparent: tp(ids[0]),
      request: `POST https://${host}/mcp/tool\nAuthorization: Bearer <MOCK token>\ntraceparent: ${tp(ids[0])}\ncontent-type: application/json\n\n${body}`,
      response: `HTTP/1.1 ${gateStatus}\ntraceparent: ${tp(ids[0])}` },
    { n: 2, from: 'policy', to: 'policy', label: 'Gate evaluates the amount bands + agent context', traceparent: tp(ids[1]),
      request: `evaluateAmountPolicy(amount: ${amount}, declaredStepUp: ${step_up_method || 'null'})\ntraceparent: ${tp(ids[1])}`,
      response: `decision: ${decision}\nobligation: ${obligation ? obligation.type : '(none)'}\nreason: ${reason}` },
  ];
  if (decision === 'HITL') {
    hops.push(
      { n: 3, from: 'policy', to: 'human', label: 'HITL_CONSENT: the agent must pause for a human', traceparent: tp(ids[2]),
        request: `consent challenge (mock)\ntraceparent: ${tp(ids[2])}\n${amount ? `amount: ${amount}` : ''}`,
        response: `HTTP 428 mcp_hitl_required\n${receipt ? `receipt: ${receipt} (single-use, amount-bound)` : 'challenge id issued'}` },
    );
  } else if (decision === 'STEP_UP' && step_up_method === 'privilege') {
    hops.push(heldHop(3, privilege?.held, privilege, tp(ids[2]), amount));
  } else if (decision === 'PERMIT' && privilege?.approval) {
    // The retry that succeeded: the whole path, so the flow shows the hold, the PingID confirmation and the retry.
    hops.push(
      heldHop(3, privilege.approval, privilege, tp(ids[2]), amount),
      { n: 4, from: 'approver', to: 'pingid', label: 'PingID confirms the approver', traceparent: tp(ids[3]),
        request: `PingID ${privilege.approval.method} (mock)\ntraceparent: ${tp(ids[3])}\n${privilege.approval.method === 'push' ? 'prompt: Are you trying to sign on?' : 'passcode entered (demo passcode)'}`,
        response: `approver confirmed (mock)\nrequest ${privilege.approval.id}: approved` },
    );
  } else if (decision === 'STEP_UP' && step_up_method === 'ciba') {
    hops.push(
      { n: 3, from: 'policy', to: 'idp', label: 'CIBA: bc-authorize mints the auth_req_id', traceparent: tp(ids[2]),
        request: `POST /bc-authorize\ntraceparent: ${tp(ids[2])}\nbinding_message: ${ciba?.bindingMessage || 'Approve'}\nscope: openid create_transfer`,
        response: `{ auth_req_id: ${ciba?.authReqId || '<auth_req_id>'}, expires_in: ${ciba?.expiresIn || 300}, interval: ${ciba?.interval || 2} }` },
      { n: 4, from: 'idp', to: 'human', label: 'Out-of-band approval on the user\'s own device', traceparent: tp(ids[3]),
        request: `push/email challenge (mock)\ntraceparent: ${tp(ids[3])}`,
        response: `binding_message: ${ciba?.bindingMessage || 'Approve'}\nstatus: ${ciba?.status || 'pending'}` },
      { n: 5, from: 'agent', to: 'idp', label: 'Agent polls for the decision', traceparent: tp(ids[4]),
        request: `GET /bc-authorize/poll/${ciba?.authReqId || '<auth_req_id>'}\ntraceparent: ${tp(ids[4])}`,
        response: `status: ${ciba?.status || 'pending'}${ciba?.receiptId ? `\nreceipt: ${ciba.receiptId} (amount-bound to ${amount})` : ''}` },
    );
  } else if (decision === 'STEP_UP') {
    hops.push(
      { n: 3, from: 'policy', to: 'human', label: 'STEP_UP: device MFA before the call runs', traceparent: tp(ids[2]),
        request: `step-up challenge (mock, method: p1mfa)\ntraceparent: ${tp(ids[2])}\ndemo OTP: 123123 (labelled demo bypass)`,
        response: `HTTP 428 mcp_step_up_required\nstep_up_method: p1mfa\n${receipt ? `credit: ${receipt} (TTL 5 min)` : 'challenge issued'}` },
    );
  } else if (decision === 'DENY') {
    hops.push(
      { n: 3, from: 'policy', to: 'agent', label: 'DENY outranks every obligation', traceparent: tp(ids[2]),
        request: `GATE-RESULT (mock)\ntraceparent: ${tp(ids[2])}`,
        response: `decision: DENY\n${reason}\nno receipt, no MFA, no approval can clear it` },
    );
  }
  if (decision !== 'DENY' && receipt) {
    hops.push(
      { n: hops.length + 1, from: 'policy', to: 'transfer', label: 'Receipt presented: the transfer executes', traceparent: tp(ids[4] || ids[3]),
        request: privilege?.approval ? `retry with ${privilege.header}: ${receipt}\ntraceparent: ${tp(ids[4] || ids[3])}` : `retry with receipt ${receipt}\ntraceparent: ${tp(ids[4] || ids[3])}`,
        response: `HTTP 200\n${amount ? `transfer of ${amount} executes` : 'the tool call proceeds'}` },
    );
  }
  return hops;
}

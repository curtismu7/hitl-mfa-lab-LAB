// Builds content-pack.json for the Learning Hub from the story data, so the pack cannot drift from the lab.
//   node scripts/build-content-pack.mjs        (writes content-pack.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CAST } from '../server/src/cast.js';
import { buildStory } from '../server/src/story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export function buildPack() {
  const story = buildStory(DEFAULT_CAST);
  const sid = (n) => `S${String(n).padStart(2, '0')}`;
  const terms = { 'consent-hitl': ['hitl'], 'mfa-step-up': ['mfa'], 'ciba-150': ['ciba'], 'deny-ceiling': ['deny'], 'receipt-replay': ['receipts'], 'receipt-amount-bound': ['receipts'] };
  return {
    schema: 'demo-content-pack/1',
    id: 'hitl-mfa-lab',
    title: 'HITL MFA Lab',
    version,
    demo: { id: 'hitl-mfa-lab', name: 'HITL MFA Lab', catalog: 'D999', baseUrl: 'http://localhost:7680', doctor: '/api/health', tags: ['hitl', 'mfa', 'ciba', 'authorize', 'policy', 'mock-only'] },
    glossary: [
      { id: 'hitl', term: 'HITL (human-in-the-loop) consent', definition: 'The policy can require explicit human approval before an agent action runs: the agent pauses, the human decides, and only a verified approval receipt lets the retried call through. The receipt is single-use and amount-bound.', aliases: ['human approval', 'consent gate'] },
      { id: 'mfa', term: 'MFA step-up', definition: 'At or above the MFA band the policy returns a STEP_UP obligation: the human must complete device MFA (demo OTP 123123) before the action runs. Step-up outranks the consent gate — highest gate wins.', aliases: ['step-up', 'step-up MFA'] },
      { id: 'ciba', term: 'CIBA (out-of-band approval)', definition: 'Client-Initiated Backchannel Authentication: for a sensitive agent-initiated action the policy requests approval on the user\'s own device (bc-authorize, then poll) — triggered by the agent context, NOT by amount. A compromised browser or rogue agent cannot self-approve.', aliases: ['out-of-band', 'decoupled approval'] },
      { id: 'deny', term: 'Hard DENY', definition: 'Above the ceiling the policy denies outright. DENY outranks every obligation — no receipt, no MFA, no approval can clear it.', aliases: ['hard limit', 'ceiling'] },
      { id: 'receipts', term: 'Approval receipts', definition: 'Approvals are receipts, not vibes: single-use (consume-on-use, so a replay re-challenges), amount-bound (approving $300 cannot discharge $600), and the MFA credit expires after five minutes.', aliases: ['single-use credit'] },
    ],
    sources: [
      { id: 'mcp-tools', title: 'Model Context Protocol: tools/call', url: 'https://modelcontextprotocol.io/docs/concepts/tools', kind: 'standard', use: 'The JSON-RPC tool-call shape the gateway scopes.', status: 'not-read', checked: '2026-11-06' },
    ],
    cards: [
      ...story.scenarios.map((sc, i) => ({ id: `try-${sc.id}`, label: `Scenario ${i + 1}: ${sc.title}`, description: sc.lesson, group: 'try-it', action: { type: 'route', href: `/#scenario-${sc.id}` }, terms: terms[sc.id], story: sid(i + 1) })),
      { id: 'concept-editor', label: 'Reconfigure the policy live', description: 'Switch the allowed state, add a blocked city, or turn the capability off; the SAME call flips on the next run.', group: 'concept', action: { type: 'route', href: '/#policy' } },
      { id: 'ref-doctor', label: 'Doctor and health', description: 'Preflight checks and the demo-health/1 endpoint.', group: 'setup', action: { type: 'route', href: '/api/health' } },
    ],
    stories: story.scenarios.map((sc, i) => ({ id: sid(i + 1), title: sc.title, say: sc.lesson })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'content-pack.json'), `${JSON.stringify(buildPack(), null, 2)}\n`);
}

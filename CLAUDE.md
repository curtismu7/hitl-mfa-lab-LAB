# hitl-mfa-lab

Demo-tier standalone app: an unmodified third-party weather MCP server is scoped at a mock agent gateway — the gateway enforces a live, admin-editable state-scope policy (one US state by default, "any", or "any-except-blocked") entirely at the edge; a denied call never reaches the backend. Name AND coordinate checks, exact matching, fail-narrow. Standalone mock of the AI-DEMO2 weather-mcp showcase (UC30/UC31/UC32, the `tx-weather-scope` gateway policy).

- Run: `./scripts/run.sh` (http://localhost:7680). Test: `npm test` (server is `node --test test/*.test.js`, a glob). Preflight: `npm run doctor`. Reset: `npm run reset`.
- Core: `server/src/gateway.js` (pure `normalizePolicy`, `evaluateWeatherScope`, `geocodeCity`), `server/src/weatherServer.js` (the policy-blind third-party tool). Story data `server/src/gatewayData.js` with `{{castBrand}}`-style tokens filled by `cast.js` (3 vertical packs); a test fails on an undefined token. Diagram: `server/diagrams/gateway-scope-flow.json` (diagram-studio/1).
- API: `GET/POST /api/policy`, `POST /api/weather/tool` (200 forwarded / 403 denied at the edge), `GET /api/runs`, `POST /api/reset`, `GET /api/info`, `POST /api/mode` (rule 19; 409 when Real unconfigured), `GET /api/health` (demo-health/1). Workspace id in `X-Workspace`.
- Rules that bite: loopback bind only; same-origin writes; zero outbound network (netguard); only `.example`/`.invalid` hosts; no `crypto.generateKeyPairSync('ec')`; ports 7680-7689; denial reasons and mock weather answers shown raw; an unknown policy value falls back to the NARROWEST state, never wider — keep it that way.
- Web: `web/src/App.jsx` (tabs, presenter, Reset, X-Workspace via `workspace.js`), `components/PolicyGate` (policy editor, tool call with the coordinate shape, verdict + hops), `DiagramTab` + `PatternDiagram` (from the scaffold). Colours come from `tokens.css` only. Test: `npm test -w web` (vitest + RTL, mocked fetch).
- Trace: `server/src/trace.js` builds W3C traceparent for every mock hop in `/api/weather/tool` (5 hops: agent → gateway → policy → scope check → backend).
- Attribution: scaffold copied from agent-preferences-lab; see README. No cross-repo imports.

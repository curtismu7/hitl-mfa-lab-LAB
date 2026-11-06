# HITL MFA Lab

**Tier: Demo.** A third-party weather MCP server is scoped at an agent gateway: the gateway enforces a live, admin-editable state-scope policy entirely at the edge — the backend never sees the restriction and has no concept of it. This is the standalone mock of the AI-DEMO2 weather-mcp showcase (UC30 / UC31 / UC32 and the `tx-weather-scope` gateway policy) — same decision contract, no real gateway or tenant.

1. **The third-party tool.** An unmodified, policy-blind weather MCP server. Remove the gateway and every city on earth works — governance must live at the edge, because you cannot always change the tool.
2. **The scope policy.** The gateway allows one configurable US state at a time (Texas by default), or everything (`any`), or everything except an admin-managed blocked-city list. It checks the city NAME and the COORDINATES (the agent geocodes first), exactly, with no substring matching: "Plano, IL" is not Plano, TX, and "Miami, OH" is not Miami, FL.
3. **Live reconfigure.** The allowed state is admin-editable and read on EVERY request: switch Texas to Any and the exact same Miami query flips from denied to permitted — no restart, no code change. Reset restores Texas so the next pass starts from the documented policy.

Mock + Real (rule 19): Mock is fully offline (mock gateway, mock policy store, mock weather server). Real toggle mechanics follow rule 19: unconfigured, it is disabled with a how-to tooltip and `POST /api/mode` answers 409. In this build Real is RESERVED — the toggle reports a configured `HMLAB_REAL_*` env, but no live-gateway data path is wired yet; Mock is the story.

Every host ends in `.example`, and the app makes no outbound network request (a netguard blocks them and tests prove it). It needs no tenant and no credentials. Denial reasons are shown raw, so a visitor sees exactly which policy line decided.

**Status: built.** Tabs: Gateway scope (scenario walkthrough, live policy editor, tool-call panel with the coordinate shape), Diagram (ReactFlow from `/api/diagram`: movable boxes, Simulate, speed, Reset), Talk track. Presenter mode (`P`, `Esc` leaves) keeps the simulation banner.

## Run

```
./scripts/run.sh          # installs, builds, runs the doctor, starts; open http://localhost:7680/
```

or `npm ci && npm run doctor && npm start`. With Docker (OrbStack): `HOST_PORT=7680 docker compose up --build -d` (published on `127.0.0.1` only). Through the family lab proxy: `https://local.ping-devops.com:8443/hitl-mfa-lab/` (once the route is added).

| Command | What it does |
| --- | --- |
| `npm test` | server (node:test), web (vitest) and repo checks |
| `npm run doctor` | preflight: node, mode, bind, port, scenarios, labels, tokens, hosts, keys, diagrams, netguard, port free |
| `npm run content-pack` | rebuilds and validates `content-pack.json` |
| `npm run reset` | resets the default workspace's policy and runs on a running server |

Port range 7680-7689 (default 7680). `GET /api/health` answers `demo-health/1`.

## API

- `GET /api/scenarios` — the story: title, intro, banner, tools, six scenarios, facts (measured / inferred / UNVERIFIED), talk track.
- `GET/POST /api/policy` — read / set this workspace's gateway policy (normalized; an unknown allowedState falls back to the NARROWEST state, never wider; blocked cities are geocoded once at add time and unknown cities are refused).
- `POST /api/weather/tool` — the gateway. Body `{ tool, arguments? }`. `200` forwarded (the mock third-party server answers), `403` denied before the backend ever runs. Raw mock hops with W3C `traceparent`.
- `GET /api/runs`, `POST /api/reset` — per-workspace history and reset.
- `GET /api/diagram`, `GET /api/info`, `GET /api/health` — diagram-studio/1 data, build info (rule 19 fields), `demo-health/1`.
- `POST /api/mode` — the Mock/Real toggle, body exactly `{ source: "mock" | "real" }`; 409 when Real is unconfigured.

Workspace id goes in `X-Workspace` (one visitor's state never touches another's).

## What is real, and what is not

- Real (shape and contract): the scope decision logic (name + coordinate checks, exact matching, the bounding boxes, the blocked-city radius), the fail-narrow default, the live per-request policy read, the capability kill switch. All mirror the AI-DEMO2 gateway script (`tx-weather-scope`) and weather-mcp page.
- Mock: the gateway (no PingGateway), the policy store (workspace state, not a feature-flag service), the weather server (fixture data, no Nominatim geocoding — a fixed demo-city table stands in), the tokens.
- UNVERIFIED: none of the product release claims are made here; the lab proves the DECISION contract only.

## Attribution

Scaffold copied from `agent-preferences-lab` (itself from the gateway-claims-lab scaffold); server, web, scripts and safety infrastructure are that scaffold's, rebranded. The domain content (gateway scope engine, third-party weather server, policy editor, scenarios) is new, derived from the AI-DEMO2 weather-mcp use cases UC30/UC31/UC32. No code was imported across repos.

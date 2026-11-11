// Opened from Customer Agent LAB: the strip and the header button show, the mapped scenario and vertical are preselected.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { scenarioFor, verticalFor, UC_SCENARIO } from "./handoffMap";
import { returnLinkFor } from "./return-link/returnTargets.js";
import { SCENARIOS } from "../../server/src/policyData.js";
import { VERTICALS } from "../../server/src/cast.js";

const calls = [];
vi.mock("./api", () => ({
  getJson: vi.fn(async (url) => { calls.push(url); return url.startsWith("/api/info") ? { mode: "mock", realAvailable: false, hosted: false } : { banner: "SIMULATED", intro: "i", verticals: ["retail", "health", "finance"], scenarios: [], talkTrack: [] }; }),
  resetWorkspace: vi.fn(), setMode: vi.fn(),
}));
vi.mock("./components/PolicyGate", () => ({ default: ({ requestedId }) => <p data-testid="pg">{String(requestedId)}</p> }));
vi.mock("./components/DiagramTab", () => ({ default: () => null }));
vi.mock("./components/ShelfLink", () => ({ default: () => null }));
import App from "./App";

const NOTE = { name: "Opened from Customer Agent LAB" };
afterEach(() => { cleanup(); calls.length = 0; window.history.replaceState(null, "", "/"); });

describe("hand-off from Customer Agent LAB", () => {
  it("the vendored files match return-link.sha256, which names the parent commit", () => {
    const dir = path.join(process.cwd(), "src", "return-link");
    const text = fs.readFileSync(path.join(dir, "return-link.sha256"), "utf8");
    expect(text.split("\n")[0]).toMatch(/^# vendored byte for byte from curtismu7\/AI-DEMO-Standalone shared\/return-link at [0-9a-f]{7,40}/);
    const pins = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/));
    expect(pins.map(([, f]) => f).sort()).toEqual(["ReturnLink.jsx", "ReturnLink.test.jsx", "returnTargets.js"]);
    for (const [h, f] of pins) expect(createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex"), f).toBe(h);
  });

  it("every mapped use case names a real scenario, every mapped vertical a real vertical", () => {
    const ids = SCENARIOS.map((s) => s.id);
    for (const s of Object.values(UC_SCENARIO)) expect(ids).toContain(s);
    expect(SCENARIOS.find((x) => x.id === UC_SCENARIO.UC7).title).toMatch(/MFA/);
    expect(SCENARIOS.find((x) => x.id === UC_SCENARIO.UC8).title).toMatch(/consent/);
    expect(SCENARIOS.find((x) => x.id === UC_SCENARIO.UC22).title).toMatch(/CIBA/);
    for (const v of ["banking", "healthcare", "retail"]) expect(Object.keys(VERTICALS)).toContain(verticalFor({ vertical: v }));
    expect(scenarioFor({ uc: "UC27" })).toBeNull();
    expect(scenarioFor({ uc: "toString" })).toBeNull();
    expect(verticalFor({ vertical: "constructor" })).toBeNull();
  });

  it("UC22 in banking: banner first, strip right below, header Back; ciba-150 and finance are preselected", async () => {
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC22&vertical=banking");
    render(<App />);
    const note = screen.getByRole("note", NOTE);
    expect(note.textContent).toContain("UC22");
    expect(screen.getByTestId("banner").nextElementSibling).toBe(note);
    expect(document.querySelector(".head__tools .top-menu button.return-link--header")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: /Back to Customer Agent LAB/ })).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId("pg").textContent).toBe("ciba-150"));
    expect(calls).toContain("/api/scenarios?vertical=finance");
  });

  it("an unmapped use case: strip only, defaults kept", async () => {
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC27&vertical=airlines");
    render(<App />);
    expect(screen.getByRole("note", NOTE)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("pg").textContent).toBe("null"));
    expect(calls.filter((u) => u.startsWith("/api/scenarios")).every((u) => u.endsWith("retail"))).toBe(true);
  });

  it("no from, an unknown from or a bad id: no strip, no button, defaults", async () => {
    for (const q of ["/", "/?from=elsewhere&uc=UC7", "/?from=customer-agent&uc=%3Cb%3E", "/?from=customer-agent&uc=UC7&vertical=a%20b"]) {
      window.history.replaceState(null, "", q);
      render(<App />);
      expect(screen.queryByRole("button", { name: /Back to/ })).toBeNull();
      expect(screen.queryByRole("note")).toBeNull();
      await waitFor(() => expect(screen.getByTestId("pg").textContent).toBe("null"));
      cleanup();
    }
  });

  it("Back goes to the proxy path behind the lab proxy, to the direct URL on the app's own port", () => {
    window.history.replaceState(null, "", "/hitl-mfa-lab/?from=customer-agent&uc=UC8");
    expect(returnLinkFor("hitl-mfa-lab").href).toBe("/customer-agent/?returned=hitl-mfa-lab&uc=UC8");
    window.history.replaceState(null, "", "/?from=customer-agent&uc=UC8");
    expect(returnLinkFor("hitl-mfa-lab").href).toBe("http://127.0.0.1:5603/?returned=hitl-mfa-lab&uc=UC8");
  });
});

  it("?from=ai-demo-standalone: strip names AI Demo Standalone, Back goes to its proxy path", () => {
    window.history.replaceState(null, "", "/hitl-mfa-lab/?from=ai-demo-standalone&uc=UC12");
    const ctx = returnLinkFor("hitl-mfa-lab");
    expect(ctx.label).toBe("AI Demo Standalone");
    expect(ctx.uc).toBe("UC12");
    expect(ctx.href).toBe("/ai-demo-standalone/?returned=hitl-mfa-lab&uc=UC12");
    window.history.replaceState(null, "", "/?from=ai-demo-standalone&uc=UC12");
    expect(returnLinkFor("hitl-mfa-lab").href).toBe("http://127.0.0.1:7810/?returned=hitl-mfa-lab&uc=UC12");
  });

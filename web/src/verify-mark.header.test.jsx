// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy
// that call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

vi.mock("./api", () => ({
  getJson: vi.fn(async (url) => (url.startsWith("/api/info") ? { mode: "mock", realAvailable: false, hosted: false } : { banner: "SIMULATED", intro: "i", verticals: ["retail"], scenarios: [], talkTrack: [] })),
  resetWorkspace: vi.fn(), setMode: vi.fn(),
}));
vi.mock("./components/PolicyGate", () => ({ default: () => null }));
vi.mock("./components/DiagramTab", () => ({ default: () => null }));
import App from "./App";

const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
const real = globalThis.fetch;
function withShelf(payload) {
  globalThis.fetch = vi.fn(async (url) => (url === "/api/shelf" ? { ok: true, status: 200, json: async () => payload } : { ok: false, status: 404, json: async () => ({}) }));
}
afterEach(() => { cleanup(); globalThis.fetch = real; });

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    withShelf({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "hitl-mfa-lab", verification: mark("verified", "Verified", { note: "Every gate run on the mock" }) }] });
    render(<App />);
    await screen.findByRole("navigation", { name: "Lab sections" });
    const bar = within(screen.getByTestId("top-menu"));
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify")).toHaveLength(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every gate run on the mock"));
  });

  it("shows nothing when the lab is opened on its own port (no demos), the shelf has no mark for it, or the mark is none", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "hitl-mfa-lab", verification: null }] }, { shelfUrl: "http://shelf.example", demos: [{ id: "hitl-mfa-lab", verification: mark("none", "None") }] }]) {
      withShelf(payload);
      const { unmount } = render(<App />);
      await screen.findByRole("navigation", { name: "Lab sections" });
      const bar = within(screen.getByTestId("top-menu"));
      expect(await bar.findByRole("link", { name: "Shelf" })).toBeInTheDocument(); // the shelf answered, and still no badge
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });

  it("App.jsx renders exactly one VerifyMark for the shelf id inside TopMenu (removing the line fails this and the first test)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src", "App.jsx"), "utf8");
    expect(src.match(/<VerifyMark id="hitl-mfa-lab" \/>/g)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(process.cwd(), "..", "docs", "shelf-entry.json"), "utf8")).demos[0].id).toBe("hitl-mfa-lab");
  });
});

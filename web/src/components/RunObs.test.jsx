// Rule 27 on this lab's page: the shared panel under the Gate result. Mock rows are simulated, Real rows are replies the lab received; the lab reads no logs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import RunObs, { RUN_OBS_STREAMS } from "./RunObs";
import { setJsonView } from "./JsonPane.jsx";
import { workspaceFetch } from "../workspace";
import { getRunObservability } from "../api";
import { mockRecord } from "../run-observability/fixtures";

vi.mock("../api", () => ({ getRunObservability: vi.fn() }));

const REAL_RECORD = {
  runId: "run-real-1", window: { from: "2026-11-22T10:00:00.000Z", to: "2026-11-22T10:00:03.000Z" }, source: "real", excerpt: true, truncated: false,
  rows: [
    { id: "r1", at: "2026-11-22T10:00:01.000Z", atExact: "2026-11-22T10:00:01.000Z", layer: "gateway", product: "Privilege gateway reply", outcome: "info", message: "The gateway held the tools/call for human approval: HTTP 403 pending_approval. A hold, not a refusal. This is the reply the lab received, not a log line.", origin: "response" },
    { id: "n-person", at: null, layer: "person", product: "none", outcome: "info", message: "The lab never calls PingID or PingOne.", origin: "not-logged" },
  ],
  coverage: { person: "not-logged", agent: "not-logged", authorize: "not-logged", privilege: "not-logged", gateway: "response", resource: "not-logged" },
  reasons: { person: "The lab never calls PingID or PingOne.", agent: "x", authorize: "y", privilege: "z", resource: "w" },
  partial: {}, summary: { allowed: 0, refused: 0, blocked: 0, info: 1, unverified: 0 },
};
const MOCK_RECORD = { ...mockRecord, runId: "run-mock-1" };
const step = () => act(async () => { window.dispatchEvent(new Event("hmlab-step")); });

beforeEach(() => { vi.clearAllMocks(); setJsonView("form"); });
afterEach(() => cleanup());

describe("RunObs", () => {
  it("before a run: the panel's empty state, and the server is not asked", () => {
    render(<RunObs mode="mock" hasRun={false} gen={0} />);
    expect(screen.getByTestId("ro-empty")).toBeTruthy();
    expect(getRunObservability).not.toHaveBeenCalled();
  });

  it("while the answer is pending it says so (never the empty state), then shows the Mock record: every row simulated, nothing tagged logged, where the lab's lines live", async () => {
    let release;
    getRunObservability.mockReturnValue(new Promise((r) => { release = r; }));
    render(<RunObs mode="mock" hasRun gen={1} />);
    expect(screen.getByTestId("ro-loading").textContent).toMatch(/Collecting this run's logs/);
    expect(screen.queryByTestId("ro-empty")).toBeNull();
    release(MOCK_RECORD);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    expect(screen.getByTestId("ro-basis").textContent).toMatch(/^Simulated/);
    expect(document.querySelector('tr[data-origin="logged"]')).toBeNull();
    expect(document.querySelectorAll('[data-origin="simulated"].ro-chip').length).toBeGreaterThan(1);
    expect(screen.getByTestId("ro-streams").textContent).toMatch(/HITL MFA Lab server/);
    expect(RUN_OBS_STREAMS.length).toBe(3);
    expect(screen.getByTestId("ro-lab-note").textContent).toMatch(/mock of PingOne Authorize/);
  });

  it("Real: the response rows are tagged response (never logged), and the note says the lab reads no logs, never calls PingID and has nothing to re-read", async () => {
    getRunObservability.mockResolvedValue(REAL_RECORD);
    render(<RunObs mode="real" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    expect(document.querySelector('tr[data-origin="response"]')).toBeTruthy();
    expect(document.querySelector('tr[data-origin="logged"]')).toBeNull();
    expect(screen.getByTestId("ro-lab-note").textContent).toMatch(/reads no product logs, so there is nothing to re-read/);
    expect(screen.getByTestId("ro-lab-note").textContent).toMatch(/never calls PingID/);
    expect(screen.queryByText(/Re-read logs/)).toBeNull();
  });

  it("a record the server built in the other mode is refused on screen, not shown under this label", async () => {
    getRunObservability.mockResolvedValue(REAL_RECORD);
    render(<RunObs mode="mock" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-mismatch")).toBeTruthy());
    expect(screen.queryByTestId("ro-table")).toBeNull();
  });

  it("a run the server has no record for says so (not the empty state), a structured error and a network failure are alerts, never blank", async () => {
    getRunObservability.mockResolvedValue({ record: null, message: "No Mock run yet in this workspace: run a scenario." });
    const a = render(<RunObs mode="mock" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-none").textContent).toMatch(/No Mock run yet/));
    a.unmount();
    getRunObservability.mockResolvedValue({ error: "run_observability_failed", message: "The run record could not be built." });
    const b = render(<RunObs mode="mock" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/could not be built/));
    b.unmount();
    getRunObservability.mockRejectedValue(new Error("down"));
    render(<RunObs mode="mock" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/Could not reach the server \(down\)/));
  });

  it("a write (a step or a human beat) re-reads the same run and keeps its record on screen meanwhile; a render with no write does not ask again", async () => {
    getRunObservability.mockResolvedValue(MOCK_RECORD);
    const { rerender } = render(<RunObs mode="mock" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    expect(getRunObservability).toHaveBeenCalledTimes(1);
    rerender(<RunObs mode="mock" hasRun gen={1} />);
    rerender(<RunObs mode="mock" hasRun gen={1} />);
    expect(getRunObservability).toHaveBeenCalledTimes(1);
    getRunObservability.mockReturnValue(new Promise(() => {}));
    await step();
    expect(getRunObservability).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("ro-table")).toBeTruthy();
    expect(screen.queryByTestId("ro-loading")).toBeNull();
  });

  it("a human beat opening or closing re-reads the run too (a lapse is only seen by the server on a poll)", async () => {
    getRunObservability.mockResolvedValue(MOCK_RECORD);
    const { rerender } = render(<RunObs mode="mock" hasRun gen={1} beat={{ kind: "ciba" }} />);
    await waitFor(() => expect(getRunObservability).toHaveBeenCalledTimes(1));
    rerender(<RunObs mode="mock" hasRun gen={1} beat={null} />);
    await waitFor(() => expect(getRunObservability).toHaveBeenCalledTimes(2));
  });

  it("a new run (gen) never shows the previous run's record: it says it is collecting until its own record is read", async () => {
    getRunObservability.mockResolvedValue(MOCK_RECORD);
    const { rerender } = render(<RunObs mode="mock" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    getRunObservability.mockReturnValue(new Promise(() => {}));
    rerender(<RunObs mode="mock" hasRun gen={2} />);
    expect(screen.getByTestId("ro-loading")).toBeTruthy();
    expect(screen.queryByTestId("ro-table")).toBeNull();
  });

  it("switching Mock -> Real -> Mock: the other mode's record is never shown under the new label, and each direction reads its own", async () => {
    getRunObservability.mockImplementation(async () => MOCK_RECORD);
    const { rerender } = render(<RunObs mode="mock" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    getRunObservability.mockReturnValue(new Promise(() => {}));
    rerender(<RunObs mode="real" hasRun gen={1} />);
    expect(screen.getByTestId("ro-loading")).toBeTruthy();
    expect(screen.queryByTestId("ro-table")).toBeNull();
    getRunObservability.mockImplementation(async () => REAL_RECORD);
    rerender(<RunObs mode="real" hasRun gen={2} />);
    await waitFor(() => expect(document.querySelector('tr[data-origin="response"]')).toBeTruthy());
    getRunObservability.mockImplementation(async () => MOCK_RECORD);
    rerender(<RunObs mode="mock" hasRun gen={3} />);
    await waitFor(() => expect(screen.getByTestId("ro-basis").textContent).toMatch(/^Simulated/));
  });

  it("a scenario that is simulated in Real mode says so and never asks for or shows a record; an attempt that began no run says so and never shows the older record", async () => {
    getRunObservability.mockResolvedValue(REAL_RECORD);
    const { rerender } = render(<RunObs mode="real" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    getRunObservability.mockClear();
    rerender(<RunObs mode="real" hasRun gen={1} simulatedInReal />);
    expect(screen.getByTestId("ro-simulated-in-real").textContent).toMatch(/simulated even in Real mode/);
    expect(screen.queryByTestId("ro-table")).toBeNull();
    rerender(<RunObs mode="real" hasRun gen={2} noRun />);
    expect(screen.getByTestId("ro-no-run").textContent).toMatch(/began no run/);
    expect(screen.queryByTestId("ro-table")).toBeNull();
    expect(getRunObservability).not.toHaveBeenCalled();
  });

  it("long names stay inside the panel as text (no markup)", async () => {
    const LONG = "long-approver-name-".repeat(12);
    const long = { ...MOCK_RECORD, rows: MOCK_RECORD.rows.map((r, i) => (i === 0 ? { ...r, message: `The approver (${LONG}) approved <img src=x onerror=alert(1)>`, detail: { actor: LONG } } : r)) };
    getRunObservability.mockResolvedValue(long);
    const { container } = render(<RunObs mode="mock" hasRun gen={1} />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("workspaceFetch tells the panel a step ran", () => {
  it("after a write, successful or failed, and never after a read", async () => {
    const real = globalThis.fetch;
    const seen = vi.fn();
    window.addEventListener("hmlab-step", seen);
    try {
      globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
      await workspaceFetch("/api/x", { method: "GET" });
      await workspaceFetch("/api/x");
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).not.toHaveBeenCalled();
      await workspaceFetch("/api/x", { method: "POST", body: "{}" });
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toHaveBeenCalledTimes(1);
      globalThis.fetch = vi.fn(async () => { throw new Error("offline"); });
      await expect(workspaceFetch("/api/x", { method: "POST", body: "{}" })).rejects.toThrow("offline");
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toHaveBeenCalledTimes(2);
    } finally { window.removeEventListener("hmlab-step", seen); globalThis.fetch = real; }
  });
});

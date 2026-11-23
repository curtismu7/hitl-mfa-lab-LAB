// Rule 27 in the page's API layer: which calls tell the run-observability panel to read its record again, and the retry mark.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callRealPrivilege, pollCiba, pollPush, runTool } from "./api";

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
let seen;
let realFetch;
beforeEach(() => { seen = vi.fn(); window.addEventListener("hmlab-step", seen); realFetch = globalThis.fetch; });
afterEach(() => { window.removeEventListener("hmlab-step", seen); globalThis.fetch = realFetch; });
const answer = (body, status = 200) => { globalThis.fetch = vi.fn(async () => json(body, status)); };
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a poll that first finds a lapse tells the panel once", () => {
  it("push: pending says nothing, the first failed poll says it, the same push again does not, another push does", async () => {
    answer({ status: "pending" });
    await pollPush("lapse-push-1");
    await settle();
    expect(seen).not.toHaveBeenCalled();
    answer({ status: "failed", detail: "the push timed out with no answer" });
    await pollPush("lapse-push-1"); await pollPush("lapse-push-1");
    await settle();
    expect(seen).toHaveBeenCalledTimes(1);
    await pollPush("lapse-push-2");
    await settle();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("CIBA: an approved poll says nothing, the first expired poll says it, polling on after expiry does not say it again", async () => {
    answer({ status: "approved" });
    await pollCiba("lapse-ciba-1");
    await settle();
    expect(seen).not.toHaveBeenCalled();
    answer({ status: "expired" });
    for (let i = 0; i < 4; i += 1) await pollCiba("lapse-ciba-2");
    await settle();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("the real call asks for a re-read only when the server says it added to the record", () => {
  it("recorded false (the same hold again): nothing; recorded true: once; a failure that recorded (no reply): once; no field: nothing", async () => {
    answer({ outcome: "held", runObservability: { began: true, recorded: false, afterReset: false } });
    await callRealPrivilege("ins_1");
    await settle();
    expect(seen).not.toHaveBeenCalled();
    answer({ outcome: "executed", runObservability: { began: true, recorded: true, afterReset: false } });
    await callRealPrivilege("ins_1");
    await settle();
    expect(seen).toHaveBeenCalledTimes(1);
    answer({ error: "upstream_unreachable", runObservability: { began: true, recorded: true, afterReset: false } }, 502);
    await callRealPrivilege("ins_1");
    await settle();
    expect(seen).toHaveBeenCalledTimes(2);
    answer({ error: "busy" }, 429);
    await callRealPrivilege();
    await settle();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe("runTool marks a retry", () => {
  it("sends X-Hmlab-Retry only on a retry, alongside the approval id when there is one, and still tells the panel (a write)", async () => {
    answer({ decision: "PERMIT" });
    await runTool({ tool: "t", amount: 1 });
    expect(globalThis.fetch.mock.calls[0][1].headers["X-Hmlab-Retry"]).toBeUndefined();
    await runTool({ tool: "t", amount: 1 }, { retry: true });
    expect(globalThis.fetch.mock.calls[1][1].headers["X-Hmlab-Retry"]).toBe("1");
    await runTool({ tool: "t", amount: 1 }, { approvalId: "ins_9", retry: true });
    const h = globalThis.fetch.mock.calls[2][1].headers;
    expect([h["X-Hmlab-Retry"], h["X-Procyon-Approval-Id"]]).toEqual(["1", "ins_9"]);
    await settle();
    expect(seen).toHaveBeenCalledTimes(3);
  });
});

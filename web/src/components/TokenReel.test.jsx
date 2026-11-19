import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import TokenReel from "./TokenReel";
import { reelCards } from "../liveFlow";

describe("TokenReel", () => {
  it("says what it is waiting for before a run", () => {
    render(<TokenReel cards={[]} />);
    expect(screen.getByTestId("reel-empty")).toBeTruthy();
  });
  it("renders one numbered MOCK card per credential, marks the current one, and shows raw ids", () => {
    const run = { decision: "HITL", error: "mcp_hitl_required", challengeId: "consent-9", tool: "create_transfer", amount: 300, hops: [] };
    render(<TokenReel cards={reelCards(run, { challenge: { id: "consent-9" } })} />);
    const list = screen.getByTestId("token-reel");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    items.forEach((li) => expect(within(li).getAllByText("MOCK").length).toBeGreaterThan(0));
    expect(screen.queryByText("REAL")).toBeNull();
    expect(screen.getByTestId("reel-challenge").getAttribute("aria-current")).toBe("step");
    expect(screen.getByTestId("reel-bearer").getAttribute("aria-current")).toBeNull();
    expect(within(screen.getByTestId("reel-challenge")).getAllByText("consent-9").length).toBeGreaterThan(0); // the field, and again in Raw
    expect(screen.getByTestId("reel-receipt-state").textContent).toBe("not issued yet");
  });
});

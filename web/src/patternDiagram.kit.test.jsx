// PatternDiagram is wired to the diagram kit (web/src/diagram-kit): labels above the boxes, and a box that expands to show its details.
// React Flow does not render edges in jsdom, so the arrow drawing itself is proved in a real browser; here: what the page hands the kit.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PatternDiagram from "./components/PatternDiagram";

// React Flow fits the view on a short timer; let it finish before the page is torn down, or it fires into a closed window.
afterEach(async () => { await act(async () => { await new Promise((r) => setTimeout(r, 120)); }); cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });
beforeEach(() => { window.history.replaceState(null, "", "/"); });

const pattern = {
  title: "Demo flow", intro: "An agent asks, a gate checks.",
  nodes: [{ id: "agent", label: "Agent", kind: "actor", x: 0, y: 0 }, { id: "gate", label: "Gate", kind: "gateway", x: 300, y: 0 }, { id: "rule", label: "Rule", kind: "resource", x: 600, y: 0 }],
  steps: [{ from: "agent", to: "gate", label: "asks", say: "The agent asks." }, { from: "gate", to: "rule", label: "checks", say: "The gate checks." }, { from: "rule", to: "gate", label: "answers", say: "The rule answers." }],
};
const mount = () => render(<PatternDiagram pattern={pattern} />);
const node = (id) => screen.getByTestId(`pat-node-${id}`);
const open = () => [...document.querySelectorAll(".dk-open")].map((b) => b.getAttribute("data-testid"));

describe("arrow labels", () => {
  it("are drawn once per step, numbered, in the kit's layer above the boxes, and none is left as SVG text", () => {
    mount();
    for (const [i, text] of [[0, "1. asks"], [1, "2. checks"], [2, "3. answers"]]) {
      const l = screen.getByTestId(`dk-label-e${i}`); expect(l).toHaveTextContent(text); expect(document.querySelector(".react-flow__viewport-portal").contains(l)).toBe(true);
    }
    expect(document.querySelectorAll(".pat-elabel").length).toBe(0); // the old labels are gone
  });
  it("Simulate marks the walked arrow's label and raises it; the arrows not yet walked are dimmed", () => {
    mount();
    expect(document.querySelectorAll(".dk-label--on, .dk-label--dim").length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /simulate/i }));
    expect(document.querySelectorAll(".dk-label--on").length).toBe(1);
    expect(screen.getByTestId("dk-label-e0").className).toContain("dk-label--on"); expect(screen.getByTestId("dk-label-e0").style.zIndex).toBe("3");
    expect(screen.getByTestId("dk-label-e1").className).toContain("dk-label--dim"); expect(screen.getByTestId("dk-label-e2").className).toContain("dk-label--dim");
  });
});

describe("a box expands in place", () => {
  it("clicking a box shows its details inside it: group, reach and both lists of arrows with their numbered text", () => {
    mount();
    expect(open()).toEqual([]);
    fireEvent.click(node("gate"));
    expect(open()).toEqual(["pat-node-gate"]);
    const p = screen.getByTestId("dk-passport-gate");
    expect(node("gate").contains(p)).toBe(true);
    expect(p).toHaveTextContent("gateway");                                                    // a box's kind is its group
    expect(screen.getByTestId("dk-passport-reach")).toHaveTextContent("Upstream 2 · Downstream 1"); // agent and rule reach the gate; the gate reaches the rule
    expect(screen.getByTestId("dk-passport-outgoing")).toHaveTextContent("Outgoing · 1"); expect(screen.getByTestId("dk-passport-outgoing")).toHaveTextContent("2. checks");
    expect(screen.getByTestId("dk-passport-incoming")).toHaveTextContent("Incoming · 2"); expect(screen.getByTestId("dk-passport-incoming")).toHaveTextContent("1. asks");
    expect(screen.queryByTestId("dk-passport-sources")).toBeNull(); // a pattern has no code pointers
  });
  it("clicking the open box again collapses it, another box moves the expansion, and the empty canvas collapses it", () => {
    mount();
    fireEvent.click(node("gate")); expect(open()).toEqual(["pat-node-gate"]);
    fireEvent.click(node("gate")); expect(open()).toEqual([]);
    fireEvent.click(node("gate")); fireEvent.click(node("rule")); expect(open()).toEqual(["pat-node-rule"]);
    fireEvent.click(document.querySelector(".react-flow__pane")); expect(open()).toEqual([]);
  });
  it("an item opens the box at the other end, Close collapses, clicks inside the details do nothing else, and the page's Reset collapses it", () => {
    mount();
    fireEvent.click(node("gate"));
    fireEvent.click(screen.getByTestId("dk-passport-reach")); expect(open()).toEqual(["pat-node-gate"]);
    fireEvent.click(screen.getByTestId("dk-passport-outgoing").querySelector("button.dk-passport-go")); // by class: jsdom never measures nodes, so React Flow keeps them visibility:hidden
    expect(open()).toEqual(["pat-node-rule"]);
    fireEvent.click(screen.getByTestId("dk-passport-close")); expect(open()).toEqual([]);
    fireEvent.click(node("agent")); expect(open()).toEqual(["pat-node-agent"]);
    fireEvent.click(screen.getByTestId("pattern-reset")); expect(open()).toEqual([]);
  });
  it("the expanded box is raised above its neighbours", () => {
    window.history.replaceState(null, "", "/?box=gate"); // opened from a link, so React Flow has not raised it by selecting it
    mount();
    expect(Number(node("gate").closest(".react-flow__node").style.zIndex)).toBe(10);
    expect(Number(node("agent").closest(".react-flow__node").style.zIndex)).toBe(0);
  });
});

describe("a shared link", () => {
  it("?box=<id> opens the page with that box expanded; a box that is not in the diagram is ignored", () => {
    window.history.replaceState(null, "", "/?box=rule"); mount(); expect(open()).toEqual(["pat-node-rule"]);
    cleanup(); window.history.replaceState(null, "", "/?box=ghost"); mount(); expect(open()).toEqual([]);
  });
  it("Copy link puts the page's address with ?box=<id> on the clipboard, keeping the rest of the address", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    window.history.replaceState(null, "", "/?vertical=retail#diagram");
    mount(); fireEvent.click(node("agent"));
    await act(async () => { fireEvent.click(screen.getByTestId("dk-passport-copy")); });
    const url = new URL(writeText.mock.calls[0][0]);
    expect(url.searchParams.get("box")).toBe("agent"); expect(url.searchParams.get("vertical")).toBe("retail"); expect(url.hash).toBe("#diagram");
  });
});

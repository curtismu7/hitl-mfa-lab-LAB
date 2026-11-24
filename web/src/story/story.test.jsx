// Story overlay, toggle and bar (vitest + Testing Library + jsdom). Run where the folder is vendored (web/src/story/).
import { render, screen, fireEvent, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import StoryToggle, { readView, storyKey } from "./StoryToggle";
import StoryBar from "./StoryBar";
import { createOverlay } from "./overlay";

beforeEach(() => { localStorage.clear(); document.body.innerHTML = ""; document.querySelectorAll(".story-hl,.story-bub,.story-slide").forEach((e) => e.remove()); });
const made = [];
const mk = (opts) => { const o = createOverlay(opts); made.push(o); return o; };   // every overlay is destroyed after its test: a live one keeps listening for resize
afterEach(() => { made.splice(0).forEach((o) => o.destroy()); document.getElementById("story-style")?.remove(); });

describe("createOverlay", () => {
  test("a bubble shows the number, 'n of N', the title and text, and a highlight on its target", () => {
    document.body.innerHTML = '<button id="send">Send</button>';
    const o = mk();
    o.cap({ n: 2, total: 5, title: "Ask", text: "Press Send.", target: "#send", lines: ["asks: a question"] });
    expect(document.querySelector(".story-bub h3").textContent).toBe("Ask");
    expect(document.querySelector(".story-bub .of").textContent).toBe("2 of 5");
    expect(document.querySelector(".story-bub .n").textContent).toBe("2");
    expect(document.querySelectorAll(".story-bub li")).toHaveLength(1);
    expect(document.querySelector(".story-hl")).not.toBeNull();
    o.clear(); expect(document.querySelector(".story-bub")).toBeNull(); expect(document.querySelector(".story-hl")).toBeNull();
  });

  test("text is set as text: markup in a title, an answer line or a slide is never parsed", () => {
    const o = mk();
    o.cap({ n: 1, total: 1, title: "<img src=x onerror=alert(1)>", text: "<b>bold</b>", lines: ["<script>x</script>"] });
    expect(document.querySelector(".story-bub img")).toBeNull(); expect(document.querySelector(".story-bub b")).toBeNull(); expect(document.querySelector(".story-bub script")).toBeNull();
    expect(document.querySelector(".story-bub p").textContent).toBe("<b>bold</b>");
    o.slide({ title: "<i>t</i>", lead: "<u>l</u>", colA: { heading: "<b>h</b>", lines: ["<s>x</s>"] }, colB: { heading: "B", lines: ["y"] }, verdict: "<em>v</em>" });
    expect(document.querySelector(".story-slide i, .story-slide u, .story-slide b, .story-slide s, .story-slide em")).toBeNull();
  });

  test("a missing target gives a centred bubble with no highlight and no tail; a long answer line wraps and does not throw", () => {
    const o = mk();
    o.cap({ n: 1, total: 1, title: "t", text: "x", target: "#nope", lines: ["w".repeat(500)] });
    expect(document.querySelector(".story-hl")).toBeNull(); expect(document.querySelector(".story-tail")).toBeNull();
  });

  test("regression: a slide image that fails to load removes only the image; both text columns stay", () => {
    const o = mk();
    o.slide({ title: "T", lead: "L", colA: { heading: "A", lines: ["a1", "a2"] }, colB: { heading: "B", lines: ["b1"] }, verdict: "V", image: "/assets/missing.jpg" });
    fireEvent.error(document.querySelector(".story-slide img"));
    expect(document.querySelector(".story-slide img")).toBeNull();
    expect(document.querySelectorAll(".story-slide li")).toHaveLength(3); expect(document.querySelectorAll(".story-slide .col")).toHaveLength(2);
    expect(document.querySelector(".story-slide .card").classList.contains("withimg")).toBe(false);
  });

  test("regression: a target the page replaced is found again, and a detached one is treated as missing", async () => {
    document.body.innerHTML = '<div id="slot"><button id="send">Send</button></div>';
    const rect = (top) => () => ({ left: 50, top, width: 80, height: 30, right: 130, bottom: top + 30 });
    const first = document.getElementById("send"); first.getBoundingClientRect = rect(100);
    const o = mk(); o.cap({ n: 1, total: 1, title: "t", text: "x", target: () => document.getElementById("send") });
    expect(document.querySelector(".story-hl").style.top).toBe("95px");
    document.getElementById("slot").innerHTML = '<button id="send">Send</button>';           // the page re-rendered: a new node
    const next = document.getElementById("send"); next.getBoundingClientRect = rect(240);
    window.dispatchEvent(new Event("resize")); await new Promise((r) => setTimeout(r, 40));
    expect(document.querySelector(".story-hl").style.top).toBe("235px");
    o.clear();
    const gone = document.createElement("div"); const o2 = mk(); o2.cap({ n: 1, total: 1, title: "t", text: "x", target: gone });   // never attached
    expect(document.querySelector(".story-hl")).toBeNull();
  });

  // helper: a page with a target, a Story bar and a bubble of a known size (jsdom has no layout)
  const stage = ({ target, bar, bubble = { width: 400, height: 200 } }) => {
    document.body.innerHTML = '<button id="t">t</button><div class="story-bar"></div>';
    const rect = (x) => ({ left: x.left, top: x.top, width: x.width, height: x.height, right: x.left + x.width, bottom: x.top + x.height });
    document.getElementById("t").getBoundingClientRect = () => rect(target);
    const barEl = document.querySelector(".story-bar"); barEl.getBoundingClientRect = () => rect(bar);
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () { return this.classList.contains("story-bub") ? rect({ left: 0, top: 0, ...bubble }) : orig.call(this); };
    return { barEl, restore: () => { HTMLElement.prototype.getBoundingClientRect = orig; }, bar };
  };
  const placed = () => { const b = document.querySelector(".story-bub"); return { left: parseFloat(b.style.left), top: parseFloat(b.style.top), tail: !!b.querySelector(".story-tail") }; };
  const under = (p, bar, w = 400, h = 200) => p.left < bar.left + bar.width && p.left + w > bar.left && p.top < bar.top + bar.height && p.top + h > bar.top;

  test("a bubble that would run under the Story bar moves above it, and its tail still points at the target", () => {
    const bar = { left: 400, top: 700, width: 600, height: 50 };
    const s = stage({ target: { left: 300, top: 700, width: 100, height: 30 }, bar });
    try {
      const o = mk(); o.cap({ n: 1, total: 1, title: "t", text: "x", target: document.getElementById("t"), prefer: "right" });   // right of the target would be under the bar
      const p = placed(); expect(under(p, bar)).toBe(false); expect(p.top + 200).toBeLessThanOrEqual(692.001);
    } finally { s.restore(); }
  });

  test("with no room above the bar it goes beside it, and never onto the highlighted target when a clear place exists", () => {
    const bar = { left: 500, top: 100, width: 500, height: 50 };
    const s = stage({ target: { left: 100, top: 110, width: 100, height: 30 }, bar, bubble: { width: 300, height: 200 } });
    try {
      const o = mk(); o.cap({ n: 1, total: 1, title: "t", text: "x", target: document.getElementById("t"), prefer: "right" });
      const p = placed(); expect(under(p, bar, 300, 200)).toBe(false);
      const onTarget = p.left < 205 && p.left + 300 > 95 && p.top < 145 && p.top + 200 > 105; expect(onTarget).toBe(false);
    } finally { s.restore(); }
  });

  test("when nothing clears the bar the bubble stays where it was drawn, without throwing", () => {
    const s = stage({ target: { left: 300, top: 300, width: 100, height: 30 }, bar: { left: 0, top: 0, width: 1024, height: 768 } });
    try { const o = mk(); expect(() => o.cap({ n: 1, total: 1, title: "t", text: "x", target: document.getElementById("t") })).not.toThrow(); expect(document.querySelector(".story-bub")).not.toBeNull(); }
    finally { s.restore(); }
  });

  test("regression: a bar that was not there (or was a different size) when the bubble was drawn is avoided on the next frame", async () => {
    document.body.innerHTML = '<button id="t">t</button>';
    const rect = (x) => ({ left: x.left, top: x.top, width: x.width, height: x.height, right: x.left + x.width, bottom: x.top + x.height });
    document.getElementById("t").getBoundingClientRect = () => rect({ left: 300, top: 700, width: 100, height: 30 });
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () { return this.classList.contains("story-bub") ? rect({ left: 0, top: 0, width: 400, height: 200 }) : orig.call(this); };
    try {
      const o = mk(); o.cap({ n: 1, total: 1, title: "t", text: "x", target: document.getElementById("t"), prefer: "right" });   // no bar yet: the bubble is drawn right of the target
      const bar = { left: 400, top: 700, width: 600, height: 50 };
      document.body.insertAdjacentHTML("beforeend", '<div class="story-bar"></div>'); document.querySelector(".story-bar").getBoundingClientRect = () => rect(bar);   // the bar mounts a moment later
      await new Promise((r) => setTimeout(r, 60));
      expect(under(placed(), bar)).toBe(false);
    } finally { HTMLElement.prototype.getBoundingClientRect = orig; }
  });

  test("regression: the bubble is placed with its measured width (narrow screens), not the nominal 470", () => {
    document.body.innerHTML = '<button id="t">t</button>';
    const t = document.getElementById("t"); t.getBoundingClientRect = () => ({ left: 400, top: 400, width: 100, height: 30, right: 500, bottom: 430 });
    const orig = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () { return this.classList.contains("story-bub") ? { left: 0, top: 0, width: 300, height: 120, right: 300, bottom: 120 } : orig.call(this); };
    try {
      const o = mk(); o.cap({ n: 1, total: 1, title: "t", text: "x", target: t, prefer: "below" });
      expect(parseFloat(document.querySelector(".story-bub").style.left)).toBe(300);   // centred under the target with the measured width: 450 - 300/2 (with the nominal 470 it would be 215)
    } finally { HTMLElement.prototype.getBoundingClientRect = orig; }
  });

  test("follow: false (the recorded video) draws a caption once and leaves it exactly there: no redraw on resize or scroll", async () => {
    document.body.innerHTML = '<button id="send">Send</button>';
    const t = document.getElementById("send"); let top = 100;
    t.getBoundingClientRect = () => ({ left: 50, top, width: 80, height: 30, right: 130, bottom: top + 30 });
    const o = mk({ follow: false });
    o.cap({ n: 1, total: 1, title: "t", text: "x", target: t });
    const bub = document.querySelector(".story-bub"); expect(document.querySelector(".story-hl").style.top).toBe("95px");
    top = 300; window.dispatchEvent(new Event("resize")); document.dispatchEvent(new Event("scroll")); await new Promise((r) => setTimeout(r, 60));
    expect(document.querySelector(".story-hl").style.top).toBe("95px");          // still where it was drawn
    expect(document.querySelector(".story-bub")).toBe(bub);                      // the very same node: nothing was redrawn
    o.destroy();
  });

  test("regression: the highlight follows a resize, and stops following once cleared", async () => {
    document.body.innerHTML = '<button id="send">Send</button>';
    const t = document.getElementById("send"); let top = 100;
    t.getBoundingClientRect = () => ({ left: 50, top, width: 80, height: 30, right: 130, bottom: top + 30 });
    const o = mk();
    o.cap({ n: 1, total: 1, title: "t", text: "x", target: t });
    expect(document.querySelector(".story-hl").style.top).toBe("95px");
    top = 300; window.dispatchEvent(new Event("resize")); await new Promise((r) => setTimeout(r, 40));
    expect(document.querySelector(".story-hl").style.top).toBe("295px");
    o.clear(); top = 500; window.dispatchEvent(new Event("resize")); await new Promise((r) => setTimeout(r, 40));
    expect(document.querySelector(".story-hl")).toBeNull(); expect(document.querySelector(".story-bub")).toBeNull();
    o.destroy();
  });

  test("rule 29: a slide with a header shows it above the title, as text; a slide without one has none", () => {
    const o = mk();
    o.slide({ header: "<b>A2A</b>, and A2A with an AWS agent", title: "T", lead: "L", colA: { heading: "A", lines: ["a"] }, colB: { heading: "B", lines: ["b"] }, verdict: "V" });
    const h = document.querySelector(".story-slide .header"); expect(h.textContent).toBe("<b>A2A</b>, and A2A with an AWS agent"); expect(h.querySelector("b")).toBeNull();
    expect(h.nextElementSibling.tagName).toBe("H1");
    o.slide({ title: "T", lead: "L", colA: { heading: "A", lines: ["a"] }, colB: { heading: "B", lines: ["b"] }, verdict: "V" });
    expect(document.querySelector(".story-slide .header")).toBeNull();
  });

  test("a slide has both columns and the verdict; no image unless one is given; a broken image is removed", () => {
    const o = mk();
    const slide = { title: "T", lead: "L", colA: { heading: "A", lines: ["a1", "a2"] }, colB: { heading: "B", lines: ["b1"] }, verdict: "V" };
    o.slide({ ...slide, image: null });
    expect(document.querySelectorAll(".story-slide li")).toHaveLength(3); expect(document.querySelector(".story-slide img")).toBeNull();
    o.slide({ ...slide, image: "/assets/x.jpg" });
    const img = document.querySelector(".story-slide img"); expect(img).not.toBeNull();
    fireEvent.error(img); expect(document.querySelector(".story-slide img")).toBeNull();
    o.destroy(); expect(document.getElementById("story-style")).toBeNull();
  });
});

describe("StoryToggle", () => {
  test("Demo is the default; choosing Story calls onChange, is remembered, and Demo brings it back", () => {
    const onChange = vi.fn();
    const { unmount } = render(<StoryToggle prefix="t" onChange={onChange} />);
    expect(screen.getByTestId("story-toggle-demo")).toHaveAttribute("aria-pressed", "true");
    expect(onChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByTestId("story-toggle-story"));
    expect(onChange).toHaveBeenLastCalledWith(true); expect(localStorage.getItem(storyKey("t"))).toBe("story");
    unmount(); render(<StoryToggle prefix="t" />);
    expect(screen.getByTestId("story-toggle-story")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("story-toggle-demo")); expect(localStorage.getItem(storyKey("t"))).toBe("demo");
  });

  test("?story=1 turns Story on; per-lab prefixes do not share a choice", () => {
    expect(readView("t", "?story=1")).toBe("story"); expect(readView("t", "")).toBe("demo");
    localStorage.setItem(storyKey("a"), "story"); expect(readView("a", "")).toBe("story"); expect(readView("b", "")).toBe("demo");
  });

  test("blocked storage does not break the toggle", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<StoryToggle prefix="t" />);
    fireEvent.click(screen.getByTestId("story-toggle-story"));
    expect(screen.getByTestId("story-toggle-story")).toHaveAttribute("aria-pressed", "true");
    spy.mockRestore(); set.mockRestore();
  });
});

function fakeStory(over = {}) {
  let state = { active: true, status: "showing", n: 2, total: 5, playing: false, paused: false, speed: "normal", message: "", warnings: [], canBack: true, canNext: true, ...over };
  const subs = new Set();
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  return {
    calls, set(next) { state = { ...state, ...next }; subs.forEach((f) => f(state)); },
    state: () => state, subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    next: rec("next"), back: rec("back"), exit: rec("exit"), play: rec("play"), pause: rec("pause"), resume: rec("resume"), restart: rec("restart"),
    setSpeed: rec("setSpeed"), manualInput: rec("manualInput"),
  };
}

describe("StoryBar", () => {
  test("regression: with no story running the bar leaves the page's own arrow keys and Esc alone", () => {
    const s = fakeStory({ active: false }); render(<StoryBar story={s} />);
    const right = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }); document.body.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(false); fireEvent.keyDown(document.body, { key: "Escape" });
    expect(s.calls.filter((c) => c[0] !== "manualInput")).toEqual([]);
  });

  test("regression: the bar picks up a story that started before it subscribed", () => {
    const s = fakeStory({ active: false }); const real = s.state; let first = true;
    s.state = () => { if (first) { first = false; return real(); } return { ...real(), active: true }; };   // active by the time the effect runs, with no emit
    render(<StoryBar story={s} />);
    expect(screen.getByTestId("story-bar")).toBeInTheDocument();
  });

  test("shows nothing when Story is not active", () => {
    const s = fakeStory({ active: false }); render(<StoryBar story={s} />);
    expect(screen.queryByTestId("story-bar")).toBeNull();
  });

  test("Back, Next, Play, Exit and the speed menu drive the engine; Mock is labelled simulated", () => {
    const s = fakeStory(); render(<StoryBar story={s} mock />);
    expect(screen.getByTestId("story-simulated")).toHaveTextContent("Simulated");
    fireEvent.click(screen.getByTestId("story-back")); fireEvent.click(screen.getByTestId("story-next")); fireEvent.click(screen.getByTestId("story-play"));
    fireEvent.change(screen.getByTestId("story-speed"), { target: { value: "slower" } }); fireEvent.click(screen.getByTestId("story-exit"));
    expect(s.calls.map((c) => c[0])).toEqual(["back", "next", "play", "setSpeed", "exit"]); expect(s.calls[3][1]).toBe("slower");
  });

  test("while playing the button is Pause, then Resume; Real mode shows no simulated label", () => {
    const s = fakeStory({ playing: true }); render(<StoryBar story={s} />);
    expect(screen.queryByTestId("story-simulated")).toBeNull();
    fireEvent.click(screen.getByTestId("story-pause")); expect(s.calls.at(-1)[0]).toBe("pause");
    act(() => s.set({ paused: true })); fireEvent.click(screen.getByTestId("story-play")); expect(s.calls.at(-1)[0]).toBe("resume");
  });

  test("waiting on the viewer: the message says it is their turn and is marked for the red slow blink; not while a run is in flight or Play is playing", () => {
    const s = fakeStory({ kind: "bubble", isPrompt: true, promptKind: "text" }); render(<StoryBar story={s} />);
    const msg = screen.getByTestId("story-msg");
    expect(msg).toHaveTextContent("Your turn: press Send, then Next"); expect(msg).toHaveAttribute("data-your-turn", "true");
    act(() => s.set({ promptKind: "press" })); expect(msg).toHaveTextContent("Your turn: press the highlighted button, then Next");
    act(() => s.set({ playing: true })); expect(msg).not.toHaveAttribute("data-your-turn");               // Play presses Send for them
    act(() => s.set({ playing: false, status: "waiting", promptKind: null, isPrompt: false })); expect(msg).not.toHaveAttribute("data-your-turn");   // waiting on the run
    act(() => s.set({ status: "stalled", message: "The run did not finish in time. Press Next to carry on, or Exit." }));
    expect(msg).toHaveAttribute("data-your-turn", "true"); expect(msg).toHaveTextContent("Press Next to carry on");
    act(() => s.set({ status: "showing", kind: "bubble", n: 3, total: 9, message: "" })); expect(msg).not.toHaveAttribute("data-your-turn"); expect(msg).toHaveTextContent("3 of 9");
    act(() => s.set({ status: "waiting", waitingOn: "viewer", promptKind: null, message: "Your turn: press Send for the question above; the story carries on when the answer is in." }));
    expect(msg).toHaveAttribute("data-your-turn", "true");                                                   // waiting on the viewer: their turn
    act(() => s.set({ waitingOn: "run", message: "Waiting for the run to finish." })); expect(msg).not.toHaveAttribute("data-your-turn");
  });

  test("a slide is labelled Slide (it has no number); a bubble shows its number among the bubbles", () => {
    const s = fakeStory({ kind: "slide", n: 2, total: 27 }); render(<StoryBar story={s} />);
    expect(screen.getByTestId("story-msg")).toHaveTextContent("Slide"); expect(screen.getByTestId("story-msg")).not.toHaveTextContent("of 27");
    act(() => s.set({ kind: "bubble", n: 3 })); expect(screen.getByTestId("story-msg")).toHaveTextContent("3 of 27");
  });

  test("Next is disabled while a run is in flight and Back at the first step", () => {
    const s = fakeStory({ status: "waiting", canNext: false, canBack: false }); render(<StoryBar story={s} />);
    expect(screen.getByTestId("story-next")).toBeDisabled(); expect(screen.getByTestId("story-back")).toBeDisabled();
    expect(screen.getByTestId("story-msg")).toHaveTextContent("Waiting for the run");
  });

  test("a failure message and unreadable values are shown, not hidden", () => {
    const s = fakeStory({ status: "stalled", message: "Play stopped: The run timed out.", warnings: ['"p1": {status} could not be read from the page'] }); render(<StoryBar story={s} />);
    expect(screen.getByTestId("story-msg")).toHaveTextContent("Play stopped: The run timed out."); expect(screen.getByTestId("story-warn")).toHaveTextContent("1 value not readable");
  });

  test("keyboard: arrows move, Esc exits, but arrows leave the question field alone", () => {
    document.body.innerHTML = '<input id="q">';
    const s = fakeStory(); render(<StoryBar story={s} />);
    fireEvent.keyDown(document.body, { key: "ArrowRight" }); fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    fireEvent.keyDown(document.getElementById("q"), { key: "ArrowRight" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(s.calls.map((c) => c[0]).filter((n) => n !== "manualInput")).toEqual(["next", "back", "exit"]);
  });

  test("a real click outside the Play controls is manual input; one on Play is not; a page-made event is not", () => {
    document.body.innerHTML = '<button id="page">page</button>';
    const s = fakeStory({ playing: true }); render(<StoryBar story={s} isManual={(e) => e.detail === 1} />);   // jsdom cannot make a trusted event: detail 1 stands in for one
    const fire = (el, real) => el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, detail: real ? 1 : 0 }));
    const manual = () => s.calls.filter((c) => c[0] === "manualInput").length;
    fire(document.getElementById("page"), true); expect(manual()).toBe(1);
    fire(screen.getByTestId("story-pause"), true); expect(manual()).toBe(1);
    fire(document.getElementById("page"), false); expect(manual()).toBe(1);
  });

  test("by default the browser's own trusted flag decides: a script's event is not manual input", () => {
    document.body.innerHTML = '<button id="page">page</button>';
    const s = fakeStory({ playing: true }); render(<StoryBar story={s} />);
    document.getElementById("page").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(s.calls.filter((c) => c[0] === "manualInput")).toHaveLength(0);
  });

  test("when the story is done, Play is disabled and Restart appears", () => {
    const s = fakeStory({ status: "done", canNext: false }); render(<StoryBar story={s} />);
    expect(screen.getByTestId("story-play")).toBeDisabled(); fireEvent.click(screen.getByTestId("story-restart")); expect(s.calls.at(-1)[0]).toBe("restart");
  });
});

import { useCallback, useEffect, useState, lazy, Suspense } from "react";
import PolicyGate from "./components/PolicyGate";
import DiagramTab from "./components/DiagramTab";
import TalkTrack from "./components/TalkTrack";
import ShelfLink from "./components/ShelfLink";
import VerifyMark from "./components/VerifyMark.jsx";
import TopMenu from "./top-menu/TopMenu";
import ReturnLink from "./return-link/ReturnLink.jsx";
import StoryToggle, { storyKey } from "./story/StoryToggle.jsx";
import { StoryBoundary } from "./StoryBoundary.jsx";
import { readReturnContext } from "./return-link/returnTargets.js";
import { scenarioFor, verticalFor } from "./handoffMap";
import { getJson, resetWorkspace, setMode } from "./api";

// Story mode is loaded only when the viewer switches it on, so the page in Demo mode does not pay for it.
const StoryRoot = lazy(() => import("./StoryRoot.jsx"));
export const STORY_PREFIX = "hmlab";

export const TABS = [
  { id: "gate", label: "Transfer gate" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
// The banner is never blank and never claims "not hosted" before it knows: until /api/info or /api/scenarios answers (or if both fail)
// it says both, honestly.
const TAIL = "Nothing here calls a real gateway, identity provider or tenant.";
export const BANNER_UNKNOWN = `SIMULATED / HOSTED SIMULATION: a mock transfer gate, mock MFA step-up, a mock CIBA out-of-band approval and a mock Privilege gateway hold confirmed by a mock PingID. ${TAIL}`;
const BANNER_LOCAL = `SIMULATED: a mock transfer gate, mock MFA step-up, a mock CIBA out-of-band approval and a mock Privilege gateway hold confirmed by a mock PingID. ${TAIL}`;
const BANNER_REAL = `REAL MODE: the PRIVILEGE scenario sends a real tools/call to the Privilege gateway configured in this lab's .env and shows its real answer; the approval is yours, in the Privilege console, confirmed with a real PingID push to the approvers. The other scenarios' standalone MFA and push beats are still simulated: their step-up OTP and in-page mock phone are a labelled demo bypass, not a real PingOne MFA or PingID call.`;
const BANNER_HOSTED = `HOSTED SIMULATION: a mock transfer gate, mock MFA step-up, a mock CIBA out-of-band approval and a mock Privilege gateway hold confirmed by a mock PingID. ${TAIL}`;

const hashParts = () => {
  const h = window.location.hash.replace("#", "");
  const m = /^scenario-([a-z0-9-]{1,40})$/.exec(h);
  if (m) return { tab: "gate", scenario: m[1] };
  return { tab: TABS.some((t) => t.id === h) ? h : "gate", scenario: null };
};

export default function App() {
  // Opened from Customer Agent LAB: preselect the matching scenario and vertical (handoffMap.js), once, on load.
  const [handoff] = useState(() => readReturnContext(window.location.search));
  const [vertical, setVertical] = useState(() => verticalFor(handoff) || "retail");
  const [story, setStory] = useState(null);
  const [info, setInfo] = useState(undefined); // undefined = loading, null = failed
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(hashParts().tab);
  const [requested, setRequested] = useState(() => hashParts().scenario || scenarioFor(handoff));
  const [presenter, setPresenter] = useState(false);
  const [storyOn, setStoryOn] = useState(false);
  const [toggleKey, setToggleKey] = useState(0);
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");

  useEffect(() => { getJson("/api/info").then(setInfo, () => setInfo(null)); }, []);
  useEffect(() => { getJson(`/api/scenarios?vertical=${encodeURIComponent(vertical)}`).then((j) => { setStory(j); setError(null); }, (e) => setError(e.message)); }, [vertical]);
  useEffect(() => {
    const on = () => { const p = hashParts(); setTab(p.tab); setRequested(p.scenario); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const select = (id) => { setTab(id); setRequested(null); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };
  const pickScenario = (sid) => { try { window.history.replaceState(null, "", `#scenario-${sid}`); } catch { /* ignore */ } };

  useEffect(() => {
    const on = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const reset = useCallback(async () => {
    const ok = await resetWorkspace().catch(() => false);
    setResetSignal((n) => n + 1);
    setResetMsg(ok ? "Reset: your workspace's bands, receipts and runs are back to defaults." : "Reset failed on the server; the view was reset.");
    try { window.dispatchEvent(new Event("hmlab:reset")); } catch { /* no window */ }
  }, []);

  // Exit in the Story bar: back to Demo, remembered, and ?story=1 dropped from the address so a reload stays in Demo.
  const leaveStory = useCallback(() => {
    try { localStorage.setItem(storyKey(STORY_PREFIX), "demo"); } catch { /* storage blocked */ }
    try { const u = new URL(window.location.href); if (u.searchParams.has("story")) { u.searchParams.delete("story"); window.history.replaceState(null, "", u); } } catch { /* no address to tidy */ }
    setToggleKey((k) => k + 1);
  }, []);

  const switchMode = useCallback(async (next) => {
    if (!info || next === info.mode) return;
    const res = await setMode(next).catch(() => ({ ok: false }));
    if (res.ok) { window.location.reload(); }
    else setResetMsg(res.body?.detail || "Could not switch mode.");
  }, [info]);

  const hosted = story ? !!story.hosted : info ? !!info.hosted : null;
  const banner = info?.mode === "real" ? BANNER_REAL : story ? story.banner : hosted === true ? BANNER_HOSTED : hosted === false ? BANNER_LOCAL : BANNER_UNKNOWN;
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header className="shell-bar">
        <span className="shell-brand">
          <span className="shell-logo" aria-hidden="true">HITL</span>
          <h1>HITL MFA Lab</h1>
          {info?.mode === "real"
            ? <span className="shell-badge shell-badge--real" data-testid="mode-badge">Real</span>
            : <span className="shell-badge" data-testid="mode-badge">Mock</span>}
        </span>
        <nav className="shell-nav" aria-label="Lab sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); select(t.id); }}>{t.label}</a>
          ))}
        </nav>
        <TopMenu
          mode={{ value: info?.mode === "real" ? "real" : "mock", onChange: switchMode, realAvailable: info?.realAvailable ?? null, realHint: "Real is owner-run: it needs HMLAB_REAL_URL, HMLAB_REAL_AGENT_KEY and HMLAB_REAL_TOOL in this lab's .env. It makes the PRIVILEGE scenario call your real gateway; everything else stays simulated." }}
          vertical={{ value: vertical, onChange: setVertical, options: story ? story.verticals : ["retail"] }}
          present={{ active: presenter, onToggle: () => setPresenter((v) => !v) }}
          talkTrack={{ active: tab === "talk", onToggle: () => select("talk") }}
          help={{ href: "https://github.com/curtismu7/hitl-mfa-lab-LAB#readme" }}
          version={info?.version || null}
          onReset={reset}
          extra={<StoryToggle key={toggleKey} prefix={STORY_PREFIX} onChange={setStoryOn} />}
        >
          <ReturnLink app="hitl-mfa-lab" variant="header" />
          <ShelfLink />
          <VerifyMark id="hitl-mfa-lab" />
        </TopMenu>
      </header>
      <main className="page">
        <p className="banner" role="status" data-testid="banner">{banner}</p>
        <ReturnLink app="hitl-mfa-lab" />
        {error && <p className="app-error" role="alert">Could not load the lab ({error}). Is the server running?</p>}
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        {!presenter && story && <div className="page-head"><p className="intro">{story.intro}</p></div>}
        <div id={`panel-${tab}`}>
          {error ? null : !story || info === undefined ? <p className="muted">Loading...</p> : (
            <>
              {presenter && tab !== "talk" && (
                <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
                  {story.talkTrack.filter((t) => (tab === "gate" ? ["say-first", "bands", "precedence", "ciba", "receipts", "pingid", "unverified"] : ["say-first"]).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
                </aside>
              )}
              {tab === "gate" && <PolicyGate key={vertical} vertical={vertical} mode={info?.mode === "real" ? "real" : "mock"} story={story} resetSignal={resetSignal} requestedId={requested} onSelect={pickScenario} />}
              {tab === "diagram" && <DiagramTab vertical={vertical} resetSignal={resetSignal} />}
              {tab === "talk" && <TalkTrack talk={story.talkTrack} />}
            </>
          )}
        </div>
      </main>
      {storyOn && !presenter ? (
        <StoryBoundary onExit={leaveStory}>
          <Suspense fallback={null}>
            <StoryRoot mode={info?.mode === "real" ? "real" : "mock"} onExit={leaveStory} prefix={STORY_PREFIX} />
          </Suspense>
        </StoryBoundary>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import PolicyGate from "./components/PolicyGate";
import DiagramTab from "./components/DiagramTab";
import TalkTrack from "./components/TalkTrack";
import ShelfLink from "./components/ShelfLink";
import TopMenu from "./top-menu/TopMenu";
import ReturnLink from "./return-link/ReturnLink.jsx";
import { readReturnContext } from "./return-link/returnTargets.js";
import { scenarioFor, verticalFor } from "./handoffMap";
import { getJson, resetWorkspace, setMode } from "./api";

export const TABS = [
  { id: "gate", label: "Transfer gate" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
// The banner is never blank and never claims "not hosted" before it knows: until /api/info or /api/scenarios answers (or if both fail)
// it says both, honestly.
const TAIL = "Nothing here calls a real gateway, identity provider or tenant.";
export const BANNER_UNKNOWN = `SIMULATED / HOSTED SIMULATION: a mock transfer gate, mock MFA step-up and a mock CIBA out-of-band approval. ${TAIL}`;
const BANNER_LOCAL = `SIMULATED: a mock transfer gate, mock MFA step-up and a mock CIBA out-of-band approval. ${TAIL}`;
const BANNER_HOSTED = `HOSTED SIMULATION: a mock transfer gate, mock MFA step-up and a mock CIBA out-of-band approval. ${TAIL}`;

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
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");
  const tabsRef = useRef(null);

  useEffect(() => { getJson("/api/info").then(setInfo, () => setInfo(null)); }, []);
  useEffect(() => { getJson(`/api/scenarios?vertical=${encodeURIComponent(vertical)}`).then((j) => { setStory(j); setError(null); }, (e) => setError(e.message)); }, [vertical]);
  useEffect(() => {
    const on = () => { const p = hashParts(); setTab(p.tab); setRequested(p.scenario); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const select = (id) => { setTab(id); setRequested(null); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };
  const pickScenario = (sid) => { try { window.history.replaceState(null, "", `#scenario-${sid}`); } catch { /* ignore */ } };

  // Keep the active tab fully in view in the scrolling tab strip (375px).
  useEffect(() => {
    const strip = tabsRef.current; const el = document.getElementById(`tab-${tab}`);
    if (!strip || !el) return;
    const left = el.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, left - 8);
  }, [tab]);

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
  }, []);

  const switchMode = useCallback(async (next) => {
    if (!info || next === info.mode) return;
    const res = await setMode(next).catch(() => ({ ok: false }));
    if (res.ok) { window.location.reload(); }
    else setResetMsg(res.body?.detail || "Could not switch mode.");
  }, [info]);

  const onKeyTab = (e, i) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    select(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const hosted = story ? !!story.hosted : info ? !!info.hosted : null;
  const banner = story ? story.banner : hosted === true ? BANNER_HOSTED : hosted === false ? BANNER_LOCAL : BANNER_UNKNOWN;
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header>
        <p className="banner" role="status" data-testid="banner">{banner}</p>
        <ReturnLink app="hitl-mfa-lab" />
        <div className="head">
          <div>
            <h1>HITL MFA Lab</h1>
            {!presenter && story && <p className="intro">{story.intro}</p>}
          </div>
          <div className="head__tools">
            <TopMenu
              mode={{ value: info?.mode === "real" ? "real" : "mock", onChange: switchMode, realAvailable: info?.realAvailable ?? null, realHint: "Real is owner-run and RESERVED in this build: the toggle reports it, the live-gateway data path is not wired yet." }}
              vertical={{ value: vertical, onChange: setVertical, options: story ? story.verticals : ["retail"] }}
              present={{ active: presenter, onToggle: () => setPresenter((v) => !v) }}
              talkTrack={{ active: tab === "talk", onToggle: () => select("talk") }}
              help={{ href: "https://github.com/curtismu7/hitl-mfa-lab-LAB#readme" }}
              version={info?.version || null}
              onReset={reset}
            >
              <ReturnLink app="hitl-mfa-lab" variant="header" />
              <ShelfLink />
            </TopMenu>
          </div>
        </div>
      </header>
      <main>
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        <div role="tablist" aria-label="Lab sections" className="tabs" ref={tabsRef}>
          {TABS.map((t, i) => (
            <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
              onClick={() => select(t.id)} onKeyDown={(e) => onKeyTab(e, i)}>{t.label}</button>
          ))}
        </div>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {error ? <p className="app-error" role="alert">Could not load the lab ({error}). Is the server running?</p> : !story ? <p className="muted">Loading...</p> : (
            <>
              {presenter && tab !== "talk" && (
                <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
                  {story.talkTrack.filter((t) => (tab === "gate" ? ["say-first", "bands", "precedence", "ciba", "receipts", "unverified"] : ["say-first"]).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
                </aside>
              )}
              {tab === "gate" && <PolicyGate key={vertical} story={story} resetSignal={resetSignal} requestedId={requested} onSelect={pickScenario} />}
              {tab === "diagram" && <DiagramTab vertical={vertical} resetSignal={resetSignal} />}
              {tab === "talk" && <TalkTrack talk={story.talkTrack} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

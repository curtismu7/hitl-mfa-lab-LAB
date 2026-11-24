// StoryBar: the Story controls (Back, Next, Play for me / Pause, speed, Exit) and the status line. It shows the engine's state; it has no logic of its own
// beyond the keyboard (arrows, Esc) and "any manual input stops Play". Mock is labelled simulated. Vendor to web/src/story/StoryBar.jsx, byte-for-byte.
//   <StoryBar story={engine} mock={mode === "mock"} />
// `isManual(event)` decides whether an event is the viewer's own (default: the browser marks it trusted); tests pass their own, since jsdom cannot make a trusted event.
import { useEffect, useRef, useState } from "react";

const SPEEDS = [["slower", "Slower"], ["normal", "Normal"], ["faster", "Faster"]];
const typing = (e) => { const t = e.target; return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)); };

const trusted = (e) => e.isTrusted;

export default function StoryBar({ story, mock = false, isManual = trusted }) {
  const [s, setS] = useState(() => story.state());
  const bar = useRef(null);
  useEffect(() => { const off = story.subscribe(setS); setS(story.state()); return off; }, [story]);   // re-read: the story may have started before this subscribed

  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!story.state().active) return;                       // no story running: the page's own arrow keys and Esc are left alone
      if (e.key === "Escape") { story.exit(); return; }
      if (typing(e)) return;                                   // the viewer is typing the question: arrows belong to the field
      if (e.key === "ArrowRight") { e.preventDefault(); story.next(); } else if (e.key === "ArrowLeft") { e.preventDefault(); story.back(); }
    };
    // A real click or key anywhere outside the Play, Pause and speed controls hands the story back to the viewer. Events the page made itself
    // (isTrusted false: Play for me pressing Send) are not manual input.
    const onManual = (e) => {
      if (!isManual(e)) return;
      const t = e.target; if (bar.current && t instanceof Node && bar.current.contains(t) && t.closest("[data-keep-play]")) return;
      story.manualInput();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onManual, true);
    document.addEventListener("keydown", onManual, true);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onManual, true); document.removeEventListener("keydown", onManual, true); };
  }, [story, isManual]);

  if (!s.active) return null;
  const done = s.status === "done";
  // Waiting on the VIEWER (not on a run): a prompt step that is up and not being played for them, or a run that failed and needs Next. The message turns bright red and
  // blinks slowly (story.css; no blink under reduced motion) so a presenter cannot miss that it is their turn.
  const yourTurn = s.status === "stalled" || (s.status === "showing" && !!s.promptKind && !s.playing) || (s.status === "waiting" && s.waitingOn === "viewer");
  const turnText = s.promptKind === "press" ? "Your turn: press the highlighted button, then Next" : "Your turn: press Send, then Next";
  return (
    <div className="story-bar" ref={bar} role="region" aria-label="Story controls" data-testid="story-bar" data-status={s.status}>
      {mock ? <span className="story-chip" data-testid="story-simulated">Simulated</span> : null}
      <span className="story-msg" role="status" aria-live="polite" data-testid="story-msg" data-your-turn={yourTurn ? "true" : undefined}>
        {s.message || (s.status === "waiting" ? "Waiting for the run…" : done ? "End of the story." : yourTurn ? turnText : s.kind === "slide" ? "Slide" : s.n ? `${s.n} of ${s.total}` : "")}
      </span>
      <button type="button" onClick={() => story.back()} disabled={!s.canBack} data-testid="story-back">Back</button>
      <button type="button" onClick={() => story.next()} disabled={!s.canNext} data-testid="story-next">Next</button>
      {s.playing && !s.paused
        ? <button type="button" data-keep-play onClick={() => story.pause()} data-testid="story-pause">Pause</button>
        : <button type="button" data-keep-play onClick={() => (s.playing ? story.resume() : story.play())} disabled={done} data-testid="story-play">{s.playing ? "Resume" : "Play for me"}</button>}
      <label className="story-speed" data-keep-play>
        <span>Speed</span>
        <select value={s.speed} onChange={(e) => story.setSpeed(e.target.value)} data-testid="story-speed" aria-label="Play speed">
          {SPEEDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      {done ? <button type="button" onClick={() => story.restart()} data-testid="story-restart">Restart</button> : null}
      <button type="button" onClick={() => story.exit()} data-testid="story-exit">Exit</button>
      {s.warnings.length ? <span className="story-warn" data-testid="story-warn" title={s.warnings.join("\n")}>{s.warnings.length} value{s.warnings.length > 1 ? "s" : ""} not readable</span> : null}
    </div>
  );
}

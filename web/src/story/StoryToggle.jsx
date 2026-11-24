// StoryToggle: the "Demo | Story" segmented control. Demo is the default and the page is unchanged with Story off. The choice persists in localStorage
// (per lab, by `prefix`); `?story=1` turns Story on for that visit. It never goes inside a vendored menu: the lab renders it in its own shell slot.
// Vendor to web/src/story/StoryToggle.jsx, byte-for-byte; never edit a lab's copy.
//   <StoryToggle prefix="a2a" onChange={(on) => setStoryOn(on)} />
import { useCallback, useEffect, useState } from "react";

export const storyKey = (prefix) => `${prefix}.story.view`;

// Storage can be blocked (private window, site data off): then the choice lasts for this page only, and nothing throws.
export function readView(prefix, search = typeof location !== "undefined" ? location.search : "") {
  try { if (new URLSearchParams(search).get("story") === "1") return "story"; } catch { /* no query string */ }
  try { return localStorage.getItem(storyKey(prefix)) === "story" ? "story" : "demo"; } catch { return "demo"; }
}
const writeView = (prefix, view) => { try { localStorage.setItem(storyKey(prefix), view); } catch { /* not remembered */ } };

export default function StoryToggle({ prefix = "story", onChange }) {
  const [view, setView] = useState(() => readView(prefix));
  const choose = useCallback((next) => {
    setView(next); writeView(prefix, next);
    try { window.dispatchEvent(new CustomEvent("story:view", { detail: { on: next === "story" } })); } catch { /* no window events */ }
  }, [prefix]);
  useEffect(() => { if (onChange) onChange(view === "story"); }, [view, onChange]);
  return (
    <div className="story-toggle" role="group" aria-label="View" data-testid="story-toggle">
      {[["demo", "Demo"], ["story", "Story"]].map(([id, label]) => (
        <button key={id} type="button" aria-pressed={view === id} data-testid={`story-toggle-${id}`} onClick={() => choose(id)}>{label}</button>
      ))}
    </div>
  );
}

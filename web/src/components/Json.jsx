// Json: family shared service (owner, 2026-11-13), now rendering through JsonView
// (Rule 24, owner 2026-11-14): colored, theme-aware, Colored/Raw toggle, visible()
// guard in both modes. The vendored JsonView reads the lab's guard from
// window.__safeTextVisible (wired in main.jsx).
import JsonView from "./JsonView.jsx";

export default function Json({ value, label, testId }) {
  return <JsonView value={value} label={label} testId={testId} />;
}

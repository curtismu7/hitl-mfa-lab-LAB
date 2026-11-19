import { useMemo } from "react";
import PatternDiagram from "./PatternDiagram";
import { diagramSteps, nowLine } from "../liveFlow";

/** The run drawn on the lab's own diagram: the arrows walked so far are solid, the current one is bold, what comes next is dimmed. */
export default function LiveFlow({ pattern, trail, run, resetSignal }) {
  const { steps, current } = useMemo(() => diagramSteps(trail, run, pattern ? pattern.nodes.map((n) => n.id) : null), [trail, run, pattern]);
  const drawn = useMemo(() => (pattern ? { ...pattern, steps } : null), [pattern, steps]);
  return (
    <>
      <p className="flow-now" role="status" aria-live="polite" data-testid="flow-now">{nowLine(run)}</p>
      {drawn ? <PatternDiagram pattern={drawn} resetSignal={resetSignal} liveStep={current} compact /> : <p className="muted">Loading the diagram...</p>}
    </>
  );
}

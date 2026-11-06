import { useEffect, useState } from "react";
import PatternDiagram from "./PatternDiagram";
import { getJson } from "../api";

export default function DiagramTab({ vertical, resetSignal }) {
  const [pattern, setPattern] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setPattern(null); getJson(`/api/diagram?vertical=${encodeURIComponent(vertical)}&name=hitl-mfa-flow`).then(setPattern, (e) => setError(e.message)); }, [vertical]);
  if (error) return <p className="field-error" role="alert">Could not load the diagram ({error}).</p>;
  if (!pattern) return <p className="muted">Loading...</p>;
  return (
    <>
      <PatternDiagram key={vertical} pattern={pattern} resetSignal={resetSignal} />
    </>
  );
}

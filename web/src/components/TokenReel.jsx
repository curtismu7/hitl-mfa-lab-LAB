import Json from "./Json";
import { visible } from "../safeText";
import "./TokenReel.css";

const STATE_CLASS = { done: "tag tag--ok", now: "tag tag--warn", next: "tag", blocked: "tag tag--deny" };

/** The token reel: the credentials of the current run as numbered cards, left to right in the order they appear.
 * Every card is a MOCK credential. Fields are shown raw (education); nothing here is a real secret. */
export default function TokenReel({ cards }) {
  if (!cards.length) return <p className="muted" data-testid="reel-empty">No credentials yet: run a scenario and they appear here, one card per hop.</p>;
  return (
    <ol className="reel" data-testid="token-reel" aria-label="Token reel: credentials in the order they appear">
      {cards.map((c, i) => (
        <li key={c.id} className={`reel__card reel__card--${c.status}`} data-testid={`reel-${c.id}`} aria-current={c.status === "now" ? "step" : undefined}>
          <header className="reel__head">
            <span className="reel__n" aria-hidden="true">{i + 1}</span>
            <h3>{c.title}</h3>
            <span className={`tag ${c.tag === "REAL" ? "tag--real" : c.tag === "INFERRED" ? "" : "tag--mock"}`} title={c.tag === "REAL" ? "Returned by your real gateway" : c.tag === "INFERRED" ? "Not reported to the lab: read from the outcome" : "Issued by this lab's mock gate, never a real credential"}>{c.tag || "MOCK"}</span>
          </header>
          <p><span className={STATE_CLASS[c.status] || "tag"} data-testid={`reel-${c.id}-state`}>{c.state}</span></p>
          <dl className="reel__fields">
            {Object.entries(c.fields).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{visible(String(v))}</dd></div>
            ))}
          </dl>
          {c.note && <p className="muted reel__note">{c.note}</p>}
          <details>
            <summary>Raw</summary>
            <Json value={c.fields} label={`${c.title}${c.tag === "REAL" || c.tag === "INFERRED" ? "" : " (mock)"}`} />
          </details>
        </li>
      ))}
    </ol>
  );
}

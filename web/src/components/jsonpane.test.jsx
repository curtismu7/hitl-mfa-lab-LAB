// JsonPane tests (vitest + Testing Library + jsdom). Run where the file is vendored
// (web/src/components/, next to web/src/safeText.js) — see shared/gateway-trace/gateway-trace.test.jsx.
import { render, screen, within, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Json, setJsonView, decodedTokensIn, decodeSegment } from "./JsonPane";

// JWT-shaped strings assembled at run time (never a real token in the repo).
const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwtOf = (header, claims, sig = "c2lnbmF0dXJl") => [b64(header), b64(claims), sig].join(".");

afterEach(cleanup);

beforeEach(() => setJsonView("form"));

describe("JsonPane Form view: single-href link objects collapse", () => {
  test("a one-key { href } object shows the parent key with the URL as its value, no nested href row", () => {
    render(<Json value={{ _links: { branding: { href: "https://api.pingone.com/v1/branding" } } }} testId="links" />);
    const row = screen.getByText("_links.branding").closest(".jform__row");
    expect(row).not.toBeNull();
    expect(screen.queryByText("href")).toBeNull();
    const url = row.querySelector(".jform__v--url");
    expect(url).not.toBeNull();
    expect(url).toHaveTextContent("https://api.pingone.com/v1/branding");
  });

  test("a multi-key object and an array of href objects stay flat rows with their paths, no duplicated labels", () => {
    render(
      <Json
        value={{
          _links: {
            multi: { href: "https://api.pingone.com/v1/x", method: "GET" },
            list: [{ href: "https://api.pingone.com/v1/a" }],
          },
        }}
        testId="links2"
      />
    );
    expect(screen.getByText("_links.multi.href")).toBeInTheDocument();
    expect(screen.queryByText("href", { selector: ".jform__k" })).toBeNull(); // paths only, no bare key labels
    expect(screen.getByText("_links.multi.method")).toBeInTheDocument();
    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("_links.list[0]")).toBeInTheDocument();
  });
});

describe("JsonPane Form view: hybrid C+A sections (owner, 2026-11-19)", () => {
  test("a nested object is one collapsed section that opens to flat dot-path rows", () => {
    render(<Json value={{ customer: { name: "Jamie", address: { city: "Denver" } } }} testId="hyb" />);
    const head = screen.getByText("customer", { selector: ".jsec__name" });
    expect(head.closest("details")).not.toBeNull();
    expect(head.closest("details").hasAttribute("open")).toBe(false); // body collapsed until opened
    fireEvent.click(head.closest("summary"));
    expect(head.closest("details").hasAttribute("open")).toBe(true);
    expect(screen.getByText("customer.name")).toBeInTheDocument();
    expect(screen.getAllByText("Jamie").length).toBeGreaterThanOrEqual(1); // preview and/or flat row
    expect(screen.getByText("customer.address.city")).toBeInTheDocument(); // flat, dot-path, no nested box
    expect(screen.getByText("Denver")).toBeInTheDocument();
  });

  test("an array of objects opens to index paths; scalars stay inline; the head says kind and size", () => {
    render(<Json value={{ status: "active", items: [{ amount: 5 }, { amount: 9 }] }} testId="hyb2" />);
    expect(screen.getByText("active")).toBeInTheDocument(); // top-level scalar: inline, no section
    fireEvent.click(screen.getByText("items", { selector: ".jsec__name" }).closest("summary"));
    expect(screen.getByText("items[0].amount")).toBeInTheDocument();
    expect(screen.getByText("items[1].amount")).toBeInTheDocument();
    expect(screen.getByText(/array · 2 items/)).toBeInTheDocument();
  });

  test("hot and alert keys keep their cues on the flat rows; chips and nulls render as before", () => {
    render(<Json value={{ user: { sub: "u-1", role: "reader", error: "none", scopes: ["a", "b"], note: null } }} hot={["sub"]} testId="hyb3" />);
    fireEvent.click(screen.getByText("user", { selector: ".jsec__name" }).closest("summary"));
    expect(screen.getByText("user.sub").closest(".jform__row")).toHaveAttribute("data-hot", "true");
    expect(screen.getByText("user.error").closest(".jform__row")).toHaveAttribute("data-alert", "true");
    expect(screen.getByText("user.scopes[0]")).toBeInTheDocument(); // a short chip list flattens to indexed rows
    expect(screen.getByText("user.note")).toBeInTheDocument();
    expect(screen.getByText("none", { selector: ".jform__v--null" })).toBeInTheDocument(); // null keeps its muted value
  });

  test("an empty object and an empty array open to their empty notes; the summary sizes stay right", () => {
    render(<Json value={{ tags: [], meta: {} }} testId="hyb4" />);
    expect(screen.getByText(/array · 0 items/)).toBeInTheDocument();
    expect(screen.getByText(/object · 0 fields/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("tags", { selector: ".jsec__name" }).closest("summary"));
    expect(screen.getByText("[ ] empty list")).toBeInTheDocument();
  });

  test("a HAL link inside a section stays one row with the URL as the value", () => {
    render(<Json value={{ _links: { branding: { href: "https://api.pingone.com/v1/branding" } } }} testId="hyb5" />);
    fireEvent.click(screen.getByText("_links", { selector: ".jsec__name" }).closest("summary"));
    expect(screen.queryByText("href")).toBeNull();
    expect(screen.getByText("_links.branding")).toBeInTheDocument();
    expect(screen.getAllByText("https://api.pingone.com/v1/branding").length).toBeGreaterThanOrEqual(1); // preview and/or row
  });
});

describe("decoded tokens (Rule 24b)", () => {
  test("a PingOne-shaped token in a body: raw in its field, then Header, Payload and Signature under the pane, named by the field", () => {
    const token = jwtOf(
      { alg: "RS256", kid: "mock-key-1", typ: "JWT" },
      { sub: "u-123", client_id: "bank-app", iss: "https://auth.ping-devops.com/as", aud: ["gateway"], scope: "openid transfer", iat: 1769000000, exp: 1769003600, may_act: JSON.stringify({ sub: "agent-1" }) }
    );
    render(<Json label="Token response" value={{ access_token: token, token_type: "Bearer", expires_in: 3600 }} />);
    const box = screen.getByTestId("decoded-tokens");
    const card = within(box).getByTestId("decoded-token");
    expect(card.textContent).toMatch(/access_token/);
    for (const h of ["Header", "Payload", "Signature"]) expect(within(card).getByText(h)).toBeTruthy();
    expect(card.textContent).toMatch(/RS256/);
    expect(card.textContent).toMatch(/u-123/);
    expect(card.textContent).toMatch(/transfer/);
    expect(card.textContent).toMatch(/gateway/);
    expect(card.textContent).toMatch(/agent-1/);
  });

  test("a Bearer authorization header, a nested act chain, and JSON that arrived as text are all decoded", () => {
    const inner = jwtOf({ alg: "ES256", kid: "mock-key-1" }, { sub: "agent-1", client_id: "agent-1", scope: "trips:read" });
    const outer = jwtOf({ alg: "RS256", kid: "k2" }, { sub: "u-123", act: { sub: "agent-1" } });
    render(<Json label="Exchange request" value={{ headers: { authorization: `Bearer ${outer}` }, body: { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: inner } }} />);
    const names = screen.getAllByTestId("decoded-token").map((e) => e.querySelector(".jdec__name").textContent);
    expect(names).toEqual(["headers.authorization", "body.subject_token"]);
    cleanup();
    render(<Json label="text body" value={JSON.stringify({ access_token: outer })} />);
    expect(screen.getByTestId("decoded-token").textContent).toMatch(/access_token/);
  });

  test("decode={false} skips decoding; the same token is shown once; caps hold (6 tokens, depth 8)", () => {
    const token = jwtOf({ alg: "none" }, { sub: "s" }, "");
    render(<Json label="raw" value={{ access_token: token }} decode={false} />);
    expect(screen.queryByTestId("decoded-tokens")).toBeNull();
    cleanup();
    const found = decodedTokensIn({ a: token, b: { c: token } });
    expect(found).toHaveLength(1);
    expect(decodedTokensIn(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`t${i}`, jwtOf({ alg: "none" }, { sub: `s${i}` })])))).toHaveLength(6);
    expect(decodedTokensIn({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: token } } } } } } } } } })).toHaveLength(0);
  });

  test("an unsigned token says so; a cut-short or non-JWT is skipped; decoded text is rendered as text, never as markup", () => {
    const token = jwtOf({ alg: "none" }, { sub: "<img src=x onerror=alert(1)>" }, "");
    render(<Json label="unsigned" value={{ access_token: token, short: `${token.slice(0, 40)}...`, note: "eyJ not a token" }} />);
    const card = screen.getByTestId("decoded-token");
    expect(card.textContent).toMatch(/no signature segment/);
    expect(card.querySelector("img, script")).toBeNull();
    expect(card.textContent).toMatch(/<img src=x onerror=alert\(1\)>/);
    expect(screen.getAllByTestId("decoded-token")).toHaveLength(1);
  });

  test("decodeSegment handles base64url with and without padding and returns null for non-objects", () => {
    expect(decodeSegment(b64({ alg: "RS256" }))).toEqual({ alg: "RS256" });
    expect(decodeSegment(btoa(JSON.stringify({ alg: "ES256" })))).toEqual({ alg: "ES256" });
    expect(() => decodeSegment("!!!")).toThrow();
  });
});

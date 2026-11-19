// Tests for the shared Phone standard. Run from a lab that vendors it (vitest + Testing Library + jsdom,
// the same setup as floating-dialog.test.jsx) or from AI-DEMO-Standalone with the lab's vitest config.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Phone from "./Phone.jsx";

describe("Phone", () => {
  it("renders open with the device chrome and content, readable testids", () => {
    render(
      <Phone open onClose={() => {}} label="Mock phone" testId="ciba-phone">
        <p className="phone__headline">Approve this sign-in?</p>
        <button type="button" onClick={() => {}}>Approve</button>
      </Phone>,
    );
    const panel = screen.getByTestId("ciba-phone");
    expect(panel.className).toContain("phone-dialog");
    expect(screen.getByTestId("ciba-phone-screen")).toBeInTheDocument();
    expect(screen.getByText("Approve this sign-in?")).toBeInTheDocument();
    // device chrome present
    expect(panel.querySelector(".phone-screen__island")).toBeTruthy();
    expect(panel.querySelector(".phone-screen__home")).toBeTruthy();
    expect(panel.querySelector(".phone-screen__time").textContent).toBe("9:41");
  });

  it("renders nothing when closed", () => {
    render(<Phone open={false} onClose={() => {}}>x</Phone>);
    expect(screen.queryByTestId("phone")).toBeNull();
  });

  it("calls onClose from the title bar close button", () => {
    const onClose = vi.fn();
    render(<Phone open onClose={onClose} testId="p">x</Phone>);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the pop-out control available (drag/resize/pop-out come from FloatingDialog)", () => {
    render(<Phone open onClose={() => {}} testId="p">x</Phone>);
    expect(screen.getByRole("button", { name: "Pop out to a new window" })).toBeTruthy();
    // 8 resize handles
    expect(document.querySelectorAll(".fd-handle").length).toBe(8);
  });

  it("renders the titlebar without a visible title; the bezel is the chrome", () => {
    render(<Phone open onClose={() => {}} label="Mock phone" testId="p">x</Phone>);
    const title = document.querySelector(".phone-dialog .fd-title");
    expect(title).toBeTruthy();
    expect(title.textContent).toBe("Mock phone");
    // the css hides it (.phone-dialog .fd-title { visibility: hidden }) — pin the hook the css keys on
    expect(title.className).toBe("fd-title");
    expect(document.querySelector(".phone-dialog.fd-panel")).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { useRef, useState } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSheet } from "./AdminSheet.js";

afterEach(cleanup);

/** Stands in for a panel: a button that opens the sheet, passing itself as `opener`. */
function Harness() {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
      >
        Open
      </button>
      {open && (
        <AdminSheet title="Create thing" onClose={() => setOpen(false)} opener={openerRef.current}>
          <div className="side-panel__body">
            <p>Fields go here.</p>
          </div>
          <div className="side-panel__footer">
            <button type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </AdminSheet>
      )}
    </>
  );
}

describe("AdminSheet", () => {
  it("is a labelled dialog, closed until opened", async () => {
    render(<Harness />);

    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      screen.getByRole("button", { name: "Open" }).click();
    });

    expect(screen.getByRole("dialog", { name: "Create thing" })).toBeTruthy();
  });

  it("moves focus into the sheet on open and back to the opener on close via the close button", async () => {
    render(<Harness />);

    const opener = screen.getByRole("button", { name: "Open" });
    await act(async () => {
      opener.click();
    });

    const dialog = screen.getByRole("dialog", { name: "Create thing" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await act(async () => {
      screen.getByRole("button", { name: "Close" }).click();
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Cancel and returns focus to the opener", async () => {
    render(<Harness />);

    const opener = screen.getByRole("button", { name: "Open" });
    await act(async () => {
      opener.click();
    });
    expect(screen.getByRole("dialog", { name: "Create thing" })).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape and returns focus to the opener", async () => {
    render(<Harness />);

    const opener = screen.getByRole("button", { name: "Open" });
    await act(async () => {
      opener.click();
    });
    expect(screen.getByRole("dialog", { name: "Create thing" })).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a backdrop click", async () => {
    render(<Harness />);

    await act(async () => {
      screen.getByRole("button", { name: "Open" }).click();
    });
    expect(screen.getByRole("dialog", { name: "Create thing" })).toBeTruthy();

    const backdrop = document.querySelector(".side-panel__backdrop");
    expect(backdrop).toBeTruthy();
    await act(async () => {
      (backdrop as HTMLElement).click();
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("calls onClose exactly once per Escape press even with an unstable onClose identity", async () => {
    const onClose = vi.fn();
    function Wrapper() {
      const openerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button ref={openerRef} type="button">
            Opener
          </button>
          <AdminSheet title="X" onClose={onClose} opener={openerRef.current}>
            <div className="side-panel__body" />
          </AdminSheet>
        </>
      );
    }
    render(<Wrapper />);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

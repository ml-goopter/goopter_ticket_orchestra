import { useEffect, useRef, type ReactNode } from "react";

export interface AdminSheetProps {
  /** Accessible name for the dialog and its visible header. */
  title: string;
  /** Optional mono/faint detail next to the title (e.g. the row being edited). */
  subtitle?: string;
  onClose: () => void;
  /** The element focus returns to when the sheet closes -- whichever button opened it. */
  opener: HTMLElement | null;
  /**
   * The sheet's own `<form>`, wrapping both its fields and its Save/Cancel
   * footer (so Enter inside a field submits it, and the footer's buttons sit
   * inside the same form as the fields they act on).
   */
  children: ReactNode;
}

/**
 * Create/edit sheet (UR7, docs/design.md §14 Admin row; approved mockup
 * `admin.mockup.html`'s `.sheet`): the shared `.side-panel--right` primitive
 * (styles/components.css) as a labelled dialog. Esc and a backdrop click
 * close it (`AttentionDrawer.tsx`'s pattern); a panel's own Cancel/close
 * button call the same `onClose`. Unlike `AttentionDrawer`, which stays
 * mounted and toggles an internal `open` flag, a caller only ever mounts
 * this while open, so focus moves in on mount and back to `opener` on
 * unmount instead of reacting to an `open` prop.
 */
export function AdminSheet({ title, subtitle, onClose, opener, children }: AdminSheetProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.focus();
    return () => {
      opener?.focus();
    };
    // Deliberately mount/unmount-only: `opener` is captured once, at the
    // moment the sheet was opened, and never changes for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <>
      <div className="side-panel__backdrop" onClick={onClose} />
      <div
        className="side-panel side-panel--right"
        role="dialog"
        aria-label={title}
        aria-modal="true"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="side-panel__header">
          <h2 className="side-panel__title">
            {title}
            {subtitle && <span className="admin-sheet__subtitle">{subtitle}</span>}
          </h2>
          <button type="button" className="side-panel__close" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

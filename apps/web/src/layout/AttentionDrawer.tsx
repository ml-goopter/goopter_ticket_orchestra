import { useState } from "react";

/**
 * Persistent right-hand drawer placeholder (design.md §14). Collapsed by
 * default; the count badge and item list are wired to real attention data by
 * GOT.36.
 */
export function AttentionDrawer() {
  const [open, setOpen] = useState(false);
  const count = 0;

  return (
    <aside aria-label="Attention">
      <button type="button" aria-expanded={open} onClick={() => setOpen((prev) => !prev)}>
        Attention <span data-testid="attention-count">{count}</span>
      </button>
      {open && (
        <div>
          <ul aria-label="Attention items" />
          <p>Nothing needs attention.</p>
        </div>
      )}
    </aside>
  );
}

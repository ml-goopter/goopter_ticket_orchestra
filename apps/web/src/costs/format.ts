/**
 * Costs-view-only number formatting (UR6, approved mockup
 * nimbalyst-local/mockups/costs.mockup.html): a compact token-count value
 * (e.g. "48.2M") for a totals tile's headline number. The exact,
 * thousands-separated count still renders underneath via
 * `../ui/number.js`'s `formatNumber` -- this is additive, not a
 * replacement.
 */

const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Compact form of a count, e.g. 48213904 -> "48.2M", 788403 -> "788.4K", 190 -> "190". */
export function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value);
}

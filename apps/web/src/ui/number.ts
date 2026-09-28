/**
 * Number formatting for cost tables and cards (design.md §14 Board, Costs).
 */

const numberFormatter = new Intl.NumberFormat("en-US");

/** Thousands separators, e.g. 1234567 -> "1,234,567". */
export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdSubCentFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

/**
 * USD with 2 decimals, or 4 decimals below one cent so sub-cent LLM token
 * costs (e.g. $0.004) don't round away to "$0.00".
 */
export function formatUsd(value: number): string {
  const isSubCent = value !== 0 && Math.abs(value) < 0.01;
  return (isSubCent ? usdSubCentFormatter : usdFormatter).format(value);
}

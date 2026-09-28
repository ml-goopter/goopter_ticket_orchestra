/**
 * SCREAMING_SNAKE_CASE enum value to a readable label: lowercase every
 * word, capitalize only the first ("SPEC_AMBIGUITY" -> "Spec ambiguity",
 * "READY_FOR_MERGE" -> "Ready for merge"). Used by `StateBadge` and any
 * later view rendering a raw enum string.
 */
export function humanizeEnum(value: string): string {
  if (value === "") return "";
  const words = value.split("_").map((word) => word.toLowerCase());
  const [first, ...rest] = words;
  const capitalizedFirst = first ? first.charAt(0).toUpperCase() + first.slice(1) : "";
  return [capitalizedFirst, ...rest].join(" ");
}

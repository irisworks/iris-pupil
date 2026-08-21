/**
 * Renders a min/max pair as human-readable bounds for a score reason.
 *
 * Shared by the tool_call_count assertion and the metric threshold evaluator so
 * the two cannot drift into describing the same constraint differently.
 * Explicitly compares against undefined rather than testing truthiness, because
 * 0 is a meaningful bound.
 */
export function formatBounds(min: number | undefined, max: number | undefined): string {
  const parts: string[] = [];
  if (min !== undefined) parts.push(`>= ${min}`);
  if (max !== undefined) parts.push(`<= ${max}`);
  return parts.join(" and ");
}

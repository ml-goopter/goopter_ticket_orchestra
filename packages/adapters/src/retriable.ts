/**
 * Adapter-error classification (design.md §9.5).
 *
 * The runner decides retry from how an execution ended, never from agent
 * prose, so this is a pure function over the failure text the adapter
 * produced.
 *
 * §9.5 states the terminal set as a closed list — auth, quota, bad model — and
 * this follows that reading: a failure matching `TERMINAL_PATTERNS` is
 * terminal and everything else is infrastructure noise the runner retries
 * under `max_infra_retries` with backoff. An unrecognised failure therefore
 * degrades to a bounded retry rather than stalling the task on
 * `NEEDS_HUMAN`, which is the safer default for a transient failure this list
 * has not learned yet.
 *
 * A message can carry both signals — a 429 whose body is really a spent quota
 * — so the terminal list decides.
 */

/** Failures no retry can fix. They need a human or a configuration change. */
const TERMINAL_PATTERNS: readonly RegExp[] = [
  // Authentication and authorisation.
  /\bauthentication[_ ]failed\b/i,
  /\bunauthorized\b|\bforbidden\b/i,
  /\bstatus\s+40[13]\b|\b40[13]\s+(?:unauthorized|forbidden)\b/i,
  /\b(?:invalid|missing|expired)\s+(?:x-)?api[_ -]?key\b/i,
  /\boauth_org_not_allowed\b|\bcloud_credential_error\b/i,
  /\baccount_on_hold\b|\bverification_required\b/i,
  // Billing and quota. Distinct from a rate limit, which is retriable.
  /\bbilling_error\b/i,
  /\bcredit balance\b/i,
  /\bquota\s+(?:exceeded|exhausted)\b|\binsufficient\s+(?:quota|credits|funds)\b/i,
  // Budget and turn allowance exhausted.
  /\berror_max_budget_usd\b|\bmax[_ ]budget\b|\bbudget\s+(?:exceeded|exhausted)\b/i,
  /\berror_max_turns\b|\bmaximum number of turns\b|\bmax[_ ]turns\b/i,
  // Model selection and malformed requests. Replaying them fails the same way.
  /\bmodel_not_found\b|\binvalid model\b|\bunknown model\b|\bmodel\b[^.]{0,40}\bdoes not exist\b/i,
  /\binvalid_request\b/i,
];

/**
 * True when the runner should retry this adapter error as infrastructure
 * (design.md §9.5), false when it must go straight to `NEEDS_HUMAN`.
 *
 * @param message failure text from the runtime: a result message's `errors`,
 *   its result text, or a thrown error's message.
 */
export function classifyRetriable(message: string): boolean {
  return !TERMINAL_PATTERNS.some((pattern) => pattern.test(message));
}

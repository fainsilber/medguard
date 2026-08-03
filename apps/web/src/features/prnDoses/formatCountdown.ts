/**
 * `msRemaining` as "1 hr 14 mins" (PRD §2.3's exact phrasing). Rounds up to the nearest minute
 * rather than down — showing "13 mins" when 40 seconds remain would read as "safe to try now",
 * which it isn't.
 */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) {
    // Defensive: assessDose never actually returns a non-positive msRemaining for a blocked
    // state (proven by a Sprint 1 property test), so this path shouldn't be reachable in
    // practice — but a formatter that can't handle its own edge case is a landmine.
    return 'less than a minute';
  }

  const totalMinutes = Math.ceil(msRemaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const hourPart = hours > 0 ? `${hours} hr${hours === 1 ? '' : 's'}` : '';
  const minutePart = minutes > 0 ? `${minutes} min${minutes === 1 ? '' : 's'}` : '';

  return [hourPart, minutePart].filter(Boolean).join(' ') || 'less than a minute';
}

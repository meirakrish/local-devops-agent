/** Minutes from `iso` to `now`; infinite when the time is unknown (treated as old). */
export function minutesSince(iso: string | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (now.getTime() - Date.parse(iso)) / 60_000;
}

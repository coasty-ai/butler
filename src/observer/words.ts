/** Calendar wording shared with Settings; this module has no filesystem imports. */
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function weekdaysPhrase(weekdays: number[]): string {
  const set = new Set(weekdays);
  if (set.size === 7) return "every day";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d)))
    return "weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "weekends";
  return [...set]
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES[d] + "s")
    .join(", ");
}

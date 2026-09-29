export const DAY = 86_400_000;

/** Local calendar date, e.g. `2026-10-30`. */
export function isoDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days elapsed from `from` to `to`. */
export function daysBetween(from: number, to: number): number {
  return Math.floor((to - from) / DAY);
}

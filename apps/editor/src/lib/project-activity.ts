const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * DAY],
  ["month", 30 * DAY],
  ["week", 7 * DAY],
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
];

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** Launcher card caption: the most recent open, falling back to creation. */
export function describeProjectActivity(
  project: { lastOpenedAt?: string; createdAt?: string },
  now = Date.now(),
): string | null {
  const [verb, iso] = project.lastOpenedAt
    ? ["Opened", project.lastOpenedAt]
    : ["Created", project.createdAt];
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return null;
  const elapsed = time - now;
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(elapsed) >= size)
      return `${verb} ${relativeTime.format(Math.round(elapsed / size), unit)}`;
  }
  return `${verb} just now`;
}

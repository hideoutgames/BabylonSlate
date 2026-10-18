const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const COMPACT_UNITS: ReadonlyArray<[string, number]> = [
  ["y", 365 * DAY],
  ["mo", 30 * DAY],
  ["w", 7 * DAY],
  ["d", DAY],
  ["h", HOUR],
  ["m", MINUTE],
];

const fullDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Launcher card caption: how long ago the project was last opened (or
 * created), compact like "31m ago" or "2d ago", with the full date for a tooltip.
 */
export function describeProjectActivity(
  project: { lastOpenedAt?: string; createdAt?: string },
  now = Date.now(),
): { label: string; title: string } | null {
  const [verb, iso] = project.lastOpenedAt
    ? ["Opened", project.lastOpenedAt]
    : ["Created", project.createdAt];
  const time = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(time)) return null;
  const title = `${verb} ${fullDate.format(time)}`;
  const elapsed = Math.max(0, now - time);
  for (const [unit, size] of COMPACT_UNITS) {
    if (elapsed >= size)
      return { label: `${Math.floor(elapsed / size)}${unit} ago`, title };
  }
  return { label: "Just now", title };
}
